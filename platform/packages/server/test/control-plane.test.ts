import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ControlStore, controlRoutes, publicPayload } from "../src/http/control-plane.js";
import type { AppEnv } from "../src/auth/middleware.js";
import { HttpError } from "../src/http/errors.js";
import { zipSync, strToU8 } from "fflate";
let db:DatabaseSync,store:ControlStore;
beforeEach(()=>{db=new DatabaseSync(":memory:");db.exec("CREATE TABLE users(user_id TEXT PRIMARY KEY); INSERT INTO users VALUES ('admin'),('alice'),('bob');");store=new ControlStore(db);});
afterEach(()=>db.close());
const skill=(audience=["alice"])=>store.save("admin",{kind:"skills",name:"测试技能",description:"公共说明",payload:{skillName:"test-skill",content:"# 公共测试方法"},audience});
describe("public control plane",()=>{
  it("accepts upstream plugin references and preserves the original skill archive and companion files",()=>{
    expect(publicPayload("plugins",{pluginName:"qa-plugin",pluginVersion:"1.0.0",source:"upstream-library"})).toEqual({pluginName:"qa-plugin",pluginVersion:"1.0.0",source:"upstream-library"});
    const archive=Buffer.from(zipSync({"qa/SKILL.md":strToU8("---\nname: qa\ndescription: test\n---\nRead references/check.md"),"qa/references/check.md":strToU8("Public checklist")})).toString("base64");
    const result=publicPayload("skills",{skillName:"qa",archiveBase64:archive,fileNames:["untrusted-list"]});
    expect(result.archiveBase64).toBe(archive);
    expect(result.fileNames).toEqual(["SKILL.md","references/check.md"]);
    expect(()=>publicPayload("skills",{skillName:"other",archiveBase64:archive})).toThrow();
  });
  it("keeps unpublished drafts private and snapshots published content",()=>{let r=skill();expect(store.accessible(r.id,"alice",false)).toBe(false);r=store.publish("admin",r.id,r.revision);expect(store.accessible(r.id,"alice",false)).toBe(true);expect(store.accessible(r.id,"bob",false)).toBe(false);store.save("admin",{kind:r.kind,name:"新草稿",description:r.description,payload:r.payload,audience:r.audience,revision:r.revision},r.id);expect(store.get(r.id).name).toBe("测试技能");expect(store.get(r.id,true).name).toBe("新草稿");});
  it("rejects stale edits and keeps an immutable version history",()=>{let r=skill();r=store.publish("admin",r.id,r.revision);expect(()=>store.publish("admin",r.id,r.revision-1)).toThrow();r=store.publish("admin",r.id,r.revision);expect(r.version).toBe(2);expect(db.prepare("SELECT count(*) n FROM public_resource_versions").get()!.n).toBe(2);});
  it("enforces dependencies, audiences, module revocation and withdrawal",()=>{let s=skill();s=store.publish("admin",s.id,s.revision);let a=store.save("admin",{kind:"agents",name:"公共模板",payload:{prompt:"测试",skillResources:[s.id]},audience:["alice"]});a=store.publish("admin",a.id,a.revision);expect(store.accessible(a.id,"alice",false)).toBe(false);store.setModules("admin","alice",["agents","skills"]);expect(store.bundle(a.id,"alice",false)).toHaveLength(2);store.setModules("admin","alice",["agents"]);expect(store.accessible(a.id,"alice",false)).toBe(false);store.setModules("admin","alice",["agents","skills"]);store.withdraw("admin",s.id);expect(store.accessible(a.id,"alice",false)).toBe(false);expect(db.prepare("SELECT count(*) n FROM public_resources").get()!.n).toBe(2);});
  it("refuses publishing broad templates backed by restricted resources",()=>{let s=skill();s=store.publish("admin",s.id,s.revision);const a=store.save("admin",{kind:"agents",name:"模板",payload:{prompt:"测试",skillResources:[s.id]},audience:["*"]});expect(()=>store.publish("admin",a.id,a.revision)).toThrow();});
  it("accepts only explicit public fields and rejects credential-bearing URLs",()=>{const model={provider:"custom",modelId:"test",baseUrl:"https://example.com/v1",clientType:"openai-chat"};expect(()=>publicPayload("models",{...model,apiKey:"secret"})).toThrow();expect(()=>publicPayload("models",{...model,baseUrl:"https://user:secret@example.com"})).toThrow();expect(()=>publicPayload("models",{...model,baseUrl:"https://example.com?key=secret"})).toThrow();expect(()=>publicPayload("skills",{skillName:"../bad",content:"x"})).toThrow();expect(()=>publicPayload("plugins",{pluginName:"x",env:{SECRET:"value"}})).toThrow();});
  it("rejects ordinary users at management endpoints regardless of URL navigation",async()=>{const app=new Hono<AppEnv>();app.onError((e,c)=>c.json({error:e.message},(e instanceof HttpError?e.status:500) as 400));app.use("*",async(c,next)=>{c.set("user",{userId:"alice",isAdmin:false} as any);await next();});app.route("/api/control",controlRoutes(store));for(const endpoint of ["resources","permissions/alice","audit"]){expect((await app.request("/api/control/admin/"+endpoint)).status).toBe(403);}expect((await app.request("/api/control/catalog")).status).toBe(200);});
});
