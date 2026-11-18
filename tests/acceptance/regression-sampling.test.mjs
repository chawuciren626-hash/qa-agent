import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  samplingModes, samplingTier, plannedRuns, judgeRuns, planSampling, summarizeVerdicts, flakyIsolation,
} from '../../scripts/regression-sampling.mjs';

/* ── 分档 ─────────────────────────────────────────────────────── */

test('L-6 分档：敏感集优先于调用场景', () => {
  assert.equal(samplingTier({ case_id: 'C', history: 'flaky' }, { suite: 'smoke' }), 'flaky');
  assert.equal(samplingTier({ case_id: 'C', new_in_version: true }, { suite: 'full' }), 'flaky');
  assert.equal(samplingTier({ case_id: 'C', touched_modules: ['a', 'b', 'c'] }, { suite: 'smoke' }), 'flaky');
  assert.equal(samplingTier({ case_id: 'C', touched_modules: ['a', 'b'] }, { suite: 'smoke' }), 'smoke');
  assert.equal(samplingTier({ case_id: 'C' }, { suite: 'smoke' }), 'smoke');
  assert.equal(samplingTier({ case_id: 'C' }, { suite: 'admission' }), 'admission');
  assert.equal(samplingTier({ case_id: 'C' }, { suite: 'full' }), 'full');
  assert.equal(samplingTier({ case_id: 'C' }), 'full');
});

test('L-6 入库门与敏感集是 always，冒烟与全量是 fail_only', () => {
  assert.equal(samplingModes.admission.mode, 'always');
  assert.equal(samplingModes.admission.runs, 3);
  assert.equal(samplingModes.flaky.mode, 'always');
  assert.equal(samplingModes.smoke.mode, 'fail_only');
  assert.equal(samplingModes.full.mode, 'fail_only');
  // 上限统一 3 次：文档里「复跑到 3 次」是对客户讲的，代码要对得上。
  for (const tier of Object.keys(samplingModes)) assert.equal(samplingModes[tier].runs, 3);
  // 每一档都要能回答「为什么是这样」，否则下次评审又要重新讨论一遍。
  for (const tier of Object.keys(samplingModes)) assert.ok(samplingModes[tier].why.length > 5);
});

test('L-6 plannedRuns 的 runs 是上限不是承诺', () => {
  const smoke = plannedRuns({ case_id: 'C' }, { suite: 'smoke' });
  assert.equal(smoke.tier, 'smoke');
  assert.equal(smoke.max_runs, 3);
  assert.equal(smoke.mode, 'fail_only');
  const admission = plannedRuns({ case_id: 'C' }, { suite: 'admission' });
  assert.equal(admission.mode, 'always');
});

/* ── 判定：复跑不能洗成通过 ───────────────────────────────────── */

test('L-6 首次通过即停，fail_only 档不会为攒通过而多跑', () => {
  const verdict = judgeRuns(['passed'], { maxRuns: 3, mode: 'fail_only' });
  assert.equal(verdict.verdict, 'passed');
  assert.equal(verdict.runs, 1);
});

test('L-6 首次失败 + 后续通过 = flaky，不是 passed', () => {
  const verdict = judgeRuns(['failed', 'passed', 'passed'], { maxRuns: 3 });
  assert.equal(verdict.verdict, 'flaky');
  assert.match(verdict.reason, /not a pass/);
  // 只采两次就说 flaky 是不成立的：fail_only 档「复跑到 3 次」是为了把 flaky 判清楚，
  // 没采满就是没判清楚，只能报 incomplete。
  assert.equal(judgeRuns(['failed', 'passed'], { maxRuns: 3 }).verdict, 'incomplete');
  // 先失败后失败再从第二次起通过，同样是 flaky。
  assert.equal(judgeRuns(['failed', 'failed', 'passed'], { maxRuns: 3 }).verdict, 'flaky');
});

test('L-6 采满仍全失败 = failed；没采满 = incomplete，不提前下结论', () => {
  assert.equal(judgeRuns(['failed', 'failed', 'failed'], { maxRuns: 3 }).verdict, 'failed');
  const partial = judgeRuns(['failed', 'failed'], { maxRuns: 3 });
  assert.equal(partial.verdict, 'incomplete');
  assert.match(partial.reason, /1 of the 3 budgeted runs have not happened/);
});

test('L-6 blocked/skipped 首次就 unknown：没测到既不算通过也不算失败', () => {
  for (const status of ['blocked', 'skipped']) {
    const verdict = judgeRuns([status], { maxRuns: 3 });
    assert.equal(verdict.verdict, 'unknown');
    assert.match(verdict.reason, /never exercised/);
  }
  // 第一次就 blocked，后面即使有 passed 也不能算通过：没有可比的对象。
  assert.equal(judgeRuns(['blocked', 'passed'], { maxRuns: 3 }).verdict, 'unknown');
});

test('L-6 判定拒绝超预算与非法状态', () => {
  assert.throws(() => judgeRuns([], { maxRuns: 3 }), /non-empty array/);
  assert.throws(() => judgeRuns(['passed', 'passed', 'passed', 'passed'], { maxRuns: 3 }), /exceed the 3-run budget/);
  assert.throws(() => judgeRuns(['pass'], { maxRuns: 3 }), /unknown status "pass"/);
});

/* ── 成本对照 ─────────────────────────────────────────────────── */

test('L-6 成本对照能复算出 §20.2.1 那张表', () => {
  // 1500 条、失败率 8%、全量档：期望 1500 + 120×2 = 1740
  const cases = Array.from({ length: 1500 }, (_, index) => ({ case_id: `TC-${index + 1}` }));
  const plan = planSampling(cases, { suite: 'full', failureRate: 0.08 });
  assert.equal(plan.cases, 1500);
  assert.equal(plan.misreadRuns, 4500);
  assert.equal(plan.expectedRuns, 1740);
  assert.equal(plan.byTier.full, 1500);
  // 最坏情况仍是 4500（全部失败都要采满），报告要能说出这个上界。
  assert.equal(plan.worstRuns, 4500);
  assert.equal(plan.savingVsMisread, 61.3);
});

test('L-6 敏感集把预算花在该花的地方，而不是一刀切', () => {
  const cases = [
    ...Array.from({ length: 100 }, (_, i) => ({ case_id: `A-${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ case_id: `F-${i}`, history: 'flaky' })),
  ];
  const plan = planSampling(cases, { suite: 'full', failureRate: 0 });
  assert.equal(plan.byTier.flaky, 20);
  assert.equal(plan.byTier.full, 100);
  // 失败率 0 时，全量档每条只跑 1 次，敏感集 3 次。
  assert.equal(plan.expectedRuns, 100 * 1 + 20 * 3);
  assert.equal(plan.entries.find(entry => entry.case_id === 'F-0').max_runs, 3);
  assert.equal(plan.entries.find(entry => entry.case_id === 'A-0').max_runs, 3);
  assert.equal(plan.entries.find(entry => entry.case_id === 'A-0').expected_runs, 1);
});

/* ── 汇总口径 ─────────────────────────────────────────────────── */

test('L-6 flaky 单独计数，永不并入 passed', () => {
  const summary = summarizeVerdicts([
    { verdict: 'passed' }, { verdict: 'passed' }, { verdict: 'failed' },
    { verdict: 'flaky' }, { verdict: 'unknown' }, { verdict: 'incomplete' },
  ]);
  assert.equal(summary.passed, 2);
  assert.equal(summary.flaky, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.incomplete, 1);
  // 分母只含真正跑出结论的那三类
  assert.equal(summary.attempted, 4);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.flakyRate, 25);
  assert.match(summary.note, /never added to passed/);
});

test('L-6 一条都没跑出结论时通过率是 null，不是 0% 也不是 100%', () => {
  const summary = summarizeVerdicts([{ verdict: 'unknown' }, { verdict: 'incomplete' }]);
  assert.equal(summary.attempted, 0);
  assert.equal(summary.passRate, null);
  assert.equal(summary.flakyRate, null);
});

test('L-6 隔离名单只收 unstable 用例，且下一轮采样立刻进 flaky 敏感集', () => {
  const comparison = {
    kind: 'replay-comparison',
    run_id: 'run-x',
    status: 'completed',
    executed_replays: 3,
    requested_replays: 3,
    per_case: [
      { case_id: 'TC-A', verdict: 'passed', consistent: true, flaky_suspect: false, verdicts: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }] },
      { case_id: 'TC-B', verdict: 'unstable', consistent: false, flaky_suspect: true, verdicts: [{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }] },
      { case_id: 'TC-C', verdict: 'inconclusive', consistent: false, flaky_suspect: false, reason: '缺席 2 次执行', verdicts: [{ status: 'passed' }] },
    ],
  };
  const list = flakyIsolation(comparison);
  assert.equal(list.kind, 'regression-isolation');
  assert.deepEqual(list.isolated.map(row => row.case_id), ['TC-B']);
  assert.equal(list.isolated[0].history, 'flaky');
  assert.deepEqual(list.isolated[0].verdicts, ['passed', 'failed', 'passed']);
  // 名单直接喂回采样器：这条用例下一轮进 flaky 档（always ×3）。
  const plan = plannedRuns({ case_id: 'TC-B', history: list.isolated[0].history }, { suite: 'full' });
  assert.equal(plan.tier, 'flaky');
  assert.equal(plan.mode, 'always');
  assert.equal(plan.max_runs, 3);
  // coverage 如实：完整执行才有 complete=true。
  assert.equal(list.coverage.complete, true);
});

test('L-6 partial 的重放仍然产出怀疑名单，但 coverage 明说执行不完整', () => {
  const comparison = {
    kind: 'replay-comparison',
    run_id: 'run-y',
    status: 'partial',
    stop_reason: 'replay_budget_exhausted',
    executed_replays: 1,
    requested_replays: 3,
    per_case: [
      { case_id: 'TC-D', verdict: 'unstable', consistent: false, flaky_suspect: true, verdicts: [{ status: 'failed' }] },
    ],
  };
  const list = flakyIsolation(comparison);
  // 一次失败就足够怀疑：怀疑就该隔离，不必等预算跑满。
  assert.deepEqual(list.isolated.map(row => row.case_id), ['TC-D']);
  assert.equal(list.coverage.complete, false);
  assert.equal(list.coverage.stop_reason, 'replay_budget_exhausted');
});

test('L-6 不是重放对比的文档拒绝产出名单', () => {
  assert.throws(() => flakyIsolation({ kind: 'something-else', per_case: [] }), /replay-comparison/);
  assert.throws(() => flakyIsolation({ kind: 'replay-comparison' }), /per_case/);
});
