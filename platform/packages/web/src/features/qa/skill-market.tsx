import { useEffect, useState } from 'react';
import { Button } from '@prismshadow/penguin-ui';
import { useProject, agentDisplayName } from '../../state/project';
import { getAgentSkills } from '../../api/endpoints';
import { apiErrorText } from '../../lib/api-error';
import { SkillTile } from '../skills/skill-icon-view';
import { SkillPreviewModal } from '../skills/skill-preview-modal';
import { QA_SKILL_STAGES, QA_SKILL_TITLES, stageSkills, skillMatches, type AgentSkillSource, type QaSkillEntry } from './skill-market-model';

export function useQaSkillMarket(enabled:boolean) {
  const {currentProject, agents, agentsLoading}=useProject();
  const projectId=currentProject?.projectId??null;
  const wanted=agents.filter(a=>QA_SKILL_STAGES.some(s=>(s.agents as readonly string[]).includes(a.agentId)));
  const signature=JSON.stringify(wanted.map(a=>({agentId:a.agentId,label:agentDisplayName(a)})));
  const [revision,setRevision]=useState(0);
  const [state,setState]=useState<{scope:string;sources:AgentSkillSource[];errors:string[]}|null>(null);
  const scope=JSON.stringify([projectId,signature,revision]);
  useEffect(()=>{
    if(!enabled||!projectId||agentsLoading)return;
    let alive=true;
    const targets=JSON.parse(signature) as {agentId:string;label:string}[];
    void Promise.allSettled(targets.map(async target=>({...target,skills:(await getAgentSkills(projectId,target.agentId,null)).skills}))).then(results=>{
      if(!alive)return;
      const sources:AgentSkillSource[]=[], errors:string[]=[];
      results.forEach((result,i)=>{if(result.status==='fulfilled')sources.push(result.value);else errors.push(`${targets[i]!.label}：${apiErrorText(result.reason)}`);});
      setState({scope,sources,errors});
    });
    return ()=>{alive=false;};
  },[enabled,projectId,agentsLoading,signature,scope]);
  const current=state?.scope===scope?state:null;
  const groups=QA_SKILL_STAGES.map(stage=>({...stage,entries:stageSkills(current?.sources??[],stage)}));
  const loading=enabled&&!!projectId&&(agentsLoading||!current);
  const count=current?new Set(groups.flatMap(g=>g.entries.map(e=>e.skill.name))).size:null;
  return {projectId,groups,loading,count,errors:current?.errors??[],reload:()=>setRevision(n=>n+1)};
}
export function QaSkillMarket({market,query}:{market:ReturnType<typeof useQaSkillMarket>;query:string}) {
  const [category,setCategory]=useState('');
  const [detail,setDetail]=useState<QaSkillEntry|null>(null);
  useEffect(()=>{setDetail(null);},[market.projectId]);
  const groups=market.groups.filter(g=>!category||g.id===category).map(g=>({...g,entries:g.entries.filter(e=>skillMatches(e,query))}));
  return <section aria-label="子智能体技能" className="qm-stage-skills">
    <div className="qm-personal-head"><div><h2 className="qm-subtitle">测试技能</h2><p>来自当前项目子智能体的已安装技能，按测试阶段浏览。共享技能可用于多个阶段。</p></div><Button size="sm" onClick={market.reload} disabled={market.loading}>刷新技能</Button></div>
    <div className="qm-chips" aria-label="技能分类"><button aria-pressed={!category} onClick={()=>setCategory('')}>全部</button>{market.groups.map(g=><button key={g.id} aria-pressed={category===g.id} onClick={()=>setCategory(g.id)}>{g.title}<span> {market.loading?'…':g.entries.length}</span></button>)}</div>
    {market.errors.length>0&&<div role="alert" className="qm-skill-errors"><p>部分智能体技能读取失败，以下为已读取的结果。可点击“刷新技能”重试。</p>{market.errors.map(e=><p key={e}>{e}</p>)}</div>}
    {market.loading?<p role="status" className="qm-empty">正在读取子智能体技能…</p>:<>
      {groups.map(g=><section key={g.id} aria-label={g.title} className="qm-skill-stage"><h3 className="qm-subtitle">{g.title} <small>{g.entries.length} 项技能</small></h3>
        {g.entries.length?<div className="qm-resource-grid">{g.entries.map(entry=><button type="button" key={entry.key} className="qm-resource qm-skill-card" onClick={()=>setDetail(entry)}>
          <div className="qm-skill-title"><SkillTile name={entry.skill.name} icon={entry.skill.icon} size={36}/><strong>{QA_SKILL_TITLES[entry.skill.name]??entry.skill.name}</strong></div>
          <small className="qm-skill-id">{entry.skill.name}</small><p className="qm-skill-description">{entry.skill.shortDescriptionZh||entry.skill.shortDescription||entry.skill.description||'暂无描述'}</p>
          <div className="qm-skill-sources">{entry.sources.map(s=><span key={s.agentId}>{s.label}</span>)}</div><small>{entry.skill.version?`v${entry.skill.version}`:'未声明版本'} · 已安装</small><span className="qm-skill-detail">查看详情 ›</span>
        </button>)}</div>:<p className="qm-empty">{query.trim()?'没有匹配的技能。':'当前项目尚无可展示的该阶段技能。'}</p>}
      </section>)}
    </>}
    <SkillPreviewModal projectId={market.projectId} skill={detail?.skill ?? null} sources={detail?.sources ?? []} title={detail ? QA_SKILL_TITLES[detail.skill.name] : undefined} onClose={()=>setDetail(null)} />
  </section>;
}
