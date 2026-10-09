import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBenchmarkRecord } from '../../scripts/benchmark-record.mjs';

function fixture() {
  const runtime = { agent_id: 'synthetic', version: 1, provider: 'fixture', model_id: 'fixture', thinking_level: 'medium', state_sha256: 'a'.repeat(64) };
  const revision_sha256 = 'b'.repeat(64);
  const expected_cases = ['A', 'B', 'C'];
  return {
    runtime, revision_sha256, expected_cases, score: 95,
    cases: expected_cases.map((case_id, i) => ({
      case_id, run: 1, status: 'scored', session_id: `synthetic-${i}`,
      runtime: { ...runtime }, revision_sha256, score: i ? 100 : 85,
      review: { status: 'approved', reviewer: 'synthetic reviewer', evidence_ref: 'synthetic-review.md:1' },
      items: [{ id: 'dimension', max_score: 100, score: i ? 100 : 85, evidence_ref: 'synthetic-output.md:1' }]
    }))
  };
}

test('structured score arithmetic accepts correct records, not a low-score target', () => {
  const result = checkBenchmarkRecord(fixture());
  assert.equal(result.passed, true);
  assert.equal(result.calculated_score, 95);
});

test('reject inaccurate historical averages, invalid-to-zero conversion and missing cells', () => {
  for (const mutate of [
    r => { r.score = 61.67; },
    r => { r.cases[0].status = 'benchmark_invalid'; r.cases[0].score = 0; r.score = 66.67; },
    r => { r.cases.pop(); },
    r => { r.cases[1].case_id = 'A'; },
    r => { r.cases[1].session_id = r.cases[0].session_id; },
    r => { r.cases[0].run = 2; }
  ]) { const r = fixture(); mutate(r); assert.equal(checkBenchmarkRecord(r).passed, false); }
});

test('reject runtime/revision drift, absent evidence and incomplete review', () => {
  for (const mutate of [
    r => { r.cases[0].runtime.thinking_level = 'max'; },
    r => { r.cases[0].runtime.state_sha256 = 'c'.repeat(64); },
    r => { r.cases[0].revision_sha256 = 'c'.repeat(64); },
    r => { r.cases[0].items[0].evidence_ref = ''; },
    r => { r.cases[0].review.status = 'pending'; },
    r => { r.runtime.version = '1'; },
    r => { r.expected_cases = []; }
  ]) { const r = fixture(); mutate(r); assert.equal(checkBenchmarkRecord(r).passed, false); }
});

test('reject malformed or inconsistent scoring dimensions', () => {
  for (const mutate of [
    r => { r.cases[0].items[0].score = 101; },
    r => { r.cases[0].items[0].max_score = 99; },
    r => { r.cases[0].items[0].score = '85'; },
    r => { r.cases[0].items = [null]; },
    r => { r.cases[0].items.push({ ...r.cases[0].items[0] }); },
    r => { r.cases[0] = null; },
    r => { r.score = null; }
  ]) { const r = fixture(); mutate(r); assert.equal(checkBenchmarkRecord(r).passed, false); }
  assert.equal(checkBenchmarkRecord(null).passed, false);
});

test('revision draft has exactly three isolated public/private cases and no scores', () => {
  const root = resolve(import.meta.dirname, '../../benchmarks/qa-evidence-review-v2');
  const cases = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  assert.equal(cases.length, 3);
  for (const entry of cases) {
    for (const part of ['statement', 'rubric']) {
      assert.ok(readFileSync(resolve(root, entry.name, part, 'README.md'), 'utf8').trim());
    }
    assert.ok(!readdirSync(resolve(root, entry.name, 'statement')).some(name => /rubric|scoreboard/i.test(name)));
  }
  assert.match(readFileSync(resolve(root, 'benchmark_config.toml'), 'utf8'), /^status = "draft"$/m);
  assert.equal(readFileSync(resolve(root, 'scoreboard.yaml'), 'utf8').trim(), 'evaluations: []');
});
