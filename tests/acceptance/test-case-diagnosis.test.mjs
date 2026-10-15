import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { designArtifacts } from './artifact-fixtures.mjs';
import { diagnoseTestCases } from '../../scripts/test-case-diagnosis.mjs';

const root = resolve(import.meta.dirname, '../..');

test('case draft diagnosis aggregates basis and data errors without requiring Excel', () => {
  const runId = `run-case-diagnosis-${randomUUID()}`;
  const { dir } = designArtifacts(root, runId);
  const json = resolve(dir, 'design/test_cases.json');
  const cases = JSON.parse(readFileSync(json, 'utf8'));
  const row = Array.isArray(cases) ? cases[0] : (cases.cases ?? cases.test_cases)[0];
  row.design_contract.basis[0].rule = 'Wrong source statement';
  row.test_data ??= {};
  row.test_data.name = 'abc';
  row.design_contract.data_checks = [{ kind: 'length', key: 'name', unit: 'code_points', expected: 2 }];
  writeFileSync(json, JSON.stringify(cases));
  const result = diagnoseTestCases(root, runId);
  assert.equal(result.status, 'needs_correction');
  assert.ok(result.errors.some(error => error.includes('Basis differs')));
  assert.ok(result.errors.some(error => error.includes('expected length 2, actual 3')));
  assert.equal(result.exports_checked, false);
  assert.deepEqual(result.data_diagnostics[0].measurements.find(item=>item.key==='name'),{key:'name',code_points:3,utf16:3,utf8_bytes:3,graphemes:3});
  assert.match(result.data_diagnostics[0].errors.join('\n'),/expected length 2, actual 3/);
});
