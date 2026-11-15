import {afterEach,beforeEach,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {Hono} from "hono";
import {ControlStore,controlRoutes} from "../src/http/control-plane.js";
import {setGlobalPluginPolicy} from "../src/http/global-plugins.js";
import {validateResolvedBundle} from "../src/auth/published-bundle.js";
import type {AppEnv} from "../src/auth/middleware.js";
let db:DatabaseSync,store:ControlStore;
beforeEach(()=>{db=new DatabaseSync(":memory:");db.exec("CREATE TABLE users(user_id TEXT PRIMARY KEY,is_admin INTEGER NOT NULL DEFAULT 0); INSERT INTO users VALUES ('admin',1),('alice',0);");store=new ControlStore(db);});
afterEach(()=>db.close());
function plugin(version="1.0.0",audience=["*"]) {
  const p=store.save("admin",{kind:"plugins",name:"Office",payload:{source:"upstream-library",pluginName:"office",pluginVersion:version},audience});
  return store.publish("admin",p.id,p.revision);
}
function agent(id:string,plugins:string[]=[]){
  const a=store.save("admin",{kind:"agents",name:id,payload:{agentId:id,prompt:"p",agentsMd:"a",pluginResources:plugins},audience:["*"]});
  return store.publish("admin",a.id,a.revision);
}
it("inherits globals for existing and future Agents; sync hash changes and task replay stays immutable",()=>{
  const a=agent("test_agent"),p=plugin();const before=store.resolveBundle(a.id,"alice",false);
  setGlobalPluginPolicy(store,"admin","office",{resourceId:p.id,revision:0});
  const active=store.resolveBundle(a.id,"alice",false);
  expect(validateResolvedBundle(active)).toEqual(active);
  expect(active.bundleHash).not.toBe(before.bundleHash);
  expect(active.resources.map(r=>r.id)).toContain(p.id);
  const future=agent("future_agent");
  expect(store.resolveRoleCatalog("alice",false).bundles.find(b=>b.agentId==="future_agent")?.resources.map(r=>r.id)).toContain(p.id);
  setGlobalPluginPolicy(store,"admin","office",{resourceId:null,revision:1});
  expect(store.resolveBundle(a.id,"alice",false).bundleHash).toBe(before.bundleHash);
  expect(store.resolveBundle(future.id,"alice",false).resources.map(r=>r.id)).not.toContain(p.id);
  expect(store.replayBundle(a.id,active.versions).bundleHash).toBe(active.bundleHash);
});
it("preserves explicit assignment priority and removing global does not uninstall explicit packages",()=>{
  const local=plugin("1.0.0"),global=plugin("2.0.0"),a=agent("test_agent",[local.id]);
  setGlobalPluginPolicy(store,"admin","office",{resourceId:global.id,revision:0});
  expect(store.resolveBundle(a.id,"alice",false).resources.filter(r=>r.kind==="plugins").map(r=>r.id)).toEqual([local.id]);
  setGlobalPluginPolicy(store,"admin","office",{resourceId:null,revision:1});
  expect(store.resolveBundle(a.id,"alice",false).resources.map(r=>r.id)).toContain(local.id);
});
it("rejects stale writes and restricted plugins, skips revoked resources",()=>{
  const p=plugin(),limited=plugin("3.0.0",["admin"]),a=agent("test_agent");
  expect(()=>setGlobalPluginPolicy(store,"admin","office",{resourceId:limited.id,revision:0})).toThrow("全部用户");
  setGlobalPluginPolicy(store,"admin","office",{resourceId:p.id,revision:0});
  expect(()=>setGlobalPluginPolicy(store,"admin","office",{resourceId:null,revision:0})).toThrow("刷新");
  store.withdraw("admin",p.id);
  expect(store.resolveBundle(a.id,"alice",false).resources.map(r=>r.id)).not.toContain(p.id);
});
it("exposes policy reads and writes only to administrators",async()=>{
  const app=new Hono<AppEnv>();app.onError((error,c)=>c.json({message:error.message},(error as {status?:number}).status===403?403:500));
  app.use("*",async(c,next)=>{c.set("user",{userId:"alice",isAdmin:c.req.header("x-test-admin")==="yes"} as AppEnv["Variables"]["user"]);await next();});app.route("/control",controlRoutes(store));
  expect((await app.request("/control/admin/global-plugins")).status).toBe(403);
  expect((await app.request("/control/admin/global-plugins/office",{method:"PUT",body:JSON.stringify({resourceId:null,revision:0}),headers:{"Content-Type":"application/json"}})).status).toBe(403);
  expect((await app.request("/control/admin/global-plugins",{headers:{"x-test-admin":"yes"}})).status).toBe(200);
});
