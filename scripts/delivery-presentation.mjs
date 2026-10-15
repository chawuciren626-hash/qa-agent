import { readRunFile, runDirectory } from './design-quality.mjs';

const documents = [
  ['report/test_report.html','测试报告','report'],
  ['design/test_cases.xlsx','测试用例 Excel','test_cases'],
  ['report/test_cases.xlsx','执行用例 Excel','report'],
  ['design/test_points.xmind','测试点 XMind','test_points'],
  ['report/test_report.docx','测试报告 Word','report'],
  ['report/test_report.pdf','测试报告 PDF','report'],
  ['analysis/requirement_analysis.md','需求分析','analysis'],
  ['defects/bugs.md','缺陷分析','defects']
];

export function deliveryPresentation(root, runId, manifest) {
  const dir=runDirectory(root,runId), artifacts=[];
  const contracts=new Map();
  for(const event of manifest.orchestration?.events ?? []) {
    const contract=event.type==='completed' ? event.evidence?.artifact_contract : null;
    if(contract?.status==='passed' && contract.run_id===runId && contract.stage===event.stage) contracts.set(event.stage,contract);
  }
  const verified=(stage,path)=>{
    const expected=contracts.get(stage)?.files?.find(file=>file.path===path);
    if(!expected) return null;
    try {const file=readRunFile(dir,path);return file.sha256===expected.sha256?file:null;} catch {return null;}
  };
  for(const [path,label,stage] of documents) {
    if(!['completed','awaiting_confirmation'].includes(manifest.stages?.[stage]?.status)) continue;
    try {
      const file=verified(stage,path);
      if(!file?.data.length) continue;
      const workspacePath=`output/runs/${runId}/${path}`;
      artifacts.push({label,path:workspacePath,markdown:`[${label}](<${workspacePath}>)`});
    } catch { /* Missing exports are not advertised as delivered. */ }
  }
  const collection=(stage,path,keys)=>{
    const file=verified(stage,path);if(!file)return null;
    try {const data=JSON.parse(file.data);const rows=Array.isArray(data)?data:keys.map(key=>data[key]).find(Array.isArray);return Array.isArray(rows)?rows.length:null;} catch{return null;}
  };
  const reportFile=verified('report','report/reportable-results.json');
  let reportSummary=null;
  try {if(reportFile) reportSummary=JSON.parse(reportFile.data).summary ?? null;} catch { /* Invalid files are not summarized. */ }
  const facts={
    test_points:collection('test_points','design/test_points.json',['points','test_points']),
    test_cases:collection('test_cases','design/test_cases.json',['cases','test_cases']),
    report_results:reportSummary,
    artifact_count:artifacts.length
  };
  const completed=[];
  if(Number.isInteger(facts.test_points)) completed.push(`测试点 ${facts.test_points} 条`);
  if(Number.isInteger(facts.test_cases)) completed.push(`测试用例 ${facts.test_cases} 条`);
  if(reportSummary && Number.isInteger(reportSummary.total)) completed.push(`报告结果 ${reportSummary.total} 条`);
  return {artifacts,markdown:artifacts.map(a=>a.markdown).join(' · '),facts,concise_summary:completed.join('，'),
    directory:`output/runs/${runId}`,
    reply_guidance:'Use concise_summary and facts as the only numeric claims; never estimate counts from conversation text. Mention only artifacts supplied in artifacts/markdown, using those exact links. Summarize actual results and limitations briefly. Ask only genuine business or access questions. Do not narrate validation, dispatch, IDs, locks, bookkeeping, or internal reasoning. No extra confirmation when nothing requires a decision.'};
}
