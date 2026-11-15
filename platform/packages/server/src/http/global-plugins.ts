import type { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.js";
import type { ControlStore, PublicResource } from "./control-plane.js";

class GlobalPluginConflict extends Error {}
function policyTable(store: ControlStore) {
  store.db.exec("CREATE TABLE IF NOT EXISTS public_global_plugins(plugin_name TEXT PRIMARY KEY,resource_id TEXT,resource_version INTEGER,revision INTEGER NOT NULL)");
}
export function globalPluginPolicies(store: ControlStore) {
  policyTable(store);
  return store.db.prepare("SELECT plugin_name AS pluginName,resource_id AS resourceId,resource_version AS resourceVersion,revision FROM public_global_plugins ORDER BY plugin_name").all() as {pluginName:string;resourceId:string|null;resourceVersion:number|null;revision:number}[];
}
export function setGlobalPluginPolicy(store: ControlStore, actor: string, name: string, raw: unknown) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new GlobalPluginConflict("插件标识无效。");
  const body=raw as {resourceId?:unknown;revision?:unknown};
  if (!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).some(key=>!["resourceId","revision"].includes(key)) || !Number.isSafeInteger(body.revision)) throw new GlobalPluginConflict("安装范围配置无效，请刷新后重试。");
  policyTable(store);
  store.db.exec("SAVEPOINT global_plugin_change");
  try {
    const old=globalPluginPolicies(store).find(item=>item.pluginName===name);
    if ((old?.revision??0)!==body.revision) throw new GlobalPluginConflict("安装范围已被修改，请刷新后重试。");
    let plugin:PublicResource|null=null;
    if (body.resourceId!==null) {
      if(typeof body.resourceId!=="string")throw new GlobalPluginConflict("请选择已发布插件。");
      plugin=store.get(body.resourceId);
      if(!plugin.published||plugin.kind!=="plugins"||plugin.payload.source!=="upstream-library"||plugin.payload.pluginName!==name||!plugin.audience.includes("*"))throw new GlobalPluginConflict("全局安装要求面向全部用户的已发布 Agent 插件。");
    }
    store.db.prepare("INSERT INTO public_global_plugins VALUES (?,?,?,?) ON CONFLICT(plugin_name) DO UPDATE SET resource_id=excluded.resource_id,resource_version=excluded.resource_version,revision=excluded.revision").run(name,plugin?.id??null,plugin?.version??null,(old?.revision??0)+1);
    store.audit(actor,plugin?"global_plugin_install":"global_plugin_remove",name);
    store.db.exec("RELEASE global_plugin_change");
    return {policies:globalPluginPolicies(store)};
  } catch(error) {store.db.exec("ROLLBACK TO global_plugin_change; RELEASE global_plugin_change");throw error;}
}

/** Add immutable global versions to a new task only. Explicit Agent assignments take priority. */
export function withGlobalPlugins(store: ControlStore, resources: PublicResource[], userId: string, admin: boolean) {
  const result=[...resources];
  for(const policy of globalPluginPolicies(store)) {
    if(!policy.resourceId||!policy.resourceVersion)continue;
    if(result.some(item=>item.kind==="plugins"&&item.payload.pluginName===policy.pluginName))continue;
    if(!store.accessible(policy.resourceId,userId,admin,new Set(),true))continue;
    const plugin=store.getVersion(policy.resourceId,policy.resourceVersion);
    if(plugin.kind!=="plugins"||plugin.payload.source!=="upstream-library"||plugin.payload.pluginName!==policy.pluginName||!plugin.audience.includes("*"))throw new Error("全局插件版本记录不一致。");
    result.push(plugin);
  }
  if(result.length>100)throw new Error("全局插件与 Agent 依赖总数超过客户端限制。");
  return result;
}

export function registerGlobalPluginRoutes(app:Hono<AppEnv>,store:ControlStore,conflict:(message:string)=>Error) {
  app.get("/admin/global-plugins",c=>c.json({policies:globalPluginPolicies(store)}));
  app.put("/admin/global-plugins/:name",async c=>{
    try{return c.json(setGlobalPluginPolicy(store,c.var.user.userId,c.req.param("name"),await c.req.json()));}
    catch(error){if(error instanceof GlobalPluginConflict)throw conflict(error.message);throw error;}
  });
}
