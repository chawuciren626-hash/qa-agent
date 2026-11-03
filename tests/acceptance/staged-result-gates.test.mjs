import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowDefinition } from '../../scripts/stage-registry.mjs';
import { assertStageReady, assertStageHistory } from '../../scripts/orchestration-state.mjs';

test('full lifecycle result review stays separate from execution authorization', () => {
  const stages=workflowDefinition().stages.map(s=>({...s,selected:true}));
  const manifest={orchestration:{plan:{workflow_mode:'lifecycle',stages},events:[]},stages:{},confirmations:[]};
  for(const stage of stages) manifest.stages[stage.id]={status:'planned'};
  for(const id of ['analysis','test_points','test_cases']) {
    manifest.stages[id].status='completed';
    manifest.confirmations.push({stage:id,kind:'result',status:'approved'});
  }
  assert.throws(()=>assertStageReady(manifest,'execution'),/执行前人工批准/);
  manifest.confirmations.push({stage:'execution',kind:'authorization',status:'approved'});
  assert.equal(assertStageReady(manifest,'execution').id,'execution');
  manifest.stages.execution.status='completed';
  assert.throws(()=>assertStageReady(manifest,'defects'),/尚未批准/);
  manifest.confirmations.push({stage:'execution',kind:'result',status:'pending'});
  manifest.stages.execution.status='awaiting_confirmation';
  assert.throws(()=>assertStageReady(manifest,'defects'),/前置阶段未完成/);
  manifest.confirmations.at(-1).status='approved';
  manifest.stages.execution.status='completed';
  manifest.orchestration.events.push({type:'confirmation_resolved',stage:'execution',decision:'approved',kind:'result'});
  assert.doesNotThrow(()=>assertStageHistory(manifest,'execution'));
  assert.equal(assertStageReady(manifest,'defects').id,'defects');
});
