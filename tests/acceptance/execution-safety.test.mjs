import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { assertExecutionAuthorized, executionSnapshot } from '../../scripts/execution-authorization.mjs';
import { hasApprovedConfirmation, assertStageReady } from '../../scripts/orchestration-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const invoke = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
function fixture() {
  const id = `run-safety-${randomUUID()}`;
  const f = executionInputs(root, id);
  const manifest = { run_id: id, stages: { execution: { status: 'planned' } }, confirmations: [], orchestration: { plan: { stages: [{ id: 'execution', selected: true, confirmation: 'before', depends_on: [] }] }, events: [] } };
  const path = resolve(f.dir, 'manifest.json');
  writeJsonFile(path, manifest);
  return { ...f, id, manifest, path };
}

test('latest revision or rejection invalidates historical approvals', () => {
  const f = fixture();
  for (const status of ['revision_requested', 'rejected', 'pending']) {
    f.manifest.confirmations = [{ stage: 'execution', status: 'approved' }, { stage: 'execution', status }];
    assert.equal(hasApprovedConfirmation(f.manifest, 'execution'), false);
    assert.throws(() => assertStageReady(f.manifest, 'execution'));
  }
});

test('request, approval and runner verify actual execution snapshot; no approval cannot start', () => {
  const f = fixture();
  const blocked = invoke('run-ui-tests', [`--run-id=${f.id}`]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /approval required/);
  assert.throws(() => assertExecutionAuthorized(root, f.id));
  let result = invoke('request-stage-confirmation', [f.id, 'execution']);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(resolve(f.testDir, 'synthetic.spec.ts'), '// changed after request\n');
  result = invoke('resolve-stage-confirmation', [f.id, 'execution', 'approved', 'synthetic only']);
  assert.notEqual(result.status, 0);
  assert.equal(invoke('resolve-stage-confirmation', [f.id, 'execution', 'revision_requested']).status, 0);
  assert.equal(invoke('request-stage-confirmation', [f.id, 'execution']).status, 0);
  assert.equal(invoke('resolve-stage-confirmation', [f.id, 'execution', 'approved', 'synthetic only']).status, 0);
  assert.ok(assertExecutionAuthorized(root, f.id).snapshot_sha256);
  const originalConfig = readFileSync(f.config, 'utf8');
  writeJsonFile(f.config, { ...JSON.parse(originalConfig), base_url: 'http://127.0.0.1:4318/healthy' });
  assert.throws(() => executionSnapshot(root, f.id), /differs/);
  writeFileSync(f.config, originalConfig);
  f.plan.execution_policy.workers = 2;
  writeJsonFile(resolve(f.dir, 'execution/execution-plan.json'), f.plan);
  assert.throws(() => assertExecutionAuthorized(root, f.id), /changed/);
});

test('full selection separates manual tasks without silently discarding them', () => {
  const f = fixture();
  const cases = JSON.parse(readFileSync(f.source, 'utf8'));
  cases.push({ ...cases[0], case_id: 'TC-MANUAL', automation_feasible: false });
  writeJsonFile(f.source, cases);
  assert.equal(invoke('select-test-cases', [`--run-id=${f.id}`, `--cases=${f.source}`, '--profile=full']).status, 0);
  const selection = resolve(f.dir, 'selection/test-selection.json');
  assert.equal(JSON.parse(readFileSync(selection)).manual_pending.length, 1);
  const result = invoke('create-execution-plan', [`--run-id=${f.id}`, `--cases=${f.source}`, `--selection=${selection}`, `--environment-config=${f.config}`, `--test-dir=${f.testDir}`]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(resolve(f.dir, 'execution/execution-plan.json')));
  assert.equal(plan.cases.length, 1);
  assert.equal(plan.manual_pending[0].case_id, 'TC-MANUAL');
});

test('latest blocked/running/stale invocation cannot reuse old success; new completion can recover', () => {
  const f = fixture();
  const write = (p, data) => writeJsonFile(resolve(f.dir, p), data);
  const results = { run_id: f.id, invocation_id: 'old', status: 'completed', cases: [{ case_id: 'TC-SYNTHETIC', status: 'passed' }], summary: { total: 1, passed: 1, failed: 0 } };
  write('execution/test_results.json', results);
  write('quality/evidence-assessment.json', { summary: { insufficient: 0 }, assessments: [] });
  write('defects/defect-records.json', { records: [] });
  write('execution/execution-blocked.json', { status: 'blocked' });
  const build = () => {
    assert.equal(invoke('build-quality-metrics', [`--run-id=${f.id}`]).status, 0);
    return JSON.parse(readFileSync(resolve(f.dir, 'report/quality-metrics.json')));
  };
  assert.equal(build().quality_gate.status, 'blocked');
  for (const status of ['blocked', 'running', 'completed']) {
    write('execution/execution-state.json', { run_id: f.id, invocation_id: 'new', status });
    const metrics = build();
    assert.equal(metrics.quality_gate.status, 'blocked');
    assert.equal(metrics.execution.passed, 0);
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.dir, 'execution/test_results.json'))), results);
  }
  write('execution/test_results.json', { ...results, invocation_id: 'new' });
  const recovered = build();
  assert.equal(recovered.execution.status, 'completed');
  assert.equal(recovered.execution.passed, 1);
  assert.equal(JSON.parse(readFileSync(resolve(f.dir, 'report/reportable-results.json'))).invocation_id, 'new');
  write('execution/execution-state.json', { run_id: f.id, invocation_id: 'new', status: 'failed' });
  assert.equal(build().quality_gate.status, 'blocked');
});
