import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRunFile, runDirectory } from './design-quality.mjs';

const assert=(ok,message)=>{if(!ok) throw new Error(message);};
export function browserLifecycle(manifest) {
  return manifest.orchestration?.plan?.workflow_mode==='lifecycle' && manifest.orchestration?.execution_strategy==='browser';
}
export function usesBrowserArtifacts(root,runId,stage) {
  if(!['execution','defects','report'].includes(stage)) return false;
  const dir=runDirectory(root,runId);
  return existsSync(resolve(dir,'manifest.json')) && browserLifecycle(JSON.parse(readRunFile(dir,'manifest.json').data));
}
export function browserAuthorization(root,runId,parent,rows,text) {
  const source=rows.filter(r=>r.type==='model_msg' && r.payload?.type==='text' && r.payload.role==='user' && r.payload.sender!=='harness' && r.payload.text===text).at(-1);
  assert(source && Number.isFinite(Date.parse(source.timestamp)), 'Browser execution needs the exact native user request, not a controller summary');
  assert(/全流程|(?:执行|开始|进行).{0,40}测试|请测试|\b(?:run|perform|execute)\b.*\btests?\b/i.test(text) && !/仅分析|只分析|只(?:生成|编写)|不要(?:执行|测试)|不执行|\b(?:do not|don't)\s+(?:test|execute)\b/i.test(text),'Source must explicitly request execution, not analysis or case generation only');
  const urls=[...new Set((text.match(/https?:\/\/[^\s<>"\]）。，]+/g) ?? []).map(value=>new URL(value).href))];
  assert(urls.length>0,'Native browser authorization must identify the target URL');
  const dir=runDirectory(root,runId);
  for(const path of ['execution/execution-state.json','execution/browser-state.json','execution/test_results.json','execution/exploration.lock','execution/browser-private.json']) assert(!existsSync(resolve(dir,path)), 'Existing execution must not be restarted through browser dispatch');
  const design=readRunFile(dir,'design/test_cases.json');
  const later=rows.slice(rows.indexOf(source)+1).filter(r=>r.type==='model_msg' && r.payload?.type==='text' && r.payload.role==='user' && r.payload.sender!=='harness');
  assert(!later.some(r=>/不要(?:继续|执行|测试)|取消测试|停止测试|暂停测试|不执行|\b(?:stop|cancel)\b/i.test(r.payload.text ?? '')), 'A later user stop overrides the earlier authorization');
  return {kind:'native_user_message',session_id:parent,timestamp:source.timestamp,sha256:createHash('sha256').update(text).digest('hex'),urls,design_sha256:design.sha256};
}
export function currentBrowserAuthorization(manifest) {
  return manifest.orchestration?.events?.filter(e=>e.stage==='execution' && e.type==='dispatched' && e.browser_authorization).at(-1)?.browser_authorization;
}
export function browserCasePlan(dir, manifest) {
  assert(browserLifecycle(manifest),'Case plan is only for lifecycle browser execution');
  const file=readRunFile(dir,'design/test_cases.json');
  assert(file.sha256===currentBrowserAuthorization(manifest)?.design_sha256,'Authorized design changed');
  const value=JSON.parse(file.data);
  const all=Array.isArray(value)?value:value.cases ?? value.test_cases;
  assert(Array.isArray(all) && all.length>0,'Browser execution requires designed cases');
  const rows=all.filter(row=>row.execution_layer!=='api');
  assert(rows.length>0 && new Set(rows.map(row=>row.case_id)).size===rows.length,'Browser case IDs must be unique');
  return {
    version:1,run_id:manifest.run_id,source_path:'design/test_cases.json',design_sha256:file.sha256,
    cases:rows.map((row,index)=>({
      order:index+1,case_id:row.case_id,title:row.title,
      readiness:(row.design_contract?.basis ?? []).some(r=>r.status!=='confirmed') ||
        (row.design_contract?.assumptions ?? []).some(r=>r.status!=='confirmed')?'pending_business_confirmation':
        row.automation_feasible===false?'manual_pending':'ready',
      priority:row.priority ?? null,preconditions:row.preconditions ?? [],test_data:row.test_data ?? {},
      steps:row.steps ?? [],expected:row.expected ?? null,expected_basis:row.expected_basis ?? null,
      automation_feasible:row.automation_feasible ?? null
    })),
    instruction:'Execute ready cases in this order. Preserve every designed step and expected clause; record any unperformed step as untested. A linked assertion alone does not complete a case.'
  };
}
export function assertBrowserTarget(root,runId,manifest,url) {
  if(!browserLifecycle(manifest)) return;
  const auth=currentBrowserAuthorization(manifest);
  assert(auth?.kind==='native_user_message','Missing native browser authorization');
  assert(readRunFile(runDirectory(root,runId),'design/test_cases.json').sha256===auth.design_sha256,'Design changed after browser authorization');
  assert(auth.urls.some(value=>new URL(value).origin===new URL(url).origin),'Target origin is outside the native user request');
}
export function assertBrowserDesignCheck(dir,manifest,check) {
  if(!browserLifecycle(manifest)) return;
  assert(check.case_ref?.source_path==='design/test_cases.json','Lifecycle assertions must reference the authorized design case; retain unmatched observations without inventing passing cases');
  const value=JSON.parse(readRunFile(dir,'design/test_cases.json').data),rows=Array.isArray(value)?value:value.cases ?? value.test_cases;
  const item=rows.find(row=>row.case_id===check.case_ref.case_id && row.execution_layer!=='api');
  assert(item && !(item.design_contract?.basis ?? []).some(r=>r.status!=='confirmed') && !(item.design_contract?.assumptions ?? []).some(r=>r.status!=='confirmed'),'Unconfirmed or conflicted case cannot produce a business pass/fail assertion');
}
export function browserCoverage(dir,manifest,results,caseReviews=[]) {
  const file=readRunFile(dir,'design/test_cases.json'),value=JSON.parse(file.data),allRows=Array.isArray(value)?value:value.cases ?? value.test_cases,rows=Array.isArray(allRows)?allRows.filter(r=>r.execution_layer!=='api'):allRows;
  assert(file.sha256===currentBrowserAuthorization(manifest)?.design_sha256,'Authorized design changed');
  assert(Array.isArray(rows) && rows.length>0 && new Set(rows.map(r=>r.case_id)).size===rows.length,'Invalid browser design source');
  const linked=new Set(results.cases.filter(row=>!['simulated','simulation_affected'].includes(row.evidence_mode) && row.case_ref?.source_path==='design/test_cases.json' && row.case_ref.source_sha256===file.sha256).map(row=>row.case_ref.case_id));
  assert(Array.isArray(caseReviews) && new Set(caseReviews.map(r=>r.case_id)).size===caseReviews.length,'Duplicate case review');
  const reviews=new Map(caseReviews.map(r=>[r.case_id,r]));
  assert(caseReviews.every(r=>rows.some(row=>row.case_id===r.case_id)),'Case review references an unknown design case');
  const complete=[];const incomplete=[];
  for(const row of rows) {
    const review=reviews.get(row.case_id),steps=Array.isArray(row.steps)?row.steps:[];
    const indices=review?.completed_step_indices ?? [];
    assert(Array.isArray(indices) && indices.every(i=>Number.isInteger(i) && i>=1 && i<=steps.length) && new Set(indices).size===indices.length,'Invalid completed step indices');
    assert(review?.untested===undefined || Array.isArray(review.untested) && review.untested.every(s=>typeof s==='string' && s.trim()),'Invalid case untested list');
    const missing=steps.map((_,i)=>i+1).filter(i=>!indices.includes(i));
    const done=linked.has(row.case_id) && !!review && !missing.length && !(review.untested ?? []).length;
    if(done)complete.push(row.case_id);
    else incomplete.push({case_id:row.case_id,title:row.title,reason:!linked.has(row.case_id)?'no_linked_assertion':!review?'no_step_review':missing.length?'steps_not_completed':'reported_untested',missing_step_indices:missing});
  }
  return {version:2,run_id:manifest.run_id,design_sha256:file.sha256,designed_cases:rows.length,linked_case_ids:rows.filter(r=>linked.has(r.case_id)).map(r=>r.case_id),case_reviews:caseReviews,completed_case_ids:complete,incomplete_cases:incomplete,untested_cases:rows.filter(r=>!linked.has(r.case_id)).map(r=>({case_id:r.case_id,title:r.title})),note:'完成用例仅表示执行者复核了设计步骤且有关联断言；通过或失败仍以原始断言为准。未复核完整步骤的用例保持部分完成。'};
}
export function browserCoverageMarkdown(coverage) {
  const cell=value=>String(value).replace(/[|\r\n<>]/g,' ');
  const incomplete=coverage.incomplete_cases ?? coverage.untested_cases;
  return ['## 设计覆盖范围',`设计用例：${coverage.designed_cases}；已关联断言的用例：${coverage.linked_case_ids.length}；完整复核用例：${coverage.completed_case_ids?.length ?? 0}；未完整执行用例：${incomplete.length}。`,coverage.note,'','| 未完整执行用例编号 | 标题 | 原因 |','| --- | --- | --- |',...incomplete.map(row=>`| ${cell(row.case_id)} | ${cell(row.title)} | ${cell(row.reason ?? '未关联断言')} |`)].join('\n');
}
