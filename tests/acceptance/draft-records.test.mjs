import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { draftRecords, reuseDesignArtifact } from '../../scripts/draft-records.mjs';
import { executeAction, actionCatalog } from '../../scripts/structured-actions.mjs';
import { guardControllerTool } from '../../scripts/controller-tool-guard.mjs';
import { recordedChildHandle } from '../../scripts/stage-evidence.mjs';
const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(stage = 'test_cases', parent = 'session-2026-10-16-00-00-00-abcdef') {
  const run_id = `run-${randomUUID()}`, dir = resolve(root, 'output/runs', run_id);
  for (const name of ['inputs', 'design', 'audit']) mkdirSync(resolve(dir, name), { recursive: true });
  const dispatch_id = randomUUID();
  const manifest = { run_id, stages: { [stage]: { status: 'in_progress', dispatch_id } },
    orchestration: { events: [{ stage, type: 'dispatched', dispatch_id, 'parent-session-id': parent }] } };
  const put = (path, value) => writeFileSync(resolve(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  put('manifest.json', manifest); put('audit/user-input-context.json', { session_id: parent });
  const act = operation => draftRecords(root, parent, { run_id, stage, operation });
  const upsert = (entries, base_sha256 = 'missing', request_id = randomUUID(), extra = {}) => act({ type: 'upsert', request_id, base_sha256, entries, ...extra });
  return { run_id, dir, parent, manifest, put, act, upsert };
}
test('batches append/update stable IDs without replacing unrelated records or source wrapper', () => {
  const f = fixture();
  f.put('design/test_cases.json', { run_id: f.run_id, custom: 'keep', cases: [{ case_id: 'C1', title: 'first' }, { case_id: 'C2', title: 'second' }] });
  const base = f.act({ type: 'inspect', ids: ['C1'] });
  assert.equal(base.count, 2); assert.equal(base.entries.length, 1);
  const next = f.upsert([{ case_id: 'C1', title: 'updated' }, { case_id: 'C3', title: 'third' }], base.sha256);
  assert.deepEqual(next.ids, ['C1', 'C2', 'C3']);
  const saved = JSON.parse(readFileSync(resolve(f.dir, 'design/test_cases.json')));
  assert.equal(saved.custom, 'keep'); assert.equal(saved.cases[1].title, 'second');
  assert.equal(JSON.parse(readFileSync(resolve(f.dir, next.audit))).before_sha256, base.sha256);
});
test('replayed batches are idempotent even after a later batch, and changed request IDs cannot overwrite', () => {
  const f = fixture(), entries = [{ case_id: 'C1', title: 'one' }];
  const first = f.upsert(entries, 'missing', 'batch1');
  const later = f.upsert([{ case_id: 'C2' }], first.sha256, 'batch2');
  const replay = f.upsert(entries, 'missing', 'batch1');
  assert.equal(replay.already_applied, true); assert.equal(replay.sha256, later.sha256);
  assert.throws(() => f.upsert([{ case_id: 'changed' }], 'missing', 'batch1'), /内容发生变化/);
  assert.throws(() => f.upsert([{ case_id: 'C3' }], first.sha256), /版本冲突/);
  assert.equal(f.act({ type: 'inspect' }).count, 2);
});
test('invalid batches and malformed JSON preserve last saved bytes', () => {
  const f = fixture();
  const first = f.upsert([{ case_id: 'C1' }]);
  for (const entries of [[{ case_id: 'C1' }, { case_id: 'C1' }], [{ id: 'wrong' }], Array.from({ length: 21 }, (_, i) => ({ case_id: String(i) }))]) {
    assert.throws(() => f.upsert(entries, first.sha256));
  }
  assert.equal(f.act({ type: 'inspect' }).sha256, first.sha256);
  f.put('design/test_cases.json', '{bad');
  assert.throws(() => f.act({ type: 'inspect' }), /JSON不可解析/);
  assert.equal(readFileSync(resolve(f.dir, 'design/test_cases.json'), 'utf8'), '{bad');
});
test('program-generated Unicode boundary strings report real lengths without claiming business validity', () => {
  const f = fixture();
  const result = f.upsert([{ case_id: 'C1', test_data: { keep: 'yes' } }], 'missing', 'sample', { samples: [{ case_id: 'C1', key: 'name', unit: '\u{1F600}', count: 3 }] });
  const data = result.measurements.find(item => item.key === 'name');
  assert.equal(data.code_points, 3); assert.equal(data.utf16, 6); assert.equal(data.utf8_bytes, 12);
  assert.equal(result.validation_required, true);
  assert.throws(() => f.upsert([{ case_id: 'C1' }], result.sha256, 'bad-sample', { samples: [{ case_id: 'C1', key: '__proto__', unit: 'x', count: 1 }] }));
});
test('completed, foreign-owned and confirmed stages cannot be rewritten and execution has no batch writer', () => {
  for (const change of [m => m.stages.test_cases.status = 'completed', m => m.orchestration.events[0]['parent-session-id'] = 'other', m => m.confirmations = [{ stage: 'test_cases', status: 'approved' }]]) {
    const f = fixture(); change(f.manifest); f.put('manifest.json', f.manifest);
    assert.throws(() => f.upsert([{ case_id: 'C1' }]));
    assert.equal(existsSync(resolve(f.dir, 'design/test_cases.json')), false);
  }
  const f = fixture('execution'); assert.throws(() => f.upsert([{ case_id: 'C1' }]), /仅支持/);
});
test('interruption after atomic save is recognized without reapplying the batch', () => {
  const f = fixture(), entries = [{ case_id: 'C1' }];
  const first = f.upsert(entries, 'missing', 'batch');
  const record = JSON.parse(readFileSync(resolve(f.dir, first.audit))); record.status = 'prepared'; f.put(first.audit, record);
  assert.equal(f.upsert(entries, 'missing', 'batch').already_applied, true);
  assert.equal(JSON.parse(readFileSync(resolve(f.dir, first.audit))).status, 'applied');
});
test('seed initializes from local input without retyping and never imports completion or overwrites a draft', () => {
  const f = fixture(); f.put('inputs/cases.json', { run_id: 'run-old', cases: [{ case_id: 'C1', title: 'old' }] });
  const op = { type: 'seed', request_id: 'seed', base_sha256: 'missing', source_path: 'inputs/cases.json' };
  const result = f.act(op); assert.equal(result.count, 1);
  assert.equal(JSON.parse(readFileSync(resolve(f.dir, 'design/test_cases.json'))).run_id, f.run_id);
  assert.equal(JSON.parse(readFileSync(resolve(f.dir, 'manifest.json'))).stages.test_cases.status, 'in_progress');
  assert.equal(f.act(op).already_applied, true);
  assert.throws(() => f.act({ ...op, request_id: 'other' }), /版本冲突/);
  assert.throws(() => f.act({ ...op, source_path: 'inputs/../manifest.json' }));
});
function reusable() {
  const source = fixture(), target = fixture();
  const bytes = '[\r\n  {"case_id":"C1","title":"original"}\r\n]\r\n';
  source.put('design/test_cases.json', bytes);
  source.manifest.stages.test_cases.status = 'completed';
  source.manifest.orchestration.events.push({ type: 'completed', stage: 'test_cases', 'parent-session-id': source.parent,
    evidence: { artifact_contract: { files: [{ path: 'design/test_cases.json', sha256: hash(bytes) }] } } });
  source.put('manifest.json', source.manifest); target.manifest.stages = {}; target.put('manifest.json', target.manifest);
  const request = { run_id: target.run_id, stage: 'test_cases', source_run_id: source.run_id, name: 'reused.json' };
  return { source, target, request, bytes, run: () => reuseDesignArtifact(root, target.parent, request) };
}
test('reuse copies original bytes and provenance into inputs, not stage outputs or execution approval', () => {
  const f = reusable(), result = f.run();
  assert.equal(readFileSync(resolve(f.target.dir, result.path), 'utf8'), f.bytes);
  assert.equal(result.approval_granted, false); assert.equal(result.execution_started, false);
  assert.deepEqual(f.run(), result);
  assert.equal(existsSync(resolve(f.target.dir, 'design/test_cases.json')), false);
});
test('reuse rejects stale seals, cross-session sources, active readers and output collisions', () => {
  for (const mutate of [f => f.source.put('design/test_cases.json', '[{"case_id":"changed"}]'),
    f => { f.source.manifest.orchestration.events.at(-1)['parent-session-id'] = 'other'; f.source.put('manifest.json', f.source.manifest); },
    f => { f.target.manifest.stages = { test_cases: { status: 'in_progress' } }; f.target.put('manifest.json', f.target.manifest); },
    f => f.target.put('inputs/reused.json', 'different')]) {
    const f = reusable(); mutate(f); assert.throws(f.run);
  }
});
test('test points use their own ID contract and retain every other record', () => {
  const f = fixture('test_points'); const a = f.upsert([{ id: 'P1' }, { id: 'P2' }]);
  const b = f.upsert([{ id: 'P1', description: 'changed' }], a.sha256);
  assert.deepEqual(b.ids, ['P1', 'P2']); assert.equal(b.path, 'design/test_points.json');
});
test('large designs retain all batches and an interrupted pre-save batch can resume from its saved base', () => {
  const f = fixture(); let base = 'missing';
  for (let batch = 0; batch < 6; batch++) {
    const entries = Array.from({ length: 10 }, (_, i) => ({ case_id: `C${batch * 10 + i}`, title: 'Retained' }));
    const result = f.upsert(entries, base, `batch-${batch}`);
    assert.equal(result.count, (batch + 1) * 10); base = result.sha256;
  }
  const before = readFileSync(resolve(f.dir, 'design/test_cases.json'));
  const entries = [{ case_id: 'C3', title: 'Local revision' }], saved = f.upsert(entries, base, 'revision');
  const record = JSON.parse(readFileSync(resolve(f.dir, saved.audit))); record.status = 'prepared'; f.put(saved.audit, record);
  writeFileSync(resolve(f.dir, 'design/test_cases.json'), before);
  const resumed = f.upsert(entries, base, 'revision');
  assert.equal(resumed.count, 60); assert.equal(resumed.sha256, saved.sha256);
  assert.equal(f.act({ type: 'inspect', ids: ['C3'] }).entries[0].title, 'Local revision');
});
test('approved delivered source can be reused but nonexistent seeds and source runs are correctable', () => {
  const f = reusable();
  f.source.manifest.orchestration.events.push({ stage: 'test_cases', type: 'confirmation_resolved', decision: 'approved' });
  f.source.put('manifest.json', f.source.manifest);
  assert.equal(f.run().sha256, hash(f.bytes));
  assert.throws(() => reuseDesignArtifact(root, f.target.parent, { ...f.request, source_run_id: `run-${randomUUID()}` }), /来源run不存在/);
  const g = fixture(); assert.throws(() => g.act({ type: 'seed', request_id: 'seed', base_sha256: 'missing', source_path: 'inputs/missing.json' }), /seed来源不存在/);
});
test('child handle comes only from the matching native tool return, not session suffixes or user messages', () => {
  const dispatch = { agent: 'test_case_agent', dispatch_id: 'dispatch-123', child_command_policy: 'policy-123', at: '2026-10-16T00:00:00Z' };
  const call = { type: 'model_msg', timestamp: '2026-10-16T00:00:01Z', payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'tool-1', arguments: { agent_id: dispatch.agent, prompt: 'run-abc dispatch-123 policy-123' } } };
  const output = { type: 'model_msg', timestamp: '2026-10-16T00:00:02Z', payload: { type: 'tool_call_output', tool_call_id: 'tool-1', stop_reason: 'completed', output: '[subagent running with subagent_id subagent-native42; use input_subagent to poll for progress or send a follow-up prompt]' } };
  assert.equal(recordedChildHandle([call], dispatch, 'run-abc').subagent_id, null);
  assert.equal(recordedChildHandle([call, { ...output, payload: { ...output.payload, type: 'text', role: 'user' } }], dispatch, 'run-abc').subagent_id, null);
  assert.equal(recordedChildHandle([call, output], dispatch, 'run-other').subagent_id, null);
  const result = recordedChildHandle([call, output], dispatch, 'run-abc');
  assert.equal(result.subagent_id, 'subagent-native42'); assert.equal(result.completion_verified, false);
  const unknown = { type: 'model_msg', payload: { type: 'tool_call_output', output: '[input_subagent error: unknown subagent_id subagent-native42 (not from this conversation)]' } };
  assert.equal(recordedChildHandle([call, output, unknown], dispatch, 'run-abc').subagent_id, null);
});
test('structured entry routes batches and safe conflicts without stopping the controller; parent cannot author drafts', async () => {
  const parent = `session-2026-10-16-00-00-00-${randomUUID().replaceAll('-', '')}`;
  const f = fixture('test_cases', parent), agentRoot = resolve(root, 'output/acceptance', randomUUID());
  const trace = resolve(agentRoot, 'test_agent/traces/2026-10-16'); mkdirSync(trace, { recursive: true });
  writeFileSync(resolve(trace, `${parent}_001.jsonl`), JSON.stringify({ type: 'session_meta', payload: { session_id: parent, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } }));
  const request = { action: 'draft_records', run_id: f.run_id, stage: 'test_cases', operation: { type: 'upsert', request_id: 'one', base_sha256: 'missing', entries: [{ case_id: 'C1' }] } };
  const execute = value => executeAction(root, parent, () => JSON.stringify(value), { agentRoot });
  assert.equal((await execute(request)).exit_code, 0);
  const conflict = await execute({ ...request, operation: { ...request.operation, request_id: 'two' } });
  assert.equal(conflict.classification, 'input_rejected'); assert.equal(conflict.recovery.retry_allowed, true);
  await execute({ ...request, operation: { ...request.operation, request_id: 'three' } });
  const stalled = await execute({ ...request, operation: { ...request.operation, request_id: 'four' } });
  assert.equal(stalled.recovery.stalled, true);
  assert.equal((await execute({ ...request, operation: { type: 'inspect' } })).exit_code, 0);
  mkdirSync(resolve(root, 'output/action-requests'), { recursive: true });
  const path = `output/action-requests/${randomUUID()}.json`; writeFileSync(resolve(root, path), JSON.stringify(request));
  assert.equal(guardControllerTool(root, { tool_name: 'exec_command', session_id: parent, arguments: { cmd: `node scripts/project-action.mjs execute --controller-session=${parent} --request=${path}` } }).decision, 'deny');
  assert.ok(actionCatalog(root).actions.reuse_design);
});
