import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { getRunContext, withRunLock, assertStageHistory, assertDesignMutable, writeJson } from './orchestration-state.mjs';
import { assertArtifactContract, assertCompletedArtifacts } from './artifact-contracts.mjs';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertContextSession } from './directory-context.mjs';
import { assertPlainPath } from './application-data.mjs';

const keys = ['case_id','module','priority','title','preconditions','steps','expected','actual','status','issues','evidence'];
const editable = new Set(['module','priority','title','preconditions','steps','expected']);
export function caseReviewColumns(root) {
  const template = JSON.parse(readFileSync(resolve(root,'config/test-delivery-template.json'),'utf8'));
  return template.case_headers.map((label,index) => ({ key:(template.case_fields ?? keys)[index], label, editable:editable.has((template.case_fields ?? keys)[index]) }));
}
export function caseRows(data) {
  const rows = Array.isArray(data) ? data : data.cases ?? data.test_cases;
  if (!Array.isArray(rows)) throw Error('用例文件格式不正确');
  return rows;
}
export function caseReviewRow(row) {
  return { id:row.case_id, values:{ case_id:row.case_id, module:row.execution_metadata?.module ?? row.module ?? '未分组', priority:row.priority, title:row.title,
    preconditions:row.preconditions ?? [], steps:row.steps ?? [], test_data:row.test_data ?? {}, expected:row.expected,
    actual:'尚未执行。', status:'未执行', issues:'', evidence:'' } };
}

/** Edits are owner-supplied design changes; no approval or product execution is implied. */
export function updateCaseReview(root, { runId, sessionId, confirmationId, actorId, version, caseId, operation, values }) {
  assertContextSession(root,sessionId);
  if (!['edit','delete'].includes(operation) || typeof caseId !== 'string' || !/^[a-f0-9]{64}$/.test(version ?? '') ||
      !/^[A-Za-z0-9_-]+$/.test(actorId ?? '')) throw Error('用例修改请求无效');
  const project = JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
  return withRunLock(root,project,runId,() => {
    const {manifest,manifestPath} = getRunContext(root,project,runId);
    if (manifest.directory_context?.session_id !== sessionId || manifest.run_id !== runId || manifest.orchestration?.plan?.review_mode !== 'staged') throw Error('任务绑定或审核模式已变化');
    assertDesignMutable(manifest,'test_cases'); assertStageHistory(manifest,'test_cases');
    if (manifest.stages?.test_cases?.status !== 'awaiting_confirmation' || Object.values(manifest.stages).some(stage=>stage.status==='in_progress')) throw Error('当前阶段不处于待确认状态');
    const latest = manifest.confirmations.filter(item=>item.stage==='test_cases').at(-1);
    if (latest?.id !== confirmationId || latest.status !== 'pending' || latest.kind === 'authorization') throw Error('审核版本已变化，请刷新后重试');
    const receipt = assertCompletedArtifacts(root,runId,manifest,'test_cases');
    if (!isDeepStrictEqual(receipt,latest.artifact_contract)) throw Error('待确认产物已变化');
    const dir = runDirectory(root,runId), source = readRunFile(dir,'design/test_cases.json');
    assertPlainPath(dir);
    if (source.sha256 !== version) throw Error('用例已被修改，请刷新后重试');
    const data = JSON.parse(source.data), rows = caseRows(data), index = rows.findIndex(row=>row.case_id===caseId);
    if (index < 0) throw Error('用例不存在');
    const at = new Date().toISOString(), revisionId = randomUUID(), archive = `audit/case-review/${revisionId}`;
    const original = structuredClone(rows[index]);
    const changed = structuredClone(original);
    if (operation==='delete') {
      if (rows.length<=1) throw Error('至少保留一条用例；若需重新设计，请提交阶段修改意见');
      rows.splice(index,1);
    } else {
      if (!values || typeof values!=='object' || Array.isArray(values) || Object.keys(values).some(key=>!editable.has(key) && key!=='test_data')) throw Error('存在不可编辑的字段');
      for (const [key,value] of Object.entries(values)) {
        if (key==='test_data') {
          if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('测试数据须为 JSON 对象');
        } else if (['steps','preconditions'].includes(key)) {
          if (!Array.isArray(value) || value.some(item=>typeof item!=='string' || !item.trim()) || key==='steps' && !value.length) throw Error('步骤和前置条件须逐行填写，步骤不能为空');
        } else if (typeof value!=='string' || !value.trim()) throw Error('字段不能为空');
        if (key==='priority' && !['P0','P1','P2','P3'].includes(value)) throw Error('优先级必须为 P0 至 P3');
        if (key==='module') changed.execution_metadata={...changed.execution_metadata,module:value};
        else changed[key]=value;
      }
      rows[index]=changed;
    }
    // The immutable archive is also the rollback source if export or validation fails.
    assertPlainPath(resolve(dir,archive));
    for (const file of ['design/test_cases.json','design/test_cases.xlsx','design/test_cases-task.json','design/test_cases-review.json','inputs']) assertPlainPath(resolve(dir,file));
    mkdirSync(resolve(dir,archive),{recursive:true});
    const before = new Map(receipt.files.filter(file=>file.path.startsWith('design/test_cases')).map(file=>[file.path,readRunFile(dir,file.path).data]));
    before.set('manifest.json',readRunFile(dir,'manifest.json').data);
    for (const [file,bytes] of before) { mkdirSync(resolve(dir,archive,file,'..'),{recursive:true}); writeFileSync(resolve(dir,archive,file),bytes,{flag:'wx'}); }
    const feedbackPath=`inputs/case-review-${revisionId}.txt`;
    const reviewPath='design/test_cases-review.json';
    const reviewBefore=before.get(reviewPath);
    let wroteFeedback=false;
    try {
      if (operation==='delete') {
        const review=reviewBefore?JSON.parse(reviewBefore):{run_id:runId,deletions:[]};
        review.deletions.push({case_id:caseId,test_point:original.related_test_point ?? null,actor_user_id:actorId,at,archive});
        writeJson(resolve(dir,reviewPath),review);
        if (!manifest.artifacts.includes(reviewPath)) manifest.artifacts.push(reviewPath);
      }
      if (operation==='edit' && changed.expected!==original.expected && Array.isArray(changed.expected_basis)) {
        mkdirSync(resolve(dir,'inputs'),{recursive:true});
        writeFileSync(resolve(dir,feedbackPath),changed.expected,{flag:'wx'}); wroteFeedback=true;
        changed.expected_basis=[{expected:changed.expected,kind:'requirement',source_path:feedbackPath,quote:changed.expected}];
        const taskPath='design/test_cases-task.json';
        if (before.has(taskPath)) { const task=JSON.parse(before.get(taskPath));task.source_paths=[...new Set([...task.source_paths,feedbackPath])];writeJson(resolve(dir,taskPath),task); }
      }
      const taskPath='design/test_cases-task.json';
      if (before.has(taskPath)) {
        const task=JSON.parse(readFileSync(resolve(dir,taskPath),'utf8'));
        task.summary=`用户已${operation==='delete'?'删除':'编辑'}用例 ${caseId}；当前共 ${rows.length} 条用例，等待确认。`;
        writeJson(resolve(dir,taskPath),task);
      }
      writeJson(resolve(dir,'design/test_cases.json'),data);
      const exported=spawnSync(process.execPath,[resolve(root,'scripts/generate-test-cases-xlsx.mjs'),resolve(dir,'design/test_cases.json'),resolve(dir,'design/test_cases.xlsx')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000});
      if (exported.error || exported.status!==0) throw Error('用例 Excel 更新失败，原版本已保留');
      // A previously authored prose copy is archived rather than left as stale current output.
      manifest.artifacts=manifest.artifacts.filter(file=>file!=='design/test_cases.md');
      const nextReceipt=assertArtifactContract(root,runId,'test_cases',{artifacts:manifest.artifacts.filter(file=>file.startsWith('design/test_cases'))});
      const previous=manifest.orchestration.events.filter(event=>event.type==='completed' && event.stage==='test_cases').at(-1);
      latest.status='revision_requested';latest.resolved_at=at;latest.reason='用户在结果列表修改用例';latest.actor_user_id=actorId;
      const nextId=`confirm-${randomUUID()}`;
      manifest.orchestration.events.push({type:'completed',stage:'test_cases',at,'dispatch-id':previous?.['dispatch-id'],evidence:{...previous?.evidence,artifact_contract:nextReceipt},origin:'human_case_review',actor_user_id:actorId,archive,operation,case_id:caseId,supersedes_confirmation:confirmationId});
      manifest.confirmations.push({...latest,id:nextId,status:'pending',requested_at:at,resolved_at:undefined,reason:undefined,artifact_contract:nextReceipt,supersedes:confirmationId});
      manifest.orchestration.events.push({type:'confirmation_requested',stage:'test_cases',at,confirmation_id:nextId,kind:'result'});
      manifest.stages.test_cases.updated_at=at;manifest.updated_at=at;
      writeJson(manifestPath,manifest);
      return {status:'saved',confirmationId:nextId,starts_execution:false};
    } catch(error) {
      for (const [file,bytes] of before) writeFileSync(resolve(dir,file),bytes);
      if (wroteFeedback) unlinkSync(resolve(dir,feedbackPath));
      if (operation==='delete' && !reviewBefore) unlinkSync(resolve(dir,reviewPath));
      throw error;
    }
  });
}
