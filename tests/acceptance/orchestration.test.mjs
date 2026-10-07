import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
test('missing artifact repair preserves history and refuses existing files', () => {
  const id = `run-fixture-${randomUUID()}`;
  const run = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run('create-run', [`--run-id=${id}`]).status, 0);
  const dir = resolve(root, 'output/runs', id);
  writeFileSync(resolve(dir, 'inputs/fixture-origin.json'), JSON.stringify({ source: 'synthetic artifact repair regression' }));
  const path = resolve(dir, 'manifest.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.artifacts = ['inputs/fixture-origin.json', 'quality/missing.json'];
  original.orchestration = { events: [{ type: 'historical_event' }] };
  writeFileSync(path, JSON.stringify(original));
  const before = readFileSync(path, 'utf8');
  for (const artifact of ['inputs/fixture-origin.json', 'unregistered.json']) {
    assert.notEqual(run('remove-missing-artifact', [id, artifact, 'regression']).status, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
  assert.equal(run('remove-missing-artifact', [id, 'quality/missing.json', 'verified absent']).status, 0);
  const repaired = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(repaired.artifacts, ['inputs/fixture-origin.json']);
  assert.deepEqual(repaired.stages, original.stages);
  assert.deepEqual(repaired.orchestration.events[0], original.orchestration.events[0]);
  assert.equal(repaired.orchestration.events[1].type, 'missing_artifact_reference_removed');
  assert.equal(repaired.orchestration.events[1].reason, 'verified absent');
});

test('stage events cannot bypass approval or override state and audit fields', () => {
  const id = `run-fixture-${randomUUID()}`;
  const run = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
  const ok = (script, args) => {
    const result = run(script, args);
    assert.equal(result.status, 0, result.stderr);
  };
  ok('create-run', [`--run-id=${id}`]);
  const dir = resolve(root, 'output/runs', id);
  writeFileSync(resolve(dir, 'inputs/fixture-origin.json'), JSON.stringify({ source: 'synthetic orchestration regression' }));
  ok('plan-run', [`--run-id=${id}`, '--stages=execution']);
  const manifest = () => readFileSync(resolve(dir, 'manifest.json'), 'utf8');
  const denied = args => {
    const before = manifest();
    assert.notEqual(run('record-orchestration-event', [id, ...args]).status, 0);
    assert.equal(manifest(), before);
  };
  denied(['revision_requested', '--stage=analysis', '--status=completed']);
  denied(['dispatched', '--stage=analysis', '--status=completed']);
  denied(['dispatched', '--stage=analysis', '--type=completed']);
  denied(['completed', '--stage=analysis']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis']);
  denied(['completed', '--stage=analysis', '--artifacts=quality/missing.json']);
  denied(['completed', '--stage=analysis', '--artifacts=../../quality/defect-index.json']);
  ok('record-orchestration-event', [id, 'completed', '--stage=analysis']);
  denied(['dispatched', '--stage=test_points', '--agent=test_point_agent', '--skills=test-point-design']);
  ok('request-stage-confirmation', [id, 'analysis']);
  denied(['revision_requested', '--stage=analysis']);
  // Synthetic decisions test transitions; they are not approval of an actual Agent run.
  ok('resolve-stage-confirmation', [id, 'analysis', 'revision_requested', 'synthetic test']);
  assert.notEqual(run('request-stage-confirmation', [id, 'analysis']).status, 0);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis']);
  ok('record-orchestration-event', [id, 'completed', '--stage=analysis']);
  ok('request-stage-confirmation', [id, 'analysis']);
  ok('resolve-stage-confirmation', [id, 'analysis', 'approved', 'synthetic test only']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=test_points', '--agent=test_point_agent', '--skills=test-point-design']);
  ok('record-orchestration-event', [id, 'completed', '--stage=test_points']);
  ok('request-stage-confirmation', [id, 'test_points']);
  ok('resolve-stage-confirmation', [id, 'test_points', 'approved', 'synthetic test only']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=test_cases', '--agent=test_case_agent', '--skills=test-case-writing']);
  ok('record-orchestration-event', [id, 'completed', '--stage=test_cases']);
  ok('request-stage-confirmation', [id, 'test_cases']);
  ok('resolve-stage-confirmation', [id, 'test_cases', 'approved', 'synthetic test only']);
  ok('request-stage-confirmation', [id, 'execution']);
  ok('resolve-stage-confirmation', [id, 'execution', 'revision_requested', 'synthetic plan revision']);
  denied(['dispatched', '--stage=execution', '--agent=automation_execution_agent', '--skills=playwright-execution']);
  ok('request-stage-confirmation', [id, 'execution']);
  const beforeDuplicate = manifest();
  assert.notEqual(run('request-stage-confirmation', [id, 'execution']).status, 0);
  assert.equal(manifest(), beforeDuplicate);
  denied(['dispatched', '--stage=execution', '--agent=automation_execution_agent', '--skills=playwright-execution']);
  const state = JSON.parse(manifest());
  assert.equal(state.stages.execution.status, 'awaiting_confirmation');
  assert.ok(!state.confirmations.some(c => c.stage === 'execution' && c.status === 'approved'));
});
