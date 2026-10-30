import type { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import type { PublicResource } from "../http/control-plane.js";
import { HttpError } from "../http/errors.js";
import { parseSkillArchive } from "../http/routes/skills.js";
import { currentAgentValues, planAgentUpdate, publishedAgentValues, type AgentResolution, type ManagedAgentValues } from "./public-agent-version.js";
const applying=new Set<string>();
function ensureAgentVersionTables(db:DatabaseSync){
  db.exec("CREATE TABLE IF NOT EXISTS applied_public_resources(project_id TEXT NOT NULL,resource_id TEXT NOT NULL,version INTEGER NOT NULL,agent_id TEXT NOT NULL,applied_at TEXT NOT NULL,PRIMARY KEY(project_id,resource_id,version,agent_id))");
  db.exec("CREATE TABLE IF NOT EXISTS applied_agent_managed(project_id TEXT NOT NULL,resource_id TEXT NOT NULL,agent_id TEXT NOT NULL,version INTEGER NOT NULL,base_json TEXT NOT NULL,PRIMARY KEY(project_id,resource_id,agent_id))");
  db.exec("CREATE TABLE IF NOT EXISTS applied_agent_backups(project_id TEXT NOT NULL,resource_id TEXT NOT NULL,agent_id TEXT NOT NULL,from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,resource_id,agent_id,to_version))");
}
function priorAgent(db:DatabaseSync,projectId:string,resourceId:string){
  return db.prepare("SELECT agent_id AS agentId,MAX(version) AS version FROM applied_public_resources WHERE project_id=? AND resource_id=? GROUP BY agent_id ORDER BY MAX(version) DESC LIMIT 1").get(projectId,resourceId) as {agentId:string;version:number}|undefined;
}
export async function previewPublicAgentUpdate(db:DatabaseSync,body:{resourceId:string;projectId:string},resources:PublicResource[],dispatch:(r:Request)=>Promise<Response>){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(body.projectId))throw new HttpError(400,"invalid_target","项目标识无效。");
  const target=resources.find(r=>r.id===body.resourceId&&r.kind==="agents");
  if(!target)throw new HttpError(400,"invalid_bundle","智能体发布资源不完整。");
  ensureAgentVersionTables(db);
  const base="/api/projects/"+encodeURIComponent(body.projectId);
  const ask=async(path:string)=>{const response=await dispatch(new Request("http://localhost"+path));if(!response.ok)throw new HttpError(response.status as 400,"project_forbidden","无法读取本机目标。");return response.json() as Promise<any>;};
  const visible=await ask("/api/projects");
  if(!visible.projects.some((p:any)=>p.projectId===body.projectId))throw new HttpError(403,"project_forbidden","不能访问其他用户的项目。");
  const prior=priorAgent(db,body.projectId,target.id);
  if(!prior)return {newInstall:true,agentId:"public_"+target.id.replaceAll("-","").slice(0,16),fromVersion:0,toVersion:target.version,fields:[]};
  const current=await ask(base+"/agents/"+encodeURIComponent(prior.agentId)+"/config");
  const row=db.prepare("SELECT base_json AS baseJson FROM applied_agent_managed WHERE project_id=? AND resource_id=? AND agent_id=?").get(body.projectId,target.id,prior.agentId) as {baseJson:string}|undefined;
  const plan=planAgentUpdate(row?JSON.parse(row.baseJson) as ManagedAgentValues:null,currentAgentValues(current),publishedAgentValues(target));
  return {newInstall:false,agentId:prior.agentId,fromVersion:prior.version,toVersion:target.version,fields:plan.fields};
}
/** Apply only the centrally returned bundle. The browser cannot submit executable resource contents. */
export async function applyPublicResource(db:DatabaseSync,body:{resourceId:string;projectId:string;agentId?:string;resolutions?:AgentResolution},resources:PublicResource[],dispatch:(r:Request)=>Promise<Response>){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(body.projectId))throw new HttpError(400,"invalid_target","项目标识无效。");
  const target=resources.find(r=>r.id===body.resourceId);if(!target)throw new HttpError(400,"invalid_bundle","发布资源不完整。");
  const key=body.projectId;if(applying.has(key))throw new HttpError(409,"busy","此项目正在应用公共资源，请稍后重试。");applying.add(key);
  ensureAgentVersionTables(db);
  const base="/api/projects/"+encodeURIComponent(body.projectId);
  const call=async(path:string,method="GET",value?:unknown):Promise<any>=>{const r=await dispatch(new Request("http://localhost"+path,{method,headers:{"content-type":"application/json"},...(value===undefined?{}:{body:JSON.stringify(value)})}));const result:any=await r.json().catch(()=>({}));if(!r.ok)throw new HttpError(r.status as 400,result.error?.code??"apply_failed",result.error?.message??"本地应用失败。");return result;};
  let agentId=body.agentId;const results:string[]=[];
  try{
    // Project access is checked by the existing local API before any write.
    const visible=await call("/api/projects");
    if(!visible.projects.some((p:any)=>p.projectId===body.projectId))throw new HttpError(403,"project_forbidden","不能应用到其他用户的项目。");
    const previous=target.kind==="agents"?priorAgent(db,body.projectId,target.id):undefined;
    let updatePlan:ReturnType<typeof planAgentUpdate>|null=null;
    let previousConfig:any=null;
    if(target.kind==="agents"){
      agentId=previous?.agentId??("public_"+target.id.replaceAll("-","").slice(0,16));
      if(previous){
        if(previous.version>=target.version)throw new HttpError(409,"already_applied","此版本已应用到本机智能体。");
        previousConfig=await call(base+"/agents/"+agentId+"/config");
        const row=db.prepare("SELECT base_json AS baseJson FROM applied_agent_managed WHERE project_id=? AND resource_id=? AND agent_id=?").get(body.projectId,target.id,agentId!) as {baseJson:string}|undefined;
        updatePlan=planAgentUpdate(row?JSON.parse(row.baseJson) as ManagedAgentValues:null,currentAgentValues(previousConfig),publishedAgentValues(target),body.resolutions);
        if(updatePlan.unresolved.length)throw new HttpError(409,"agent_update_conflict","请先逐项确认本机修改与发布版本的差异。");
      }else{
        const current=await call(base+"/agents");if(current.agents.some((a:any)=>a.agentId===agentId))throw new HttpError(409,"agent_id_conflict","本机已有同名智能体，未覆盖。");
      }
    } else if(target.kind!=="models"&&!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId??""))throw new HttpError(400,"choose_agent","请选择目标智能体。");
    // Reuse the upstream library and installer. Never replace an existing plugin's local parts.
    const upstreamPlugins=resources.filter(r=>r.kind==="plugins"&&r.payload.source==="upstream-library"&&(!previous||!db.prepare("SELECT 1 FROM applied_public_resources WHERE project_id=? AND resource_id=? AND version=? AND agent_id=?").get(body.projectId,r.id,r.version,agentId??"")));
    let pluginNames:string[]=[];
    if(upstreamPlugins.length){
      const library=await call("/api/plugins");
      const available=library.groups.flatMap((group:any)=>group.plugins);
      const installed=target.kind==="agents"&&!previous?{skills:[],hooks:[],mcpServers:[],workbenches:[]}:await call(base+"/agents/"+agentId+"/plugins");
      for(const resource of upstreamPlugins){
        const plugin=available.find((item:any)=>item.name===resource.payload.pluginName);
        if(!plugin||plugin.version!==resource.payload.pluginVersion)throw new HttpError(409,"upstream_plugin_required","请先在原有插件市场获取管理员指定的插件版本；此处不替换上游安装器。");
        const conflict=(plugin.skills??[]).some((item:any)=>installed.skills.some((local:any)=>local.name===item.name))||installed.hooks.some((local:any)=>local.name===plugin.name)||(plugin.mcpServers??[]).some((item:any)=>installed.mcpServers.some((local:any)=>local.name===item.name))||(plugin.workbenches??[]).some((item:any)=>(installed.workbenches??[]).some((local:any)=>local.name===item.name));
        if(conflict)throw new HttpError(409,"existing_plugin","此智能体已有插件相关组件；请在原有插件页核对或更新，公共发布不会覆盖个人配置。");
        pluginNames.push(plugin.name);
      }
    }
    // Validate full skill archives before any local write, using the existing importer parser.
    const skillArchives=resources.filter(r=>r.kind==="skills"&&r.payload.archiveBase64).map(resource=>({resource,parsed:parseSkillArchive(Buffer.from(String(resource.payload.archiveBase64),"base64"))}));
    if(skillArchives.length&&target.kind!=="agents"){
      const installed=await call(base+"/agents/"+agentId+"/skills");
      if(skillArchives.some(({parsed})=>installed.skills.some((skill:any)=>skill.name===parsed.name)))throw new HttpError(409,"existing_skill","已有同名技能；请使用原有技能导入界面核对更新，公共发布不会覆盖个人修改。");
    }
    const models=resources.filter(r=>r.kind==="models");
    if(models.length){
      const current=await call(base+"/models");
      const entries=current.models.map((m:any)=>{
        const out:Record<string,unknown>={provider:m.provider,modelId:m.modelId};
        for(const k of ["displayName","contextWindow","clientType","vision","maxTokens","fastMode","pricing","discount"])if(m[k]!==undefined)out[k]=m[k];
        if(m.credential?.baseUrl!==undefined)out.baseUrl=m.credential.baseUrl;return out;
      });
      let added=false;for(const r of models){const p=r.payload;const provider=String(p.provider), modelId=String(p.modelId);
        const index=entries.findIndex((m:any)=>m.provider===provider&&m.modelId===modelId);
        // Keep the upstream (provider, modelId) identity. A synthetic provider breaks the
        // vendor's protocol routing and prevents the existing provider key from reaching it.
        // The administrator's metadata is adopted only when the user explicitly clicks Apply;
        // a local key and locally chosen URL always remain on this machine.
        const publicFields=Object.fromEntries(["contextWindow","clientType","vision","maxTokens","fastMode","pricing","discount"].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
        if(index>=0){
          entries[index]={...entries[index],...publicFields,displayName:r.name};
        }else{
          entries.push({provider,modelId,displayName:r.name,...publicFields,...(p.baseUrl?{baseUrl:p.baseUrl}:{})});
        }
        added=true;results.push(r.name);
      }
      if(added)await call(base+"/models","PUT",{models:entries});
    }
    if(target.kind==="agents"){
      if(previous){
        db.prepare("INSERT OR IGNORE INTO applied_agent_backups VALUES (?,?,?,?,?,?,?)").run(body.projectId,target.id,agentId!,previous.version,target.version,JSON.stringify(previousConfig),new Date().toISOString());
        if(pluginNames.length)await call(base+"/agents/"+agentId+"/plugins","POST",{names:pluginNames});
        const values=updatePlan!.values;
        await call(base+"/agents/"+agentId+"/config","PUT",{agentsMd:values.agentsMd,config:{name:values.name,description:values.description,systemPrompt:values.prompt,...(values.maxTurns===undefined?{}:{maxTurns:values.maxTurns})}});
      }else{
        await call(base+"/agents","POST",{agentId,name:target.name,description:target.description,...(pluginNames.length?{plugins:pluginNames}:{})});
        await call(base+"/agents/"+agentId+"/config","PUT",{...(target.payload.agentsMd===undefined?{}:{agentsMd:target.payload.agentsMd}),config:{systemPrompt:String(target.payload.prompt),...(target.payload.maxTurns===undefined?{}:{maxTurns:target.payload.maxTurns})}});
      }
      results.push(target.name);
    }
    if(target.kind!=="agents"&&pluginNames.length)await call(base+"/agents/"+agentId+"/plugins","POST",{names:pluginNames});
    for(const r of resources.filter(r=>r.kind==="skills"||(r.kind==="plugins"&&r.payload.instructions))){
      if(db.prepare("SELECT 1 FROM applied_public_resources WHERE project_id=? AND resource_id=? AND version=? AND agent_id=?").get(body.projectId,r.id,r.version,agentId??""))continue;
      const skillName="public-"+r.id.replaceAll("-","").slice(0,12)+"-v"+r.version;
      const archive=zipSync({[skillName+"/SKILL.md"]:strToU8("---\nname: "+skillName+"\ndescription: "+JSON.stringify(r.description||r.name)+"\n---\n\n"+String(r.kind==="plugins"?r.payload.instructions:r.payload.content))});
      await call(base+"/agents/"+agentId+"/skills/archive","POST",{dataBase64:r.payload.archiveBase64??Buffer.from(archive).toString("base64"),overwrite:false});results.push(r.name);
      db.prepare("INSERT OR IGNORE INTO applied_public_resources VALUES (?,?,?,?,?)").run(body.projectId,r.id,r.version,agentId??"",new Date().toISOString());
    }
    for(const r of resources)db.prepare("INSERT OR IGNORE INTO applied_public_resources VALUES (?,?,?,?,?)").run(body.projectId,r.id,r.version,agentId??"",new Date().toISOString());
    if(target.kind==="agents")db.prepare("INSERT INTO applied_agent_managed VALUES (?,?,?,?,?) ON CONFLICT(project_id,resource_id,agent_id) DO UPDATE SET version=excluded.version,base_json=excluded.base_json").run(body.projectId,target.id,agentId!,target.version,JSON.stringify(publishedAgentValues(target)));
    return {ok:true,agentId,applied:results,message:"已获取管理员配置；模型密钥和个人地址仍在本机管理。"};
  }finally{applying.delete(key);}
}
