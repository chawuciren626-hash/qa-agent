import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkData, inspectDesign, designReceipt, validatePlanDesign } from '../../scripts/design-quality.mjs';
import { createExecutionCases, validateExecutionPlan } from '../../scripts/execution-plan.mjs';
import { provenanceFixture } from './provenance-fixtures.mjs';

const root = resolve(import.meta.dirname, '../..');
function fixture() {
  const runId = `run-design-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', runId);
  for (const folder of ['inputs', 'design', 'environment', 'execution']) mkdirSync(resolve(dir, folder), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/requirements.md'), 'Synthetic requirement: names contain 3 code points.');
  const cases = [{ case_id: 'TC-ONE', title: 'Synthetic design contract', steps: ['Submit exact test data'], expected: 'Accepted', automation_feasible: true,
    test_data: { name: 'abc', gross: 10000, discount: 4000, paid: 6000 },
    design_contract: { basis: [{ source: 'inputs/requirements.md', rule: 'Name length', status: 'confirmed' }], assumptions: [], data_checks: [
      { kind: 'length', key: 'name', unit: 'code_points', expected: 3 },
      { kind: 'minor_unit_sum', currency: 'CNY', terms: [{ key: 'gross', sign: 1 }, { key: 'discount', sign: -1 }], total_key: 'paid' }
    ] }
  }];
  const source = resolve(dir, 'design/test_cases.json');
  provenanceFixture(dir, runId, 'Name length');
  cases[0].design_contract.basis[0].rule_id = 'RULE-SYNTHETIC';
  const save = () => writeFileSync(source, JSON.stringify(cases));
  save();
  writeFileSync(resolve(dir, 'environment/runtime.json'), JSON.stringify({ execution: { enabled: false, max_workers: 1 } }));
  const inspect = options => inspectDesign({ root, runId, source, ...options });
  const command = (name, args = []) => spawnSync(process.execPath, [`scripts/${name}.mjs`, `--run-id=${runId}`, ...args], { cwd: root, encoding: 'utf8' });
  return { runId, dir, cases, source, save, inspect, command };
}

test('design checks calculate explicit Unicode units and exact integer money', () => {
  const f = fixture();
  assert.deepEqual(checkData(f.cases[0]), []);
  const c = f.cases[0];
  c.test_data.name = '\u{1F600}e\u0301';
  for (const [unit, expected] of [['code_points', 3], ['utf16', 4], ['utf8_bytes', 7], ['graphemes', 2]]) {
    c.design_contract.data_checks[0] = { kind: 'length', key: 'name', unit, expected };
    assert.deepEqual(checkData(c), []);
  }
  c.test_data.paid = 6001;
  assert.match(checkData(c).join(), /Money sum/);
  c.test_data.paid = 60.01;
  assert.match(checkData(c).join(), /safe integer/);
  c.design_contract.data_checks[0].unit = 'unknown';
  assert.match(checkData(c).join(), /unit/);
});

test('pending design remains a draft but cannot enter execution; missing contracts block', () => {
  const f = fixture();
  f.cases[0].design_contract.assumptions = [{ statement: 'Unspecified gateway policy', status: 'pending' }]; f.save();
  assert.equal(f.inspect({ execution: false }).status, 'passed');
  assert.equal(f.inspect().status, 'blocked');
  f.cases[0].design_contract.assumptions[0].status = 'confirmed'; f.save();
  assert.match(f.inspect().errors.join(), /Confirmation evidence/);
  writeFileSync(resolve(f.dir, 'inputs/confirmation.md'), 'Synthetic confirmation, not real execution approval.');
  f.cases[0].design_contract.assumptions[0].confirmation_ref = 'inputs/confirmation.md'; f.save();
  const ledger = JSON.parse(readFileSync(resolve(f.dir, 'analysis/requirement-ledger.json'), 'utf8'));
  ledger.sources.push({ id: 'CONFIRM', kind: 'user_confirmation', path: 'inputs/confirmation.md', origin: 'synthetic confirmation', locator: 'fixture' });
  ledger.rules.push({ id: 'ASSUMPTION', statement: 'Unspecified gateway policy', kind: 'assumption', scope: 'in_scope', status: 'confirmed', citations: [{ source_id: 'CONFIRM', quote: 'Synthetic confirmation' }] });
  writeFileSync(resolve(f.dir, 'analysis/requirement-ledger.json'), JSON.stringify(ledger));
  f.cases[0].design_contract.assumptions[0].rule_id = 'ASSUMPTION'; f.save();
  assert.equal(f.inspect().status, 'passed');
  f.cases[0].design_contract.basis[0].status = 'conflicted'; f.save();
  assert.equal(f.inspect().status, 'blocked');
  delete f.cases[0].design_contract; f.save();
  assert.equal(f.inspect().status, 'blocked');
});

test('reject cross-run sources, missing references, duplicate and silently omitted selections', () => {
  const f = fixture(); const other = fixture();
  assert.equal(f.inspect({ source: other.source }).status, 'blocked');
  for (const selectedIds of [[], ['MISSING'], ['TC-ONE', 'TC-ONE']]) assert.equal(f.inspect({ selectedIds }).status, 'blocked');
  f.cases[0].design_contract.basis[0].source = resolve(other.dir, 'inputs/requirements.md'); f.save();
  assert.equal(f.inspect().status, 'blocked');
  f.cases[0].design_contract.basis[0].source = 'inputs/missing.md'; f.save();
  assert.equal(f.inspect().status, 'blocked');
  f.cases.push({ ...f.cases[0] }); f.save();
  assert.match(f.inspect().errors.join(), /duplicate/);
});

test('plans bind exact case data, cited evidence and execution contracts', () => {
  const f = fixture();
  const checked = f.inspect();
  const plan = { run_id: f.runId, source: f.source, cases: createExecutionCases(checked.cases), design_gate: designReceipt(checked), execution_policy: { workers: 1 } };
  assert.deepEqual(validatePlanDesign(root, f.runId, plan), []);
  plan.cases[0].title = 'Changed after validation';
  assert.match(validatePlanDesign(root, f.runId, plan).join(), /differ/);
  plan.cases = createExecutionCases(checked.cases);
  writeFileSync(resolve(f.dir, 'inputs/requirements.md'), 'Changed requirement');
  assert.match(validatePlanDesign(root, f.runId, plan).join(), /changed/);
  assert.ok(validatePlanDesign(root, f.runId, { ...plan, design_gate: undefined }).length);
});

test('real CLI generation and runner reject invalid inputs without overwriting previous results', () => {
  const f = fixture();
  const args = [`--cases=${f.source}`, `--environment-config=${resolve(f.dir, 'environment/runtime.json')}`];
  let result = f.command('create-execution-plan', args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.command('validate-execution-plan').status, 0);
  const planFile = resolve(f.dir, 'execution/execution-plan.json');
  const before = readFileSync(planFile, 'utf8');
  const oldResults = '{"source":"historical synthetic result"}';
  writeFileSync(resolve(f.dir, 'execution/test_results.json'), oldResults);
  f.cases[0].test_data.name = 'ab'; f.save();
  assert.notEqual(f.command('create-execution-plan', args).status, 0);
  assert.equal(readFileSync(planFile, 'utf8'), before);
  assert.notEqual(f.command('validate-execution-plan').status, 0);
  result = f.command('run-ui-tests');
  assert.equal(result.status, 2);
  const blocked = JSON.parse(readFileSync(resolve(f.dir, 'execution/execution-blocked.json'), 'utf8'));
  assert.match(blocked.block_reason, /expected length 3, actual 2/);
  assert.equal(readFileSync(resolve(f.dir, 'execution/test_results.json'), 'utf8'), oldResults);
  assert.equal(f.command('validate-design').status, 2);
});

test('malformed plans and run traversal fail closed', () => {
  for (const plan of [null, { cases: {} }, { cases: [null] }, { cases: [], execution_policy: { workers: 1.5 } }]) assert.ok(validateExecutionPlan(plan).length);
  const result = spawnSync(process.execPath, ['scripts/validate-design.mjs', '--run-id=../../outside'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('reference acceptance preparation remains compatible without executing browser tests', () => {
  const id = `run-design-reference-${randomUUID()}`;
  const result = spawnSync(process.execPath, ['scripts/prepare-acceptance.mjs', `--run-id=${id}`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(resolve(root, 'output/runs', id, 'execution/execution-plan.json'), 'utf8'));
  assert.equal(plan.cases.length, 6);
  assert.deepEqual(validatePlanDesign(root, id, plan), []);
});
