import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonFile } from './safety-fixtures.mjs';
import { buildDefectIndex, buildQualityTrends } from '../../scripts/quality-index.mjs';
import { governedDefects } from '../../scripts/defect-lifecycle.mjs';

test('index is scope-aware, excludes fixtures and warns instead of failing on one damaged run', () => {
  const root = resolve(import.meta.dirname, '../../output/acceptance', `quality-index-${randomUUID()}`);
  const put = (id, data) => writeJsonFile(resolve(root, 'output/runs', id, 'defects/defect-records.json'), data);
  const record = { defect_id: 'DEF-ONE', fingerprint: 'same-title-fingerprint', title: 'Identical title', category: 'product_defect', lifecycle_status: 'draft', confidence: 'medium', related_cases: ['TC-ONE'] };
  for (const id of ['run-a', 'run-b', 'run-fixture', 'run-broken']) put(id, { run_id: id, records: [record] });
  writeJsonFile(resolve(root, 'output/runs/run-fixture/inputs/fixture-origin.json'), { source: 'synthetic excluded dataset' });
  writeFileSync(resolve(root, 'output/runs/run-broken/defects/defect-records.json'), '{');
  const separate = buildDefectIndex(root);
  assert.equal(separate.unique_defects, 2); assert.equal(separate.warnings.length, 1);
  for (const id of ['run-a', 'run-b']) put(id, { run_id: id, records: [{ ...record, scope_id: 'explicit-business-scope' }] });
  const candidates = buildDefectIndex(root);
  assert.equal(candidates.unique_defects, 1); assert.equal(candidates.repeated_defects, 1);
  assert.equal(candidates.grouping, 'scoped_duplicate_candidates_only');
  put('run-partial', { run_id: 'run-partial', records: [{ ...record, scope_id: 'explicit-business-scope' }, { ...record, defect_id: 'DEF-BAD', fingerprint: null }] });
  const partial = buildDefectIndex(root);
  assert.equal(partial.warnings.length, 2);
  assert.equal(partial.defects[0].occurrence_count, 2);
});

test('trends skip stale governance and execution state with explicit diagnostics', () => {
  const root = resolve(import.meta.dirname, '../../output/acceptance', `quality-trends-${randomUUID()}`);
  for (const id of ['run-current', 'run-stale', 'run-active']) {
    const dir = resolve(root, 'output/runs', id);
    const data = { run_id: id, records: [] };
    writeJsonFile(resolve(dir, 'defects/defect-records.json'), data);
    const governance = { ...governedDefects(root, id, data), integrity_error: null };
    writeJsonFile(resolve(dir, 'report/quality-metrics.json'), { run_id: id, generated_at: '2026-10-09T00:00:00Z', governance: id === 'run-stale' ? {} : governance, execution: { pass_rate: 100 }, quality_gate: { status: 'informational' }, defects: { total: 0 } });
    if (id === 'run-active') writeJsonFile(resolve(dir, 'execution/execution-state.json'), { status: 'running', invocation_id: 'new' });
  }
  const result = buildQualityTrends(root);
  assert.equal(result.runs.length, 1); assert.equal(result.runs[0].run_id, 'run-current');
  assert.equal(result.skipped.length, 2);
});
