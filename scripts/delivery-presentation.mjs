import { readRunFile, runDirectory } from './design-quality.mjs';
import { stageDefinitions } from './stage-registry.mjs';

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
  for(const [stage,current] of Object.entries(manifest.stages ?? {})) {
    if(!['completed','awaiting_confirmation'].includes(current.status)) continue;
    const events=(manifest.orchestration?.events ?? []).filter(event=>event.stage===stage);
    const event=events.filter(event=>event.type==='completed').at(-1);
    const dispatch=events.filter(event=>event.type==='dispatched').at(-1);
    const contract=event?.evidence?.artifact_contract;
    if(contract?.status!=='passed' || contract.run_id!==runId || contract.stage!==stage) continue;
    // Legacy contracts carry their binding on the completion event, not in the receipt.
    // With no dispatch identity anywhere, retain the legacy chronological contract.
    if(dispatch && events.indexOf(event)<events.indexOf(dispatch)) continue;
    const dispatchId=dispatch?.dispatch_id ?? current.dispatch_id;
    if(dispatchId && event['dispatch-id']!==dispatchId) continue;
    if(current.dispatch_id && dispatch?.dispatch_id && current.dispatch_id!==dispatch.dispatch_id) continue;
    if(contract.dispatch_id && contract.dispatch_id!==(dispatchId ?? event['dispatch-id'])) continue;
    contracts.set(stage,contract);
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
  const summaries=[],questions=[],limitations=[],confirmationStages=[];
  let verifiedTasks=0;
  for(const stage of stageDefinitions) {
    const status=manifest.stages?.[stage.id]?.status;
    if(status==='awaiting_confirmation') confirmationStages.push(stage.id);
    if(!['completed','awaiting_confirmation'].includes(status)) continue;
    const file=verified(stage.id,stage.task_result);
    if(!file) continue;
    try {
      const task=JSON.parse(file.data);
      if(task.run_id!==runId || task.stage!==stage.id || !Array.isArray(task.questions)) continue;
      verifiedTasks++;
      if(typeof task.summary==='string' && task.summary.trim()) summaries.push(task.summary.trim());
      questions.push(...task.questions.filter(value=>typeof value==='string' && value.trim()));
      limitations.push(...(Array.isArray(task.limitations)?task.limitations:[]).filter(value=>typeof value==='string' && value.trim()));
    } catch { /* Unverified task summaries cannot establish a question or clear a confirmation. */ }
  }
  const pendingQuestions=[...new Set(questions)];
  return {artifacts,markdown:artifacts.map(a=>a.markdown).join(' · '),facts,concise_summary:completed.join('，'),
    pending_questions:pendingQuestions,limitations:[...new Set(limitations)],confirmation_stages:confirmationStages,
    question_status:pendingQuestions.length?'present':verifiedTasks?'none_recorded':'unknown',
    reply_template: [summaries.length?[...new Set(summaries)].join('\n'):completed.length ? `已整理：${completed.join('，')}。` : '', artifacts.map(a=>a.markdown).join(' · '),pendingQuestions.length?`待确认：\n${pendingQuestions.map(q=>`- ${q}`).join('\n')}`:''].filter(Boolean).join('\n\n'),
    directory:`output/runs/${runId}`,
    reply_guidance:'Use reply_template as the delivery skeleton, not a second message after a verbose summary. pending_questions and limitations are separate: limitations do not request approval or extra work. When pending_questions and confirmation_stages are empty, omit a pending-confirmation section entirely, including a section saying none. Saved staged-mode confirmations remain required. Add only actual business findings and necessary limitations. Never claim product execution or success from artifact counts. Mention only artifacts in artifacts/markdown using exact links; no internal JSON or invented filenames unless explicitly requested. Do not copy this tool JSON, status, run IDs, dispatch, validation or internal reasoning into chat. Do not query status again after a consistent handoff unless a later action changed state.'};
}
