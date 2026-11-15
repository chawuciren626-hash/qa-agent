import { describe,it,expect } from 'vitest';
import { QA_SKILL_STAGES,stageSkills,skillMatches } from '../src/features/qa/skill-market-model';
const skill=(name:string,description='业务能力')=>({name,description,version:''});
describe('QA skill market',()=>{
  it('uses only actually installed business skills and excludes plugin toolkits',()=>{
    const entries=stageSkills([{agentId:'requirement_analysis_agent',label:'需求分析智能体',skills:[skill('requirement-analysis'),skill('ace-rsi-toolkit')]}],QA_SKILL_STAGES[0]);
    expect(entries.map(e=>e.skill.name)).toEqual(['requirement-analysis']);
    expect(stageSkills([],QA_SKILL_STAGES[0])).toEqual([]);
  });
  it('merges shared automation skills while preserving their sources',()=>{
    const entries=stageSkills(['automation_execution_agent','api_automation_agent'].map(agentId=>({agentId,label:agentId,skills:[skill('api-testing')]})),QA_SKILL_STAGES[3]);
    expect(entries).toHaveLength(1);expect(entries[0]?.sources).toHaveLength(2);
  });
  it('keeps distinct installed variants separate and assigns shared skills to each stage',()=>{
    const sources=[{agentId:'automation_execution_agent',label:'Web',skills:[skill('api-testing','A')]},{agentId:'api_automation_agent',label:'API',skills:[skill('api-testing','B')]}];
    expect(stageSkills(sources,QA_SKILL_STAGES[3])).toHaveLength(2);
    expect(stageSkills(sources,QA_SKILL_STAGES[0])).toHaveLength(0);
  });
  it('searches Chinese titles, skill identities and source names',()=>{
    const [entry]=stageSkills([{agentId:'test_report_agent',label:'报告智能体',skills:[skill('test-report-writing')]}],QA_SKILL_STAGES[5]);
    expect(skillMatches(entry!,'报告生成')).toBe(true);expect(skillMatches(entry!,'TEST-REPORT')).toBe(true);expect(skillMatches(entry!,'报告智能体')).toBe(true);expect(skillMatches(entry!,'不存在')).toBe(false);
  });
});
