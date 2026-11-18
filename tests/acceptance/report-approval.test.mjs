import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReportApproval, submitForReview, approveReport, rejectReport,
  evaluateHardGates, verifyAudit,
} from '../../scripts/report-approval.mjs';

/* ── 硬闸评估 ─────────────────────────────────────────────────── */

const completeReplay = {
  kind: 'replay-comparison',
  run_id: 'R1',
  status: 'completed',
  requested_replays: 3,
  executed_replays: 3,
  per_case: [
    { case_id: 'C-1', verdict: 'stable_passed' },
    { case_id: 'C-2', verdict: 'stable_failed' },
  ],
};

test('硬闸：重放完整且无 unstable/not_run 时放行', () => {
  const result = evaluateHardGates({ replay_comparison: completeReplay });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('硬闸：重放 partial（预算到点）阻止批准', () => {
  const partial = { ...completeReplay, status: 'partial', executed_replays: 1, stop_reason: 'replay_budget_exhausted' };
  const result = evaluateHardGates({ replay_comparison: partial });
  assert.equal(result.passed, false);
  const gate = result.failures.find(f => f.gate === 'replay_complete');
  assert.ok(gate);
  assert.match(gate.detail, /replay_budget_exhausted/);
});

test('硬闸：unstable 用例未隔离阻止批准（flaky 不进可靠通过）', () => {
  const withUnstable = {
    ...completeReplay,
    per_case: [{ case_id: 'C-1', verdict: 'unstable' }, { case_id: 'C-2', verdict: 'stable_passed' }],
  };
  const result = evaluateHardGates({ replay_comparison: withUnstable });
  assert.equal(result.passed, false);
  assert.match(result.failures.find(f => f.gate === 'no_unstable_in_pass').detail, /C-1/);
});

test('硬闸：not_run 用例出现在对比里阻止批准（未执行不得报通过）', () => {
  const withNotRun = {
    ...completeReplay,
    per_case: [{ case_id: 'C-3', verdict: 'not_run' }],
  };
  const result = evaluateHardGates({ replay_comparison: withNotRun });
  assert.equal(result.passed, false);
  assert.match(result.failures.find(f => f.gate === 'no_unexecuted_pass').detail, /C-3/);
});

test('硬闸：缺重放对比文档直接闸死（无证据不批准）', () => {
  const result = evaluateHardGates({});
  assert.equal(result.passed, false);
  assert.equal(result.failures[0].gate, 'evidence_present');
});

test('硬闸：unknown 与 passed 并存时闸死（unknown 不算通过也不拉低通过）', () => {
  const result = evaluateHardGates({
    replay_comparison: completeReplay,
    sampling_summary: { passed: 5, failed: 1, flaky: 0, unknown: 2, incomplete: 0 },
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.find(f => f.gate === 'unknown_not_pass').detail, /unknown\/incomplete/);
});

test('硬闸：只有 unknown 没有 passed 不触发 unknown_not_pass（分桶如实即可）', () => {
  const result = evaluateHardGates({
    replay_comparison: completeReplay,
    sampling_summary: { passed: 0, failed: 0, flaky: 0, unknown: 2, incomplete: 0 },
  });
  assert.equal(result.passed, true);
});

/* ── 状态机 ───────────────────────────────────────────────────── */

function draft() {
  return createReportApproval({ run_id: 'gateway_admin_accept', report_ref: 'report/report-20261118.md', actor: 'tester' });
}

test('创建即 draft 且创建本身留审计（seq 1）', () => {
  const doc = draft();
  assert.equal(doc.status, 'draft');
  assert.equal(doc.audit.length, 1);
  assert.equal(doc.audit[0].action, 'created');
  assert.equal(doc.audit[0].seq, 1);
  assert.ok(doc.report_fingerprint);
});

test('draft → reviewing → approved 全程留痕', () => {
  const doc = submitForReview(draft(), { actor: 'tester', note: '批次 4 全量执行完毕' });
  assert.equal(doc.status, 'reviewing');
  doc.approved_note = undefined;
  const approved = approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: completeReplay } });
  assert.equal(approved.status, 'approved');
  const actions = approved.audit.map(entry => entry.action);
  assert.deepEqual(actions, ['created', 'submitted', 'approved']);
  assert.ok(verifyAudit(approved));
});

test('硬闸失败：状态停在 reviewing、审计记 approve_blocked、错误带明细', () => {
  const doc = submitForReview(draft(), { actor: 'tester' });
  const partial = { ...completeReplay, status: 'partial', stop_reason: 'replay_budget_exhausted' };
  assert.throws(
    () => approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: partial } }),
    error => {
      assert.match(error.message, /hard gates blocked approval/);
      assert.equal(error.gate_failures.length, 1);
      return true;
    },
  );
  assert.equal(doc.status, 'reviewing'); // 没批成，也没悄悄放行
  const blocked = doc.audit[doc.audit.length - 1];
  assert.equal(blocked.action, 'approve_blocked');
  assert.equal(blocked.gate_failures[0].gate, 'replay_complete');
  assert.match(blocked.gate_failures[0].detail, /replay_budget_exhausted/);
  assert.ok(verifyAudit(doc));
});

test('闸失败后补正重放，重新批准成功（blocked 不是终态）', () => {
  const doc = submitForReview(draft(), { actor: 'tester' });
  const partial = { ...completeReplay, status: 'partial', stop_reason: 'replay_budget_exhausted' };
  assert.throws(() => approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: partial } }));
  const approved = approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: completeReplay } });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.audit.map(e => e.action), ['created', 'submitted', 'approve_blocked', 'approved']);
});

test('非法状态转换一律拒绝', () => {
  assert.throws(() => approveReport(draft(), { gates: { replay_comparison: completeReplay } })); // draft 不能直接 approve
  const doc = submitForReview(draft(), {});
  assert.throws(() => submitForReview(doc, {})); // reviewing 不能重复提交
  const approved = approveReport(doc, { gates: { replay_comparison: completeReplay } });
  assert.throws(() => rejectReport(approved, { reason: 'x' })); // approved 不能退回
});

test('退回必须带原因；退回后可重新送审', () => {
  const doc = submitForReview(draft(), {});
  assert.throws(() => rejectReport(doc, {}));
  rejectReport(doc, { actor: 'reviewer', reason: '报告缺重放指纹' });
  assert.equal(doc.status, 'draft');
  submitForReview(doc, { actor: 'tester', note: '已补指纹' });
  assert.equal(doc.status, 'reviewing');
  assert.ok(verifyAudit(doc));
});

/* ── 审计篡改检测 ─────────────────────────────────────────────── */

test('审计 seq 断档或重复时 verifyAudit 报不可信', () => {
  // 造一条长链：created → submitted → approve_blocked → approved
  const doc = submitForReview(draft(), {});
  const partial = { ...completeReplay, status: 'partial', stop_reason: 'replay_budget_exhausted' };
  assert.throws(() => approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: partial } }));
  approveReport(doc, { actor: 'reviewer', gates: { replay_comparison: completeReplay } });
  assert.equal(verifyAudit(doc), true);
  doc.audit.splice(1, 1); // 删中间的 submitted → seq 变 [1,3,4]，断档
  assert.equal(verifyAudit(doc), false);
  doc.audit[1].seq = 1; // 改成重复 seq → [1,1,4]，同样不可信
  assert.equal(verifyAudit(doc), false);
});

test('审批文档拒绝外来 JSON（kind 不对就拒收）', () => {
  assert.throws(() => submitForReview({ kind: 'something-else', status: 'draft', audit: [] }), /report-approval/);
  assert.throws(() => verifyAudit({ kind: 'nope', audit: [] }), /report-approval/);
});
