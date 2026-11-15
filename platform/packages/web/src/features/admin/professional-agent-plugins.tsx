import { useCallback, useEffect, useState } from "react";
import type { PluginItem } from "@prismshadow/penguin-server/api";
import { Button, ConfirmModal, Modal } from "@prismshadow/penguin-ui";
import { InstallRow } from "../plugins/plugin-card";
import { controlRequest } from "../../api/control";

export interface PluginResource { id: string; kind: string; name: string; description: string; payload: Record<string, unknown>; audience: string[]; revision: number; version: number; published: boolean }
export interface ProfessionalAgent { resourceId: string; name: string; payload: Record<string, unknown>; status: string }
interface GlobalPluginPolicy {pluginName:string;resourceId:string|null;resourceVersion:number|null;revision:number}
export const pluginReferences = (value: Record<string, unknown>): string[] => Array.isArray(value.pluginResources) ? value.pluginResources.filter((id): id is string => typeof id === "string") : [];
export function useProfessionalPlugins(enabled = true) {
  const [agents, setAgents] = useState<ProfessionalAgent[]>([]);
  const [resources, setResources] = useState<PluginResource[]>([]);
  const [policies,setPolicies]=useState<GlobalPluginPolicy[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const [cards, catalog, global] = await Promise.all([controlRequest("/api/control/admin/agent-cards"), controlRequest("/api/control/admin/resources"),controlRequest("/api/control/admin/global-plugins")]);
    setAgents(cards.cards);
    setResources(catalog.resources);
    setPolicies(global.policies);
    setError("");
  }, []);
  useEffect(() => { if (!enabled) return; void reload().catch(cause => setError(String(cause))).finally(() => setLoading(false)); }, [reload, enabled]);
  const resourceFor = (plugin: PluginItem) => resources.find(r => r.kind === "plugins" && r.published && r.payload.source === "upstream-library" && r.payload.pluginName === plugin.name && r.payload.pluginVersion === plugin.version);
  const globalPolicy = (plugin:PluginItem) => policies.find(p=>p.pluginName===plugin.name);
  const globallyInstalled = (plugin:PluginItem) => {
    const policy=globalPolicy(plugin);
    return !!policy?.resourceId && resources.some(r=>r.id===policy.resourceId&&r.published&&r.audience.includes("*"));
  };
  const directlyInstalled = (agent: ProfessionalAgent, plugin: PluginItem) => resources.some(r => r.kind === "plugins" && r.payload.pluginName === plugin.name && pluginReferences(agent.payload).includes(r.id));
  const uses = (agent:ProfessionalAgent,plugin:PluginItem) => directlyInstalled(agent,plugin)||globallyInstalled(plugin);
  const ensureResource = async (plugin:PluginItem) => {
    let resource=resourceFor(plugin);
    if(!resource){
      const saved=await controlRequest("/api/control/admin/resources","POST",{kind:"plugins",name:plugin.titleZh??plugin.title??plugin.name,description:plugin.descriptionZh??plugin.description,payload:{source:"upstream-library",pluginName:plugin.name,pluginVersion:plugin.version},audience:["*"]});
      resource=await controlRequest(`/api/control/admin/resources/${saved.id}/publish`,"POST",{revision:saved.revision}) as PluginResource;
    }
    return resource;
  };
  const changeGlobal = async(plugin:PluginItem,enabled:boolean) => {
    const resource=enabled?await ensureResource(plugin):null;
    await controlRequest(`/api/control/admin/global-plugins/${encodeURIComponent(plugin.name)}`,"PUT",{resourceId:resource?.id??null,revision:globalPolicy(plugin)?.revision??0});
    await reload();
  };
  const change = async (agentId: string, plugin: PluginItem, enabled: boolean) => {
    // Read the live definition just before editing; preserve all unrelated fields and adapters.
    const current = await controlRequest(`/api/control/admin/agents/${encodeURIComponent(agentId)}/live`) as PluginResource;
    const resource = enabled ? await ensureResource(plugin) : null;
    const related = new Set(resources.filter(r => r.kind === "plugins" && r.payload.source === "upstream-library" && r.payload.pluginName === plugin.name).map(r => r.id));
    const ids = pluginReferences(current.payload).filter(id => !related.has(id));
    if (enabled && resource) ids.push(resource.id);
    await controlRequest(`/api/control/admin/agents/${encodeURIComponent(agentId)}/live`, "PUT", {kind:"agents",name:current.name,description:current.description,payload:{...current.payload,pluginResources:[...new Set(ids)]},audience:current.audience,revision:current.revision});
    await reload();
  };
  return {agents,resources,policies,error,loading,reload,uses,change,globallyInstalled,directlyInstalled,changeGlobal};
}
export type ProfessionalPlugins = ReturnType<typeof useProfessionalPlugins>;
export function ProfessionalPluginInstalls({plugin, state, onClose}: {plugin:PluginItem;state:ProfessionalPlugins;onClose:()=>void}) {
  const [pending,setPending] = useState<{agent:ProfessionalAgent|null;enabled:boolean}|null>(null);
  const [scope,setScope]=useState<"agent"|"global">("agent");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  return <><Modal open title={`管理安装：${plugin.titleZh ?? plugin.title ?? plugin.name}`} onClose={() => {if(!busy)onClose();}}>
    {(error || state.error) && <p role="alert" className="text-red-600">{error || state.error}</p>}
    <div className="mb-3 flex gap-1 rounded-lg bg-gray-50 p-1 dark:bg-gray-800" role="group" aria-label="安装范围">
      <Button size="sm" className="flex-1" variant={scope==="global"?"secondary":"ghost"} aria-pressed={scope==="global"} onClick={()=>setScope("global")} disabled={busy}>全局</Button>
      <Button size="sm" className="flex-1" variant={scope==="agent"?"secondary":"ghost"} aria-pressed={scope==="agent"} onClick={()=>setScope("agent")} disabled={busy}>指定 Agent</Button>
    </div>
    {scope==="global" ? <>
      <InstallRow agentId="all-professional-agents" name="所有专业 Agent" installed={state.globallyInstalled(plugin)} outdated={false} mcp={null} isOwner={false} held={busy?{reason:"正在保存",off:false,busy:true}:null} onToggle={enabled=>setPending({agent:null,enabled})} onUpdate={()=>{}} onSetUp={()=>{}} />
      <p className="mt-3 text-xs text-fg-muted">现有及以后新建的专业 Agent 默认可用。客户端同步后在本机执行；独立安装的配置保留。</p>
    </> : <><div className="max-h-80 space-y-1 overflow-y-auto">{state.agents.map(agent => <InstallRow
      key={agent.resourceId}
      agentId={String(agent.payload.agentId ?? agent.resourceId)}
      name={agent.name+(state.globallyInstalled(plugin)&&!state.directlyInstalled(agent,plugin)?" · 全局继承":"")}
      installed={state.uses(agent,plugin)}
      outdated={false}
      mcp={null}
      isOwner={false}
      held={busy ? {reason:"正在保存",off:false,busy:true} : state.globallyInstalled(plugin)&&!state.directlyInstalled(agent,plugin)?{reason:"此 Agent 继承全局安装，请在全局范围管理。",off:false,busy:false}:null}
      onToggle={enabled => setPending({agent,enabled})}
      onUpdate={() => {}}
      onSetUp={() => {}}
    />)}</div>
    <p className="mt-3 text-xs text-fg-muted">已发布 Agent 的变更对新任务生效；草稿需发布后生效。</p>
    {!state.loading && !state.agents.length && <p>暂无专业 Agent，请先在 Agent 管理中创建。</p>}</>}
  </Modal><ConfirmModal open={pending !== null} title={pending?.enabled ? "安装插件" : "移除安装"} onClose={() => {if(!busy)setPending(null);}} onConfirm={async () => {if(!pending)return;setBusy(true);setError("");try {if(pending.agent)await state.change(pending.agent.resourceId,plugin,pending.enabled);else await state.changeGlobal(plugin,pending.enabled);setPending(null);}catch(cause){setError(String(cause));}finally{setBusy(false);}}} busy={busy} confirmLabel="确认" cancelLabel="取消">
    {pending && <p>{pending.agent?.name??"所有专业 Agent"}：{pending.enabled ? "安装" : "移除"} {plugin.titleZh ?? plugin.title ?? plugin.name}。{!pending.agent?"全局变更在客户端同步后对新任务生效，已有任务保留原快照；移除全局安装不会删除独立安装。":pending.agent.status === "published" ? "本次修改会发布新的 Agent 版本；若存在全局安装，移除独立安装后仍继承全局能力。" : "本次修改保存到草稿，发布后生效。"}</p>}
  </ConfirmModal></>;
}
