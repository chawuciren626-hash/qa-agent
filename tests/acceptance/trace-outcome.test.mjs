import test from 'node:test';
import assert from 'node:assert/strict';
import {toolOutcome} from '../../scripts/trace-outcome.mjs';
import {findParentDispatch} from '../../scripts/stage-evidence.mjs';
test('reads legacy and source-platform tool outcomes and rejects ambiguity',()=>{
  for(const status of ['completed','aborted','fatal','retryable']) {
    assert.equal(toolOutcome({stop_reason:status}),status);
    assert.equal(toolOutcome({status}),status);
  }
  assert.equal(toolOutcome({status:'completed',stop_reason:'fatal'}),undefined);
  assert.equal(toolOutcome({status:'invented'}),undefined);
  assert.equal(toolOutcome({}),undefined);
});
test('source trace tool status preserves native parent-child dispatch evidence',()=>{
  const rows=[
    {type:'model_msg',timestamp:'2026-10-26T00:00:01Z',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'call-1',arguments:JSON.stringify({agent_id:'test_point_agent',prompt:'run-demo dispatch-demo'})}},
    {type:'event_msg',timestamp:'2026-10-26T00:00:02Z',payload:{type:'subagent',session_id:'child-demo'}},
    {type:'model_msg',timestamp:'2026-10-26T00:00:03Z',payload:{type:'tool_call_output',tool_call_id:'call-1',status:'completed',output:'done'}},
  ];
  const args={runId:'run-demo',agent:'test_point_agent',childId:'child-demo',dispatchId:'dispatch-demo',dispatchedAt:'2026-10-26T00:00:00Z'};
  assert.equal(findParentDispatch(rows,args)?.tool_call_id,'call-1');
  rows[2].payload.status='fatal';
  assert.equal(findParentDispatch(rows,args),null);
  rows[2].payload.stop_reason='completed';
  assert.equal(findParentDispatch(rows,args),null);
});
