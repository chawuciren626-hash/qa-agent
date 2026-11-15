import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectationOf, buildCeilingIndex, applyCeilings, summarizeWithCeilings, describeCeilings,
} from '../../scripts/execution-verdict.mjs';

// R4 的签字落在断言级的 `verified_by`，用 `human:` 前缀；agent 不能给自己发证书。
const verifiedSource = (ref = 'doc#1') => ({ type: 'human', ref, quote: '原文如此' });
const signed = { verified_by: 'human:zhangsan' };

/** 一条「预期已被人工确认」的用例。 */
const trusted = id => ({
  case_id: id,
  expectations: [{ kind: 'decide', text: 'a', source: verifiedSource(), state: 'verified', ...signed }],
});

/** 一条「预期从未被人工确认」的用例。 */
const untrusted = id => ({
  case_id: id,
  expectations: [{ kind: 'decide', text: 'a', source: { type: 'model', ref: 'agent#1', quote: '模型生成' }, state: 'unverified' }],
});

test('L-3 上限只降不升：fail 不因预期可信而变 pass，pass 因预期不可信而降级', () => {
  const index = buildCeilingIndex([trusted('TC-1'), untrusted('TC-2')]);
  assert.equal(index.get('TC-1').ceiling, 'pass');
  assert.equal(index.get('TC-2').ceiling, 'inconclusive');

  const applied = applyCeilings([
    { case_id: 'TC-1', status: 'failed' },
    { case_id: 'TC-1', status: 'passed' },
    { case_id: 'TC-2', status: 'passed' },
  ], index);
  const [failed, trustedPass, untrustedPass] = applied.cases;
  assert.equal(failed.status, 'failed');
  assert.equal(trustedPass.status, 'passed');
  assert.equal(untrustedPass.status, 'inconclusive');
  assert.equal(untrustedPass.original_status, 'passed');
  assert.equal(untrustedPass.ceiling_applied, true);
  assert.equal(applied.downgraded.length, 1);
  assert.equal(applied.downgraded[0].case_id, 'TC-2');
  assert.match(applied.downgraded[0].reason, /均未被人工确认/);
});

test('L-3 通过率的分母跟着改，并给出不套上限时的对照值', () => {
  const index = buildCeilingIndex([trusted('A'), untrusted('B'), untrusted('C')]);
  const summary = summarizeWithCeilings([
    { case_id: 'A', status: 'passed' },
    { case_id: 'B', status: 'passed' },
    { case_id: 'C', status: 'passed' },
  ], index);
  // 3 条全 pass，但只有 1 条的预期撑得住 pass 结论。
  assert.equal(summary.summary.passed, 1);
  assert.equal(summary.summary.inconclusive, 2);
  assert.equal(summary.summary.downgraded, 2);
  assert.equal(summary.passRate, 33.3);
  // 这个是「差一点就报出去的那个数」——并排给出来才是证据。
  assert.equal(summary.inflatedPassRate, 100);
});

test('L-3 没有用例清单依据的结果单独标出，不默认算通过也不假装是失败', () => {
  const index = buildCeilingIndex([trusted('A')]);
  const summary = summarizeWithCeilings([{ case_id: 'A', status: 'passed' }, { case_id: 'GHOST', status: 'passed' }], index);
  assert.deepEqual(summary.unmatched, ['GHOST']);
  const ghost = summary.cases.find(row => row.case_id === 'GHOST');
  assert.equal(ghost.expectation, null);
  assert.equal(ghost.expectation_unknown, true);
  // 原结论保留：把「清单缺失」拉低成 fail 或 inconclusive，会让它看起来像用例问题。
  assert.equal(ghost.status, 'passed');
  assert.equal(summary.summary.expectation_unknown, 1);
});

test('L-3 blocked/skipped 不进通过率分母', () => {
  const index = buildCeilingIndex([trusted('A'), trusted('B'), trusted('C')]);
  const summary = summarizeWithCeilings([
    { case_id: 'A', status: 'passed' },
    { case_id: 'B', status: 'blocked' },
    { case_id: 'C', status: 'skipped' },
  ], index);
  assert.equal(summary.passRate, 100);
  assert.equal(summary.summary.blocked, 1);
  assert.equal(summary.summary.skipped, 1);
});

test('L-3 兼容散装字段：用例级 expected_source 继承到断言级', () => {
  const normalized = expectationOf({ case_id: 'X', expected_source: verifiedSource('doc#9'), assertions: [{ text: 'a' }] });
  assert.equal(normalized.expectations.length, 1);
  assert.equal(normalized.expectations[0].source.ref, 'doc#9');
  // 继承只解决「来源」，不解决「谁认过」。没有 verified_by 的用例照样撑不住 pass——
  // 这正是 R3 的立场：有来源 ≠ 有人负责。
  const unsigned = buildCeilingIndex([{ case_id: 'X', expected_source: verifiedSource('doc#9'), assertions: [{ text: 'a' }] }]);
  assert.equal(unsigned.get('X').ceiling, 'inconclusive');
  assert.equal(unsigned.get('X').smoke.eligible, true);
  const signedCase = buildCeilingIndex([{
    case_id: 'X', expected_source: verifiedSource('doc#9'),
    assertions: [{ text: 'a', state: 'verified', ...signed }],
  }]);
  assert.equal(signedCase.get('X').ceiling, 'pass');
  // 数组形态原样透传
  assert.equal(expectationOf({ case_id: 'Y', expectations: [{ kind: 'decide' }] }).expectations.length, 1);
  assert.equal(expectationOf({ case_id: 'Z' }).expectations.length, 0);
});

test('L-3 报告措辞：降级与清单缺失都要说清，一样没有时不要编', () => {
  const clean = summarizeWithCeilings([{ case_id: 'A', status: 'passed' }], buildCeilingIndex([trusted('A')]));
  assert.equal(clean.summary.downgraded, 0);
  assert.match(describeCeilings(clean), /没有因预期不可信而降级的用例/);

  const dirty = summarizeWithCeilings([
    { case_id: 'A', status: 'passed' }, { case_id: 'B', status: 'passed' }, { case_id: 'GHOST', status: 'passed' },
  ], buildCeilingIndex([trusted('A'), untrusted('B')]));
  const text = describeCeilings(dirty);
  assert.match(text, /1 条原本通过，因预期未被人工确认而降级为 inconclusive/);
  assert.match(text, /不套上限时通过率为 100%/);
  assert.match(text, /1 条执行结果在用例清单里找不到对应预期/);
});

test('L-3 没有任何可判定的执行结果时通过率是 null，不是 0% 也不是 100%', () => {
  const summary = summarizeWithCeilings([{ case_id: 'A', status: 'blocked' }], buildCeilingIndex([trusted('A')]));
  assert.equal(summary.passRate, null);
  assert.equal(summary.inflatedPassRate, null);
  assert.match(describeCeilings(summary), /通过率 —%/);
});
