import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateConsistency,
  evaluateEvidence,
  evaluateTiming,
  inspectM1,
} from '../../scripts/consistency-report.mjs';

/* ---------------------------- 一致性 ---------------------------- */

test('没有执行记录 → available=false，不报「100% 一致」', () => {
  const report = evaluateConsistency({ runs: [] });
  assert.equal(report.available, false);
  assert.equal(report.reason, 'no_runs');
  assert.equal(report.consistency_rate, null);
});

test('单次执行不算一致也不算不一致', () => {
  const report = evaluateConsistency({ runs: [{ case_id: 'c1', status: 'passed' }] });
  assert.equal(report.available, false, '只有一条用例且只跑 1 次，一致率不可计算');
  assert.equal(report.consistency_rate, null);
  assert.equal(report.cases[0].counted, false);
  assert.equal(report.cases[0].consistent, null, '单次执行的一致性必须是 null，不是 true');
  assert.match(report.warnings.join('\n'), /单次执行没有一致性可言/);
});

test('重复次数不足 → 不计入分母并给出警告', () => {
  const runs = [
    { case_id: 'c1', status: 'passed' },
    { case_id: 'c1', status: 'passed' },
  ];
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  assert.equal(report.counted, 0);
  assert.equal(report.consistency_rate, null);
  assert.equal(report.insufficient.length, 1);
  assert.match(report.warnings.join('\n'), /重复次数不足 3 次/);
});

test('3 次同结果 → 一致率 1', () => {
  const runs = ['passed', 'passed', 'passed'].map((status, index) => ({ case_id: 'c1', status, attempt: `a${index}` }));
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  assert.equal(report.available, true);
  assert.equal(report.counted, 1);
  assert.equal(report.consistent, 1);
  assert.equal(report.consistency_rate, 1);
  assert.deepEqual(report.inconsistency, []);
});

test('2 passed + 1 failed → 一致率 0 且列出不一致明细', () => {
  const runs = [
    { case_id: 'c1', status: 'passed', attempt: 'a1' },
    { case_id: 'c1', status: 'failed', attempt: 'a2' },
    { case_id: 'c1', status: 'passed', attempt: 'a3' },
  ];
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  assert.equal(report.consistency_rate, 0);
  assert.equal(report.inconsistency.length, 1);
  assert.equal(report.inconsistency[0].case_id, 'c1');
  assert.deepEqual(report.inconsistency[0].outcomes.map(row => row.status), ['passed', 'failed', 'passed']);
});

test('inconclusive 不算「不一致」也不算「一致」，单列', () => {
  const runs = [
    { case_id: 'c1', status: 'passed' },
    { case_id: 'c1', status: 'inconclusive' },
    { case_id: 'c1', status: 'passed' },
  ];
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  const item = report.cases[0];
  assert.equal(item.repeats, 3);
  assert.equal(item.inconclusive, 1);
  assert.equal(item.decided, 2);
  assert.equal(item.consistent, true, '可判的两次结果一致，就该算一致');
  assert.equal(report.consistency_rate, 1);
});

test('blocked / skipped 同样不进可判集', () => {
  const runs = [
    { case_id: 'c1', status: 'failed' },
    { case_id: 'c1', status: 'blocked' },
    { case_id: 'c1', status: 'skipped' },
  ];
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  assert.equal(report.cases[0].decided, 1);
  assert.equal(report.cases[0].counted, false, '可判结果只有 1 次，不构成一致性');
});

test('部分用例重复数够、部分不够 → 分母只算够的', () => {
  const runs = [
    { case_id: 'c1', status: 'passed' }, { case_id: 'c1', status: 'passed' }, { case_id: 'c1', status: 'passed' },
    { case_id: 'c2', status: 'passed' },
    { case_id: 'c3', status: 'failed' }, { case_id: 'c3', status: 'failed' }, { case_id: 'c3', status: 'passed' },
  ];
  const report = evaluateConsistency({ runs, requiredRepeats: 3 });
  assert.equal(report.counted, 2);
  assert.equal(report.consistent, 1);
  assert.equal(report.consistency_rate, 0.5);
  assert.equal(report.insufficient.length, 1);
});

test('口径写清是入库门 N=3，不是运行期', () => {
  const report = evaluateConsistency({ runs: [{ case_id: 'c1', status: 'passed' }], requiredRepeats: 3 });
  assert.equal(report.scope, 'entry_gate');
  assert.match(report.scope_note, /入库门/);
  assert.match(report.scope_note, /并非每条都跑 3 次/);
});

/* ---------------------------- 取证包 ---------------------------- */

test('没有失败记录 → 可定位性不适用，不是满分', () => {
  const report = evaluateEvidence({ runs: [{ case_id: 'c1', status: 'passed' }] });
  assert.equal(report.available, false);
  assert.equal(report.locatable_rate, null);
  assert.match(report.note, /不适用不等于满分/);
});

test('失败带证据路径 + 错误 → 可定位', () => {
  const report = evaluateEvidence({
    runs: [
      { case_id: 'c1', status: 'failed', evidence_paths: ['evidence/c1/'], error: { type: 'TypeError' } },
      { case_id: 'c2', status: 'failed', evidence: { paths: ['evidence/c2/'] }, failure_summary: 'x' },
    ],
  });
  assert.equal(report.locatable, 2);
  assert.equal(report.locatable_rate, 1);
});

test('失败缺证据 → 计入不可定位并列出用例号', () => {
  const report = evaluateEvidence({
    runs: [
      { case_id: 'c1', status: 'failed', evidence_paths: ['evidence/c1/'], error: { type: 'TypeError' } },
      { case_id: 'c2', status: 'failed', error: { type: 'TypeError' } },
      { case_id: 'c3', status: 'failed', evidence_paths: ['evidence/c3/'] },
    ],
  });
  assert.equal(report.failures, 3);
  assert.equal(report.locatable, 1);
  assert.deepEqual(report.missing_evidence, ['c2', 'c3']);
});

test('取证包口径明说不是人工抽检结论', () => {
  const report = evaluateEvidence({ runs: [{ case_id: 'c1', status: 'failed', evidence_paths: ['e/'], error: { type: 'X' } }] });
  assert.match(report.note, /不等于人工抽检/);
});

/* ---------------------------- 耗时 ---------------------------- */

test('没有 duration_ms → 明确报不达标，不拿 0 充数', () => {
  const report = evaluateTiming({ runs: [{ case_id: 'c1', status: 'passed' }] });
  assert.equal(report.available, false);
  assert.equal(report.reason, 'no_duration');
  assert.match(report.note, /不达标/);
});

test('有耗时 → 给出 p50/p95/max 与总量', () => {
  const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const report = evaluateTiming({ runs: durations.map((duration_ms, index) => ({ case_id: `c${index}`, status: 'passed', duration_ms })) });
  assert.equal(report.available, true);
  assert.equal(report.samples, 10);
  assert.equal(report.total_ms, 5500);
  assert.equal(report.max_ms, 1000);
  assert.equal(report.p50_ms, 600);
  assert.match(report.note, /CPU\/内存占用/);
  assert.match(report.note, /只满足一半/, '耗时不等于资源占用，口径要写明');
});

/* ---------------------------- 四条汇总 ---------------------------- */

const healthyRuns = () => {
  const runs = [];
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
    for (let index = 0; index < 3; index += 1) {
      runs.push({ case_id: id, status: 'passed', attempt: `a${index}`, duration_ms: 120 + index * 10, evidence_paths: ['e/'], error: null });
    }
  }
  return runs;
};

test('第 4 条永远是 manual', () => {
  const report = inspectM1({ runs: healthyRuns() });
  const diff = report.checks.find(item => item.id === 'diff');
  assert.equal(diff.status, 'manual');
  assert.equal(diff.value, null);
  assert.match(diff.detail, /只能人工判定/);
});

test('全部通过 → 第 2 条 not_applicable（零失败=没有抽检对象，不等于满分），整体 ready_pending_manual', () => {
  const report = inspectM1({ runs: healthyRuns() });
  assert.equal(report.checks[1].status, 'not_applicable');
  assert.match(report.checks[1].detail, /不适用不等于满分/);
  assert.equal(report.overall, 'ready_pending_manual',
    '不适用与待人工一样：不阻塞，但也不能声称 fully ready');
});

test('1/2/3 条都有结论且达标 + 第 4 条待人工 → ready_pending_manual', () => {
  // 掺入一个带完整证据的失败，才能让第 2 条有可判依据
  const runs = healthyRuns();
  runs[0] = { ...runs[0], status: 'failed', evidence_paths: ['evidence/c1/'], error: { type: 'TypeError' } };
  const report = inspectM1({ runs });
  assert.equal(report.checks[1].status, 'pass');
  assert.equal(report.checks[0].status, 'fail', '掺了失败后第 1 条就不一致了');
  // 单独构造一份「一致 + 有可定位失败」的数据，验证 ready_pending_manual 这条路
  const clean = healthyRuns().filter(row => row.case_id !== 'c5');
  clean.push({ case_id: 'c5', status: 'failed', attempt: 'a0', duration_ms: 90, evidence_paths: ['e/'], error: { type: 'TypeError' } });
  clean.push({ case_id: 'c5', status: 'failed', attempt: 'a1', duration_ms: 90, evidence_paths: ['e/'], error: { type: 'TypeError' } });
  clean.push({ case_id: 'c5', status: 'failed', attempt: 'a2', duration_ms: 90, evidence_paths: ['e/'], error: { type: 'TypeError' } });
  const cleanReport = inspectM1({ runs: clean });
  assert.equal(cleanReport.checks[0].status, 'pass');
  assert.equal(cleanReport.checks[1].status, 'pass');
  assert.equal(cleanReport.checks[2].status, 'pass');
  assert.equal(cleanReport.checks[3].status, 'manual');
  assert.equal(cleanReport.overall, 'ready_pending_manual');
});

test('出现不一致 → not_ready', () => {
  const runs = healthyRuns();
  runs[0] = { ...runs[0], status: 'failed' };
  const report = inspectM1({ runs });
  assert.equal(report.checks[0].status, 'fail');
  assert.equal(report.overall, 'not_ready');
});

test('没有执行记录 → 第 1 条 unknown，整体 not_ready（不知道不等于通过）', () => {
  const report = inspectM1({ runs: [] });
  assert.equal(report.checks[0].status, 'unknown');
  assert.equal(report.overall, 'not_ready');
});

test('缺 duration_ms → 第 3 条 fail', () => {
  const runs = healthyRuns().map(({ duration_ms, ...rest }) => rest);
  const report = inspectM1({ runs });
  assert.equal(report.checks[2].status, 'fail');
  assert.equal(report.overall, 'not_ready');
});

test('提供人工 diff 结论 → 写进第 4 条说明但仍为 manual', () => {
  const report = inspectM1({ runs: healthyRuns(), diffReview: { verdict: '通过', minutes: 6, note: '抽样 3 条。' } });
  const diff = report.checks.find(item => item.id === 'diff');
  assert.equal(diff.status, 'manual');
  assert.match(diff.detail, /人工结论：通过/);
  assert.match(diff.detail, /6 分钟/);
});

test('markdown 含四条表格与不一致明细', () => {
  const runs = healthyRuns();
  runs[1] = { ...runs[1], status: 'failed' };
  const report = inspectM1({ runs });
  assert.match(report.markdown, /# M1 一致性验收报告/);
  assert.match(report.markdown, /\| # \| 验收项 \| 标准 \| 结果 \| 数值 \|/);
  assert.match(report.markdown, /### 不一致明细/);
  assert.match(report.markdown, /- c1：failed \/ passed \/ passed|failed \/ passed/);
  assert.match(report.markdown, /## 口径/);
});
