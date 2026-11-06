import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  SEVERITY_LEVELS,
  severityCounts,
  severityNeedsReview,
  severityProblems,
  severityStandardCounts
} from '../../scripts/defect-severity.mjs';
import { defectGateReasons, qualityGateStatus } from '../../scripts/quality-gate.mjs';

const root = resolve(import.meta.dirname, '../..');
const dimensions = { user_business_impact: 'major', reach_frequency: 'some', recoverability: 'workaround', data_security_compliance: 'none' };
const standard = (overrides = {}) => ({
  severity: 'Major',
  severity_standard_version: 1,
  severity_reason: 'Synthetic fixture: core flow degraded with a documented workaround',
  severity_dimensions: { ...dimensions },
  ...overrides
});
function fixture() {
  const id = `run-severity-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', id);
  const write = (path, value) => { const file = resolve(dir, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  write('execution/test_results.json', { run_id: id, status: 'failed', summary: { total: 1, failed: 1 }, cases: [{ case_id: 'TC-1', status: 'failed', evidence_paths: ['execution/error.txt'] }] });
  mkdirSync(resolve(dir, 'execution'), { recursive: true });
  writeFileSync(resolve(dir, 'execution/error.txt'), 'synthetic assertion evidence');
  return {
    id,
    dir,
    write,
    run: script => spawnSync(process.execPath, [`scripts/${script}.mjs`, `--run-id=${id}`], { cwd: root, encoding: 'utf8' }),
    read: path => JSON.parse(readFileSync(resolve(dir, path), 'utf8'))
  };
}

test('every documented severity level is accepted on a complete standard record', () => {
  assert.deepEqual([...SEVERITY_LEVELS].sort(), ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial', 'unknown'].sort());
  for (const level of SEVERITY_LEVELS) {
    assert.deepEqual(severityProblems(standard({ severity: level }), { requireStandard: true }), [], level);
  }
});

test('missing, free-text and partial severity assessments are rejected for new records', () => {
  assert.match(severityProblems({}, { requireStandard: true }).join('; '), /severity is required/);
  assert.match(severityProblems(standard({ severity: 'High' }), { requireStandard: true }).join('; '), /severity must be one of/);
  assert.match(severityProblems(standard({ severity_reason: '   ' }), { requireStandard: true }).join('; '), /severity_reason is required/);
  assert.match(severityProblems({ severity: 'Major', severity_standard_version: 1 }, { requireStandard: true }).join('; '), /severity_dimensions is required/);
  assert.match(severityProblems(standard({ severity_dimensions: { user_business_impact: 'major' } }), { requireStandard: true }).join('; '), /severity_dimensions\.reach_frequency is required/);
  assert.match(severityProblems(standard({ severity_dimensions: { ...dimensions, reach_frequency: 'often' } }), { requireStandard: true }).join('; '), /reach_frequency must be one of/);
  assert.match(severityProblems(standard({ severity_dimensions: { ...dimensions, extra: 'none' } }), { requireStandard: true }).join('; '), /unknown severity dimension/);
  assert.match(severityProblems(standard({ severity_standard_version: 2 }), { requireStandard: true }).join('; '), /severity_standard_version must be 1/);
});

test('legacy defect records stay readable and are not retroactively rewritten', () => {
  assert.deepEqual(severityProblems({ severity: 'Major' }), []);
  assert.deepEqual(severityProblems({}), []);
  assert.notDeepEqual(severityProblems({ severity: 'Major' }, { requireStandard: true }), []);
  const counts = severityStandardCounts([{ severity: 'Major' }, standard(), { ...standard({ severity: 'unknown' }), severity_reason: '' }]);
  assert.deepEqual(counts, { standard: 2, legacy: 1, unknown: 1, missing: 0, missing_reason: 1 });
});

test('unknown severity is unclassified, never folded into a low level, and triggers review for new standards', () => {
  const unknown = standard({ severity: 'unknown', severity_reason: 'Impact cannot be confirmed without a production account' });
  assert.deepEqual(severityProblems(unknown, { requireStandard: true }), []);
  assert.deepEqual(severityCounts([unknown, { severity: 'Trivial' }, {}]), { Blocker: 0, Critical: 0, Major: 0, Minor: 0, Trivial: 1, unknown: 1, missing: 1 });
  assert.equal(severityNeedsReview(unknown, { defect_severity: { review_on_unknown: true } }), true);
  assert.equal(severityNeedsReview(unknown, { defect_severity: { review_on_unknown: false } }), false);
  assert.equal(severityNeedsReview({ severity: 'unknown' }), false);
  const record = { ...unknown, category: 'product_defect', lifecycle_status: 'draft' };
  const reasons = defectGateReasons([record], [], { defect_severity: { review_on_unknown: true } });
  assert.ok(reasons.includes('unknown_severity'), reasons.join(', '));
  assert.equal(qualityGateStatus({ review_on: [] }, ['unknown_severity']), 'review_required');
});

test('severity evidence may only cite evidence already attached to the defect', () => {
  const record = { ...standard(), evidence_refs: ['execution/error.txt'], severity_evidence: ['execution/error.txt'] };
  assert.deepEqual(severityProblems(record), []);
  assert.match(severityProblems({ ...record, severity_evidence: ['execution/other.png'] }).join('; '), /severity_evidence must reference existing evidence_refs/);
  assert.match(severityProblems({ ...record, severity_evidence: [''] }).join('; '), /array of non-empty strings/);
  assert.match(severityProblems({ ...standard(), severity_evidence: ['execution/error.txt'] }).join('; '), /evidence_refs is required/);
});

test('normalizer refuses missing or invented severity and persists the full assessment', () => {
  const f = fixture();
  const base = { bug_id: 'BUG-SYNTHETIC', title: 'Synthetic issue', classification: 'product_defect', case_id: 'TC-1', evidence_paths: ['execution/error.txt'] };
  f.write('defects/bugs.json', { bugs: [base] });
  const missing = f.run('normalize-defects');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /缺少 severity/);

  f.write('defects/bugs.json', { bugs: [{ ...base, severity: 'High' }] });
  const invalid = f.run('normalize-defects');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /severity 必须是/);

  f.write('defects/bugs.json', { bugs: [{ ...base, severity: 'unknown', severity_standard_version: 1, severity_reason: 'Cannot reproduce outside the synthetic fixture', severity_dimensions: { ...dimensions, user_business_impact: 'unknown' }, severity_evidence: ['execution/error.txt'], priority: 'P2' }] });
  const accepted = f.run('normalize-defects');
  assert.equal(accepted.status, 0, accepted.stderr);
  const record = f.read('defects/defect-records.json').records[0];
  assert.equal(record.severity, 'unknown');
  assert.equal(record.severity_standard_version, 1);
  assert.deepEqual(record.severity_dimensions, { ...dimensions, user_business_impact: 'unknown' });
  assert.deepEqual(record.severity_evidence, ['execution/error.txt']);
  assert.equal(record.priority, 'P2');
});
