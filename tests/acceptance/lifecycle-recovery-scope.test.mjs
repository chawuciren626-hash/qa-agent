import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRecoveryDecisions, currentStageDecision } from '../../scripts/orchestration-state.mjs';
import { matchingDispatchCalls, findParentDispatch } from '../../scripts/stage-evidence.mjs';

test('recovery respects current dependency decisions, not superseded or unrelated history', () => {
  const manifest = {orchestration:{plan:{stages:[{id:'test_cases',depends_on:['analysis']},{id:'report',depends_on:[]}]}},
    confirmations:[{stage:'analysis',status:'revision_requested'},{stage:'analysis',status:'approved'},{stage:'report',status:'pending'}]};
  assert.doesNotThrow(() => assertRecoveryDecisions(manifest,'test_cases'));
  manifest.confirmations.push({stage:'analysis',status:'rejected'});
  assert.throws(() => assertRecoveryDecisions(manifest,'test_cases'),/analysis rejected/);
  assert.throws(() => assertRecoveryDecisions(manifest,'report'),/report pending/);
});

test('only a recorded revision dispatch consumes a revision request, never a rejection', () => {
  const manifest={stages:{analysis:{dispatch_id:'new'}},confirmations:[{stage:'analysis',status:'revision_requested'}],
    orchestration:{events:[{type:'confirmation_resolved',stage:'analysis',decision:'revision_requested'},
      {type:'dispatched',stage:'analysis',dispatch_id:'new',revision_context:{archive:'audit/revisions/new'}}]}};
  assert.equal(currentStageDecision(manifest,'analysis'),null);
  manifest.confirmations[0].status='rejected';
  assert.equal(currentStageDecision(manifest,'analysis').status,'rejected');
  manifest.confirmations[0].status='revision_requested';
  delete manifest.orchestration.events[1].revision_context;
  assert.equal(currentStageDecision(manifest,'analysis').status,'revision_requested');
});

test('current dispatch binding ignores other runs, malformed unrelated calls and older same-role attempts', () => {
  const at='2026-10-20T00:00:00Z',dispatch={dispatch_id:'dispatch-current',agent:'test_case_agent',at};
  const call=(id,run,token)=>({type:'model_msg',timestamp:at,payload:{type:'tool_call',name:'run_subagent',tool_call_id:id,
    arguments:{agent_id:dispatch.agent,prompt:`${run} ${token} policy-current`}}});
  const rows=[call('old','run-current','dispatch-old'),call('foreign','run-other','dispatch-other'),
    {type:'model_msg',timestamp:at,payload:{type:'tool_call',name:'run_subagent',arguments:'{"agent_id":'}},
    call('current','run-current',dispatch.dispatch_id),
    {type:'event_msg',timestamp:at,payload:{type:'subagent',session_id:'child-current'}},
    {type:'model_msg',timestamp:at,payload:{type:'tool_call_output',tool_call_id:'current',stop_reason:'completed',output:'done'}}];
  assert.deepEqual(matchingDispatchCalls(rows,'run-current',dispatch).map(row=>row.payload.tool_call_id),['current']);
  assert.equal(findParentDispatch(rows,{runId:'run-current',agent:dispatch.agent,dispatchId:dispatch.dispatch_id,
    childId:'child-current',dispatchedAt:at,commandPolicy:'policy-current'}).tool_call_id,'current');
  rows.push(call('duplicate','run-current',dispatch.dispatch_id));
  assert.equal(matchingDispatchCalls(rows,'run-current',dispatch).length,2);
});
