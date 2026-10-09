import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findParentDispatch } from '../../scripts/stage-evidence.mjs';
import { assertChildCommands, childCommandPolicy } from '../../scripts/child-command-policy.mjs';

const request = { runId: 'run-synthetic-a', agent: 'requirement_analysis_agent', childId: 'session-2026-10-09-10-05-30-a8bced7d', dispatchedAt: '2026-10-09T02:05:25.179Z' };
function trace() {
  return [
    { timestamp: '2026-10-09T02:05:30.804Z', type: 'model_msg', payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'call-a', arguments: JSON.stringify({ agent_id: request.agent, prompt: `Analyze ${request.runId}` }) } },
    { timestamp: '2026-10-09T02:05:30.856Z', type: 'event_msg', payload: { type: 'subagent', session_id: request.childId } },
    { timestamp: '2026-10-09T02:05:54.651Z', type: 'model_msg', payload: { type: 'tool_call_output', tool_call_id: 'call-a', output: 'Analysis delivered.', stop_reason: 'completed' } }
  ];
}

test('binds actual PenguinHarness layout with ID in structured event, not response text', () => {
  assert.equal(findParentDispatch(trace(), request)?.tool_call_id, 'call-a');
});

test('new dispatch binding requires the exact dispatch token in the actual child prompt', () => {
  const token = '09fa16d0-676c-4b11-9983-e857606b9a5f';
  const binding = { ...request, dispatchId: token };
  assert.equal(findParentDispatch(trace(), binding), null);
  const rows = trace();
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId} ${token}-old` });
  assert.equal(findParentDispatch(rows, binding), null);
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId} dispatch_id=${token}` });
  assert.equal(findParentDispatch(rows, binding)?.tool_call_id, 'call-a');
});

test('rejects text-only IDs, old or missing events and missing/mismatched responses', () => {
  for (const mutate of [
    rows => { rows.splice(1, 1); rows[1].payload.output = request.childId; },
    rows => { rows[1].timestamp = '2026-10-09T02:05:20Z'; },
    rows => { rows[1].payload.session_id = 'another-session'; },
    rows => { rows.pop(); },
    rows => { rows[2].payload.tool_call_id = 'other-call'; },
    rows => { rows[2].payload.stop_reason = 'fatal'; },
    rows => { rows.push(structuredClone(rows[2])); },
    rows => { rows.splice(1, 0, structuredClone(rows[1])); }
  ]) { const rows = trace(); mutate(rows); assert.equal(findParentDispatch(rows, request), null); }
});

test('rejects wrong agent/run and malformed call arguments or chronology', () => {
  for (const args of [{ agent_id: 'wrong', prompt: request.runId }, { agent_id: request.agent, prompt: `${request.runId}-other` }, '{bad']) {
    const rows = trace(); rows[0].payload.arguments = typeof args === 'string' ? args : JSON.stringify(args);
    assert.equal(findParentDispatch(rows, request), null);
  }
  assert.equal(findParentDispatch(trace(), { ...request, dispatchedAt: '2026-10-09T02:06:00Z' }), null);
});

test('does not guess among overlapping calls, but supports completed sequential calls', () => {
  const rows = trace();
  const other = structuredClone(rows[0]); other.payload.tool_call_id = 'call-b';
  rows.splice(1, 0, other);
  assert.equal(findParentDispatch(rows, request), null);
  const first = trace();
  first[0].payload.tool_call_id = first[2].payload.tool_call_id = 'old';
  first[1].payload.session_id = 'old-session';
  first.forEach(row => { row.timestamp = '2026-10-09T02:00:00Z'; });
  assert.equal(findParentDispatch([...first, ...trace()], request)?.tool_call_id, 'call-a');
});

test('dispatch requires exact stop policy in the actual parent prompt', () => {
  const rows = trace(); const policy = childCommandPolicy('synthetic-token');
  assert.equal(findParentDispatch(rows, { ...request, commandPolicy: policy }), null);
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId}\n${policy}` });
  assert.ok(findParentDispatch(rows, { ...request, commandPolicy: policy }));
  assert.equal(findParentDispatch(rows, { ...request, commandPolicy: childCommandPolicy('other-token') }), null);
});

test('failed, rejected, unknown and timed-out child commands cannot be hidden by later success', () => {
  const pair = (id, output) => [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: id, arguments: JSON.stringify({ cmd: 'node scripts/project-command.mjs run node validate-artifacts.mjs -- run-synthetic analysis' }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output, stop_reason: 'completed' } }
  ];
  const success = JSON.stringify({ status: 'completed', exit_code: 0, result: { termination_confirmed: true } });
  assert.doesNotThrow(() => assertChildCommands(pair('ok', `/etc/profile warning\n${success}`)));
  for (const status of ['failed', 'input_rejected', 'timeout', 'interrupted', 'cleanup_required', 'runner_error']) {
    assert.throws(() => assertChildCommands([...pair('bad', JSON.stringify({ status, exit_code: 2 })), ...pair('ok', success)]));
  }
  assert.throws(() => assertChildCommands(pair('bad', 'unparseable')));
  assert.throws(() => assertChildCommands(pair('bad', success).slice(0, 1)));
  assert.throws(() => assertChildCommands(pair('bad', JSON.stringify({ status: 'completed', exit_code: 0 }))));
});
