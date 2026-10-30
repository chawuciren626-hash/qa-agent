import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageDefinitions } from '../../scripts/stage-registry.mjs';
import { buildDelegationTaskBrief, renderDelegationTaskBrief } from '../../scripts/delegation-task-brief.mjs';

const manifest={
  delivery:{scope_name:'登录模块'},test_track:{label:'功能'},
  orchestration:{plan:{workflow_mode:'lifecycle',source_mode:'provided_materials',execution_platform:'browser'}}
};
const base={runId:'run-current',dispatchId:'dispatch-current',inputContext:{
  user_messages:[{path:'inputs/user-request.txt',sha256:'user-hash'}],
  attachments:[{path:'inputs/spec.docx',sha256:'attachment-hash'}],warnings:[]
},availableSources:[{path:'analysis/requirement-ledger.json',sha256:'upstream-hash'}],manifest};

test('every professional stage receives an assignment with source lineage and its own acceptance criteria',()=>{
  for(const stage of stageDefinitions) {
    const brief=buildDelegationTaskBrief({...base,stage:stage.id,agent:stage.agent,artifacts:stage.task_artifacts});
    const visible=renderDelegationTaskBrief(brief,{compact:true});
    const full=renderDelegationTaskBrief(brief);
    assert.equal(brief.stage,stage.id);
    assert.equal(brief.agent,stage.agent);
    assert.deepEqual(brief.source_inputs.map(row=>row.path),['inputs/user-request.txt','inputs/spec.docx']);
    assert.deepEqual(brief.upstream_artifacts,[{path:'analysis/requirement-ledger.json',sha256:'upstream-hash'}]);
    assert.deepEqual(brief.deliverables,stage.task_artifacts);
    assert.ok(brief.acceptance.length>=2);
    for(const field of ['【任务】','【目标】','【本次输入】','【有效上游】','【工作】','【交付】','【验收】']) {
      assert.ok(visible.includes(field),`${stage.id}: ${field}`);
    }
    assert.ok(full.startsWith(visible));
    assert.match(full,/upstream-hash/);
    assert.doesNotMatch(visible,/upstream-hash/);
  }
});

test('execution preparation is clearly separate from product testing and unresolved rules remain unresolved',()=>{
  const brief=buildDelegationTaskBrief({...base,stage:'execution',agent:'automation_execution_agent',mode:'prepare',artifacts:['execution/execution-plan.json']});
  const visible=renderDelegationTaskBrief(brief,{compact:true});
  assert.match(visible,/不运行产品测试/);
  assert.match(visible,/脚本准备/);
  assert.deepEqual(brief.deliverables,['execution/execution-plan.json']);
  assert.match(renderDelegationTaskBrief(brief),/保持未决/);
});
