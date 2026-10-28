import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mobileAuthorization, assertMobileTarget, acquireMobileResource, releaseMobileResource, sealMobileResult } from '../../scripts/mobile-stage.mjs';
import { inspectIndependentArtifacts } from '../../scripts/independent-task.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function temporary(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'mobile-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'execution/android-evidence'), { recursive: true });
  mkdirSync(resolve(root, 'output/runs/run-mobile/execution'), { recursive: true });
  return root;
}

test('mobile grant uses native user wording, exact target and later stop', t => {
  const root = temporary(t);
  const parent = 'session-2026-10-28-00-00-00-aaaa';
  const text = '请测试 Android App com.example.app 的登录功能';
  const rows = [{ type: 'model_msg', timestamp: '2026-10-28T01:00:00Z', payload: { type: 'text', role: 'user', text } }];
  const grant = mobileAuthorization(root, 'run-mobile', parent, rows, text, 'android');
  assert.deepEqual(grant.targets, ['com.example.app']);
  assert.throws(() => assertMobileTarget('android', { type: 'start', package: 'com.other.app', device: 'emulator-5554' }, grant, root), /outside/);
  assert.throws(() => assertMobileTarget('android', { type: 'start', package: 'com.example.app' }, grant, root), /device serial/);
  rows.push({ type: 'model_msg', timestamp: '2026-10-28T01:01:00Z', payload: { type: 'text', role: 'user', text: '停止测试' } });
  assert.throws(() => mobileAuthorization(root, 'run-mobile', parent, rows, text, 'android'), /later user stop/);
  assert.throws(() => mobileAuthorization(root, 'run-mobile', parent, rows, '请测试 com.example.other', 'android'), /exact native/);
});

test('device ownership rejects another run and survives until explicit finish release', t => {
  const root = temporary(t);
  const owner = { run_id: 'run-one', dispatch_id: 'dispatch-one', child_session: 'session-one', key: 'emulator-5554' };
  const path = acquireMobileResource(root, 'android', owner.key, owner, { start: true });
  assert.equal(acquireMobileResource(root, 'android', owner.key, owner, { start: true }), path);
  const other = { ...owner, run_id: 'run-two' };
  assert.throws(() => acquireMobileResource(root, 'android', owner.key, other, { start: true }), /owned by another/);
  releaseMobileResource(path, other);
  assert.throws(() => acquireMobileResource(root, 'android', owner.key, other), /owned by another/);
  releaseMobileResource(path, owner);
  assert.equal(acquireMobileResource(root, 'android', owner.key, other, { start: true }), path);
});

test('sealed result preserves source assertions and rejects changed evidence', t => {
  const root = temporary(t);
  const name = 'execution/android-evidence/assert.png';
  const bytes = Buffer.from('observed screenshot');
  writeFileSync(resolve(root, name), bytes);
  const source = {
    run_id: 'run-mobile', invocation_id: 'attempt-1', status: 'completed',
    started_at: '2026-10-28T01:00:00Z', finished_at: '2026-10-28T01:00:01Z',
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
    cases: [{ case_id: 'M1', status: 'passed', evidence_mode: 'real', verification_scope: { layer: 'android_ui' }, evidence_paths: [name] }],
    android: { backend: 'adb', evidence_mode: 'real', package: 'com.example.app', evidence_paths: [name] },
    evidence_index: [{ path: name, size: bytes.length, sha256: sha(bytes) }]
  };
  writeFileSync(resolve(root, 'execution/android-results.json'), JSON.stringify(source));
  const sealed = sealMobileResult(root, 'run-mobile', 'android', 'dispatch-one', 'session-one');
  assert.equal(sealed.output.cases[0].status, 'passed');
  assert.deepEqual(JSON.parse(readFileSync(resolve(root, 'execution/test_results.json'))).cases, source.cases);
  writeFileSync(resolve(root, name), 'tampered');
  assert.throws(() => sealMobileResult(root, 'run-mobile', 'android', 'dispatch-one', 'session-one'), /evidence changed/);
});

test('mobile execution contract accepts sealed real evidence and rejects changed source facts', t => {
  const root = temporary(t), runId = 'run-mobile', dir = resolve(root, 'output/runs', runId);
  mkdirSync(resolve(dir, 'execution/android-evidence'), { recursive: true });
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/request.txt'), '请测试 com.example.app');
  const name = 'execution/android-evidence/assert.png', bytes = Buffer.from('real observation');
  writeFileSync(resolve(dir, name), bytes);
  const source = { run_id: runId, invocation_id: 'attempt-1', status: 'completed', started_at: '2026-10-28T01:00:00Z', finished_at: '2026-10-28T01:00:01Z', summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 }, cases: [{ case_id: 'M1', status: 'passed', evidence_mode: 'real', verification_scope: { layer: 'android_ui' }, evidence_paths: [name] }], android: { backend: 'adb', evidence_mode: 'real', package: 'com.example.app', evidence_paths: [name] }, evidence_index: [{ path: name, size: bytes.length, sha256: sha(bytes) }] };
  writeFileSync(resolve(dir, 'execution/android-results.json'), JSON.stringify(source));
  sealMobileResult(dir, runId, 'android', 'dispatch-one', 'session-one', { targets: ['com.example.app'] });
  writeFileSync(resolve(dir, 'execution/execution-task.json'), JSON.stringify({ run_id: runId, stage: 'execution', outcome: 'completed', summary: 'One real assertion', source_paths: ['inputs/request.txt'], questions: [], limitations: [] }));
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ run_id: runId, orchestration: { plan: { workflow_mode: 'task', execution_platform: 'android' }, events: [{ type: 'dispatched', stage: 'execution', dispatch_id: 'dispatch-one', mobile_authorization: { platform: 'android' } }] } }));
  const check = inspectIndependentArtifacts(root, runId, 'execution');
  assert.equal(check.status, 'passed', check.errors?.join('; '));
  const result = JSON.parse(readFileSync(resolve(dir, 'execution/test_results.json')));
  result.cases[0].status = 'failed';
  writeFileSync(resolve(dir, 'execution/test_results.json'), JSON.stringify(result));
  assert.equal(inspectIndependentArtifacts(root, runId, 'execution').status, 'blocked');
});
