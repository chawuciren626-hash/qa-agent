import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectByChange, SOURCES_BY_RELIABILITY } from '../../scripts/regression-impact.mjs';

/* ── 基础选集：五触发源各有落点 ───────────────────────────────── */

const CASES = [
  { id: 'C-001', derived_from_requirements: ['REQ-045'], modules: ['order-service'], fragments: [{ id: 'frag-login', version: 1 }] },
  { id: 'C-002', modules: ['payment-service'] },
  { id: 'C-003', fragments: ['frag-login@2'] },
  { id: 'C-004', derived_from_requirements: ['REQ-099'] },
];

function baseInput() {
  return {
    explicit_ids: ['C-010'],
    changed_requirements: ['REQ-045'],
    changed_modules: ['payment-service'],
    changed_fragments: ['frag-login@2'],
    similar_cases: ['C-099'],
    cases: CASES,
  };
}

test('§13.2 五触发源各自命中并给出可解释理由', () => {
  const result = selectByChange(baseInput());
  assert.deepEqual(result.selected, ['C-001', 'C-002', 'C-003', 'C-010', 'C-099']);
  assert.equal(result.reasons['C-010'][0].source, 'explicit');
  assert.equal(result.reasons['C-001'][0].source, 'requirement_change');
  assert.equal(result.reasons['C-001'][0].reason, 'source:REQ-045');
  assert.equal(result.reasons['C-002'][0].source, 'code_change');
  assert.equal(result.reasons['C-002'][0].reason, 'module:payment-service');
  assert.equal(result.reasons['C-003'][0].source, 'dependency');
  // 字符串片段不带 version 字段，与参考实现一致记 '?'（对象片段才记真实版本）。
  assert.equal(result.reasons['C-003'][0].reason, 'fragment:frag-login@?');
  assert.equal(result.reasons['C-099'][0].source, 'history_similar');
  assert.ok(result.explainable);
});

test('可靠性排序写死且理由按可靠性排在前面的触发源优先', () => {
  assert.deepEqual(SOURCES_BY_RELIABILITY, ['explicit', 'requirement_change', 'code_change', 'dependency', 'history_similar']);
  // 同一条用例被需求变更与代码变更同时命中：requirement_change（可靠性 1）排在 code_change（2）前。
  const result = selectByChange({ changed_requirements: ['REQ-045'], changed_modules: ['order-service'], cases: CASES });
  assert.deepEqual(result.reasons['C-001'].map(r => r.source), ['requirement_change', 'code_change']);
});

test('隔离区用例命中触发源也不进选集', () => {
  const result = selectByChange({ ...baseInput(), quarantine_ids: ['C-002'] });
  assert.ok(!result.selected.includes('C-002'));
  assert.ok(!result.reasons['C-002']);
});

test('unselected_risk 记录总分母与选中数', () => {
  const result = selectByChange(baseInput());
  assert.equal(result.unselected_risk.total_cases, 4);
  // selected_count 是 5 而非 4：explicit（C-010）与 similar（C-099）是清单外的 id，
  // 与参考实现一致——显式指定和兜底名单不要求出现在 cases 里。
  assert.equal(result.unselected_risk.selected_count, 5);
});

/* ── 稳定化：同一变更，输入顺序打乱后两次选集完全一致 ─────────── */

test('同一变更：用例清单顺序、变更列表顺序、重复项都不影响选集与指纹', () => {
  const first = selectByChange(baseInput());
  const shuffled = selectByChange({
    explicit_ids: ['C-010', 'C-010'], // 重复项
    changed_requirements: ['REQ-045', 'REQ-045'],
    changed_modules: ['payment-service'], // 与 baseInput 顺序不同也无妨（只有一个）
    changed_fragments: ['frag-login@2'],
    similar_cases: ['C-099'],
    cases: [CASES[2], CASES[0], CASES[3], CASES[1]], // 用例清单顺序打乱
  });
  assert.equal(first.selection_fingerprint, shuffled.selection_fingerprint);
  assert.deepEqual(first.selected, shuffled.selected);
  assert.deepEqual(first.reasons, shuffled.reasons);
});

test('同一变更连续两次调用指纹相同，变更内容变了指纹就变', () => {
  const a = selectByChange(baseInput());
  const b = selectByChange(baseInput());
  assert.equal(a.selection_fingerprint, b.selection_fingerprint);
  const different = selectByChange({ ...baseInput(), changed_modules: ['user-service'] });
  assert.notEqual(a.selection_fingerprint, different.selection_fingerprint);
});

test('理由排序不受触发源处理顺序影响（多触发源命中同一用例）', () => {
  const input = {
    changed_requirements: ['REQ-045'],
    changed_modules: ['order-service'],
    changed_fragments: ['frag-login'],
    cases: CASES,
  };
  const forward = selectByChange(input);
  // cases 逆序传入：理由列表仍按 (reliability, source, reason) 排序。
  const backward = selectByChange({ ...input, cases: [...CASES].reverse() });
  assert.deepEqual(forward.reasons['C-001'], backward.reasons['C-001']);
});

/* ── 入参校验 ─────────────────────────────────────────────────── */

test('非数组入参、非字符串项、缺 id 用例一律拒绝', () => {
  assert.throws(() => selectByChange({ explicit_ids: 'C-001', cases: [] }), /array of strings/);
  assert.throws(() => selectByChange({ explicit_ids: [42], cases: [] }), /expects strings/);
  assert.throws(() => selectByChange({ cases: 'nope' }), /cases expects an array/);
  assert.throws(() => selectByChange({ cases: [{ modules: ['m'] }] }), /non-empty string id/);
});

test('空输入产出空选集且 explainable 为真（vacuous truth）', () => {
  const result = selectByChange({ cases: [] });
  assert.deepEqual(result.selected, []);
  assert.equal(result.explainable, true);
  assert.match(result.selection_fingerprint, /^[0-9a-f]{16}$/);
});
