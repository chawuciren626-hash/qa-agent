import { useEffect, useState } from "react";
import { Button, Modal } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { apiErrorText } from "../../lib/api-error";
import { SkillTile } from "../skills/skill-icon-view";
import { CentralSkillFiles } from "../skills/central-skill-files";

type Skill = { id:string; name:string; description:string; content:string; files:Record<string,string>; categoryId:string };
type Category = { id:string; name:string };
export function CentralSkillsCatalog(){
  const [skills,setSkills]=useState<Skill[]>([]);
  const [categories,setCategories]=useState<Category[]>([]);
  const [selected,setSelected]=useState<Skill|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError("");
    void controlRequest("/api/control/skills/catalog").then(result=>{if(active){setSkills(result.skills);setCategories(result.categories);}}).catch(cause=>{if(active)setError(apiErrorText(cause));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[revision]);
  return <section className="qm-personal" aria-label="内置技能"><div className="qm-personal-head"><div><h2 className="qm-subtitle">内置技能 <small>{skills.length}</small></h2><p>技能由管理员统一配置，按测试流程使用。刷新可查看最新内容。</p></div><Button size="sm" onClick={()=>setRevision(n=>n+1)} disabled={loading}>刷新技能</Button></div>
    {error&&<p role="alert" className="my-2 text-red-600">{error}</p>}
    {loading?<p role="status">正在读取内置技能…</p>:skills.length===0?<p className="qm-empty">暂无可用的内置技能。</p>:<div className="qm-resource-grid">{skills.map(skill=><button type="button" key={skill.id} className="qm-resource qm-skill-card" onClick={()=>setSelected(skill)}><div className="qm-skill-title"><SkillTile name={skill.name} size={36}/><strong>{skill.name}</strong></div><p className="qm-skill-description">{skill.description}</p><small>{categories.find(category=>category.id===skill.categoryId)?.name??"通用"}</small><span className="qm-skill-detail">查看详情 ›</span></button>)}</div>}
    {selected&&<Modal open title={selected.name} onClose={()=>setSelected(null)} widthClass="sm:max-w-4xl"><p>{selected.description}</p><div className="mt-5"><CentralSkillFiles key={selected.id} name={selected.name} files={selected.files}/></div></Modal>}
  </section>;
}
