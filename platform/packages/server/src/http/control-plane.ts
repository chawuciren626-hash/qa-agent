/** Public configuration only: this store never reads a project, credential store or workspace. */
import { CentralModelConfig, centralModelConfigRoutes } from "./central-model-config.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { strFromU8 } from "fflate";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultSystemConfig, parseSkillFrontmatter } from "@prismshadow/penguin-core";
import { parsePeriod, MIN_PERIOD_MS } from "../runtime/schedule-file.js";
import { APPROVAL_MODES } from "./routes/sessions.js";
import { HttpError } from "./errors.js";
import type { AppEnv } from "../auth/middleware.js";
import { parseSkillArchive } from "./routes/skills.js";
import { AdminSystemStore } from "./admin-system-store.js";
import { publishedResourceRef, resolvedBundleHash } from "../auth/published-bundle.js";
import { CentralAgentPrivateStore, type PrivateAgentKind } from "./central-agent-private-store.js";
import { agentComponents, agentComponentCounts } from "./central-agent-components.js";
import { centralSkillRoutes } from "./central-skills.js";
import { pluginLibraryRoutes } from "./routes/plugins.js";
import { withGlobalPlugins, registerGlobalPluginRoutes } from "./global-plugins.js";

export const CONTROL_BODY_LIMIT = 2 * 1024 * 1024;

export const MODULES = ["chat", "projects", "library", "schedules", "agents", "models", "plugins", "skills", "machines", "usage", "benchmark"] as const;
export const KINDS = ["agents", "models", "plugins", "skills"] as const;
export type ResourceKind = typeof KINDS[number];
export interface PublicResource { id:string; kind:ResourceKind; name:string; description:string; payload:Record<string,unknown>; audience:string[]; revision:number; version:number; published:boolean; updatedAt:string; hasWorkCopy?:boolean }
const fail=(message:string):never=>{throw new HttpError(400,"invalid_public_configuration",message);};
const object=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:fail("配置必须是对象。");
function fields(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))fail("配置含未允许的字段；请勿上传密钥、环境变量或业务数据。");}
function str(v:unknown,max=2000,empty=false):string {if(typeof v!=="string"||v.length>max||(!empty&&!v.trim()))fail("文本为空或超过长度限制。");return v as string;}
function strings(v:unknown,max=100):string[]{if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=="string"))fail("列表格式错误。");return [...new Set(v as string[])];}
function identifier(v:unknown):string {const s=str(v,100);if(!/^[a-z][a-z0-9_-]*$/.test(s))fail("标识只能包含小写字母、数字、下划线或短横线。");return s;}
function safeUrl(v:unknown):string {const s=str(v,1000);let u:URL;try{u=new URL(s);}catch{return fail("地址格式错误。");}if(u.username||u.password||u.search||u.hash||!["https:","http:"].includes(u.protocol))fail("公共地址不能包含凭据、查询参数或片段。");return s;}
function positiveInteger(v:unknown,label:string,max=10000000):number {if(!Number.isSafeInteger(v)||Number(v)<1||Number(v)>max)fail(`${label}无效。`);return Number(v);}
function positiveOrMinusOne(v:unknown,label:string,max=10000000):number {if(v===-1)return -1;return positiveInteger(v,label,max);}
function publicAgentModel(value:unknown):Record<string,unknown>{
  const p=object(value);fields(p,["maxTokens","timeoutMs","thinkingLevel"]);
  const out:Record<string,unknown>={};
  if(p.maxTokens!==undefined)out.maxTokens=positiveOrMinusOne(p.maxTokens,"最大 Token");
  if(p.timeoutMs!==undefined)out.timeoutMs=positiveOrMinusOne(p.timeoutMs,"超时",3600000);
  if(p.thinkingLevel!==undefined){if(typeof p.thinkingLevel!=="string"||!["none","low","medium","high","xhigh","max"].includes(p.thinkingLevel))fail("思考等级无效。");out.thinkingLevel=p.thinkingLevel;}
  return out;
}
function publicAgentCompaction(value:unknown):Record<string,unknown>{
  const p=object(value);fields(p,["maxContextLength","maxSessionTurns","mode","prompt"]);
  const out:Record<string,unknown>={};
  if(p.maxContextLength!==undefined)out.maxContextLength=positiveOrMinusOne(p.maxContextLength,"上下文压缩阈值");
  if(p.maxSessionTurns!==undefined)out.maxSessionTurns=positiveOrMinusOne(p.maxSessionTurns,"会话轮数阈值");
  if(p.mode!==undefined){if(p.mode!=="summarize"&&p.mode!=="discard")fail("上下文压缩模式无效。");out.mode=p.mode;}
  if(p.prompt!==undefined)out.prompt=str(p.prompt,100000,true);
  return out;
}
function publicAgentTools(value:unknown):Record<string,unknown>[] {
  if(!Array.isArray(value)||value.length>100)fail("工具列表无效。");
  const entries=value as unknown[];
  const names=new Set<string>();
  return entries.map(raw=>{
    const tool=object(raw);fields(tool,["name","description","parameters","permission","forModel","timeoutMs","maxOutputLength","call_description"]);
    const name=identifier(tool.name);
    if(names.has(name))fail("工具名称重复。");names.add(name);
    const out:Record<string,unknown>={name,description:str(tool.description,10000,true)};
    if(tool.parameters!==undefined){const parameters=object(tool.parameters);if(JSON.stringify(parameters).length>20000)fail("工具参数过长。");out.parameters=parameters;}
    if(tool.permission!==undefined){if(tool.permission!=="r"&&tool.permission!=="rw")fail("工具权限无效。");out.permission=tool.permission;}
    if(tool.forModel!==undefined){if(tool.forModel!=="vision"&&tool.forModel!=="text-only")fail("工具模型范围无效。");out.forModel=tool.forModel;}
    for(const key of ["timeoutMs","maxOutputLength"])if(tool[key]!==undefined){if(!Number.isSafeInteger(tool[key])||Number(tool[key])<0||Number(tool[key])>10000000)fail(`${key}无效。`);out[key]=tool[key];}
    if(tool.call_description!==undefined){if(typeof tool.call_description!=="boolean")fail("工具调用说明开关无效。");out.call_description=tool.call_description;}
    return out;
  });
}
/** Published intent only. The local Project supplies its own start time, model and credentials. */
function publicScheduleTemplates(value:unknown):Record<string,unknown>[] {
  if(!Array.isArray(value)||value.length>100)fail("定时任务模板列表无效。");
  const names=new Set<string>();
  return (value as unknown[]).map((raw:unknown)=>{
    const template=object(raw);fields(template,["name","prompt","period"]);
    const name=identifier(template.name);
    if(names.has(name))fail("定时任务模板名称重复。");names.add(name);
    const prompt=str(template.prompt,100000);
    const period=template.period===undefined?undefined:str(template.period,20);
    if(period!==undefined&&(parsePeriod(period)??0)<MIN_PERIOD_MS)fail("定时任务模板周期不能短于 5 分钟。");
    return {name,prompt,...(period===undefined?{}:{period})};
  });
}
/** API publication has safe defaults, never a key or an exposure switch. */
function publicAgentApiTemplate(value:unknown):Record<string,unknown> {
  const template=object(value);fields(template,["approvalMode","thinkingLevel","maxConcurrentRuns"]);
  const out:Record<string,unknown>={};
  if(template.approvalMode!==undefined){if(!APPROVAL_MODES.includes(template.approvalMode as typeof APPROVAL_MODES[number]))fail("Agent API 审批模式无效。");out.approvalMode=template.approvalMode;}
  if(template.thinkingLevel!==undefined){if(!["none","low","medium","high","xhigh","max"].includes(String(template.thinkingLevel)))fail("Agent API 思考等级无效。");out.thinkingLevel=template.thinkingLevel;}
  if(template.maxConcurrentRuns!==undefined)out.maxConcurrentRuns=positiveInteger(template.maxConcurrentRuns,"Agent API 并发数",1000);
  return out;
}
function publicInjection(value:unknown,prompt:boolean) {
 const data=object(value);fields(data,prompt?["enabled","prompt"]:["enabled"]);
 if(data.enabled!==undefined&&typeof data.enabled!=="boolean")fail("启用状态必须是布尔值。");
 return {...(data.enabled===undefined?{}:{enabled:data.enabled}),...(data.prompt===undefined?{}:{prompt:str(data.prompt,100000,true)})};
}
export function publicPayload(kind:ResourceKind,value:unknown):Record<string,unknown>{
  const p=object(value);
  if(kind==="agents"){
    fields(p,["agentId","prompt","agentsMd","maxTurns","modelResource","skillResources","pluginResources","model","compaction","toolsBuiltin","kernelVersion","scheduleTemplates","apiTemplate","skills","hooks"]);
    if(p.maxTurns!==undefined&&(p.maxTurns!==-1&&(!Number.isSafeInteger(p.maxTurns)||Number(p.maxTurns)<1||Number(p.maxTurns)>100000)))fail("智能体轮数无效。");
    const kernelVersion=p.kernelVersion===undefined?undefined:str(p.kernelVersion,10);
    if(kernelVersion!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(kernelVersion)||kernelVersion>String(defaultSystemConfig().kernel_version)))fail("内核版本无效。");
    return {...(p.agentId===undefined?{}:{agentId:identifier(p.agentId)}),prompt:str(p.prompt,100000,true),...(p.agentsMd===undefined?{}:{agentsMd:str(p.agentsMd,100000,true)}),...(p.maxTurns===undefined?{}:{maxTurns:p.maxTurns}),modelResource:p.modelResource?str(p.modelResource,100):"",skillResources:strings(p.skillResources??[]),pluginResources:strings(p.pluginResources??[]),...(p.skills===undefined?{}:{skills:publicInjection(p.skills,true)}),...(p.hooks===undefined?{}:{hooks:publicInjection(p.hooks,false)}),...(p.model===undefined?{}:{model:publicAgentModel(p.model)}),...(p.compaction===undefined?{}:{compaction:publicAgentCompaction(p.compaction)}),...(p.toolsBuiltin===undefined?{}:{toolsBuiltin:publicAgentTools(p.toolsBuiltin)}),...(p.scheduleTemplates===undefined?{}:{scheduleTemplates:publicScheduleTemplates(p.scheduleTemplates)}),...(p.apiTemplate===undefined?{}:{apiTemplate:publicAgentApiTemplate(p.apiTemplate)}),...(kernelVersion===undefined?{}:{kernelVersion})};
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
    if(p.source==="server-module"){
      fields(p,["pluginName","pluginVersion","moduleSpecifier","source","instructions"]);
      const moduleSpecifier=str(p.moduleSpecifier,200);
      if(!/^@penguinharness\/[a-z0-9-]+$/.test(moduleSpecifier))fail("插件模块标识无效。");
      return {pluginName:identifier(p.pluginName),pluginVersion:str(p.pluginVersion,100),moduleSpecifier,source:"server-module",...(p.instructions===undefined?{}:{instructions:str(p.instructions,10000,true)})};
    }
    if(p.source==="trusted-local-adapter"){
      fields(p,["pluginName","adapterVersion","adapterHash","source"]);
      const pluginName=identifier(p.pluginName);
      if(!["qa-default-entry","qa-delegation-guard","qa-stage-boundary","goal"].includes(pluginName))fail("未登记的本机适配插件。");
      const adapterHash=str(p.adapterHash,71);
      if(!/^sha256:[a-f0-9]{64}$/.test(adapterHash))fail("本机适配插件哈希无效。");
      return {pluginName,adapterVersion:str(p.adapterVersion,80),adapterHash,source:"trusted-local-adapter"};
    }
    if(p.source==="upstream-library"){
      fields(p,["pluginName","pluginVersion","source","instructions"]);
      return {pluginName:identifier(p.pluginName),pluginVersion:str(p.pluginVersion,100),source:"upstream-library",...(p.instructions===undefined?{}:{instructions:str(p.instructions,10000,true)})};
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
const sha256=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
/** A public, non-secret view of a validated payload; archives are reduced to names and hashes. */
export function publicPayloadSummary(kind:ResourceKind,payload:Record<string,unknown>):Record<string,unknown>{
  if(kind==="skills"){
    let name=String(payload.skillName??""),description="",files:string[]=[],bytes=0,hash="";
    if(typeof payload.archiveBase64==="string"){
      const archive=Buffer.from(payload.archiveBase64,"base64");
      const parsed=parseSkillArchive(archive);
      const skillMd=parsed.files.get("SKILL.md");
      name=parsed.name;description=skillMd?parseSkillFrontmatter(strFromU8(skillMd))?.description??"":"";
      files=[...parsed.files.keys()].sort();bytes=archive.byteLength;hash=sha256(archive);
    }else{
      const content=String(payload.content??"");const meta=parseSkillFrontmatter(content);
      description=meta?.description??"";files=content?["SKILL.md"]:[];bytes=Buffer.byteLength(content);hash=content?sha256(content):"";
    }
    return {kind,name:name,skillName:name,description,fileCount:files.length,files,sizeBytes:bytes,contentHash:hash?`sha256:${hash}`:""};
  }
  if(kind==="plugins"){
    if(payload.source==="trusted-local-adapter")return {kind,pluginName:String(payload.pluginName??""),adapterVersion:String(payload.adapterVersion??""),adapterHash:String(payload.adapterHash??""),source:"trusted-local-adapter"};
    if(payload.source==="upstream-library")return {kind,pluginName:String(payload.pluginName??""),pluginVersion:String(payload.pluginVersion??""),source:"upstream-library"};
    return {kind,pluginName:String(payload.pluginName??""),source:"managed",skillResources:[...(payload.skillResources as string[]??[])],instructionsLength:String(payload.instructions??"").length};
  }
  if(kind==="agents")return {kind,modelResource:String(payload.modelResource??""),skillResources:[...(payload.skillResources as string[]??[])],pluginResources:[...(payload.pluginResources as string[]??[])],builtinToolCount:Array.isArray(payload.toolsBuiltin)?payload.toolsBuiltin.length:0,promptLength:String(payload.prompt??"").length,agentsMdLength:String(payload.agentsMd??"").length,...(payload.maxTurns===undefined?{}:{maxTurns:payload.maxTurns})};
  return {kind,provider:String(payload.provider??""),modelId:String(payload.modelId??""),contextWindow:payload.contextWindow??null,maxTokens:payload.maxTokens??null};
}
export class ControlStore {
  readonly modelConfig: CentralModelConfig;
  readonly system: AdminSystemStore;
  readonly privateAgents: CentralAgentPrivateStore;
  constructor(readonly db:DatabaseSync, private readonly privateRoot?:string){db.exec(`
    CREATE TABLE IF NOT EXISTS public_resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,draft TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,audience TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_resource_versions(resource_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(resource_id,version));
    CREATE TABLE IF NOT EXISTS public_resource_version_dependencies(resource_id TEXT NOT NULL,version INTEGER NOT NULL,dependency_id TEXT NOT NULL,dependency_kind TEXT NOT NULL,dependency_version INTEGER NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(resource_id,version,dependency_id));
    CREATE TABLE IF NOT EXISTS public_resource_version_pins(resource_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(resource_id,version));
    CREATE TABLE IF NOT EXISTS public_module_grants(user_id TEXT PRIMARY KEY,modules TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_admin_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,resource_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_agent_work_copies(resource_id TEXT PRIMARY KEY,base_version INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,builtin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS public_agent_group_assignments(resource_id TEXT PRIMARY KEY,group_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_plugin_categories(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_plugin_category_assignments(resource_id TEXT PRIMARY KEY,category_id TEXT NOT NULL);
  `);this.system=new AdminSystemStore(db,(actor,action,id)=>this.audit(actor,action,id),MODULES);this.privateAgents=new CentralAgentPrivateStore(db,privateRoot);this.modelConfig=new CentralModelConfig(db,privateRoot);}
  modules(userId:string,admin:boolean):string[]{if(admin)return [...MODULES];const row=this.db.prepare("SELECT modules FROM public_module_grants WHERE user_id=?").get(userId);const grants:string[]=this.system.roleModules(userId)??(row?JSON.parse(String(row.modules)):["chat","projects","library","schedules","plugins","skills"]);return [...new Set([...grants,"models"])];}
  setModules(actor:string,userId:string,v:unknown){const modules=strings(v);if(modules.some(m=>!(MODULES as readonly string[]).includes(m)))fail("未知模块。");if(!this.db.prepare("SELECT user_id FROM users WHERE user_id=?").get(userId))throw new HttpError(404,"not_found","用户不存在。");if(userId==="admin")fail("管理员保留全部权限。");const effective=[...new Set([...modules,"models"])];this.db.exec("BEGIN IMMEDIATE");try{this.db.prepare("INSERT INTO public_module_grants VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET modules=excluded.modules").run(userId,JSON.stringify(effective));this.db.prepare("DELETE FROM public_role_members WHERE user_id=?").run(userId);this.audit(actor,"permissions",userId);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}return effective;}
  audit(actor:string,action:string,id:string){this.db.prepare("INSERT INTO public_admin_audit(actor,action,resource_id,created_at) VALUES (?,?,?,?)").run(actor,action,id,new Date().toISOString());}
  row(id:string){const row=this.db.prepare("SELECT * FROM public_resources WHERE id=?").get(id);if(!row)throw new HttpError(404,"not_found","资源不存在。");return row;}
  get(id:string,draft=false):PublicResource {const row=this.row(id);const version=Number(row.version);const body=draft?JSON.parse(String(row.draft)):JSON.parse(String(this.db.prepare("SELECT body FROM public_resource_versions WHERE resource_id=? AND version=?").get(id,version)?.body??"null"));if(!body)throw new HttpError(404,"not_published","资源尚未发布。");return {...body,id,kind:row.kind,revision:Number(row.revision),version,published:!!row.published,audience:body.audience??JSON.parse(String(row.audience)),updatedAt:String(row.updated_at),...(draft&&row.kind==="agents"?{hasWorkCopy:!!this.db.prepare("SELECT 1 FROM public_agent_work_copies WHERE resource_id=?").get(id)}:{})};}
  copyAgent(actor:string,id:string,version:number,revision:unknown){const row=this.row(id);if(row.kind!=="agents"||!row.published)throw new HttpError(409,"agent_not_published","只有已发布的智能体可复制。");if(row.revision!==revision)throw new HttpError(409,"revision_conflict","请刷新后再复制。");if(this.db.prepare("SELECT 1 FROM public_agent_work_copies WHERE resource_id=?").get(id))throw new HttpError(409,"work_copy_exists","请先完成当前未发布版本。");const latest=this.get(id),draft=this.get(id,true);if(JSON.stringify({name:draft.name,description:draft.description,payload:draft.payload,audience:draft.audience})!==JSON.stringify({name:latest.name,description:latest.description,payload:latest.payload,audience:latest.audience}))throw new HttpError(409,"untracked_draft","中央已有未发布改动，请先核对。");const source=this.getVersion(id,version);if(version!==latest.version&&resourceDependencies(source).length)this.versionBundle(id,version);this.db.exec("BEGIN IMMEDIATE");try{this.db.prepare("UPDATE public_resources SET draft=?,audience=?,revision=revision+1,updated_at=? WHERE id=?").run(JSON.stringify({kind:source.kind,name:source.name,description:source.description,payload:source.payload}),JSON.stringify(source.audience),new Date().toISOString(),id);this.db.prepare("INSERT INTO public_agent_work_copies VALUES (?,?,?)").run(id,version,new Date().toISOString());this.audit(actor,"copy",id);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}return this.get(id,true);}
  discardAgentCopy(actor:string,id:string,revision:unknown){const row=this.row(id);if(row.kind!=="agents"||row.revision!==revision||!this.db.prepare("SELECT 1 FROM public_agent_work_copies WHERE resource_id=?").get(id))throw new HttpError(409,"work_copy_conflict","工作副本已变化，请刷新后重试。");const published=this.get(id);this.db.exec("BEGIN IMMEDIATE");try{this.db.prepare("UPDATE public_resources SET draft=?,audience=?,revision=revision+1,updated_at=? WHERE id=?").run(JSON.stringify({kind:published.kind,name:published.name,description:published.description,payload:published.payload}),JSON.stringify(published.audience),new Date().toISOString(),id);this.db.prepare("DELETE FROM public_agent_work_copies WHERE resource_id=?").run(id);this.audit(actor,"discard_copy",id);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}return this.get(id,true);}
  /** Read an immutable published body by version, including after a later update or withdrawal. */
  getVersion(id:string,version:number):PublicResource {
    if(!Number.isSafeInteger(version)||version<1)throw new HttpError(400,"invalid_version","资源版本无效。");
    const row=this.row(id);
    const saved=this.db.prepare("SELECT body,created_at FROM public_resource_versions WHERE resource_id=? AND version=?").get(id,version) as {body:string;created_at:string}|undefined;
    if(!saved)throw new HttpError(404,"version_not_found","资源版本不存在。");
    const body=JSON.parse(saved.body) as Record<string,unknown>;
    if(body.kind!==row.kind)throw new HttpError(409,"version_kind_mismatch","资源历史类型不一致。");
    return {...body,id,kind:row.kind,revision:0,version,published:Number(row.version)===version&&!!row.published,audience:body.audience as string[],updatedAt:saved.created_at} as PublicResource;
  }
  centralAgentDirectory(id:string):string{
    const current=this.get(id,true);
    if(current.kind!=="agents")fail("仅智能体有中央配置目录。");
    if(!this.privateRoot)throw new HttpError(503,"central_storage_unavailable","中央配置目录未启用。");
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))fail("中央资源标识无效。");
    const root=path.resolve(this.privateRoot,"central-agents");
    const directory=path.resolve(root,id);
    if(path.dirname(directory)!==root)fail("中央资源路径无效。");
    for(const item of [root,directory]){
      const before=fs.lstatSync(item,{throwIfNoEntry:false});
      if(before&&(!before.isDirectory()||before.isSymbolicLink()))throw new HttpError(409,"central_storage_unsafe","中央配置目录不可用。");
      if(!before)fs.mkdirSync(item,{mode:0o700});
      const after=fs.lstatSync(item);
      if(!after.isDirectory()||after.isSymbolicLink())throw new HttpError(409,"central_storage_unsafe","中央配置目录不可用。");
    }
    const write=(filename:string,value:unknown)=>{
      const target=path.join(directory,filename),serialized=JSON.stringify(value,null,2)+"\n";
      const existing=fs.lstatSync(target,{throwIfNoEntry:false});
      if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new HttpError(409,"central_storage_unsafe","中央配置快照路径不可用。");
      if(existing){
        if(fs.readFileSync(target,"utf8")===serialized)return;
        if(filename!=="draft.json")throw new HttpError(409,"central_storage_modified","中央历史版本快照被修改，请核对目录。");
      }
      const temporary=path.join(directory,`.${filename}.${randomUUID()}.tmp`);
      try{fs.writeFileSync(temporary,serialized,{flag:"wx",mode:0o600});fs.renameSync(temporary,target);}catch(error){try{fs.unlinkSync(temporary);}catch{/* best effort */}throw error;}
    };
    write("draft.json",{format:"aitest-central-agent-v1",resourceId:id,version:"draft",name:current.name,description:current.description,payload:current.payload,audience:current.audience});
    for(const item of this.history(id))write(`v${item.version}.json`,{format:"aitest-central-agent-v1",resourceId:id,version:item.version,name:item.body.name,description:item.body.description,payload:item.body.payload,audience:item.body.audience});
    return directory;
  }
  list(draft=false):PublicResource[]{return this.db.prepare("SELECT id FROM public_resources ORDER BY updated_at DESC,id").all().flatMap(row=>{try{return [this.get(String(row.id),draft)];}catch{return [];}});}
  save(actor:string,raw:unknown,id?:string):PublicResource{
    const b=object(raw);fields(b,["kind","name","description","payload","audience","revision"]);
    if(!(KINDS as readonly unknown[]).includes(b.kind))fail("未知资源类型。");const kind=b.kind as ResourceKind;
    const audience=strings(b.audience??[]);if(audience.some(u=>u!=="*"&&!/^[a-z][a-z0-9_]{1,31}$/.test(u)))fail("授权账号无效。");
    for(const u of audience)if(u!=="*"&&!this.db.prepare("SELECT user_id FROM users WHERE user_id=?").get(u))fail("授权账号不存在。");
    const body={kind,name:str(b.name,100),description:str(b.description??"",2000,true),payload:publicPayload(kind,b.payload)};
    const now=new Date().toISOString();
    if(id){const old=this.row(id);if(old.kind!==kind)fail("不能改变资源类型。");if(old.revision!==b.revision)throw new HttpError(409,"revision_conflict","资源已变化，请刷新后再编辑。");this.db.prepare("UPDATE public_resources SET draft=?,revision=revision+1,audience=?,updated_at=? WHERE id=?").run(JSON.stringify(body),JSON.stringify(audience),now,id);if(kind==="agents"&&Number(old.version)>0)this.db.prepare("INSERT OR IGNORE INTO public_agent_work_copies VALUES (?,?,?)").run(id,Number(old.version),now);}
    else{id=randomUUID();this.db.prepare("INSERT INTO public_resources(id,kind,draft,revision,audience,updated_at) VALUES (?,?,?,1,?,?)").run(id,kind,JSON.stringify(body),JSON.stringify(audience),now);}
    this.audit(actor,"save",id);return this.get(id,true);
  }
  /** Edit the live Agent atomically; immutable revisions remain internal task evidence. */
  saveLiveAgent(actor:string,id:string,raw:unknown):PublicResource {
    const current=this.get(id,true);
    if(current.kind!=="agents")fail("仅智能体支持此操作。");
    this.db.exec("SAVEPOINT live_agent_edit");
    try {
      const saved=this.save(actor,raw,id);
      const result=current.published?this.publish(actor,id,saved.revision):saved;
      this.db.exec("RELEASE live_agent_edit");return result;
    } catch(error){this.db.exec("ROLLBACK TO live_agent_edit; RELEASE live_agent_edit");throw error;}
  }
  accessible(id:string,userId:string,admin:boolean,visited=new Set<string>(),asDependency=false):boolean{
    if(visited.has(id))return false;visited.add(id);
    try{const r=this.get(id);const modules=admin?[]:this.modules(userId,false);return r.published&&(admin||((asDependency||modules.includes(r.kind)||(r.kind==="agents"&&modules.includes("chat")))&&(r.audience.includes("*")||r.audience.includes(userId))))&&resourceDependencies(r).every(d=>this.get(d.id).kind===d.kind&&this.accessible(d.id,userId,admin,new Set(visited),true));}catch{return false;}
  }
  private assertDependencies(r:PublicResource){for(const d of resourceDependencies(r)){const dep=this.get(d.id);if(dep.kind!==d.kind||!this.accessible(d.id,"",true))fail("依赖资源必须先发布且类型正确。");if(r.audience.includes("*")&&!dep.audience.includes("*"))fail("面向全部用户的模板不能依赖受限资源。");for(const u of r.audience)if(u!=="*"&&!this.accessible(d.id,u,false,new Set(),true))fail("部分授权用户无权使用依赖资源。");}}
  private recordDependencyVersions(r:PublicResource,version:number,sourceVersion?:number){
    this.db.prepare("INSERT INTO public_resource_version_pins VALUES (?,?)").run(r.id,version);
    const insert=this.db.prepare("INSERT INTO public_resource_version_dependencies VALUES (?,?,?,?,?,?)");
    if(sourceVersion!==undefined){
      const rows=this.db.prepare("SELECT dependency_id AS id,dependency_kind AS kind,dependency_version AS version,content_hash AS contentHash FROM public_resource_version_dependencies WHERE resource_id=? AND version=?").all(r.id,sourceVersion) as {id:string;kind:ResourceKind;version:number;contentHash:string}[];
      if(rows.length!==resourceDependencies(r).length)throw new HttpError(409,"historical_dependencies_unpinned","目标历史版本缺少依赖版本记录，不能精确回滚。");
      for(const row of rows)insert.run(r.id,version,row.id,row.kind,row.version,row.contentHash);
      return;
    }
    for(const dependency of resourceDependencies(r)){
      const published=this.get(dependency.id);
      const ref=publishedResourceRef(this.getVersion(dependency.id,published.version));
      insert.run(r.id,version,dependency.id,dependency.kind,published.version,ref.contentHash);
    }
  }
  versionBundle(id:string,version:number){
    const resources:PublicResource[]=[];
    const visit=(resourceId:string,resourceVersion:number)=>{
      const resource=this.getVersion(resourceId,resourceVersion);
      const existing=resources.find(item=>item.id===resourceId);
      if(existing){if(existing.version!==resourceVersion)throw new HttpError(409,"historical_dependencies_conflict","历史依赖图引用了同一资源的不同版本。");return;}
      const pinned=this.db.prepare("SELECT 1 FROM public_resource_version_pins WHERE resource_id=? AND version=?").get(resourceId,resourceVersion);
      const dependencies=resourceDependencies(resource);
      if(!pinned&&dependencies.length)throw new HttpError(409,"historical_dependencies_unpinned","该历史版本没有依赖版本记录，不能确定当时的技能和插件内容。");
      resources.push(resource);
      const rows=this.db.prepare("SELECT dependency_id AS id,dependency_kind AS kind,dependency_version AS version,content_hash AS contentHash FROM public_resource_version_dependencies WHERE resource_id=? AND version=? ORDER BY dependency_id").all(resourceId,resourceVersion) as {id:string;kind:ResourceKind;version:number;contentHash:string}[];
      if(rows.length!==dependencies.length)throw new HttpError(409,"historical_dependencies_incomplete","历史版本依赖记录不完整。");
      for(const row of rows){
        if(!dependencies.some(dep=>dep.id===row.id&&dep.kind===row.kind))throw new HttpError(409,"historical_dependencies_mismatch","历史版本依赖记录与正文不符。");
        const actual=this.getVersion(row.id,row.version);
        if(actual.kind!==row.kind||publishedResourceRef(actual).contentHash!==row.contentHash)throw new HttpError(409,"historical_dependencies_mismatch","历史依赖版本或哈希不一致。");
        visit(row.id,row.version);
      }
    };
    visit(id,version);
    return {resources};
  }
  publish(actor:string,id:string,revision:unknown){const r=this.get(id,true);if(r.revision!==revision)throw new HttpError(409,"revision_conflict","请刷新资源后再发布。");
    if(r.kind==="agents"&&r.payload.agentId!==undefined&&(!String(r.payload.prompt??"").trim()||!String(r.payload.agentsMd??"").trim()))fail("可执行的共享智能体必须同时提供提示词模板和角色指令。");
    this.assertDependencies(r);
    if(r.kind==="agents"&&typeof r.payload.agentId==="string"){
      const duplicate=this.list().find(other=>other.id!==id&&other.kind==="agents"&&other.published&&other.payload.agentId===r.payload.agentId);
      if(duplicate)throw new HttpError(409,"duplicate_shared_role","此智能体标识已有发布定义。");
    }
    const next=r.kind==="skills"?Number(this.db.prepare("SELECT COALESCE(MAX(version),0) AS value FROM public_resource_versions WHERE resource_id=?").get(id)?.value)+1:r.version+1, now=new Date().toISOString();this.db.exec("SAVEPOINT publish_resource");try{this.db.prepare("INSERT INTO public_resource_versions VALUES (?,?,?,?)").run(id,next,JSON.stringify({kind:r.kind,name:r.name,description:r.description,payload:r.payload,audience:r.audience}),now);const copied=this.db.prepare("SELECT base_version AS baseVersion FROM public_agent_work_copies WHERE resource_id=?").get(id) as {baseVersion:number}|undefined;const source=copied?this.getVersion(id,copied.baseVersion):null;const unchangedDependencies=source&&JSON.stringify(resourceDependencies(source))===JSON.stringify(resourceDependencies(r));const pinned=source&&this.db.prepare("SELECT 1 FROM public_resource_version_pins WHERE resource_id=? AND version=?").get(id,copied!.baseVersion);this.recordDependencyVersions(r,next,unchangedDependencies&&pinned?copied!.baseVersion:undefined);this.db.prepare("UPDATE public_resources SET version=?,published=1,revision=revision+1,updated_at=? WHERE id=?").run(next,now,id);if(r.kind==="agents")this.db.prepare("DELETE FROM public_agent_work_copies WHERE resource_id=?").run(id);this.audit(actor,"publish",id);this.db.exec("RELEASE publish_resource");}catch(e){this.db.exec("ROLLBACK TO publish_resource; RELEASE publish_resource");throw e;}return this.get(id,true);}
  /** Validate a payload without saving it; dependencies may be unpublished drafts but must exist and match. */
  validate(kind:string,value:unknown){
    if(!(KINDS as readonly string[]).includes(kind))fail("未知资源类型。");
    const resourceKind=kind as ResourceKind;
    const payload=publicPayload(resourceKind,value);
    const dependencies=resourceDependencies({kind:resourceKind,payload});
    const warnings:string[]=[];
    if(resourceKind==="agents"&&payload.agentId!==undefined&&(!String(payload.prompt??"").trim()||!String(payload.agentsMd??"").trim()))warnings.push("发布前必须填写提示词模板和角色指令。");
    for(const dependency of dependencies){
      let found:PublicResource|undefined;
      try { found=this.get(dependency.id); } catch {
        try { found=this.get(dependency.id,true);warnings.push(`依赖 ${dependency.id} 尚未发布。`); } catch { fail(`依赖资源不存在：${dependency.id}`); }
      }
      if(found!.kind!==dependency.kind)fail("依赖资源类型不正确。");
    }
    return {valid:true as const,kind:resourceKind,summary:publicPayloadSummary(resourceKind,payload),dependencies,warnings};
  }
  history(id:string){
    const row=this.row(id);const currentVersion=Number(row.version);
    const rows=this.db.prepare("SELECT version,body,created_at FROM public_resource_versions WHERE resource_id=? ORDER BY version DESC").all(id) as {version:number;body:string;created_at:string}[];
    return rows.map(item=>{
      let body:Record<string,unknown>;
      try { body=object(JSON.parse(item.body)); } catch { body={}; }
      const kind=(typeof body.kind==="string"&&(KINDS as readonly string[]).includes(body.kind)?body.kind:row.kind) as ResourceKind;
      let summary:Record<string,unknown>;
      try { summary={...publicPayloadSummary(kind,object(body.payload??{})),name:String(body.name??"")}; }
      catch { summary={kind,name:String(body.name??"")}; }
      const dependencies=this.db.prepare("SELECT dependency_id AS id,dependency_kind AS kind,dependency_version AS version,content_hash AS contentHash FROM public_resource_version_dependencies WHERE resource_id=? AND version=? ORDER BY dependency_id").all(id,Number(item.version));
      const pinned=!!this.db.prepare("SELECT 1 FROM public_resource_version_pins WHERE resource_id=? AND version=?").get(id,Number(item.version));
      return {version:Number(item.version),created_at:String(item.created_at),current:Number(item.version)===currentVersion,published:Number(item.version)===currentVersion&&!!row.published,summary,audience:Array.isArray(body.audience)?body.audience:[],body,dependencies:pinned?dependencies:null};
    });
  }
  /** Restores a published version's content as the next immutable version; history is never rewritten. */
  rollback(actor:string,id:string,targetVersion:number,revision:unknown){
    const row=this.row(id);
    if(this.db.prepare("SELECT 1 FROM public_agent_work_copies WHERE resource_id=?").get(id))throw new HttpError(409,"work_copy_exists","请先完成当前未发布版本。");
    if(row.revision!==revision)throw new HttpError(409,"revision_conflict","请刷新资源后再回滚。");
    if(!Number.isSafeInteger(targetVersion)||targetVersion<1)fail("回滚目标版本无效。");
    const source=this.db.prepare("SELECT body FROM public_resource_versions WHERE resource_id=? AND version=?").get(id,targetVersion) as {body:string}|undefined;
    if(!source)throw new HttpError(404,"version_not_found","回滚目标版本不存在。");
    const body=object(JSON.parse(source.body));
    if(body.kind!==row.kind)fail("历史版本类型与当前资源不一致。");
    const kind=row.kind as ResourceKind;
    const name=str(body.name,100),description=str(body.description??"",2000,true),payload=publicPayload(kind,body.payload);
    const audience=strings(body.audience??[]);
    const candidate:PublicResource={id,kind,name,description,payload,audience,revision:Number(row.revision),version:Number(row.version),published:true,updatedAt:String(row.updated_at)};
    if(resourceDependencies(candidate).length)this.versionBundle(id,targetVersion);
    this.assertDependencies(candidate);
    if(kind==="agents"&&typeof payload.agentId==="string"){
      const duplicate=this.list().find(other=>other.id!==id&&other.kind==="agents"&&other.published&&other.payload.agentId===payload.agentId);
      if(duplicate)throw new HttpError(409,"duplicate_shared_role","此智能体标识已有发布定义。");
    }
    const next=Number(row.version)+1,now=new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO public_resource_versions VALUES (?,?,?,?)").run(id,next,JSON.stringify({kind,name,description,payload,audience}),now);
      this.recordDependencyVersions(candidate,next,targetVersion);
      this.db.prepare("UPDATE public_resources SET draft=?,version=?,published=1,revision=revision+1,audience=?,updated_at=? WHERE id=?").run(JSON.stringify({kind,name,description,payload}),next,JSON.stringify(audience),now,id);
      this.audit(actor,"rollback",id);
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
    return this.get(id,true);
  }
  withdraw(actor:string,id:string){this.row(id);this.db.prepare("UPDATE public_resources SET published=0,revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(),id);this.audit(actor,"withdraw",id);}
  deleteDraft(actor:string,id:string,revision:unknown){
    const row=this.row(id);
    if(row.revision!==revision)throw new HttpError(409,"revision_conflict","资源已变化，请刷新后再删除。");
    if(Number(row.version)>0)fail("已发布过的资源须保留版本记录；请下架，不要删除。");
    for(const other of this.list(true))if(other.id!==id&&resourceDependencies(other).some(dependency=>dependency.id===id))fail("此资源仍被其他公共配置引用，请先解除关联。");
    this.db.prepare("DELETE FROM public_resources WHERE id=?").run(id);
    this.db.prepare("DELETE FROM public_agent_group_assignments WHERE resource_id=?").run(id);
    this.audit(actor,"delete_draft",id);
  }
  bundle(id:string,userId:string,admin:boolean):PublicResource[]{if(!this.accessible(id,userId,admin))throw new HttpError(403,"resource_forbidden","资源已下架或没有使用权限。");const out=new Map<string,PublicResource>();const walk=(key:string)=>{if(out.has(key))return;const r=this.get(key);out.set(key,r);for(const d of resourceDependencies(r))walk(d.id);};walk(id);return [...out.values()];}
  /** Resolve current pointers once for a new task; the returned version map can be replayed later. */
  resolveBundle(id:string,userId:string,admin:boolean){
    const latest=this.bundle(id,userId,admin)[0]!;
    const pinned=!!this.db.prepare("SELECT 1 FROM public_resource_version_pins WHERE resource_id=? AND version=?").get(id,latest.version);
    const fixed=pinned?this.versionBundle(id,latest.version).resources:this.bundle(id,userId,admin).map(resource=>this.getVersion(resource.id,resource.version));
    // New tasks follow the current Skill pointer; replayBundle retains the exact captured versions.
    const resources=withGlobalPlugins(this,fixed.map(resource=>resource.kind==="skills"?this.getVersion(resource.id,this.get(resource.id).version):resource),userId,admin);
    const versions=resources.map(publishedResourceRef);
    return {rootId:id,versions,bundleHash:resolvedBundleHash(versions),resources};
  }
  /** One read transaction fixes every accessible role's current pointer for a new root Session. */
  resolveRoleCatalog(userId:string,admin:boolean){
    this.db.exec("BEGIN");
    try{
      const roles=this.list().filter(r=>r.kind==="agents"&&typeof r.payload.agentId==="string"&&this.accessible(r.id,userId,admin));
      const ids=new Set<string>();
      for(const role of roles){
        const agentId=String(role.payload.agentId);
        if(ids.has(agentId))throw new HttpError(409,"duplicate_shared_role","共享智能体标识重复。");
        ids.add(agentId);
      }
      const bundles=roles.map(role=>({agentId:String(role.payload.agentId),...this.resolveBundle(role.id,userId,admin)}));
      this.db.exec("COMMIT");
      return {bundles};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /** Replay a task's fixed resource versions, refusing missing or mismatched resources. */
  replayBundle(id:string,versions:readonly {id:string;kind:ResourceKind;version:number;contentHash:string}[]){
    if(!Array.isArray(versions)||versions.length===0||versions[0]?.id!==id)throw new HttpError(400,"invalid_bundle","任务资源清单无效。");
    const resources=versions.map(ref=>{
      const resource=this.getVersion(ref.id,ref.version);
      const actual=publishedResourceRef(resource).contentHash;
      if(resource.kind!==ref.kind||actual!==ref.contentHash)throw new HttpError(409,"bundle_mismatch","任务资源版本或哈希不一致。");
      return resource;
    });
    const seen=new Set(resources.map(resource=>resource.id));
    if(seen.size!==resources.length)throw new HttpError(400,"invalid_bundle","任务资源清单包含重复项。");
    for(const resource of resources)for(const dep of resourceDependencies(resource))if(!resources.some(item=>item.id===dep.id&&item.kind===dep.kind))throw new HttpError(409,"bundle_incomplete","任务资源缺少依赖。");
    return {rootId:id,versions,bundleHash:resolvedBundleHash(versions),resources};
  }
}
const AGENT_GROUPS = [["common","通用","#64748b"],["req","需求分析","#7b61ff"],["design","测试设计","#0ea5a4"],["case","用例生成","#2ea86e"],["web","Web 自动化","#e8833a"],["api","接口自动化","#d97706"],["app","App 自动化","#8b5cf6"],["mini","小程序自动化","#07a35a"],["defect","缺陷管理","#e8618c"],["report","测试报告","#3b82d4"]] as const;
const BUILTIN_AGENT_GROUPS:Record<string,string>={
  default_agent:"common",test_agent:"common",requirement_analysis_agent:"req",
  test_point_agent:"design",test_case_agent:"case",automation_execution_agent:"web",
  api_automation_agent:"api",android_test_agent:"app",miniprogram_test_agent:"mini",
  defect_analysis_agent:"defect",test_report_agent:"report",
};
export function controlRoutes(store:ControlStore):Hono<AppEnv>{
  const app=new Hono<AppEnv>();app.use("*",bodyLimit({maxSize:CONTROL_BODY_LIMIT}));
  app.use("/admin/*",async(c,next)=>{if(!c.var.user.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以访问管理后台。");await next();});
  app.route("/skills",centralSkillRoutes(store));
  app.route("/admin/plugin-library",pluginLibraryRoutes());
  registerGlobalPluginRoutes(app,store,message=>new HttpError(409,"global_plugin_conflict",message));
  app.route("/admin/model-config",centralModelConfigRoutes(store.modelConfig));
  const privateKind=(value:string):PrivateAgentKind=>{if(value!=="memory"&&value!=="vault")fail("私有数据类型无效。");return value as PrivateAgentKind;};
  const privateScope=(userId:string,scope:unknown,projectId:unknown)=>{
    if(scope===undefined||scope==="user"){
      if(projectId!==undefined&&projectId!=="")fail("用户范围不能指定项目。");
      return {userId,projectId:""};
    }
    if(scope!=="project"||typeof projectId!=="string"||!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(projectId))fail("项目范围无效。");
    return {userId,projectId:projectId as string};
  };
  const privateAgent=(id:string,userId:string,admin:boolean)=>{
    const row=store.row(id);
    if(row.kind!=="agents"||(!store.accessible(id,userId,admin)&&!(admin&&store.get(id,true))))throw new HttpError(403,"agent_forbidden","无权访问此智能体。");
  };
  app.get("/private/agents/:id/:kind",c=>{
    const id=c.req.param("id"),kind=privateKind(c.req.param("kind")),user=c.var.user;
    privateAgent(id,user.userId,user.isAdmin);
    const scope=privateScope(user.userId,c.req.query("scope"),c.req.query("projectId"));
    return c.json({entries:store.privateAgents.list(id,scope,kind)});
  });
  app.put("/private/agents/:id/:kind",async c=>{
    const id=c.req.param("id"),kind=privateKind(c.req.param("kind")),user=c.var.user;
    privateAgent(id,user.userId,user.isAdmin);
    const body=object(await c.req.json().catch(()=>null));fields(body,["scope","projectId","name","value"]);
    const scope=privateScope(user.userId,body.scope,body.projectId),name=identifier(body.name),value=str(body.value,kind==="memory"?100000:10000,true);
    store.privateAgents.put(id,scope,kind,name,value);
    return c.json({ok:true});
  });
  app.delete("/private/agents/:id/:kind",async c=>{
    const id=c.req.param("id"),kind=privateKind(c.req.param("kind")),user=c.var.user;
    privateAgent(id,user.userId,user.isAdmin);
    const body=object(await c.req.json().catch(()=>null));fields(body,["scope","projectId","name"]);
    const scope=privateScope(user.userId,body.scope,body.projectId),name=identifier(body.name);
    return c.json({deleted:store.privateAgents.delete(id,scope,kind,name)});
  });
  const seedGroups=()=>{
    const insert=store.db.prepare("INSERT OR IGNORE INTO public_agent_groups VALUES (?,?,?,1)");
    for(const row of AGENT_GROUPS)insert.run(...row);
    const assign=store.db.prepare("INSERT OR IGNORE INTO public_agent_group_assignments VALUES (?,?)");
    for(const agent of store.list(true).filter(resource=>resource.kind==="agents")){
      const stage=BUILTIN_AGENT_GROUPS[String(agent.payload.agentId??"")];
      if(stage)assign.run(agent.id,stage);
    }
  };
  app.get("/admin/agent-groups",c=>{seedGroups();return c.json({stages:store.db.prepare("SELECT id,name,color,builtin FROM public_agent_groups ORDER BY builtin DESC,id").all(),assignments:store.db.prepare("SELECT resource_id AS resourceId,group_id AS stageId FROM public_agent_group_assignments").all()});});
  app.post("/admin/agent-groups",async c=>{seedGroups();const body=await c.req.json() as {name?:string;color?:string};const name=str(body.name,40).trim(),color=str(body.color,7);if(!/^#[a-fA-F0-9]{6}$/.test(color))fail("阶段颜色无效。");const id=`stage_${randomUUID().replaceAll("-","").slice(0,12)}`;store.db.prepare("INSERT INTO public_agent_groups VALUES (?,?,?,0)").run(id,name,color);return c.json({id,name,color,builtin:0},201);});
  app.put("/admin/agent-groups/assign",async c=>{seedGroups();const body=await c.req.json() as {resourceId?:string;stageId?:string};const resourceId=str(body.resourceId,100),stageId=str(body.stageId,100);if(!store.db.prepare("SELECT 1 FROM public_agent_groups WHERE id=?").get(stageId)||store.get(resourceId,true).kind!=="agents")fail("阶段或智能体无效。");store.db.prepare("INSERT INTO public_agent_group_assignments VALUES (?,?) ON CONFLICT(resource_id) DO UPDATE SET group_id=excluded.group_id").run(resourceId,stageId);return c.json({ok:true});});
  app.put("/admin/agent-groups/:id",async c=>{seedGroups();const body=await c.req.json() as {name?:string;color?:string};const name=str(body.name,40).trim(),color=str(body.color,7);if(!/^#[a-fA-F0-9]{6}$/.test(color))fail("阶段颜色无效。");const result=store.db.prepare("UPDATE public_agent_groups SET name=?,color=? WHERE id=?").run(name,color,c.req.param("id"));if(!result.changes)throw new HttpError(404,"stage_missing","阶段不存在。");return c.json({ok:true});});
  app.delete("/admin/agent-groups/:id",c=>{seedGroups();const id=c.req.param("id");if(store.db.prepare("SELECT 1 FROM public_agent_group_assignments WHERE group_id=?").get(id))throw new HttpError(409,"stage_not_empty","请先移走此阶段下的智能体。");const row=store.db.prepare("SELECT builtin FROM public_agent_groups WHERE id=?").get(id) as {builtin:number}|undefined;if(!row)throw new HttpError(404,"stage_missing","阶段不存在。");if(row.builtin)throw new HttpError(409,"builtin_stage","内置阶段不可删除。");store.db.prepare("DELETE FROM public_agent_groups WHERE id=?").run(id);return c.json({ok:true});});
  app.get("/admin/central-plugin-categories",c=>{const seed=store.db.prepare("INSERT OR IGNORE INTO public_plugin_categories VALUES (?,?,?)");for(const [id,name] of [["agent_evolution","Agent 自进化"],["office","办公效率"],["software","软件开发"],["ai_apps","AI 应用开发"],["other","其他"]] as [string,string][])seed.run(id,name,"2026-01-01T00:00:00.000Z");return c.json({categories:store.db.prepare("SELECT id,name FROM public_plugin_categories ORDER BY created_at,id").all(),assignments:store.db.prepare("SELECT resource_id AS resourceId,category_id AS categoryId FROM public_plugin_category_assignments").all()});});
  app.post("/admin/central-plugin-categories",async c=>{const body=object(await c.req.json());const name=str(body.name,40).trim();const id=`plugin_${randomUUID().replaceAll("-","").slice(0,12)}`;store.db.prepare("INSERT INTO public_plugin_categories VALUES (?,?,?)").run(id,name,new Date().toISOString());return c.json({id,name},201);});
  app.put("/admin/central-plugin-categories/assign",async c=>{const body=object(await c.req.json());const resourceId=str(body.resourceId,100),categoryId=str(body.categoryId,100);if(store.get(resourceId,true).kind!=="plugins"||!store.db.prepare("SELECT 1 FROM public_plugin_categories WHERE id=?").get(categoryId))fail("插件或分类无效。");store.db.prepare("INSERT INTO public_plugin_category_assignments VALUES (?,?) ON CONFLICT(resource_id) DO UPDATE SET category_id=excluded.category_id").run(resourceId,categoryId);return c.json({ok:true});});
  app.delete("/admin/central-plugin-categories/assignment/:id",c=>{store.db.prepare("DELETE FROM public_plugin_category_assignments WHERE resource_id=?").run(c.req.param("id"));return c.json({ok:true});});
  app.put("/admin/central-plugin-categories/:id",async c=>{const body=object(await c.req.json());const name=str(body.name,40).trim();const result=store.db.prepare("UPDATE public_plugin_categories SET name=? WHERE id=?").run(name,c.req.param("id"));if(!result.changes)throw new HttpError(404,"category_missing","分类不存在。");return c.json({ok:true});});
  app.delete("/admin/central-plugin-categories/:id",c=>{const id=c.req.param("id");if(store.db.prepare("SELECT 1 FROM public_plugin_category_assignments WHERE category_id=?").get(id))throw new HttpError(409,"category_not_empty","请先移走该分类下的插件。");store.db.prepare("DELETE FROM public_plugin_categories WHERE id=?").run(id);return c.json({ok:true});});
  app.get("/access",c=>{const u=c.var.user;return c.json({modules:store.modules(u.userId,u.isAdmin),menuKeys:u.isAdmin?store.system.menuItems().map(item=>item.key):store.system.ordinaryMenus(),resourceIds:store.list().filter(r=>store.accessible(r.id,u.userId,u.isAdmin)).map(r=>r.id)});});
  app.get("/catalog",c=>{const u=c.var.user;return c.json({resources:store.list().filter(r=>store.accessible(r.id,u.userId,u.isAdmin))});});
  app.get("/catalog/roles",c=>{const u=c.var.user;return c.json({roles:store.list().filter(r=>r.kind==="agents"&&typeof r.payload.agentId==="string"&&store.accessible(r.id,u.userId,u.isAdmin)).map(r=>({agentId:r.payload.agentId,resourceId:r.id,version:r.version}))});});
  app.get("/catalog/roles/resolved",c=>{const u=c.var.user;return c.json(store.resolveRoleCatalog(u.userId,u.isAdmin));});
  app.get("/catalog/:id",c=>c.json({resources:store.bundle(c.req.param("id"),c.var.user.userId,c.var.user.isAdmin)}));
  app.get("/catalog/:id/resolved",c=>c.json(store.resolveBundle(c.req.param("id"),c.var.user.userId,c.var.user.isAdmin)));
  app.get("/admin/resources",c=>c.json({resources:store.list(true)}));
  app.get("/admin/resources/:id/components",async c=>c.json(await agentComponents(store,c.req.param("id"),c.req.query("version")??"draft")));
  app.get("/admin/agent-defaults",c=>{
    const config=defaultSystemConfig();
    return c.json({skills:{enabled:true,prompt:"# Shared Skills\nRead the matching SKILL.md from the absolute paths in the Published Agent Resources section before using it.\n{{SKILL_METADATA}}"},hooks:{enabled:true},prompt:config.system_prompt,maxTurns:config.max_turns,model:{maxTokens:config.model?.max_tokens,timeoutMs:config.model?.timeoutMs,thinkingLevel:config.model?.thinking_level},compaction:{maxContextLength:config.compaction?.max_context_length,maxSessionTurns:config.compaction?.max_session_turns,mode:config.compaction?.mode,prompt:config.compaction?.prompt},toolsBuiltin:config.tools?.builtin??[],kernelVersion:config.kernel_version});
  });
  app.post("/admin/resources/:id/kernel-update",async c=>{
    const id=c.req.param("id"),body=object(await c.req.json().catch(()=>null));fields(body,["revision","reset"]);
    const draft=store.get(id,true);
    const current=draft.published?store.get(id):draft;
    if(current.kind!=="agents")fail("仅智能体支持内核配置更新。");
    const defaults=defaultSystemConfig();
    const source=current.payload;
    const model=object(source.model??{}),compaction=object(source.compaction??{});
    const template={prompt:defaults.system_prompt,maxTurns:defaults.max_turns,
      model:{maxTokens:defaults.model?.max_tokens,timeoutMs:defaults.model?.timeoutMs,thinkingLevel:defaults.model?.thinking_level},
      compaction:{maxContextLength:defaults.compaction?.max_context_length,maxSessionTurns:defaults.compaction?.max_session_turns,mode:defaults.compaction?.mode,prompt:defaults.compaction?.prompt},
      toolsBuiltin:defaults.tools?.builtin??[],kernelVersion:defaults.kernel_version};
    const reset=body.reset===true;
    const payload=reset?{...source,...template}:{...source,
      prompt:String(source.prompt??"").trim()?source.prompt:template.prompt,
      maxTurns:source.maxTurns??template.maxTurns,
      model:{...template.model,...model},compaction:{...template.compaction,...compaction},
      toolsBuiltin:source.toolsBuiltin??template.toolsBuiltin,kernelVersion:template.kernelVersion};
    return c.json(store.saveLiveAgent(c.var.user.userId,id,{kind:"agents",name:current.name,description:current.description,payload,audience:current.audience,revision:body.revision}));
  });
  app.get("/admin/resources/:id/snapshot",c=>{
    const id=c.req.param("id"),rawVersion=c.req.query("version")??"draft";
    const resource=rawVersion==="draft"?store.get(id,true):store.getVersion(id,Number(rawVersion));
    if(resource.kind!=="agents")fail("仅智能体支持配置快照。");
    const snapshot={format:"aitest-central-agent-v1",resourceId:id,version:rawVersion,
      name:resource.name,description:resource.description,payload:resource.payload,audience:resource.audience};
    return new Response(JSON.stringify(snapshot,null,2),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="central-agent-${id}-v${resource.version}.json"`}});
  });
  app.get("/admin/resources/:id/storage",c=>c.json({directory:store.centralAgentDirectory(c.req.param("id"))}));
  app.post("/admin/resources/:id/snapshot",async c=>{
    const id=c.req.param("id"),body=object(await c.req.json().catch(()=>null));fields(body,["revision","snapshot"]);
    const snapshot=object(body.snapshot);fields(snapshot,["format","resourceId","version","name","description","payload","audience"]);
    if(snapshot.format!=="aitest-central-agent-v1"||snapshot.resourceId!==id)fail("快照格式或智能体标识不匹配。");
    const draft=store.get(id,true);
    const current=draft.published?store.get(id):draft;
    if(current.kind!=="agents")fail("仅智能体支持配置快照。");
    const payload=publicPayload("agents",snapshot.payload);
    if(payload.agentId!==current.payload.agentId)fail("快照中的 Agent ID 与当前智能体不一致。");
    return c.json(store.saveLiveAgent(c.var.user.userId,id,{kind:"agents",name:snapshot.name,description:snapshot.description,payload,audience:current.audience,revision:body.revision}));
  });
  app.get("/admin/agent-cards",c=>{
    seedGroups();
    const privateScope={userId:c.var.user.userId,projectId:""};
    const cardStats=(resourceId:string,version:number,status:string,payload:Record<string,unknown>)=>{
      let skillCount:number|null=null,hookCount:number|null=null;
      try{
        ({skillCount,hookCount}=agentComponentCounts(store,resourceId,status==="draft"?"draft":String(version)));
      }catch{/* Old versions without pinned dependencies cannot report an exact count. */}
      return {toolCount:Array.isArray(payload.toolsBuiltin)?payload.toolsBuiltin.length:(defaultSystemConfig().tools?.builtin?.length??null),skillCount,hookCount,
        workbenchCount:null,scheduleCount:Array.isArray(payload.scheduleTemplates)?payload.scheduleTemplates.length:0,
        memoryCount:store.privateAgents.count(resourceId,privateScope,"memory"),
        vaultKeyCount:store.privateAgents.count(resourceId,privateScope,"vault")};
    };
    const assignments=new Map((store.db.prepare("SELECT resource_id AS resourceId,group_id AS stageId FROM public_agent_group_assignments").all() as {resourceId:string;stageId:string}[]).map(row=>[row.resourceId,row.stageId]));
    const cards:Record<string,unknown>[]=[];
    for(const draft of store.list(true).filter(resource=>resource.kind==="agents")){
      const stageId=assignments.get(draft.id)??"common";
      if(!draft.published&&draft.version>0)continue;
      const current=draft.published?store.get(draft.id):draft;
      const status=draft.published?"published":"draft";
      cards.push({resourceId:current.id,version:current.version,status,stageId,name:current.name,description:current.description,payload:current.payload,updatedAt:current.updatedAt,revision:current.revision,...cardStats(current.id,current.version,status,current.payload)});
    }
    return c.json({cards});
  });
  app.get("/admin/agents/:id/live",c=>{const draft=store.get(c.req.param("id"),true);if(draft.kind!=="agents")fail("仅智能体支持此操作。");return c.json(draft.published?store.get(draft.id):draft);});
  app.put("/admin/agents/:id/live",async c=>c.json(store.saveLiveAgent(c.var.user.userId,c.req.param("id"),await c.req.json())));
  app.post("/admin/resources/validate",async c=>{
    const body=await c.req.json().catch(()=>null) as {kind?:unknown;payload?:unknown}|null;
    if(!body||typeof body.kind!=="string")throw new HttpError(400,"invalid_public_configuration","请选择资源类型。");
    try{return c.json(store.validate(body.kind,body.payload));}
    catch(error){if(error instanceof HttpError&&error.status===400)return c.json({valid:false,error:{code:error.code,message:error.message}});throw error;}
  });
  app.post("/admin/resources/:id/validate",c=>{
    try{const draft=store.get(c.req.param("id"),true);return c.json(store.validate(draft.kind,draft.payload));}
    catch(error){if(error instanceof HttpError&&error.status===400)return c.json({valid:false,error:{code:error.code,message:error.message}});throw error;}
  });
  app.post("/admin/resources",async c=>c.json(store.save(c.var.user.userId,await c.req.json()),201));
  app.put("/admin/resources/:id",async c=>c.json(store.save(c.var.user.userId,await c.req.json(),c.req.param("id"))));
  app.post("/admin/resources/:id/copy",async c=>{const body=await c.req.json() as {version:number;revision:number};return c.json(store.copyAgent(c.var.user.userId,c.req.param("id"),body.version,body.revision));});
  app.delete("/admin/resources/:id/copy",async c=>{const body=await c.req.json() as {revision:number};return c.json(store.discardAgentCopy(c.var.user.userId,c.req.param("id"),body.revision));});
  app.delete("/admin/resources/:id",async c=>{store.deleteDraft(c.var.user.userId,c.req.param("id"),(await c.req.json()).revision);return c.json({ok:true});});
  app.post("/admin/resources/:id/publish",async c=>c.json(store.publish(c.var.user.userId,c.req.param("id"),(await c.req.json()).revision)));
  app.post("/admin/resources/:id/rollback",async c=>{
    const body=await c.req.json().catch(()=>null) as {version?:unknown;revision?:unknown}|null;
    return c.json(store.rollback(c.var.user.userId,c.req.param("id"),Number(body?.version),body?.revision));
  });
  app.post("/admin/resources/:id/withdraw",c=>{store.withdraw(c.var.user.userId,c.req.param("id"));return c.json({ok:true});});
  app.get("/admin/resources/:id/history",c=>{store.row(c.req.param("id"));return c.json({versions:store.history(c.req.param("id"))});});
  app.get("/admin/resources/:id/versions/:version/resolved",c=>c.json(store.versionBundle(c.req.param("id"),Number(c.req.param("version")))));
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
    const actions:Record<string,string[]>={publish:["publish","rollback"],rollback:["rollback"],withdraw:["withdraw"],draft:["save","delete_draft"],permissions:["permissions","role_assign","role_menus","role_create","role_update","role_delete","menus"],login:["login"]};
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
