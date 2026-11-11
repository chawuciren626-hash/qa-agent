import { useEffect, useState } from "react";
import { Button, ConfirmModal, GlyphIcon, HelpFold, IconButton, ICONS, ICON_SIZE, Input, ListRow, Modal, SettingsEmpty, SettingsList, SkeletonList } from "@prismshadow/penguin-ui";
import type { PluginItem } from "@prismshadow/penguin-server/api";
import { controlRequest } from "../../api/control";
import { libraryPluginArchiveUrl } from "../../api/endpoints";
import { SkillTile } from "../skills/skill-icon-view";
import { PluginDetailModal } from "../plugins/plugin-detail";
import { downloadArchive } from "../agents/archive-download";
import { ProfessionalPluginInstalls, pluginReferences, useProfessionalPlugins } from "./professional-agent-plugins";

export function ProfessionalAgentPluginTab({resourceId,onChanged}:{resourceId:string;onChanged:()=>Promise<void>}) {
  const state=useProfessionalPlugins();
  const [plugins,setPlugins]=useState<PluginItem[]>([]);
  const [libraryLoading,setLibraryLoading]=useState(true);
  const [selected,setSelected]=useState<PluginItem|null>(null);
  const [viewing,setViewing]=useState<PluginItem|null>(null);
  const [removing,setRemoving]=useState<PluginItem|null>(null);
  const [adding,setAdding]=useState(false);
  const [query,setQuery]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;void controlRequest("/api/control/admin/plugin-library")
    .then(data=>{if(active)setPlugins(data.groups.flatMap((group:{plugins:PluginItem[]})=>group.plugins));})
    .catch(cause=>{if(active)setError(String(cause));}).finally(()=>{if(active)setLibraryLoading(false);});return()=>{active=false;};},[]);
  const agent=state.agents.find(item=>item.resourceId===resourceId);
  const bound=new Map<string,{name:string;description:string;version:string;inherited:boolean;plugin?:PluginItem}>();
  for(const resource of state.resources) {
    if(!agent||resource.kind!=="plugins"||resource.payload.source!=="upstream-library")continue;
    const direct=pluginReferences(agent.payload).includes(resource.id);
    const inherited=state.policies.some(p=>p.resourceId===resource.id)&&resource.published&&resource.audience.includes("*");
    if(!direct&&!inherited)continue;
    const name=String(resource.payload.pluginName);
    if(bound.has(name)&&!direct)continue;
    bound.set(name,{name,description:resource.description,version:String(resource.payload.pluginVersion??""),inherited:!direct,plugin:plugins.find(p=>p.name===name)});
  }
  const available=plugins.filter(plugin=>!bound.has(plugin.name)&&`${plugin.titleZh??plugin.title??plugin.name} ${plugin.descriptionZh??plugin.description}`.toLowerCase().includes(query.toLowerCase()));
  const loading=state.loading||libraryLoading;
  return <div className="space-y-4">
    <HelpFold label="插件">仅显示此 Agent 独立绑定及全局继承的插件。独立安装可在此移除；全局继承请到插件管理中调整，变更在客户端同步后对新任务生效。</HelpFold>
    <div className="flex justify-end"><Button size="sm" variant="primary" disabled={loading||!agent||busy} onClick={()=>{setQuery("");setAdding(true);}}>添加插件</Button></div>
    {(error||state.error)&&<p role="alert" className="text-xs text-red-600">{error||state.error}</p>}
    {loading?<SkeletonList rows={3}/>:bound.size===0?<SettingsEmpty>此 Agent 暂未绑定插件。</SettingsEmpty>:<SettingsList label="已绑定插件">
      {[...bound.values()].map(item=>{
        const plugin=item.plugin;
        const title=plugin?.titleZh??plugin?.title??item.name;
        const matches=plugin?.version===item.version;
        return <ListRow key={item.name} as="li" leading={<SkillTile icon={plugin?.icon} name={item.name} fallback={ICONS.puzzle}/>}
          title={<span className="font-semibold">{title}</span>}
          description={<span title={item.description}>{plugin?.shortDescriptionZh??plugin?.shortDescription??item.description}</span>}
          meta={`${item.inherited?"全局继承":"独立绑定"} · ${item.version}`}
          trailing={<>
            <IconButton label={`查看 ${item.name}`} title={matches?"查看插件":"当前插件库中没有此绑定版本"} disabled={!matches||busy} onClick={()=>setViewing(plugin!)}><GlyphIcon d={ICONS.eye} size={ICON_SIZE.iconButton}/></IconButton>
            <IconButton label={`导出 ${item.name}`} title="导出插件" disabled={!matches||busy} onClick={()=>void downloadArchive(libraryPluginArchiveUrl(item.name),item.name).catch(cause=>setError(String(cause)))}><GlyphIcon d={ICONS.download} size={ICON_SIZE.iconButton}/></IconButton>
            <IconButton variant="danger" label={`移除 ${item.name}`} title={item.inherited?"全局继承，请到插件管理调整":"移除绑定"} disabled={item.inherited||!plugin||busy} onClick={()=>setRemoving(plugin!)}><GlyphIcon d={ICONS.trash} size={ICON_SIZE.iconButton}/></IconButton>
          </>}/>;
      })}
    </SettingsList>}
    {adding&&<Modal open title="添加插件" onClose={()=>setAdding(false)}>
      <Input aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={event=>setQuery(event.target.value)}/>
      <div className="mt-3 max-h-80 overflow-y-auto">{available.length===0?<SettingsEmpty>没有可添加的插件。</SettingsEmpty>:<SettingsList label="可添加插件">{available.map(plugin=><ListRow key={plugin.name} as="li" leading={<SkillTile icon={plugin.icon} name={plugin.name} fallback={ICONS.puzzle}/>} title={plugin.titleZh??plugin.title??plugin.name} description={plugin.shortDescriptionZh??plugin.shortDescription??plugin.descriptionZh??plugin.description} trailing={<Button size="sm" onClick={()=>{setAdding(false);setSelected(plugin);}}>添加</Button>}/>)}</SettingsList>}</div>
    </Modal>}
    {selected&&<ProfessionalPluginInstalls plugin={selected} state={{...state,agents:agent?[agent]:[],change:async(...args)=>{await state.change(...args);await onChanged();}}} onClose={()=>setSelected(null)}/>}
    {viewing&&<PluginDetailModal libraryPath="/api/control/admin/plugin-library" row={{key:`library:${viewing.name}`,name:viewing.name,category:"other",library:viewing}} head={{status:"installed",statusHint:"此 Agent 已绑定",categoryTitle:"插件",usedBy:null}} footer={null} onClose={()=>setViewing(null)}/>}
    <ConfirmModal open={!!removing} title="移除插件绑定" confirmLabel="移除" cancelLabel="取消" busy={busy} onClose={()=>{if(!busy)setRemoving(null);}} onConfirm={async()=>{if(!removing||!agent)return;setBusy(true);setError("");try{await state.change(agent.resourceId,removing,false);await onChanged();setRemoving(null);}catch(cause){setError(String(cause));}finally{setBusy(false);}}}>
      <p>移除 {removing?.titleZh??removing?.title??removing?.name} 与此 Agent 的独立绑定。已有任务保留原快照；若全局仍启用此插件，移除后仍会继承全局能力。</p>
    </ConfirmModal>
  </div>;
}
