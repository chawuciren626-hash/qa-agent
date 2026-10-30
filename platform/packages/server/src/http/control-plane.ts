/** Public configuration only: this store never reads a project, credential store or workspace. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { AppEnv } from "../auth/middleware.js";
import { parseSkillArchive } from "./routes/skills.js";
import { AdminSystemStore } from "./admin-system-store.js";

export const CONTROL_BODY_LIMIT = 2 * 1024 * 1024;

export const MODULES = ["chat", "projects", "library", "schedules", "agents", "models", "plugins", "skills", "machines", "usage", "benchmark"] as const;
export const KINDS = ["agents", "models", "plugins", "skills"] as const;
export type ResourceKind = typeof KINDS[number];
export interface PublicResource { id:string; kind:ResourceKind; name:string; description:string; payload:Record<string,unknown>; audience:string[]; revision:number; version:number; published:boolean; updatedAt:string }
const fail=(message:string):never=>{throw new HttpError(400,"invalid_public_configuration",message);};
const object=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:fail("配置必须是对象。");
function fields(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))fail("配置含未允许的字段；请勿上传密钥、环境变量或业务数据。");}
function str(v:unknown,max=2000,empty=false):string {if(typeof v!=="string"||v.length>max||(!empty&&!v.trim()))fail("文本为空或超过长度限制。");return v as string;}
function strings(v:unknown,max=100):string[]{if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=="string"))fail("列表格式错误。");return [...new Set(v as string[])];}
function identifier(v:unknown):string {const s=str(v,100);if(!/^[a-z][a-z0-9_-]*$/.test(s))fail("标识只能包含小写字母、数字、下划线或短横线。");return s;}
function safeUrl(v:unknown):string {const s=str(v,1000);let u:URL;try{u=new URL(s);}catch{return fail("地址格式错误。");}if(u.username||u.password||u.search||u.hash||!["https:","http:"].includes(u.protocol))fail("公共地址不能包含凭据、查询参数或片段。");return s;}
export function publicPayload(kind:ResourceKind,value:unknown):Record<string,unknown>{
  const p=object(value);
  if(kind==="agents"){
    fields(p,["prompt","agentsMd","maxTurns","modelResource","skillResources","pluginResources"]);
    if(p.maxTurns!==undefined&&(!Number.isSafeInteger(p.maxTurns)||Number(p.maxTurns)<1||Number(p.maxTurns)>100000))fail("智能体轮数无效。");
    return {prompt:str(p.prompt,100000,true),...(p.agentsMd===undefined?{}:{agentsMd:str(p.agentsMd,100000,true)}),...(p.maxTurns===undefined?{}:{maxTurns:p.maxTurns}),modelResource:p.modelResource?str(p.modelResource,100):"",skillResources:strings(p.skillResources??[]),pluginResources:strings(p.pluginResources??[])};
  }
  if(kind==="models"){
    fields(p,["provider","modelId","baseUrl","clientType","contextWindow","maxTokens","vision","fastMode","pricing","discount"]);
    const out:Record<string,unknown>={provider:identifier(p.provider),modelId:str(p.modelId,200),...(p.baseUrl?{baseUrl:safeUrl(p.baseUrl)}:{}),...(p.clientType?{clientType:str(p.clientType,80)}:{}),vision:p.vision!==false};
    if(p.fastMode!==undefined){if(typeof p.fastMode!=="boolean")fail("模型 fastMode 必须为布尔值。");out.fastMode=p.fastMode;}
    if(p.pricing!==undefined){const pricing=object(p.pricing);fields(pricing,["input","output","cacheRead","cacheWrite"]);for(const value of Object.values(pricing))if(typeof value!=="number"||!Number.isFinite(value)||value<0)fail("模型价格无效。");out.pricing=pricing;}
    if(p.discount!==undefined){if(p.discount!==null&&(typeof p.discount!=="number"||p.discount<=0||p.discount>=1))fail("模型折扣无效。");out.discount=p.discount;}
    for(const k of ["contextWindow","maxTokens"])if(p[k]!==undefined){if(!Number.isSafeInteger(p[k])||Number(p[k])<1||Number(p[k])>10000000)fail("模型 token 参数无效。");out[k]=p[k];}return out;
  }
  if(kind==="plugins"){
    if(p.source==="upstream-library"){
      fields(p,["pluginName","pluginVersion","source"]);
      return {pluginName:identifier(p.pluginName),pluginVersion:str(p.pluginVersion,100),source:"upstream-library"};
    }
    fields(p,["pluginName","skillResources","instructions"]);
    if(!String(p.instructions??"").trim()&&(!Array.isArray(p.skillResources)||!p.skillResources.length))fail("插件至少需要公共使用说明或关联技能。");
    return {pluginName:identifier(p.pluginName),skillResources:strings(p.skillResources??[]),instructions:str(p.instructions??"",10000,true)};
  }
  if(p.archiveBase64!==undefined){
    fields(p,["skillName","archiveBase64","fileNames"]);
    const encoded=str(p.archiveBase64,1400000);
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail("技能包编码无效。");
    const archive=Buffer.from(encoded,"base64");if(archive.length>1024*1024)fail("公共技能包不能超过 1 MB。");
    const parsed=parseSkillArchive(archive);
    if(parsed.name!==p.skillName)fail("技能名称与原有导出包不一致。");
    return {skillName:parsed.name,archiveBase64:encoded,fileNames:[...parsed.files.keys()]};
  }
  fields(p,["skillName","content"]);
  return {skillName:identifier(p.skillName),content:str(p.content,60000)};
}
export function resourceDependencies(r:Pick<PublicResource,"kind"|"payload">):{id:string;kind:ResourceKind}[]{
  const p=r.payload;return [...(p.modelResource?[{id:String(p.modelResource),kind:"models" as const}]:[]),...(Array.isArray(p.skillResources)?p.skillResources.map(id=>({id:String(id),kind:"skills" as const})):[]),...(Array.isArray(p.pluginResources)?p.pluginResources.map(id=>({id:String(id),kind:"plugins" as const})):[])];
}
export class ControlStore {
  readonly system: AdminSystemStore;
  constructor(readonly db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS public_resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,draft TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,audience TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_resource_versions(resource_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(resource_id,version));
    CREATE TABLE IF NOT EXISTS public_module_grants(user_id TEXT PRIMARY KEY,modules TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_admin_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,resource_id TEXT NOT NULL,created_at TEXT NOT NULL);
  `);this.system=new AdminSystemStore(db,(actor,action,id)=>this.audit(actor,action,id),MODULES);}
  modules(userId:string,admin:boolean):string[]{if(admin)return [...MODULES];const row=this.db.prepare("SELECT modules FROM public_module_grants WHERE user_id=?").get(userId);const grants:string[]=this.system.roleModules(userId)??(row?JSON.parse(String(row.modules)):["chat","projects","library","schedules","plugins","skills"]);return [...new Set([...grants,"models"])];}
  setModules(actor:string,userId:string,v:unknown){const modules=strings(v);if(modules.some(m=>!(MODULES as readonly string[]).includes(m)))fail("未知模块。");if(!this.db.prepare("SELECT user_id FROM users WHERE user_id=?").get(userId))throw new HttpError(404,"not_found","用户不存在。");if(userId==="admin")fail("管理员保留全部权限。");const effective=[...new Set([...modules,"models"])];this.db.exec("BEGIN IMMEDIATE");try{this.db.prepare("INSERT INTO public_module_grants VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET modules=excluded.modules").run(userId,JSON.stringify(effective));this.db.prepare("DELETE FROM public_role_members WHERE user_id=?").run(userId);this.audit(actor,"permissions",userId);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}return effective;}
  audit(actor:string,action:string,id:string){this.db.prepare("INSERT INTO public_admin_audit(actor,action,resource_id,created_at) VALUES (?,?,?,?)").run(actor,action,id,new Date().toISOString());}
  row(id:string){const row=this.db.prepare("SELECT * FROM public_resources WHERE id=?").get(id);if(!row)throw new HttpError(404,"not_found","资源不存在。");return row;}
  get(id:string,draft=false):PublicResource {const row=this.row(id);const version=Number(row.version);const body=draft?JSON.parse(String(row.draft)):JSON.parse(String(this.db.prepare("SELECT body FROM public_resource_versions WHERE resource_id=? AND version=?").get(id,version)?.body??"null"));if(!body)throw new HttpError(404,"not_published","资源尚未发布。");return {...body,id,kind:row.kind,revision:Number(row.revision),version,published:!!row.published,audience:body.audience??JSON.parse(String(row.audience)),updatedAt:String(row.updated_at)};}
  list(draft=false):PublicResource[]{return this.db.prepare("SELECT id FROM public_resources ORDER BY updated_at DESC,id").all().flatMap(row=>{try{return [this.get(String(row.id),draft)];}catch{return [];}});}
  save(actor:string,raw:unknown,id?:string):PublicResource{
    const b=object(raw);fields(b,["kind","name","description","payload","audience","revision"]);
    if(!(KINDS as readonly unknown[]).includes(b.kind))fail("未知资源类型。");const kind=b.kind as ResourceKind;
    const audience=strings(b.audience??[]);if(audience.some(u=>u!=="*"&&!/^[a-z][a-z0-9_]{1,31}$/.test(u)))fail("授权账号无效。");
    for(const u of audience)if(u!=="*"&&!this.db.prepare("SELECT user_id FROM users WHERE user_id=?").get(u))fail("授权账号不存在。");
    const body={kind,name:str(b.name,100),description:str(b.description??"",2000,true),payload:publicPayload(kind,b.payload)};
    const now=new Date().toISOString();
    if(id){const old=this.row(id);if(old.kind!==kind)fail("不能改变资源类型。");if(old.revision!==b.revision)throw new HttpError(409,"revision_conflict","资源已变化，请刷新后再编辑。");this.db.prepare("UPDATE public_resources SET draft=?,revision=revision+1,audience=?,updated_at=? WHERE id=?").run(JSON.stringify(body),JSON.stringify(audience),now,id);}
    else{id=randomUUID();this.db.prepare("INSERT INTO public_resources(id,kind,draft,revision,audience,updated_at) VALUES (?,?,?,1,?,?)").run(id,kind,JSON.stringify(body),JSON.stringify(audience),now);}
    this.audit(actor,"save",id);return this.get(id,true);
  }
  accessible(id:string,userId:string,admin:boolean,visited=new Set<string>()):boolean{
    if(visited.has(id))return false;visited.add(id);
    try{const r=this.get(id);return r.published&&(admin||(this.modules(userId,false).includes(r.kind)&&(r.audience.includes("*")||r.audience.includes(userId))))&&resourceDependencies(r).every(d=>this.get(d.id).kind===d.kind&&this.accessible(d.id,userId,admin,new Set(visited)));}catch{return false;}
  }
  publish(actor:string,id:string,revision:unknown){const r=this.get(id,true);if(r.revision!==revision)throw new HttpError(409,"revision_conflict","请刷新资源后再发布。");
    for(const d of resourceDependencies(r)){const dep=this.get(d.id);if(dep.kind!==d.kind||!this.accessible(d.id,actor,true))fail("依赖资源必须先发布且类型正确。");if(r.audience.includes("*")&&!dep.audience.includes("*"))fail("面向全部用户的模板不能依赖受限资源。");for(const u of r.audience)if(u!=="*"&&!this.accessible(d.id,u,false))fail("部分授权用户无权使用依赖资源。");}
    const next=r.version+1, now=new Date().toISOString();this.db.exec("BEGIN IMMEDIATE");try{this.db.prepare("INSERT INTO public_resource_versions VALUES (?,?,?,?)").run(id,next,JSON.stringify({kind:r.kind,name:r.name,description:r.description,payload:r.payload,audience:r.audience}),now);this.db.prepare("UPDATE public_resources SET version=?,published=1,revision=revision+1,updated_at=? WHERE id=?").run(next,now,id);this.audit(actor,"publish",id);this.db.exec("COMMIT");}catch(e){this.db.exec("ROLLBACK");throw e;}return this.get(id,true);}
  withdraw(actor:string,id:string){this.row(id);this.db.prepare("UPDATE public_resources SET published=0,revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(),id);this.audit(actor,"withdraw",id);}
  deleteDraft(actor:string,id:string,revision:unknown){
    const row=this.row(id);
    if(row.revision!==revision)throw new HttpError(409,"revision_conflict","资源已变化，请刷新后再删除。");
    if(Number(row.version)>0)fail("已发布过的资源须保留版本记录；请下架，不要删除。");
    for(const other of this.list(true))if(other.id!==id&&resourceDependencies(other).some(dependency=>dependency.id===id))fail("此资源仍被其他公共配置引用，请先解除关联。");
    this.db.prepare("DELETE FROM public_resources WHERE id=?").run(id);
    this.audit(actor,"delete_draft",id);
  }
  bundle(id:string,userId:string,admin:boolean):PublicResource[]{if(!this.accessible(id,userId,admin))throw new HttpError(403,"resource_forbidden","资源已下架或没有使用权限。");const out=new Map<string,PublicResource>();const walk=(key:string)=>{if(out.has(key))return;const r=this.get(key);out.set(key,r);for(const d of resourceDependencies(r))walk(d.id);};walk(id);return [...out.values()];}
}
export function controlRoutes(store:ControlStore):Hono<AppEnv>{
  const app=new Hono<AppEnv>();app.use("*",bodyLimit({maxSize:CONTROL_BODY_LIMIT}));
  app.use("/admin/*",async(c,next)=>{if(!c.var.user.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以访问管理后台。");await next();});
  app.get("/access",c=>{const u=c.var.user;return c.json({modules:store.modules(u.userId,u.isAdmin),menuKeys:u.isAdmin?store.system.menuItems().map(item=>item.key):store.system.ordinaryMenus(),resourceIds:store.list().filter(r=>store.accessible(r.id,u.userId,u.isAdmin)).map(r=>r.id)});});
  app.get("/catalog",c=>{const u=c.var.user;return c.json({resources:store.list().filter(r=>store.accessible(r.id,u.userId,u.isAdmin))});});
  app.get("/catalog/:id",c=>c.json({resources:store.bundle(c.req.param("id"),c.var.user.userId,c.var.user.isAdmin)}));
  app.get("/admin/resources",c=>c.json({resources:store.list(true)}));
  app.post("/admin/resources",async c=>c.json(store.save(c.var.user.userId,await c.req.json()),201));
  app.put("/admin/resources/:id",async c=>c.json(store.save(c.var.user.userId,await c.req.json(),c.req.param("id"))));
  app.delete("/admin/resources/:id",async c=>{store.deleteDraft(c.var.user.userId,c.req.param("id"),(await c.req.json()).revision);return c.json({ok:true});});
  app.post("/admin/resources/:id/publish",async c=>c.json(store.publish(c.var.user.userId,c.req.param("id"),(await c.req.json()).revision)));
  app.post("/admin/resources/:id/withdraw",c=>{store.withdraw(c.var.user.userId,c.req.param("id"));return c.json({ok:true});});
  app.get("/admin/resources/:id/history",c=>{store.row(c.req.param("id"));return c.json({versions:store.db.prepare("SELECT version,body,created_at FROM public_resource_versions WHERE resource_id=? ORDER BY version DESC").all(c.req.param("id")).map(r=>({...r,body:JSON.parse(String(r.body))}))});});
  app.get("/admin/permissions/:id",c=>c.json({modules:store.modules(c.req.param("id"),c.req.param("id")==="admin")}));
  app.put("/admin/permissions/:id",async c=>c.json({modules:store.setModules(c.var.user.userId,c.req.param("id"),(await c.req.json()).modules)}));
  app.get("/admin/roles",c=>c.json(store.system.roleSummary()));
  app.put("/admin/roles/:id/users",async c=>c.json(store.system.assignUsers(c.var.user.userId,c.req.param("id"),(await c.req.json()).userIds)));
  app.put("/admin/roles/ordinary/menus",async c=>c.json({menus:store.system.setOrdinaryMenus(c.var.user.userId,(await c.req.json()).menuKeys)}));
  app.get("/admin/menus",c=>c.json({items:store.system.menuItems()}));
  app.put("/admin/menus",async c=>c.json({items:store.system.setMenus(c.var.user.userId,(await c.req.json()).items)}));
  app.get("/admin/audit",c=>{
    const page=Math.max(1,Math.min(100000,Number(c.req.query("page"))||1));
    const type=c.req.query("type")??"",keyword=(c.req.query("keyword")??"").trim().slice(0,100);
    const actions:Record<string,string[]>={publish:["publish"],withdraw:["withdraw"],draft:["save","delete_draft"],permissions:["permissions","role_assign","role_menus","role_create","role_update","role_delete","menus"],login:["login"]};
    const selected=actions[type]??[];
    const clauses=["1=1"],args:(string|number)[]=[];
    if(type&&selected.length){clauses.push(`a.action IN (${selected.map(()=>"?").join(",")})`);args.push(...selected);}
    if(keyword){clauses.push("(a.actor LIKE ? OR a.resource_id LIKE ? OR json_extract(r.draft,'$.name') LIKE ?)");args.push(...Array(3).fill(`%${keyword}%`));}
    const from=" FROM public_admin_audit a LEFT JOIN public_resources r ON r.id=a.resource_id WHERE "+clauses.join(" AND ");
    const total=Number(store.db.prepare("SELECT COUNT(*) AS total"+from).get(...args)?.total??0);
    const events=store.db.prepare("SELECT a.*,r.kind AS resource_kind,json_extract(r.draft,'$.name') AS resource_name"+from+" ORDER BY a.id DESC LIMIT 10 OFFSET ?").all(...args,(page-1)*10);
    return c.json({events,total,page,pageSize:10});
  });
  return app;
}
