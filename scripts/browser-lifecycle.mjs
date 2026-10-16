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
  assert(/全流程|(?:执行|开始|进行).{0,8}测试|请测试|\b(?:run|perform|execute)\b.*\btests?\b/i.test(text) && !/仅分析|只分析|只(?:生成|编写)|不要(?:执行|测试)|不执行|\b(?:do not|don't)\s+(?:test|execute)\b/i.test(text),'Source must explicitly request execution, not analysis or case generation only');
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
  const item=rows.find(row=>row.case_id===check.case_ref.case_id);
  assert(item && !(item.design_contract?.basis ?? []).some(r=>r.status!=='confirmed') && !(item.design_contract?.assumptions ?? []).some(r=>r.status!=='confirmed'),'Unconfirmed or conflicted case cannot produce a business pass/fail assertion');
}
export function browserCoverage(dir,manifest,results) {
  const file=readRunFile(dir,'design/test_cases.json'),value=JSON.parse(file.data),rows=Array.isArray(value)?value:value.cases ?? value.test_cases;
  assert(file.sha256===currentBrowserAuthorization(manifest)?.design_sha256,'Authorized design changed');
  assert(Array.isArray(rows) && rows.length>0 && new Set(rows.map(r=>r.case_id)).size===rows.length,'Invalid browser design source');
  const linked=new Set(results.cases.filter(row=>!['simulated','simulation_affected'].includes(row.evidence_mode) && row.case_ref?.source_path==='design/test_cases.json' && row.case_ref.source_sha256===file.sha256).map(row=>row.case_ref.case_id));
  return {version:1,run_id:manifest.run_id,design_sha256:file.sha256,designed_cases:rows.length,linked_case_ids:rows.filter(r=>linked.has(r.case_id)).map(r=>r.case_id),untested_cases:rows.filter(r=>!linked.has(r.case_id)).map(r=>({case_id:r.case_id,title:r.title})),note:'关联断言不代表整条设计用例全部步骤已完成；未关联项为未测，不得计为通过。'};
}
export function browserCoverageMarkdown(coverage) {
  const cell=value=>String(value).replace(/[|\r\n<>]/g,' ');
  return ['## 设计覆盖范围',`设计用例：${coverage.designed_cases}；已关联断言的用例：${coverage.linked_case_ids.length}；未测用例：${coverage.untested_cases.length}。`,coverage.note,'','| 未测用例编号 | 标题 |','| --- | --- |',...coverage.untested_cases.map(row=>`| ${cell(row.case_id)} | ${cell(row.title)} |`)].join('\n');
}
