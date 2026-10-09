import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { executionSnapshot } from '../../scripts/execution-authorization.mjs';
import { executeAttempt } from '../../scripts/execution-runner.mjs';
import { beginAttempt, blockedResult, finishAttempt, recoverAttempt, verifyAttempt, verifyCurrentAttempt } from '../../scripts/execution-attempts.mjs';
import { runManagedProcess } from '../../scripts/managed-process.mjs';
import { parsePlaywrightResults } from '../../scripts/playwright-results.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
function fixture(approved = true) {
  const id = `run-attempt-${randomUUID()}`;
  const data = executionInputs(root, id);
  const manifest = { run_id: id, stages: { execution: { status: 'planned' } }, confirmations: [], orchestration: { events: [], plan: { stages: [{ id: 'execution', selected: true, confirmation: 'before', depends_on: [] }] } } };
  if (approved) manifest.confirmations.push({ id: 'synthetic-approval', stage: 'execution', status: 'approved', execution_snapshot: executionSnapshot(root, id) });
  writeJsonFile(resolve(data.dir, 'manifest.json'), manifest);
  return { id, ...data };
}
function raw(status = 'passed') {
  return { stats: { startTime: new Date().toISOString() }, errors: [], suites: [{ specs: [{ title: 'TC-SYNTHETIC synthetic case', tests: [{ results: [{ status, duration: 1, attachments: [] }] }] }] }] };
}
function simulatedProcess(f, { status = 'passed', mutate, noReport = false, termination = null } = {}) {
  return async options => {
    // Inject only at the module boundary; production CLI has no simulation switch.
    writeFileSync(options.logPath, 'Synthetic process output, not browser execution.');
    const dir = dirname(options.logPath);
    if (options.args[0].endsWith('preflight-test-environment.mjs')) {
      writeJsonFile(resolve(dir, 'environment/preflight.json'), { status: 'ready', environment_id: 'synthetic' });
      return { code: 0, pid: null, termination_confirmed: true };
    }
    assert.equal(options.env.QA_RUN_DIR.replaceAll('\\', '/'), dir.replaceAll('\\', '/'));
    assert.ok(options.args.includes('--retries=0'));
    const value = raw(status);
    mutate?.(value, options);
    if (!noReport) writeJsonFile(resolve(dir, 'playwright/playwright-results.json'), value);
    return { code: status === 'passed' ? 0 : 1, termination, pid: null, termination_confirmed: true };
  };
}

test('blocked CLI starts get independent sealed attempts and preserve historical results', () => {
  const f = fixture(false);
  const target = resolve(f.dir, 'execution/test_results.json');
  writeFileSync(target, '{"source":"synthetic historical result"}');
  const previous = readFileSync(target, 'utf8');
  for (let i = 0; i < 2; i++) assert.equal(cli('run-ui-tests', [`--run-id=${f.id}`]).status, 2);
  const ids = readdirSync(resolve(f.dir, 'execution/attempts'));
  assert.equal(ids.length, 2);
  for (const id of ids) {
    assert.equal(verifyAttempt(root, f.id, id).status, 'blocked');
    assert.equal(readFileSync(resolve(f.dir, 'execution/attempts', id, 'previous/execution/test_results.json'), 'utf8'), previous);
  }
  assert.equal(readFileSync(target, 'utf8'), previous);
  assert.equal(existsSync(resolve(f.dir, 'execution/execution.lock.json')), false);
});

test('success and failure reruns retain raw results, logs, views and sealed evidence hashes', async () => {
  const f = fixture();
  const first = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f) });
  assert.equal(first.status, 'completed', first.reason);
  const rawPath = resolve(first.attempt_dir, 'playwright/playwright-results.json');
  const before = readFileSync(rawPath, 'utf8');
  const second = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f, { status: 'failed' }) });
  assert.equal(second.status, 'failed', second.reason);
  assert.notEqual(first.invocation_id, second.invocation_id);
  assert.equal(readFileSync(rawPath, 'utf8'), before);
  assert.equal(verifyAttempt(root, f.id, first.invocation_id).status, 'completed');
  assert.equal(verifyAttempt(root, f.id, second.invocation_id).status, 'failed');
  const state = read(resolve(f.dir, 'execution/execution-state.json'));
  const result = read(resolve(f.dir, 'execution/test_results.json'));
  assert.equal(result.invocation_id, second.invocation_id);
  assert.equal(verifyCurrentAttempt(root, f.id, state, result).status, 'failed');
  const oldView = read(resolve(second.attempt_dir, 'previous/execution/test_results.json'));
  assert.equal(oldView.invocation_id, first.invocation_id);
});

test('missing, invalid, duplicate and omitted results cannot overwrite earlier success', async () => {
  const f = fixture();
  const first = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f) });
  assert.equal(first.code, 0, first.reason);
  const before = readFileSync(resolve(f.dir, 'execution/test_results.json'), 'utf8');
  for (const options of [
    { noReport: true },
    { mutate: value => { value.suites = []; } },
    { mutate: value => { value.suites[0].specs.push(value.suites[0].specs[0]); } },
    { mutate: value => { value.errors = [{ message: 'Synthetic global setup failure' }]; } },
    { mutate: value => { value.suites[0].specs[0].tests[0].results[0].status = 'failed'; } },
    { termination: 'timeout' },
    { termination: 'interrupted' }
  ]) {
    const result = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f, options) });
    assert.equal(result.code, 2);
    verifyAttempt(root, f.id, result.invocation_id);
    assert.equal(readFileSync(resolve(f.dir, 'execution/test_results.json'), 'utf8'), before);
    assert.equal(read(resolve(f.dir, 'execution/execution-state.json')).status, 'blocked');
    assert.equal(cli('build-quality-metrics', [`--run-id=${f.id}`]).status, 0);
    assert.equal(read(resolve(f.dir, 'report/quality-metrics.json')).execution.passed, 0);
  }
});

test('same-run concurrent start is refused without changing active state or lock', () => {
  const f = fixture();
  const context = beginAttempt(root, f.id);
  const before = readFileSync(resolve(f.dir, 'execution/execution-state.json'), 'utf8');
  assert.throws(() => beginAttempt(root, f.id), /lock exists/);
  assert.equal(cli('run-ui-tests', [`--run-id=${f.id}`]).status, 3);
  assert.equal(readFileSync(resolve(f.dir, 'execution/execution-state.json'), 'utf8'), before);
  assert.throws(() => recoverAttempt(root, f.id, 'synthetic active recovery', true), /still alive/);
  finishAttempt(context, { status: 'blocked', result: blockedResult(context, 'synthetic only'), reason: 'synthetic only' });
  assert.throws(() => finishAttempt(context, { status: 'blocked', result: blockedResult(context, 'again') }));
});

test('orphaned attempts require explicit recovery; recovery never executes tests or fabricates success', () => {
  const f = fixture();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {beginAttempt} from './scripts/execution-attempts.mjs'; beginAttempt(process.cwd(), ${JSON.stringify(f.id)});`], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => recoverAttempt(root, f.id, 'synthetic crash'), /confirm-stopped/);
  const recovered = recoverAttempt(root, f.id, 'synthetic crashed child; no descendants created', true);
  assert.equal(recovered.status, 'recovered_without_execution');
  assert.equal(verifyAttempt(root, f.id, recovered.invocation_id).status, 'interrupted');
  assert.equal(read(resolve(f.dir, 'execution/execution-state.json')).status, 'blocked');
  assert.equal(existsSync(resolve(f.dir, 'execution/execution.lock.json')), false);
});

test('archive tampering and stale derived artifacts block report publication', async () => {
  const f = fixture();
  const outcome = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f) });
  assert.equal(outcome.code, 0, outcome.reason);
  writeJsonFile(resolve(f.dir, 'quality/evidence-assessment.json'), { invocation_id: 'old', summary: { insufficient: 0 }, assessments: [] });
  writeJsonFile(resolve(f.dir, 'defects/defect-records.json'), { invocation_id: 'old', records: [] });
  assert.equal(cli('build-quality-metrics', [`--run-id=${f.id}`]).status, 0);
  assert.ok(read(resolve(f.dir, 'report/quality-metrics.json')).quality_gate.reasons.includes('stale_derived_artifacts'));
  writeFileSync(resolve(outcome.attempt_dir, 'playwright.log'), 'changed');
  assert.throws(() => verifyAttempt(root, f.id, outcome.invocation_id), /changed/);
  assert.equal(cli('build-quality-metrics', [`--run-id=${f.id}`]).status, 0);
  const metrics = read(resolve(f.dir, 'report/quality-metrics.json'));
  assert.equal(metrics.execution.passed, 0);
  assert.match(metrics.trust.attempt_integrity_error, /changed/);
});

test('parser preserves retry information and refuses evidence from another attempt', () => {
  const f = fixture();
  const dir = resolve(f.dir, 'synthetic-parser'); mkdirSync(dir);
  const value = raw();
  value.suites[0].specs[0].tests[0].results.unshift({ retry: 0, status: 'failed', duration: 2, attachments: [] });
  const parsed = parsePlaywrightResults({ raw: value, plan: f.plan, runId: f.id, invocationId: randomUUID(), attemptDir: dir, exitCode: 0 });
  assert.equal(parsed.cases[0].flaky, true);
  assert.equal(parsed.cases[0].retries.length, 2);
  writeFileSync(resolve(f.dir, 'foreign.png'), 'synthetic outside evidence');
  value.suites[0].specs[0].tests[0].results[1].attachments = [{ path: resolve(f.dir, 'foreign.png') }];
  assert.throws(() => parsePlaywrightResults({ raw: value, plan: f.plan, runId: f.id, invocationId: randomUUID(), attemptDir: dir, exitCode: 0 }), /outside current attempt/);
});

test('termination uncertainty retains an unsealed archive and lock', async () => {
  const f = fixture();
  const outcome = await executeAttempt(root, f.id, { runProcess: async options => {
    writeFileSync(options.logPath, 'Synthetic unknown process termination');
    return { code: null, termination: 'timeout', termination_confirmed: false };
  } });
  assert.equal(outcome.recovery_required, true);
  assert.equal(existsSync(resolve(outcome.attempt_dir, 'attempt.json')), false);
  assert.equal(existsSync(resolve(f.dir, 'execution/execution.lock.json')), true);
  assert.throws(() => recoverAttempt(root, f.id, 'synthetic active process', true), /still alive/);
  // This test owns the simulated context and created no subprocess.
  const context = { root, runId: f.id, invocationId: outcome.invocation_id, dir: outcome.attempt_dir, output: resolve(f.dir, 'execution'), lockPath: resolve(f.dir, 'execution/execution.lock.json'), startedAt: new Date().toISOString() };
  finishAttempt(context, { status: 'interrupted', result: blockedResult(context, 'Synthetic cleanup, no child was created'), reason: 'Synthetic cleanup' });
});

test('derived outputs bind the latest attempt, including a blocked rerun after success', async () => {
  const f = fixture();
  const first = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f) });
  assert.equal(first.code, 0, first.reason);
  const second = await executeAttempt(root, f.id, { runProcess: simulatedProcess(f, { noReport: true }) });
  assert.equal(second.code, 2);
  assert.equal(cli('assess-execution-evidence', [`--run-id=${f.id}`]).status, 0);
  const assessment = read(resolve(f.dir, 'quality/evidence-assessment.json'));
  assert.equal(assessment.invocation_id, second.invocation_id);
  assert.equal(assessment.assessments.length, 0);
  writeJsonFile(resolve(f.dir, 'defects/bugs.json'), { run_id: f.id, invocation_id: first.invocation_id, bugs: [] });
  assert.notEqual(cli('normalize-defects', [`--run-id=${f.id}`]).status, 0);
  writeJsonFile(resolve(f.dir, 'defects/bugs.json'), { run_id: f.id, invocation_id: second.invocation_id, bugs: [] });
  assert.equal(cli('normalize-defects', [`--run-id=${f.id}`]).status, 0);
  assert.equal(read(resolve(f.dir, 'defects/defect-records.json')).invocation_id, second.invocation_id);
  assert.equal(cli('build-quality-metrics', [`--run-id=${f.id}`]).status, 0);
  const metrics = read(resolve(f.dir, 'report/quality-metrics.json'));
  assert.equal(metrics.trust.stale_derived_artifacts, false);
  assert.equal(metrics.execution.passed, 0);
  assert.equal(metrics.quality_gate.status, 'blocked');
});

test('managed local Node processes capture output, time out and cancel without a browser', async () => {
  const f = fixture(false);
  const common = { command: process.execPath, cwd: root, env: process.env, timeoutMs: 5000 };
  const done = await runManagedProcess({ ...common, args: ['-e', 'console.log("synthetic child")'], logPath: resolve(f.dir, 'normal.log') });
  assert.equal(done.code, 0);
  assert.equal(done.termination_confirmed, true);
  assert.match(readFileSync(resolve(f.dir, 'normal.log'), 'utf8'), /synthetic child/);
  const timed = await runManagedProcess({ ...common, timeoutMs: 400, args: ['-e', 'setInterval(()=>{},1000)'], logPath: resolve(f.dir, 'timeout.log') });
  assert.equal(timed.termination, 'timeout');
  assert.equal(timed.termination_confirmed, true);
  const abort = new AbortController();
  const canceled = runManagedProcess({ ...common, signal: abort.signal, args: ['-e', 'setInterval(()=>{},1000)'], logPath: resolve(f.dir, 'cancel.log'), onSpawn: () => setTimeout(() => abort.abort(), 200) });
  const stopped = await canceled;
  assert.equal(stopped.termination, 'interrupted');
  assert.equal(stopped.termination_confirmed, true);
});
