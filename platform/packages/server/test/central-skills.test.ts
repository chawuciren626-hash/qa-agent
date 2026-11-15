import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ControlStore, controlRoutes } from "../src/http/control-plane.js";
import type { AppEnv } from "../src/auth/middleware.js";
import { HttpError } from "../src/http/errors.js";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";

let db:DatabaseSync,store:ControlStore,app:Hono<AppEnv>;
beforeEach(()=>{
  db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(user_id TEXT PRIMARY KEY,is_admin INTEGER NOT NULL DEFAULT 0); INSERT INTO users VALUES ('admin',1),('alice',0);");
  store=new ControlStore(db);
  app=new Hono<AppEnv>();
  app.onError((error)=>new Response(JSON.stringify({error:error.message}),{status:error instanceof HttpError?error.status:500,headers:{"content-type":"application/json"}}));
  app.use("*",async(c,next)=>{c.set("user",{userId:c.req.header("x-user")??"admin",isAdmin:c.req.header("x-user")!=="alice"} as AppEnv["Variables"]["user"]);await next();});
  app.route("/api/control",controlRoutes(store));
});
const send=(path:string,method="GET",body?:unknown,user="admin")=>app.request("/api/control/skills"+path,{method,headers:{"content-type":"application/json","x-user":user},...(body===undefined?{}:{body:JSON.stringify({publish:true,...body as object})})});
afterEach(()=>{db.close();});

it("classifies existing central skills by stage and preserves explicit assignments, including common",async()=>{
  store.setModules("admin","alice",["skills"]);
  const expected:Record<string,string>={"requirement-analysis":"req","api-contract-analysis":"req","test-point-design":"design","test-design-methods":"design","test-case-writing":"case","playwright-execution":"web","browser-automation":"web","api-test-execution":"api","api-testing":"api","android-execution":"app","miniprogram-execution":"mini","bug-reporting":"defect","qa-investigation":"defect","test-report-writing":"report","test-asset-management":"common"};
  for(const name of Object.keys(expected))expect((await send("/admin","POST",{name,description:"说明",content:"# 正文"})).status).toBe(201);
  const read=async(route:string,user="admin")=>((await (await send(route,"GET",undefined,user)).json()) as {skills:{name:string;categoryId:string}[]}).skills;
  for(const skill of await read("/admin"))expect(skill.categoryId,skill.name).toBe(expected[skill.name]);
  for(const skill of await read("/catalog","alice"))expect(skill.categoryId,skill.name).toBe(expected[skill.name]);
  expect((await send("/categories/assign","PUT",{skillName:"bug-reporting",categoryId:"common"})).status).toBe(200);
  expect((await read("/catalog","alice")).find(skill=>skill.name==="bug-reporting")?.categoryId).toBe("common");
  expect((await send("/categories/assignment/bug-reporting","DELETE")).status).toBe(200);
  expect((await read("/admin")).find(skill=>skill.name==="bug-reporting")?.categoryId).toBe("defect");
});

it("saves a central skill and makes the newest content visible to an authorized user immediately",async()=>{
  store.setModules("admin","alice",["skills"]);
  const created=await send("/admin","POST",{name:"test-skill",description:"初版",content:"# 初版"});
  expect(created.status).toBe(201);
  const first=await created.json() as {id:string;revision:number};
  let catalog=await (await send("/catalog","GET",undefined,"alice")).json() as {skills:{content:string}[]};
  expect(catalog.skills[0]?.content).toContain("# 初版");
  const updated=await send("/admin/"+first.id,"PUT",{description:"新版",content:"# 新版",revision:first.revision});
  expect(updated.status).toBe(200);
  catalog=await (await send("/catalog","GET",undefined,"alice")).json() as typeof catalog;
  expect(catalog.skills[0]?.content).toContain("# 新版");
  expect(catalog.skills[0]?.content).not.toContain("# 初版");
  const category=await (await send("/categories","POST",{name:"性能"})).json() as {id:string};
  expect((await send("/categories/assign","PUT",{skillName:"test-skill",categoryId:category.id})).status).toBe(200);
  catalog=await (await send("/catalog","GET",undefined,"alice")).json() as typeof catalog;
  expect((catalog.skills[0] as any).categoryId).toBe(category.id);
  expect((await send("/admin/"+first.id,"DELETE")).status).toBe(200);
  catalog=await (await send("/catalog","GET",undefined,"alice")).json() as typeof catalog;
  expect(catalog.skills).toEqual([]);
  expect((await (await send("/admin")).json() as {skills:unknown[]}).skills).toEqual([]);
});

it("rejects member edits and hides skills from users without access",async()=>{
  store.setModules("admin","alice",[]);
  const member=await send("/admin","POST",{name:"other-skill",description:"说明",content:"# 内容"},"alice");
  expect(member.status).toBe(403);
  const created=await send("/admin","POST",{name:"other-skill",description:"说明",content:"# 内容"});
  expect(created.status).toBe(201);
  const catalog=await (await send("/catalog","GET",undefined,"alice")).json() as {skills:unknown[]};
  expect(catalog.skills).toEqual([]);
});

it("keeps imported support files when the administrator edits SKILL.md",async()=>{
  const original=zipSync({
    "archive-skill/SKILL.md":strToU8('---\nname: archive-skill\ndescription: 原说明\n---\n\n# 原正文'),
    "archive-skill/references/notes.md":strToU8("参考资料"),
  });
  const created=await send("/admin","POST",{archiveBase64:Buffer.from(original).toString("base64")});
  expect(created.status).toBe(201);
  const entry=await created.json() as {id:string;revision:number;files:Record<string,string>};
  expect(entry.files["references/notes.md"]).toBe("参考资料");
  const edited=await send("/admin/"+entry.id,"PUT",{description:"新说明",content:"# 新正文",revision:entry.revision});
  expect(edited.status).toBe(200);
  const archive=await (await send("/admin/"+entry.id+"/export")).json() as {dataBase64:string};
  const files=unzipSync(Buffer.from(archive.dataBase64,"base64"));
  expect(strFromU8(files["references/notes.md"]!)).toBe("参考资料");
  expect(strFromU8(files["SKILL.md"]!)).toContain("# 新正文");
});

 it("keeps skill drafts private until publication and reads immutable history",async()=>{
  store.setModules("admin","alice",["skills"]);
  const first=await (await send("/admin","POST",{name:"versioned-skill",description:"one",content:"# One"})).json() as any;
  const draft=await (await send(`/admin/${first.id}`,"PUT",{revision:first.revision,description:"two",content:"# Two",publish:false})).json() as any;
  expect(draft.hasDraft).toBe(true);
  const catalog=await (await send("/catalog","GET",undefined,"alice")).json() as any;
  expect(catalog.skills[0].content).toContain("# One");
  expect((await send(`/admin/${first.id}/publish`,"POST",{revision:first.revision})).status).toBe(409);
  const published=await (await send(`/admin/${first.id}/publish`,"POST",{revision:draft.revision})).json() as any;
  expect(published.version).toBe(2);expect(published.hasDraft).toBe(false);
  const old=await (await send(`/admin/${first.id}/versions/1`)).json() as any;
  expect(old.content).toContain("# One");
  const restored=await (await send(`/admin/${first.id}/restore`,"POST",{revision:published.revision,version:1})).json() as any;
  expect(restored.hasDraft).toBe(true);
  expect(store.get(first.id).payload.content).toContain("# Two");
  expect((await send(`/admin/${first.id}/history`,"GET",undefined,"alice")).status).toBe(403);
 });

it("manages named versions, switches the current pointer, and soft deletes drafts and skills",async()=>{
  store.setModules("admin","alice",["skills"]);
  const created=await (await send("/admin","POST",{name:"managed-skill",description:"first",content:"# First"})).json() as any;
  const route=`/admin/${created.id}/version-management`;
  let management=await (await send(route)).json() as any;
  expect(management.currentLabel).toBe("V1.0.0");
  expect((await send(route,"POST",{label:"V1.1.0",changeNote:"Second",copyCurrent:true})).status).toBe(201);
  expect((await send(route,"POST",{label:"V1.1.0"})).status).toBe(409);
  let draft=await (await send(route+"/V1.1.0")).json() as any;
  expect(draft.content).toContain("# First");
  expect((await send(route+"/V1.1.0","PUT",{revision:draft.revision,description:"second",content:"# Second",changeNote:"changed"})).status).toBe(200);
  draft=await (await send(route+"/V1.1.0")).json() as any;
  expect((await send(route+"/V1.1.0/publish","POST",{revision:draft.revision})).status).toBe(200);
  management=await (await send(route)).json() as any;
  expect(management.currentLabel).toBe("V1.1.0");
  expect((await send(route+"/V1.1.0","PUT",{revision:draft.revision,description:"x",content:"x"})).status).toBe(409);
  expect((await send(route+"/V1.0.0/rollback","POST")).status).toBe(200);
  management=await (await send(route)).json() as any;
  expect(management.currentLabel).toBe("V1.0.0");
  const catalog=await (await send("/catalog","GET",undefined,"alice")).json() as any;
  expect(catalog.skills[0].content).toContain("# First");
  expect((await send(route,"POST",{label:"V1.2.0",copyCurrent:true})).status).toBe(201);
  expect((await send(route+"/V1.2.0","DELETE")).status).toBe(200);
  expect(db.prepare("SELECT state FROM central_skill_versions WHERE resource_id=? AND label='V1.2.0'").get(created.id)?.state).toBe("deleted");
  expect((await send(`/admin/${created.id}`,"DELETE")).status).toBe(200);
  expect(db.prepare("SELECT id FROM public_resources WHERE id=?").get(created.id)?.id).toBe(created.id);
  expect((await (await send("/admin")).json() as any).skills).toEqual([]);
});
