import { useEffect, useState } from "react";
import { Button, Input, ListRow, Modal, SettingsEmpty, SettingsList, SkeletonList } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { SkillTile } from "../skills/skill-icon-view";

interface ExistingSkill {id:string;kind:string;name:string;description:string;published:boolean;version:number;payload:Record<string,unknown>}
export function ExistingSkillPicker({boundIds,boundNames,onAdd,onClose}:{boundIds:string[];boundNames:string[];onAdd:(ids:string[])=>Promise<boolean>;onClose:()=>void}) {
  const [skills,setSkills]=useState<ExistingSkill[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [query,setQuery]=useState("");
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;void controlRequest("/api/control/catalog").then(data=>{if(active)setSkills(data.resources.filter((item:ExistingSkill)=>item.kind==="skills"&&item.published));}).catch(cause=>{if(active)setError(String(cause));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const available=skills.filter(skill=>!boundIds.includes(skill.id)&&!boundNames.includes(String(skill.payload.skillName??skill.name)));
  const visible=available.filter(skill=>`${skill.name} ${skill.payload.skillName??""} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal open title="添加技能" onClose={()=>{if(!busy)onClose();}} widthClass="sm:max-w-2xl" footer={<>
    <Button size="sm" disabled={busy} onClick={onClose}>取消</Button>
    <Button size="sm" variant="primary" disabled={busy||loading||selected.length===0} onClick={async()=>{setBusy(true);setError("");try{if(await onAdd([...new Set([...boundIds,...selected])]))onClose();else setError("绑定失败，请检查提示后重试。");}catch(cause){setError(String(cause));}finally{setBusy(false);}}}>{busy?"正在添加…":`添加${selected.length?` (${selected.length})`:""}`}</Button>
  </>}>
    <p className="mb-3 text-xs text-fg-muted">从技能管理中选择已发布的技能，绑定到当前 Agent。已有绑定会保留。</p>
    <Input aria-label="搜索已有技能" placeholder="搜索技能名称或描述" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/>
    {error&&<p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    <div className="mt-3 max-h-80 overflow-y-auto">{loading?<SkeletonList rows={3}/>:visible.length===0?<SettingsEmpty>{query?"没有匹配的技能。":"暂无可添加的已发布技能，请先在技能管理中发布。"}</SettingsEmpty>:<SettingsList label="已有技能">{visible.map(skill=><ListRow key={skill.id} as="li" leading={<SkillTile name={String(skill.payload.skillName??skill.name)}/>} title={<span className="font-mono font-semibold">{String(skill.payload.skillName??skill.name)}</span>} description={skill.description} meta={String(skill.version)} trailing={<input type="checkbox" className="h-4 w-4 accent-gray-900" aria-label={`选择 ${String(skill.payload.skillName??skill.name)}`} disabled={busy} checked={selected.includes(skill.id)} onChange={event=>setSelected(previous=>event.target.checked?[...previous,skill.id]:previous.filter(id=>id!==skill.id))}/>}/>)}</SettingsList>}</div>
  </Modal>;
}
