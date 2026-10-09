import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { executionSnapshot } from '../../scripts/execution-authorization.mjs';
import { inspectDesign, designReceipt } from '../../scripts/design-quality.mjs';
import { beginAttempt, finishAttempt } from '../../scripts/execution-attempts.mjs';
import { governedDefects, readLifecycle, registerObservations, transitionDefect } from '../../scripts/defect-lifecycle.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const invoke = (script, id) => spawnSync(process.execPath, [`scripts/${script}.mjs`, `--run-id=${id}`], { cwd: root, encoding: 'utf8' });
const emptySummary = { product_defect: 0, script_issue: 0, environment_issue: 0, test_data_issue: 0, needs_review: 0 };
function fixture() {
  const id = `run-lifecycle-${randomUUID()}`;
  const f = executionInputs(root, id);
  writeJsonFile(resolve(f.dir, 'inputs/fixture-origin.json'), { source: 'synthetic lifecycle engineering test; not actual Agent execution' });
  writeFileSync(resolve(f.dir, 'inputs/review.md'), 'Synthetic reviewer decision, not an actual user approval.');
  writeFileSync(resolve(f.dir, 'inputs/fix.md'), 'Synthetic fix reference.');
  return { id, ...f };
}
function attempt(f, status = 'failed', options = {}) {
  const context = beginAttempt(root, f.id);
  writeJsonFile(resolve(context.dir, 'inputs/approval-snapshot.json'), { confirmation_id: 'synthetic', snapshot: executionSnapshot(root, f.id) });
  writeFileSync(resolve(context.dir, 'evidence.txt'), 'Synthetic assertion evidence');
  writeFileSync(resolve(context.dir, 'response.txt'), 'Synthetic response evidence');
  const result = { run_id: f.id, invocation_id: context.invocationId, status: status === 'failed' ? 'failed' : 'completed', started_at: context.startedAt, finished_at: new Date().toISOString(), summary: { total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, skipped: status === 'skipped' ? 1 : 0, blocked: 0 }, cases: [{ case_id: 'TC-SYNTHETIC', status, error_message: status === 'failed' ? 'Synthetic failure' : '', evidence_paths: [resolve(context.dir, 'evidence.txt'), resolve(context.dir, 'response.txt')] }] };
  if (options.omit) { result.cases = []; result.summary.total = 0; }
  finishAttempt(context, { status: result.status, result });
  assert.equal(invoke('assess-execution-evidence', f.id).status, 0);
  return { id: context.invocationId, dir: context.dir, result };
}
function observations(f, a, records) {
  const data = { run_id: f.id, invocation_id: a.id, records, summary: { ...emptySummary } };
  for (const record of records) data.summary[record.category]++;
  registerObservations(root, f.id, data);
  writeJsonFile(resolve(f.dir, 'defects/defect-records.json'), data);
  return data;
}
function origin(f) {
  const a = attempt(f);
  const record = { defect_id: 'DEF-SYNTHETIC', fingerprint: 'synthetic-fingerprint', category: 'needs_review', lifecycle_status: 'needs_review', confidence: 'medium', severity: 'Major', priority: 'P1', title: 'Synthetic issue', related_cases: ['TC-SYNTHETIC'], evidence_refs: a.result.cases[0].evidence_paths, duplicate_of: null };
  return { ...a, data: observations(f, a, [record]) };
}
const transition = (f, a, action, revision, extra = {}) => transitionDefect(root, f.id, { invocation_id: a.id, defect_id: 'DEF-SYNTHETIC', action, revision, actor: 'synthetic-reviewer', reason: 'synthetic review only', evidence: [action === 'fixed' ? 'inputs/fix.md' : 'inputs/review.md'], category: 'product_defect', ...extra });
function metrics(f) {
  const result = invoke('build-quality-metrics', f.id);
  assert.equal(result.status, 0, result.stderr);
  return read(resolve(f.dir, 'report/quality-metrics.json'));
}

test('confirm, fix, independent retest and close retain observations and full decision chain', async () => {
  const f = fixture(); const a = origin(f);
  const before = readFileSync(resolve(f.dir, 'defects/defect-records.json'), 'utf8');
  assert.equal(transition(f, a, 'confirm', 0).defect.lifecycle_status, 'confirmed');
  assert.equal(metrics(f).quality_gate.status, 'risk_present');
  assert.equal(transition(f, a, 'fixed', 1).defect.lifecycle_status, 'fixed');
  await delay(5); const retest = attempt(f, 'passed'); observations(f, retest, []);
  assert.ok(metrics(f).quality_gate.reasons.includes('unresolved_historical_defects'));
  assert.equal(transition(f, a, 'retest', 2, { retest_invocation_id: retest.id }).defect.lifecycle_status, 'closed');
  const final = metrics(f);
  assert.equal(final.quality_gate.status, 'informational');
  assert.equal(final.governance.history[0].lifecycle_status, 'closed');
  const subject = readLifecycle(root, f.id).subjects[0];
  assert.equal(subject.events.length, 3);
  assert.deepEqual(subject.base, JSON.parse(before).records[0]);
});

test('failed retest reopens issue and another fix is required before closing', async () => {
  const f = fixture(); const a = origin(f);
  transition(f, a, 'confirm', 0); transition(f, a, 'fixed', 1);
  await delay(5); const failed = attempt(f);
  assert.equal(transition(f, a, 'retest', 2, { retest_invocation_id: failed.id }).defect.lifecycle_status, 'confirmed');
  await delay(5); const passed = attempt(f, 'passed');
  assert.throws(() => transition(f, a, 'retest', 3, { retest_invocation_id: passed.id }), /requires fixed/);
  transition(f, a, 'fixed', 3);
  assert.throws(() => transition(f, a, 'retest', 4, { retest_invocation_id: passed.id }), /after the fix/);
});

test('illegal transitions, missing evidence and stale revisions do not mutate the ledger', () => {
  const f = fixture(); const a = origin(f); const path = resolve(f.dir, 'defects/lifecycle.json');
  const before = readFileSync(path, 'utf8');
  for (const fn of [
    () => transition(f, a, 'closed', 0),
    () => transition(f, a, 'fixed', 0),
    () => transition(f, a, 'confirm', 5),
    () => transition(f, a, 'confirm', 0, { evidence: [] }),
    () => transition(f, a, 'confirm', 0, { evidence: ['../foreign.md'] }),
    () => transition(f, a, 'confirm', 0, { category: 'needs_review' })
  ]) { assert.throws(fn); assert.equal(readFileSync(path, 'utf8'), before); }
  transition(f, a, 'reject', 0);
  assert.equal(governedDefects(root, f.id, a.data).current[0].lifecycle_status, 'rejected');
});

test('skipped, omitted and changed-design retests cannot close a defect', async () => {
  const f = fixture(); const a = origin(f);
  transition(f, a, 'confirm', 0); transition(f, a, 'fixed', 1);
  for (const [status, options] of [['skipped', {}], ['passed', { omit: true }]]) {
    await delay(5); const b = attempt(f, status, options);
    assert.throws(() => transition(f, a, 'retest', 2, { retest_invocation_id: b.id }), /omitted, skipped or blocked/);
  }
  const plan = read(resolve(f.dir, 'execution/execution-plan.json'));
  plan.design_gate.files[0].sha256 = '0'.repeat(64);
  // Keep approval fixture valid while changing only the archived test evidence for this negative case.
  await delay(5); const b = attempt(f, 'passed');
  writeJsonFile(resolve(b.dir, 'inputs/execution-plan.json'), plan);
  assert.throws(() => transition(f, a, 'retest', 2, { retest_invocation_id: b.id }), /changed or is incomplete/);
});

test('decision evidence tampering blocks reports; normalizing cannot forge status or erase history', () => {
  const f = fixture(); const a = origin(f);
  transition(f, a, 'confirm', 0);
  assert.throws(() => registerObservations(root, f.id, { ...a.data, records: [] }), /remove/);
  assert.throws(() => registerObservations(root, f.id, { ...a.data, records: [{ ...a.data.records[0], title: 'changed' }] }), /changed/);
  writeFileSync(resolve(f.dir, 'inputs/review.md'), 'changed evidence');
  assert.throws(() => readLifecycle(root, f.id), /evidence changed/);
  assert.equal(metrics(f).quality_gate.status, 'blocked');
  assert.ok(metrics(f).quality_gate.reasons.includes('lifecycle_integrity_error'));
});

test('normalizer ignores claimed closed status and preserves registered review decisions on repeat', () => {
  const f = fixture(); const a = attempt(f);
  writeJsonFile(resolve(f.dir, 'defects/bugs.json'), { run_id: f.id, invocation_id: a.id, bugs: [{ bug_id: 'DEF-SYNTHETIC', title: 'Synthetic issue', classification: 'product_defect', lifecycle_status: 'closed', case_id: 'TC-SYNTHETIC', evidence_paths: a.result.cases[0].evidence_paths }] });
  assert.equal(invoke('normalize-defects', f.id).status, 0);
  assert.equal(read(resolve(f.dir, 'defects/defect-records.json')).records[0].lifecycle_status, 'draft');
  transition(f, a, 'confirm', 0);
  assert.equal(invoke('normalize-defects', f.id).status, 0);
  assert.equal(readLifecycle(root, f.id).subjects[0].events.length, 1);
  assert.equal(metrics(f).defects.lifecycle.confirmed, 1);
});

test('explicit cross-run retest requires identical design and archived environment approval', async () => {
  const f = fixture(); const a = origin(f);
  transition(f, a, 'confirm', 0); transition(f, a, 'fixed', 1);
  const target = fixture();
  await delay(5); const wrong = attempt(target, 'passed');
  assert.throws(() => transition(f, a, 'retest', 2, { retest_run_id: target.id, retest_invocation_id: wrong.id }), /environment differs/);
  target.plan.environment_config = f.config;
  const ledgerPath = resolve(target.dir, 'analysis/requirement-ledger.json');
  const ledger = read(ledgerPath);
  const originalLocator = ledger.sources[0].locator;
  ledger.sources[0].locator = 'Different source attribution'; writeJsonFile(ledgerPath, ledger);
  target.plan.design_gate = designReceipt(inspectDesign({ root, runId: target.id, source: target.source }));
  writeJsonFile(resolve(target.dir, 'execution/execution-plan.json'), target.plan);
  await delay(5); const changed = attempt(target, 'passed');
  assert.throws(() => transition(f, a, 'retest', 2, { retest_run_id: target.id, retest_invocation_id: changed.id }), /design basis differs/);
  ledger.sources[0].locator = originalLocator; writeJsonFile(ledgerPath, ledger);
  target.plan.design_gate = designReceipt(inspectDesign({ root, runId: target.id, source: target.source }));
  writeJsonFile(resolve(target.dir, 'execution/execution-plan.json'), target.plan);
  await delay(5); const correct = attempt(target, 'passed');
  assert.equal(transition(f, a, 'retest', 2, { retest_run_id: target.id, retest_invocation_id: correct.id }).defect.lifecycle_status, 'closed');
});

test('lifecycle changes invalidate completed reports and retain prior report history', () => {
  const f = fixture(); const a = origin(f);
  writeJsonFile(resolve(f.dir, 'manifest.json'), { run_id: f.id, status: 'completed', stages: { report: { status: 'completed' } }, orchestration: { plan: { stages: [{ id: 'report', selected: true }] }, events: [{ type: 'completed', stage: 'report', evidence: { synthetic: true } }] } });
  transition(f, a, 'confirm', 0);
  const manifest = read(resolve(f.dir, 'manifest.json'));
  assert.equal(manifest.stages.report.status, 'revision_requested');
  assert.equal(manifest.orchestration.events[0].type, 'completed');
  assert.equal(manifest.orchestration.events.at(-1).type, 'quality_revision_required');
  manifest.stages.report.status = 'in_progress';
  writeJsonFile(resolve(f.dir, 'manifest.json'), manifest);
  assert.throws(() => transition(f, a, 'fixed', 1), /generation is active/);
});
