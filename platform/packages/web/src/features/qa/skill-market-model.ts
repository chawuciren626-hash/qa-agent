import type { SkillMetadataItem } from '@prismshadow/penguin-server/api';
import roles from '../../../../../../penguin/agents.json';

export const QA_SKILL_STAGES = [
  {id:'requirements', title:'需求分析', agents:['requirement_analysis_agent']},
  {id:'scenarios', title:'测试点/场景分析', agents:['test_point_agent']},
  {id:'cases', title:'用例生成', agents:['test_case_agent']},
  {id:'automation', title:'自动化测试', agents:['automation_execution_agent','api_automation_agent']},
  {id:'defects', title:'缺陷分析', agents:['defect_analysis_agent']},
  {id:'reports', title:'报告生成', agents:['test_report_agent']},
] as const;
export const QA_SKILL_TITLES: Record<string,string> = {
  'requirement-analysis':'需求分析', 'api-contract-analysis':'接口契约分析',
  'test-design-methods':'测试设计方法', 'test-point-design':'测试点与场景设计',
  'test-case-writing':'测试用例生成', 'api-testing':'接口测试设计',
  'playwright-execution':'Web 自动化测试', 'api-test-execution':'接口自动化测试',
  'bug-reporting':'缺陷分析与登记', 'qa-investigation':'问题调查与定位',
  'test-report-writing':'测试报告生成',
};
export type AgentSkillSource = {agentId:string; label:string; skills:SkillMetadataItem[]};
export type QaSkillEntry = {key:string; skill:SkillMetadataItem; sources:{agentId:string;label:string}[]};
export function stageSkills(sources:AgentSkillSource[], stage:typeof QA_SKILL_STAGES[number]):QaSkillEntry[] {
  const entries = new Map<string,QaSkillEntry>();
  for(const source of sources) {
    if(!(stage.agents as readonly string[]).includes(source.agentId))continue;
    // The product role manifest defines business capabilities. Installed plugin toolkits
    // stay in the Plugins tab; never manufacture missing skills from this manifest.
    const allowed = roles.agents.find(role=>role.id===source.agentId)?.skills ?? [];
    for(const skill of source.skills) {
      if(!allowed.includes(skill.name))continue;
      const key=JSON.stringify([skill.name,skill.version,skill.description,skill.shortDescription,skill.shortDescriptionZh]);
      const entry=entries.get(key)??{key,skill,sources:[]};
      entry.sources.push({agentId:source.agentId,label:source.label});
      entries.set(key,entry);
    }
  }
  return [...entries.values()].sort((a,b)=>a.skill.name.localeCompare(b.skill.name));
}
export function skillMatches(entry:QaSkillEntry, query:string):boolean {
  return [QA_SKILL_TITLES[entry.skill.name],entry.skill.name,entry.skill.description,entry.skill.shortDescription,entry.skill.shortDescriptionZh,...entry.sources.map(s=>s.label)].join(' ').toLowerCase().includes(query.trim().toLowerCase());
}
