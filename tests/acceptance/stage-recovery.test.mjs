import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
function fixture() {
  const id = `run-recovery-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', id);
  const agentRoot = resolve(dir, 'synthetic-agents');
  const parent = `session-2026-10-09-16-00-00-${randomUUID().replaceAll('-', '')}`;
  const env = { ...process.env, PENGUIN_AGENT_ROOT: agentRoot };
  const call = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, env, encoding: 'utf8' });
  const ok = (script, args) => { const result = call(script, args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  ok('create-run', [`--run-id=${id}`]);
  writeFileSync(resolve(dir, 'inputs/fixture-origin.json'), JSON.stringify({ source: 'synthetic stage recovery; no real Agent or user approval' }));
  writeFileSync(resolve(dir, 'inputs/recovery.md'), 'Synthetic cleanup and authorized recovery review. Not an actual user approval.');
  ok('plan-run', [`--run-id=${id}`, '--stages=analysis']);
  const trace = (agent, session, rows) => {
    const folder = resolve(agentRoot, agent, 'traces/2026-10-09'); mkdirSync(folder, { recursive: true });
    const path = resolve(folder, `${session}_001.jsonl`);
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return path;
  };
  const parentFile = trace('test_agent', parent, [{ type: 'session_meta', payload: { session_id: parent, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } }]);
  const manifestPath = resolve(dir, 'manifest.json');
  const read = () => JSON.parse(readFileSync(manifestPath));
  const hash = () => createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  const dispatchArgs = [id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis', `--parent-session-id=${parent}`];
  const dispatch = () => ok('record-orchestration-event', dispatchArgs).event.dispatch_id;
  const block = token => ok('record-orchestration-event', [id, 'blocked', '--stage=analysis', `--parent-session-id=${parent}`, `--dispatch-id=${token}`, '--reason=synthetic-failure']);
  const recovery = () => [id, 'analysis', `--expected-sha256=${hash()}`, '--actor=synthetic-reviewer', '--reason=synthetic-recovery', '--approval-ref=synthetic-only', '--evidence=inputs/recovery.md', `--parent-session-id=${parent}`];
  return { id, dir, env, agentRoot, parent, parentFile, trace, call, ok, read, hash, manifestPath, dispatchArgs, dispatch, block, recovery };
}

test('controlled recovery preserves history and artifacts, invalidates approvals, and requires a fresh dispatch', () => {
  const f = fixture(); const token = f.dispatch(); f.block(token);
  const state = f.read();
  state.confirmations = [{ stage: 'analysis', status: 'approved', id: 'synthetic-old' }];
  writeFileSync(f.manifestPath, JSON.stringify(state));
  writeFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'), 'Synthetic original observation');
  const result = f.ok('recover-stage', f.recovery());
  assert.equal(result.status, 'revision_requested'); assert.equal(result.starts_execution, false);
  const recovered = f.read();
  assert.deepEqual(recovered.orchestration.events.slice(0, -1), state.orchestration.events);
  const event = recovered.orchestration.events.at(-1);
  assert.equal(event.from, 'blocked'); assert.equal(event.previous_stage.dispatch_id, token);
  assert.equal(recovered.confirmations[0].status, 'superseded');
  assert.equal(readFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'), 'utf8'), 'Synthetic original observation');
  const next = f.dispatch(); assert.notEqual(next, token);
  const before = f.hash();
  const stale = f.call('record-orchestration-event', [f.id, 'blocked', '--stage=analysis', `--parent-session-id=${f.parent}`, `--dispatch-id=${token}`, '--reason=old-dispatch']);
  assert.notEqual(stale.status, 0); assert.equal(f.hash(), before);
  f.block(next);
});

test('recovery fails closed for stale revision, missing evidence, outside paths, active state and legacy dispatch', () => {
  const f = fixture(); const token = f.dispatch();
  assert.notEqual(f.call('recover-stage', f.recovery()).status, 0);
  f.block(token); const baseline = readFileSync(f.manifestPath);
  const deny = args => { const before = f.hash(); assert.notEqual(f.call('recover-stage', args).status, 0); assert.equal(f.hash(), before); };
  deny(f.recovery().map(arg => arg.startsWith('--expected-sha256=') ? '--expected-sha256=old' : arg));
  deny(f.recovery().filter(arg => !arg.startsWith('--approval-ref=')));
  deny(f.recovery().map(arg => arg.startsWith('--evidence=') ? '--evidence=../escape.md' : arg));
  writeFileSync(resolve(f.dir, 'execution/execution.lock.json'), '{}'); deny(f.recovery()); unlinkSync(resolve(f.dir, 'execution/execution.lock.json'));
  const state = f.read(); delete state.orchestration.events.find(e => e.type === 'dispatched').dispatch_id;
  writeFileSync(f.manifestPath, JSON.stringify(state)); deny(f.recovery());
  writeFileSync(f.manifestPath, baseline);
  state.confirmations = [{ stage: 'analysis', status: 'rejected' }]; writeFileSync(f.manifestPath, JSON.stringify(state)); deny(f.recovery());
});

test('active or unknown child termination blocks recovery, ended child permits audited recovery', () => {
  const f = fixture(); const token = f.dispatch(); f.block(token);
  const childId = `session-2026-10-09-16-01-00-${randomUUID().replaceAll('-', '')}`;
  const at = new Date(Date.now() + 1000).toISOString();
  const rows = [
    { timestamp: at, type: 'model_msg', payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'synthetic-call', arguments: JSON.stringify({ agent_id: 'requirement_analysis_agent', prompt: `${f.id} ${token}` }) } },
    { timestamp: at, type: 'event_msg', payload: { type: 'subagent', session_id: childId } }
  ];
  appendFileSync(f.parentFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const childFile = f.trace('requirement_analysis_agent', childId, [{ timestamp: at, type: 'event_msg', payload: { type: 'request_begin' } }]);
  assert.notEqual(f.call('recover-stage', f.recovery()).status, 0);
  appendFileSync(f.parentFile, JSON.stringify({ timestamp: at, type: 'model_msg', payload: { type: 'tool_call_output', tool_call_id: 'synthetic-call', stop_reason: 'fatal', output: 'Synthetic interrupted child' } }) + '\n');
  assert.notEqual(f.call('recover-stage', f.recovery()).status, 0);
  appendFileSync(childFile, JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'request_end', status: 'interrupted' } }) + '\n');
  f.ok('recover-stage', f.recovery());
  assert.deepEqual(f.read().orchestration.events.at(-1).verified_children, [childId]);
});

test('manual stage override cannot turn a blocked audited stage into a new dispatch', () => {
  const f = fixture(); f.block(f.dispatch());
  const state = f.read(); state.stages.analysis.status = 'planned'; writeFileSync(f.manifestPath, JSON.stringify(state));
  const before = f.hash();
  const result = f.call('record-orchestration-event', f.dispatchArgs);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /latest audit event/); assert.equal(f.hash(), before);
});

test('concurrent dispatches commit exactly one event without truncating the manifest', async () => {
  const f = fixture();
  const start = () => new Promise((done, reject) => {
    const processChild = spawn(process.execPath, ['scripts/record-orchestration-event.mjs', ...f.dispatchArgs], { cwd: root, env: f.env, stdio: 'ignore' });
    processChild.on('error', reject); processChild.on('exit', code => done(code));
  });
  const results = await Promise.all([start(), start()]);
  assert.equal(results.filter(code => code === 0).length, 1);
  assert.equal(f.read().orchestration.events.filter(e => e.type === 'dispatched').length, 1);
});

test('manifest lock blocks confirmation and recovery without deleting another owner lock', () => {
  const f = fixture(); f.block(f.dispatch());
  const lock = resolve(f.dir, 'manifest.json.lock'); writeFileSync(lock, 'synthetic-other-owner');
  assert.notEqual(f.call('recover-stage', f.recovery()).status, 0);
  assert.notEqual(f.call('request-stage-confirmation', [f.id, 'analysis']).status, 0);
  assert.equal(readFileSync(lock, 'utf8'), 'synthetic-other-owner');
  unlinkSync(lock);
});
