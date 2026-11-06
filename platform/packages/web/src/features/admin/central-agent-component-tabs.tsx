import { useEffect, useState } from "react";
import type { AgentConfigResponse, AgentConfigUpdateRequest, HookItem, SkillMetadataItem } from "@prismshadow/penguin-server/api";
import { toastError } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { S } from "../../lib/strings";
import { SkillImportDialogContent, SkillsTabView } from "../agents/skills-tab";
import { HookImportDialogContent, HooksTabView } from "../agents/hooks-tab";
import { usePromptInjectionControls } from "../agents/prompt-injection-controls";
import { CentralSkillFiles } from "../skills/central-skill-files";
import {useNavigate} from "react-router";
import {useAuth} from "../../state/auth";
import {buildAiDraft,aiChatRouteState} from "../ai-create";
import {draftKey,loadDraft,saveDraft} from "../chat/draft-cache";
import {parkActiveDraft} from "../chat/draft-sessions";

type ComponentResource = {id:string;kind:string;name:string;description:string;payload:Record<string,unknown>};
type Skill = SkillMetadataItem & {resourceId:string;files:Record<string,string>;archiveBase64:string};
type Hook = HookItem & {resourceId:string;archiveBase64:string};
type Components = {skills:Skill[];hooks:Hook[];warning:string};

export function CentralAgentComponentTab({resourceId,version,feature,data,editable,catalog,onSave,onChange,selectedIds}: {
 resourceId:string;version:string;feature:"skills"|"hooks";data:AgentConfigResponse;editable:boolean;
 catalog:ComponentResource[];onSave:(value:AgentConfigUpdateRequest)=>Promise<AgentConfigResponse|null>;
 onChange:(ids:string[])=>Promise<void>;selectedIds:string[];
}) {
 const navigate=useNavigate();const userId=useAuth().user?.userId;
 const [components,setComponents]=useState<Components|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [removing,setRemoving]=useState<string|null>(null);
 const [importOpen,setImportOpen]=useState(false);
 const [viewing,setViewing]=useState<SkillMetadataItem|null>(null);
 const [reload,setReload]=useState(0);
 const {applyConfig,toggleCard,alertStrip,promptSection}=usePromptInjectionControls({
  feature,strings:feature==="skills"?S.skills.injection:S.hooks.injection,canEdit:editable,
  write:async update=>{const result=await onSave(update);if(!result)throw Error("保存失败，请刷新后重试。");return result;},
  insert:async()=>{
   const result=await onSave({config:{systemPrompt:`${data.config.systemPrompt}\n\n{{SKILLS}}`}});
   if(!result)throw Error("保存失败，请刷新后重试。");return result.config.skills;
  },
 });
 useEffect(()=>applyConfig(data.config),[data,applyConfig]);
 useEffect(()=>{
  let active=true;setComponents(null);setError(null);
  void controlRequest(`/api/control/admin/resources/${encodeURIComponent(resourceId)}/components?version=${encodeURIComponent(version)}`)
   .then(value=>{if(active)setComponents(value as Components);}).catch(cause=>{if(active)setError(String(cause.message??cause));});
  return()=>{active=false;};
 },[resourceId,version,reload,selectedIds.join(",")]);
 const items=feature==="skills"?components?.skills:components?.hooks;
 const exportItem=async(name:string)=>{
  const item=items?.find(item=>item.name===name);
  if(!item?.archiveBase64){toastError("此版本没有可导出的组件快照。");return;}
  const bytes=Uint8Array.from(atob(item.archiveBase64),ch=>ch.charCodeAt(0));
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/zip"}));
  const link=document.createElement("a");link.href=url;link.download=`${name}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 const change=async(ids:string[])=>{setBusy(true);try{await onChange(ids);setReload(v=>v+1);return true;}catch(cause){toastError(String(cause));return false;}finally{setBusy(false);}};
 const confirmRemove=async()=>{const item=items?.find(item=>item.name===removing);if(item&&await change(selectedIds.filter(id=>id!==item.resourceId)))setRemoving(null);};
 const transport={
  install:async(_agentId:string,archive:{dataBase64:string})=>{
   if(feature === "hooks")throw Error("钩子只能关联服务端已发布的受信包；请在上方填写包名，通过管理员助手添加。ZIP 上传暂不支持。");
   const skill=await controlRequest("/api/control/skills/admin","POST",{archiveBase64:archive.dataBase64,publish:true});
   if(!await change([...selectedIds,skill.id]))throw Error("技能已导入技能库，但关联失败，请刷新后重试。");
  },
  prompt:(source:string)=>`请为智能体「${data.config.name??resourceId}」配置${feature === "skills"?"技能":"钩子"}。资源 ID：${resourceId}。来源：${source}。\n先查找并确认来源；已有已发布资源则添加引用。读取 GET /api/control/admin/agents/${resourceId}/live，保留其他字段及 revision，使用 PUT /api/control/admin/agents/${resourceId}/live 更新引用，保存后线上生效。不要写本机 Agent 目录。可选的已发布资源：${catalog.filter(item=>feature === "skills"?item.kind === "skills":item.kind === "plugins"&&item.payload.source === "trusted-local-adapter").map(item=>item.name).join("、")}。`,
  openChat:(_agentId:string,text:string)=>{
   const request={agentId:"default_agent",text};
   if(userId){parkActiveDraft(userId,"admin_agent_catalog");const key=draftKey(userId,"admin_agent_catalog");saveDraft(key,buildAiDraft(loadDraft(key),request));}
   navigate("/chat/new",{state:aiChatRouteState(request)});
  },
 };
 const dialogProps={projectId:"",agentId:resourceId,onClose:()=>setImportOpen(false),onImported:()=>{setImportOpen(false);setReload(v=>v+1);},transport};
 const importDialog=feature === "skills"?<SkillImportDialogContent {...dialogProps}/>:<HookImportDialogContent {...dialogProps}/>;
 const common={busy,error:error??components?.warning??null,agentName:data.config.name??resourceId,editable,removing,setRemoving,confirmRemove,importOpen,setImportOpen,importDialog,toggleCard};
 return feature==="skills"?<SkillsTabView {...common} skills={components?.skills??(error?[]:null)} alertStrip={alertStrip} promptSection={promptSection} exportSkill={exportItem} viewing={viewing} setViewing={setViewing}
  renderFiles={name=>{const item=components?.skills.find(item=>item.name===name);return item&&Object.keys(item.files).length?<CentralSkillFiles name={name} files={item.files}/>:<p className="text-sm text-gray-500">此版本没有可预览的组件快照。</p>;}}/>
  :<HooksTabView {...common} isOwner hooks={components?.hooks??(error?[]:null)} exportHook={exportItem}/>;
}
