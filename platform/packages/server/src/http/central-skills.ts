import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { strFromU8, strToU8, zipSync } from "fflate";
import { parseSkillFrontmatter } from "@prismshadow/penguin-core";
import { HttpError } from "./errors.js";
import { parseSkillArchive } from "./routes/skills.js";
import type { AppEnv } from "../auth/middleware.js";
import { resourceDependencies, type ControlStore, type PublicResource } from "./control-plane.js";

const defaults = [["common","通用"],["req","需求分析"],["design","测试设计"],["case","用例生成"],["web","Web 自动化"],["api","接口自动化"],["app","App 自动化"],["mini","小程序自动化"],["report","测试报告"],["defect","缺陷管理"]];
/** Preserve the 59764 list's automatic stages for skills without a manual assignment. */
function defaultSkillCategory(name:string):string {
  const value=name.toLowerCase();
  if(/miniprogram|mini.app|小程序/.test(value))return "mini";
  if(/android|ios|mobile/.test(value))return "app";
  if(/playwright|browser|web.execution/.test(value))return "web";
  if(/api.test.execution|api.automation|api.testing/.test(value))return "api";
  if(/requirement|api.contract/.test(value))return "req";
  if(/test.point|test.design/.test(value))return "design";
  if(/test.case/.test(value))return "case";
  if(/defect|bug|investigation/.test(value))return "defect";
  if(/report/.test(value))return "report";
  return "common";
}
const bad = (message:string) => { throw new HttpError(400,"invalid_skill",message); };
function skillName(value:unknown):string {
  if(typeof value!=="string"||!/^[a-z][a-z0-9_-]{0,63}$/.test(value))return bad("技能名称无效。");
  return value;
}
function contentOf(resource:PublicResource):string {
  if(typeof resource.payload.archiveBase64==="string"){
    const parsed=parseSkillArchive(Buffer.from(resource.payload.archiveBase64,"base64"));
    return strFromU8(parsed.files.get("SKILL.md")!);
  }
  return String(resource.payload.content??"");
}
function filesOf(resource:PublicResource):Record<string,string> {
  if(typeof resource.payload.archiveBase64!=="string")return {"SKILL.md":contentOf(resource)};
  const parsed=parseSkillArchive(Buffer.from(resource.payload.archiveBase64,"base64"));
  const files:Record<string,string>={};
  const decoder=new TextDecoder("utf-8",{fatal:true});
  for(const [name,data] of parsed.files)try{if(!data.includes(0))files[name]=decoder.decode(data);}catch{/* Binary adjuncts remain in the archive. */}
  return files;
}
function skillBody(name:string,description:string,body:string):string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
}
function asPayload(resource:PublicResource|undefined,name:string,content:string,archiveBase64?:string):Record<string,unknown> {
  if(archiveBase64!==undefined)return {skillName:name,archiveBase64};
  if(typeof resource?.payload.archiveBase64==="string"){
    const parsed=parseSkillArchive(Buffer.from(resource.payload.archiveBase64,"base64"));
    parsed.files.set("SKILL.md",strToU8(content));
    return {skillName:name,archiveBase64:Buffer.from(zipSync(Object.fromEntries(parsed.files))).toString("base64")};
  }
  return {skillName:name,content};
}
export function centralSkillRoutes(store:ControlStore):Hono<AppEnv>{
  const app=new Hono<AppEnv>();
  const db=store.db;
  db.exec("CREATE TABLE IF NOT EXISTS central_skill_categories(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,builtin INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS central_skill_assignments(skill_name TEXT PRIMARY KEY,category_id TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS central_skill_versions(resource_id TEXT NOT NULL,label TEXT NOT NULL,resource_version INTEGER,body TEXT,change_note TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('draft','published','deleted')),revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(resource_id,label));
    CREATE TABLE IF NOT EXISTS central_skill_deleted(resource_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,deleted_by TEXT NOT NULL);`);
  // Attach labels to existing immutable snapshots without modifying their bodies.
  const legacy=db.prepare("SELECT resource_id,version,created_at FROM public_resource_versions WHERE resource_id IN (SELECT id FROM public_resources WHERE kind='skills') ORDER BY resource_id,version").all() as {resource_id:string;version:number;created_at:string}[];
  const insertLegacy=db.prepare("INSERT OR IGNORE INTO central_skill_versions(resource_id,label,resource_version,body,state,created_at,updated_at) VALUES (?,?,?,NULL,'published',?,?)");
  for(const row of legacy)if(!db.prepare("SELECT 1 FROM central_skill_versions WHERE resource_id=? AND resource_version=?").get(row.resource_id,row.version))insertLegacy.run(row.resource_id,`V1.0.${row.version-1}`,row.version,row.created_at,row.created_at);
  for(const row of db.prepare("SELECT id,draft,updated_at FROM public_resources WHERE kind='skills' AND version=0").all() as {id:string;draft:string;updated_at:string}[])db.prepare("INSERT OR IGNORE INTO central_skill_versions(resource_id,label,body,state,created_at,updated_at) VALUES (?,'V1.0.0',?,'draft',?,?)").run(row.id,row.draft,row.updated_at,row.updated_at);
  for(const row of db.prepare("SELECT id,draft,updated_at FROM public_resources WHERE kind='skills' AND version>0").all() as {id:string;draft:string;updated_at:string}[]){
    if(db.prepare("SELECT 1 FROM central_skill_versions WHERE resource_id=? AND state='draft'").get(row.id))continue;
    const published=store.get(row.id),draft=JSON.parse(row.draft) as {description:string;payload:Record<string,unknown>};
    if(draft.description===published.description&&JSON.stringify(draft.payload)===JSON.stringify(published.payload))continue;
    const labels=db.prepare("SELECT label FROM central_skill_versions WHERE resource_id=?").all(row.id) as {label:string}[];
    const minor=Math.max(0,...labels.map(item=>Number(/^V1\.(\d+)\./.exec(item.label)?.[1]??0)))+1;
    db.prepare("INSERT OR IGNORE INTO central_skill_versions(resource_id,label,body,state,created_at,updated_at) VALUES (?,?,?,'draft',?,?)").run(row.id,`V1.${minor}.0`,row.draft,row.updated_at,row.updated_at);
  }
  const seed=db.prepare("INSERT OR IGNORE INTO central_skill_categories VALUES (?,?,?,?,?)");
  for(const [id,name] of defaults)seed.run(id!,name!,1,0,"builtin");
  const categories=()=>db.prepare("SELECT id,name,builtin FROM central_skill_categories WHERE deleted=0 ORDER BY builtin DESC,created_at,id").all();
  const assignments=()=>db.prepare("SELECT skill_name AS skillName,category_id AS categoryId FROM central_skill_assignments").all() as {skillName:string;categoryId:string}[];
  const categoryMap=()=>new Map(assignments().map(row=>[row.skillName,row.categoryId]));
  const serialize=(r:PublicResource,map:Map<string,string>)=>({id:r.id,name:String(r.payload.skillName),description:r.description,content:contentOf(r),files:filesOf(r),categoryId:map.get(String(r.payload.skillName))??defaultSkillCategory(String(r.payload.skillName)),revision:r.revision,version:r.version,published:r.published,hasDraft:!!db.prepare("SELECT 1 FROM central_skill_versions WHERE resource_id=? AND state='draft'").get(r.id)||r.version>0&&(JSON.stringify(store.get(r.id,true).payload)!==JSON.stringify(store.get(r.id).payload)||store.get(r.id,true).description!==store.get(r.id).description),archive:typeof r.payload.archiveBase64==="string"});
  const getSkill=(id:string)=>{const r=store.get(id,true);if(r.kind!=="skills"||db.prepare("SELECT 1 FROM central_skill_deleted WHERE resource_id=?").get(id))throw new HttpError(404,"skill_missing","技能不存在。");return r;};
  const active=(id:string)=>!db.prepare("SELECT 1 FROM central_skill_deleted WHERE resource_id=?").get(id);
  const versionRow=(id:string,label:string)=>{const row=db.prepare("SELECT * FROM central_skill_versions WHERE resource_id=? AND label=? AND state!='deleted'").get(id,label) as {resource_id:string;label:string;resource_version:number|null;body:string|null;change_note:string;state:string;revision:number;created_at:string;updated_at:string}|undefined;if(!row)throw new HttpError(404,"version_not_found","技能版本不存在。");return row;};
  const versionResource=(id:string,row:ReturnType<typeof versionRow>):PublicResource=>row.state==="published"?store.getVersion(id,row.resource_version!):{...JSON.parse(row.body!),id,kind:"skills",revision:row.revision,version:0,published:false,audience:store.get(id,true).audience,updatedAt:row.updated_at};
  const packageFiles=(r:PublicResource)=>{const parsed=typeof r.payload.archiveBase64==="string"?parseSkillArchive(Buffer.from(r.payload.archiveBase64,"base64")).files:new Map([["SKILL.md",strToU8(contentOf(r))]]);return Object.fromEntries([...parsed].map(([path,data])=>[path,{size:data.byteLength,hash:createHash("sha256").update(data).digest("hex"),text:(()=>{try{return new TextDecoder("utf-8",{fatal:true}).decode(data);}catch{return null;}})()}]));};
  const validLabel=(value:unknown)=>{if(typeof value!=="string"||!/^V\d+\.\d+\.\d+$/.test(value))return bad("版本号格式应为 V1.2.3。");return value;};
  const admin=(c:{var:{user:{isAdmin:boolean}}})=>{if(!c.var.user.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以管理技能。");};
  app.get("/catalog",c=>{const map=categoryMap();return c.json({skills:store.list().filter(r=>r.kind==="skills"&&active(r.id)&&store.accessible(r.id,c.var.user.userId,c.var.user.isAdmin)).map(r=>serialize(r,map)),categories:categories()});});
  app.get("/admin",c=>{admin(c);const map=categoryMap();return c.json({skills:store.list(true).filter(r=>r.kind==="skills"&&active(r.id)&&(r.published||r.version===0)).map(r=>serialize(r.published?store.get(r.id):r,map)),categories:categories()});});
  app.post("/admin",async c=>{
    admin(c);const data=await c.req.json() as Record<string,unknown>;
    const archive=typeof data.archiveBase64==="string"?parseSkillArchive(Buffer.from(data.archiveBase64,"base64")):null;
    const name=skillName(archive?.name??data.name);
    const existing=store.list(true).find(r=>r.kind==="skills"&&r.payload.skillName===name);
    if(existing?.published||existing?.version===0)throw new HttpError(409,"skill_exists","技能名称已存在。");
    const description=String(data.description??(archive?parseSkillFrontmatter(strFromU8(archive.files.get("SKILL.md")!))?.description:"")??"").trim(),body=String(data.content??"").trim();
    if(!description||description.length>2000||(!body&&typeof data.archiveBase64!=="string"))return bad("技能描述或正文无效。");
    const payload=asPayload(undefined,name,skillBody(name,description,body),typeof data.archiveBase64==="string"?data.archiveBase64:undefined);
    const saved=store.save(c.var.user.userId,{kind:"skills",name,description,payload,audience:existing?.audience??["*"],...(existing?{revision:existing.revision}:{})},existing?.id);
    const current=data.publish===true?store.publish(c.var.user.userId,saved.id,saved.revision):saved;
    if(data.publish===true)db.prepare("INSERT OR IGNORE INTO central_skill_versions(resource_id,label,resource_version,state,created_at,updated_at) VALUES (?,'V1.0.0',?,'published',?,?)").run(saved.id,current.version,new Date().toISOString(),new Date().toISOString());
    else db.prepare("INSERT OR IGNORE INTO central_skill_versions(resource_id,label,body,state,created_at,updated_at) VALUES (?,'V1.0.0',?,'draft',?,?)").run(saved.id,JSON.stringify({kind:"skills",name,description,payload,audience:saved.audience}),new Date().toISOString(),new Date().toISOString());
    return c.json(serialize(current,categoryMap()),201);
  });
  app.put("/admin/:id",async c=>{
    admin(c);const old=getSkill(c.req.param("id")),data=await c.req.json() as Record<string,unknown>;
    if(old.revision!==data.revision)throw new HttpError(409,"revision_conflict","技能已变化，请刷新后重试。");
    const name=String(old.payload.skillName),description=String(data.description??"").trim(),body=String(data.content??"").trim();
    if(!description||description.length>2000||!body||body.length>60000)return bad("技能描述或正文无效。");
    const payload=asPayload(old,name,skillBody(name,description,body));
    const saved=store.save(c.var.user.userId,{kind:"skills",name,description,payload,audience:old.audience,revision:old.revision},old.id);
    return c.json(serialize(data.publish===true?store.publish(c.var.user.userId,old.id,saved.revision):saved,categoryMap()));
  });
  app.get("/admin/:id/history",c=>{admin(c);const r=getSkill(c.req.param("id"));return c.json({versions:store.history(r.id).map(item=>({version:item.version,createdAt:item.created_at,current:item.current}))});});
  app.get("/admin/:id/versions/:version",c=>{admin(c);const r=getSkill(c.req.param("id"));return c.json(serialize(store.getVersion(r.id,Number(c.req.param("version"))),categoryMap()));});
  app.post("/admin/:id/publish",async c=>{admin(c);const r=getSkill(c.req.param("id")),data=await c.req.json();return c.json(serialize(store.publish(c.var.user.userId,r.id,data.revision),categoryMap()));});
  app.get("/admin/:id/version-management",c=>{admin(c);const r=getSkill(c.req.param("id"));const rows=db.prepare("SELECT label,resource_version,change_note,state,revision,created_at,updated_at FROM central_skill_versions WHERE resource_id=? AND state!='deleted' ORDER BY created_at DESC,label DESC").all(r.id) as {label:string;resource_version:number|null;change_note:string;state:string;revision:number;created_at:string;updated_at:string}[];const versions=rows.map(row=>{const resource=versionResource(r.id,{...row,resource_id:r.id,body:row.state==="draft"?(db.prepare("SELECT body FROM central_skill_versions WHERE resource_id=? AND label=?").get(r.id,row.label) as {body:string}).body:null});const files=packageFiles(resource);return {label:row.label,state:row.state==="draft"?"draft":row.resource_version===r.version&&r.published?"current":"published",revision:row.revision,changeNote:row.change_note,createdAt:row.created_at,updatedAt:row.updated_at,files:Object.entries(files).map(([path,value])=>({path,size:value.size,hash:value.hash})),size:Object.values(files).reduce((n,file)=>n+file.size,0)};});const current=versions.find(row=>row.state==="current");return c.json({skill:serialize(r.published?store.get(r.id):r,categoryMap()),versions,currentLabel:current?.label??null,agentCount:store.list(true).filter(item=>item.kind==="agents"&&resourceDependencies(item).some(dep=>dep.id===r.id)).length});});
  app.post("/admin/:id/version-management",async c=>{admin(c);const r=getSkill(c.req.param("id")),data=await c.req.json() as Record<string,unknown>,label=validLabel(data.label);if(db.prepare("SELECT 1 FROM central_skill_versions WHERE resource_id=? AND label=?").get(r.id,label))throw new HttpError(409,"version_exists","版本号已存在。");const source=data.copyCurrent===false?null:r.published?store.get(r.id):r;const body=source?{kind:"skills",name:r.name,description:source.description,payload:source.payload,audience:r.audience}:{kind:"skills",name:r.name,description:r.description,payload:asPayload(undefined,String(r.payload.skillName),skillBody(String(r.payload.skillName),r.description,"# "+r.name)),audience:r.audience};const now=new Date().toISOString();db.prepare("INSERT INTO central_skill_versions(resource_id,label,body,change_note,state,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)").run(r.id,label,JSON.stringify(body),String(data.changeNote??""),now,now);store.audit(c.var.user.userId,"skill_version_create",r.id);return c.json({ok:true},201);});
  app.get("/admin/:id/version-management/:label",c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label")),resource=versionResource(r.id,row);return c.json({...serialize(resource,categoryMap()),label:row.label,state:row.state==="draft"?"draft":row.resource_version===r.version?"current":"published",changeNote:row.change_note,revision:row.revision});});
  app.put("/admin/:id/version-management/:label",async c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label")),data=await c.req.json() as Record<string,unknown>;if(row.state!=="draft")throw new HttpError(409,"published_immutable","已发布版本不可编辑。");if(data.revision!==row.revision)throw new HttpError(409,"revision_conflict","草稿已变化，请刷新。");const description=String(data.description??"").trim(),content=String(data.content??"").trim();if(!description||description.length>2000||!content||content.length>60000)return bad("技能描述或正文无效。");const source=versionResource(r.id,row),payload=asPayload(source,String(r.payload.skillName),skillBody(String(r.payload.skillName),description,content));const body={kind:"skills",name:r.name,description,payload,audience:r.audience};db.prepare("UPDATE central_skill_versions SET body=?,change_note=?,revision=revision+1,updated_at=? WHERE resource_id=? AND label=? AND revision=?").run(JSON.stringify(body),String(data.changeNote??row.change_note),new Date().toISOString(),r.id,row.label,row.revision);store.audit(c.var.user.userId,"skill_version_edit",r.id);return c.json({ok:true});});
  app.post("/admin/:id/version-management/:label/publish",async c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label")),data=await c.req.json() as Record<string,unknown>;if(row.state!=="draft"||data.revision!==row.revision)throw new HttpError(409,"revision_conflict","草稿已变化，请刷新。");const body=JSON.parse(row.body!) as {name:string;description:string;payload:Record<string,unknown>;audience:string[]};const content=contentOf(versionResource(r.id,row)),front=parseSkillFrontmatter(content);if(!front||front.name!==r.payload.skillName||!front.description) return bad("SKILL.md 的元信息无效。");db.exec("SAVEPOINT skill_version_publish");try{const saved=store.save(c.var.user.userId,{kind:"skills",name:r.name,description:body.description,payload:body.payload,audience:r.audience,revision:r.revision},r.id);const published=store.publish(c.var.user.userId,r.id,saved.revision);db.prepare("UPDATE central_skill_versions SET state='published',body=NULL,resource_version=?,updated_at=? WHERE resource_id=? AND label=?").run(published.version,new Date().toISOString(),r.id,row.label);db.exec("RELEASE skill_version_publish");}catch(error){db.exec("ROLLBACK TO skill_version_publish; RELEASE skill_version_publish");throw error;}return c.json({ok:true});});
  app.post("/admin/:id/version-management/:label/rollback",c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label"));if(row.state!=="published"||!row.resource_version||row.resource_version===r.version)throw new HttpError(409,"invalid_rollback","该版本不能回滚。");const now=new Date().toISOString(),source=store.getVersion(r.id,row.resource_version);db.prepare("UPDATE public_resources SET version=?,draft=?,published=1,revision=revision+1,updated_at=? WHERE id=?").run(row.resource_version,JSON.stringify({kind:"skills",name:source.name,description:source.description,payload:source.payload}),now,r.id);store.audit(c.var.user.userId,"skill_version_rollback",r.id);return c.json({ok:true});});
  app.delete("/admin/:id/version-management/:label",c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label"));if(row.state!=="draft")throw new HttpError(409,"published_immutable","仅可删除草稿版本。");db.prepare("UPDATE central_skill_versions SET state='deleted',updated_at=? WHERE resource_id=? AND label=?").run(new Date().toISOString(),r.id,row.label);store.audit(c.var.user.userId,"skill_version_delete",r.id);return c.json({ok:true});});
  app.get("/admin/:id/version-management/:label/export",c=>{admin(c);const r=getSkill(c.req.param("id")),row=versionRow(r.id,c.req.param("label")),resource=versionResource(r.id,row),name=String(r.payload.skillName);const data=typeof resource.payload.archiveBase64==="string"?resource.payload.archiveBase64:Buffer.from(zipSync({[name+"/SKILL.md"]:strToU8(contentOf(resource))})).toString("base64");return c.json({name,dataBase64:data});});
  app.get("/admin/:id/version-diff",c=>{admin(c);const r=getSkill(c.req.param("id")),a=versionRow(r.id,c.req.query("a")??""),b=versionRow(r.id,c.req.query("b")??""),left=packageFiles(versionResource(r.id,a)),right=packageFiles(versionResource(r.id,b));return c.json({files:[...new Set([...Object.keys(left),...Object.keys(right)])].sort().flatMap(path=>{const old=left[path],next=right[path];if(old?.hash===next?.hash)return [];return [{path,change:!old?"added":!next?"removed":"modified",oldText:old?.text??null,newText:next?.text??null,oldHash:old?.hash??null,newHash:next?.hash??null}];})});});
  app.post("/admin/:id/restore",async c=>{
    admin(c);const r=getSkill(c.req.param("id")),data=await c.req.json();const source=store.getVersion(r.id,Number(data.version));
    const saved=store.save(c.var.user.userId,{kind:"skills",name:source.name,description:source.description,payload:source.payload,audience:r.audience,revision:data.revision},r.id);
    return c.json(serialize(saved,categoryMap()));
  });
  app.delete("/admin/:id",async c=>{
    admin(c);const old=getSkill(c.req.param("id"));
    if(store.list(true).some(r=>r.id!==old.id&&resourceDependencies(r).some(dependency=>dependency.id===old.id)))throw new HttpError(409,"skill_in_use","此技能仍被中央配置引用。");
    db.prepare("INSERT OR IGNORE INTO central_skill_deleted VALUES (?,?,?)").run(old.id,new Date().toISOString(),c.var.user.userId);
    if(old.version)store.withdraw(c.var.user.userId,old.id);
    store.audit(c.var.user.userId,"skill_delete",old.id);
    return c.json({ok:true});
  });
  app.get("/admin/:id/export",c=>{admin(c);const r=getSkill(c.req.param("id")),name=String(r.payload.skillName);const data=typeof r.payload.archiveBase64==="string"?r.payload.archiveBase64:Buffer.from(zipSync({[name+"/SKILL.md"]:strToU8(contentOf(r))})).toString("base64");return c.json({name,dataBase64:data});});
  app.get("/categories",c=>{admin(c);return c.json({categories:categories(),assignments:assignments()});});
  app.post("/categories",async c=>{admin(c);const {name}=await c.req.json() as {name:unknown};if(typeof name!=="string"||!name.trim()||name.trim().length>40)return bad("分类名称无效。");const id="cat_"+randomUUID().replaceAll("-","").slice(0,12);try{db.prepare("INSERT INTO central_skill_categories VALUES (?,?,?,?,?)").run(id,name.trim(),0,0,new Date().toISOString());}catch{throw new HttpError(409,"category_exists","分类名称已存在。");}return c.json({id,name:name.trim()},201);});
  app.put("/categories/assign",async c=>{admin(c);const {skillName:raw,categoryId}=await c.req.json() as {skillName:unknown;categoryId:unknown};const name=skillName(raw);if(typeof categoryId!=="string"||!db.prepare("SELECT 1 FROM central_skill_categories WHERE id=? AND deleted=0").get(categoryId))return bad("分类无效。");db.prepare("INSERT INTO central_skill_assignments VALUES (?,?) ON CONFLICT(skill_name) DO UPDATE SET category_id=excluded.category_id").run(name,categoryId);return c.json({ok:true});});
  app.delete("/categories/assignment/:name",c=>{admin(c);db.prepare("DELETE FROM central_skill_assignments WHERE skill_name=?").run(skillName(c.req.param("name")));return c.json({ok:true});});
  app.put("/categories/:id",async c=>{admin(c);const {name}=await c.req.json() as {name:unknown};if(typeof name!=="string"||!name.trim()||name.trim().length>40)return bad("分类名称无效。");try{const result=db.prepare("UPDATE central_skill_categories SET name=? WHERE id=? AND deleted=0").run(name.trim(),c.req.param("id"));if(!result.changes)throw new HttpError(404,"category_missing","分类不存在。");}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(409,"category_exists","分类名称已存在。");}return c.json({ok:true});});
  app.delete("/categories/:id",c=>{admin(c);const id=c.req.param("id"),row=db.prepare("SELECT builtin FROM central_skill_categories WHERE id=? AND deleted=0").get(id) as {builtin:number}|undefined;if(!row)throw new HttpError(404,"category_missing","分类不存在。");if(row.builtin)throw new HttpError(409,"builtin_category","内置分类不可删除。");if(db.prepare("SELECT 1 FROM central_skill_assignments WHERE category_id=?").get(id))throw new HttpError(409,"category_not_empty","请先移走此分类下的技能。");db.prepare("UPDATE central_skill_categories SET deleted=1 WHERE id=?").run(id);return c.json({ok:true});});
  return app;
}
