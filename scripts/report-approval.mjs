/**
 * 报告审批流：draft → reviewing → approved + 硬闸 + 审计留痕（批次 5，对应 A4）。
 *
 * 验收口径（手册批次 5 行）：「硬闸失败阻止报告批准；报告审批留审计」。
 *
 * 状态机只有三条合法边，其余一律拒绝：
 *   draft    --submit-->  reviewing   （提交送审）
 *   reviewing --approve--> approved    （硬闸全过才放行）
 *   reviewing --reject-->  draft       （退回修改）
 *
 * 硬闸（evaluateHardGates）不是建议，是批准的前置条件。四条闸的每一根都
 * 指向一个已知的造假路径：
 *   1. replay_complete      重放没跑完（partial / 预算到点）→ 不存在"可靠通过"可言；
 *   2. no_unstable_in_pass  per_case 里有 unstable → flaky 没有被隔离，
 *                           塞进通过率就是「复跑洗成通过」的翻版；
 *   3. no_unexecuted_pass   有 not_run 的用例 → 未执行的用例不得出现在任何通过结论里；
 *   4. evidence_present     重放对比文档缺失 → 没有证据不批准，不是"先批了再补"。
 *
 * 审计留痕是 append-only：每条 {seq, at, action, actor, ...}，seq 连续递增；
 * verifyAudit 校验连续性——seq 断档或重复 = 记录被动过，审批文档不可信。
 *
 * 与全仓口径一致：approve 是纯函数层（不碰文件系统），落盘由调用方负责，
 * 和 execution-plan / replay 层一样便于在无 IO 的测试里穷举状态机。
 */

import { createHash } from 'node:crypto';

const STATUS = Object.freeze({ DRAFT: 'draft', REVIEWING: 'reviewing', APPROVED: 'approved' });

function nowIso() {
  return new Date().toISOString();
}

/** 追加一条审计记录：seq 连续，时间与动作不可由调用方伪造。 */
function appendAudit(doc, action, { actor, note, ...extra } = {}) {
  const seq = doc.audit.length ? doc.audit[doc.audit.length - 1].seq + 1 : 1;
  doc.audit.push({
    seq,
    at: nowIso(),
    action,
    actor: actor ?? 'unknown',
    ...(note ? { note } : {}),
    status_after: doc.status,
    ...extra,
  });
}

/** 创建审批文档：初始 draft，审计从 seq 1 开始（创建本身也要留痕）。 */
export function createReportApproval({ run_id, report_ref, actor } = {}) {
  if (!run_id || typeof run_id !== 'string') throw new Error('createReportApproval expects a run_id string');
  if (!report_ref || typeof report_ref !== 'string') throw new Error('createReportApproval expects a report_ref string');
  const doc = {
    kind: 'report-approval',
    version: 1,
    run_id,
    report_ref,
    report_fingerprint: createHash('sha256').update(report_ref).digest('hex').slice(0, 16),
    status: STATUS.DRAFT,
    created_at: nowIso(),
    audit: [],
  };
  appendAudit(doc, 'created', { actor, note: `report ${report_ref} entered draft` });
  return doc;
}

/** 提交送审：仅 draft → reviewing。已送审/已批准的文档重复提交一律拒绝。 */
export function submitForReview(doc, { actor, note } = {}) {
  if (doc?.kind !== 'report-approval') throw new Error('Expected a report-approval document');
  if (doc.status !== STATUS.DRAFT) {
    throw new Error(`submit expects status draft, got "${doc.status}"`);
  }
  doc.status = STATUS.REVIEWING;
  appendAudit(doc, 'submitted', { actor, note });
  return doc;
}

/** 退回修改：仅 reviewing → draft，必须带退回原因（没有原因的退回无法改进）。 */
export function rejectReport(doc, { actor, reason } = {}) {
  if (doc?.kind !== 'report-approval') throw new Error('Expected a report-approval document');
  if (doc.status !== STATUS.REVIEWING) {
    throw new Error(`reject expects status reviewing, got "${doc.status}"`);
  }
  if (!reason || typeof reason !== 'string') throw new Error('reject requires a reason string');
  doc.status = STATUS.DRAFT;
  appendAudit(doc, 'rejected', { actor, note: reason });
  return doc;
}

/* ── 硬闸 ─────────────────────────────────────────────────────── */

/**
 * 硬闸评估。输入取自批次 4/5 的既有产物，缺什么就闸什么：
 *   replay_comparison  execution/replay-comparison.json 的内容（可省略 → 闸 4 失败）
 *   sampling_summary   summarizeVerdicts 的输出（unknown/incomplete 被算进 passed 时闸死）
 *
 * 返回 {passed, failures: [{gate, detail}]}：failures 是空数组才允许批准。
 */
export function evaluateHardGates({ replay_comparison, sampling_summary } = {}) {
  const failures = [];

  if (!replay_comparison || replay_comparison.kind !== 'replay-comparison') {
    failures.push({
      gate: 'evidence_present',
      detail: 'no replay-comparison document supplied; approval without execution evidence is not allowed',
    });
  } else {
    if (replay_comparison.status !== 'completed') {
      failures.push({
        gate: 'replay_complete',
        detail: `replay status is "${replay_comparison.status}"${replay_comparison.stop_reason ? ` (stop_reason: ${replay_comparison.stop_reason})` : ''}; partial replays cannot back a reliable pass`,
      });
    }
    const perCase = Array.isArray(replay_comparison.per_case) ? replay_comparison.per_case : [];
    const unstable = perCase.filter(row => row?.verdict === 'unstable').map(row => row.case_id);
    if (unstable.length) {
      failures.push({
        gate: 'no_unstable_in_pass',
        detail: `unstable cases not isolated: ${unstable.join(', ')}; flaky never counts toward reliable pass`,
      });
    }
    const notRun = perCase.filter(row => row?.verdict === 'not_run').map(row => row.case_id);
    if (notRun.length) {
      failures.push({
        gate: 'no_unexecuted_pass',
        detail: `cases never executed: ${notRun.join(', ')}; unexecuted cases cannot appear in any pass conclusion`,
      });
    }
  }

  if (sampling_summary) {
    const leakedUnknown = (sampling_summary.unknown ?? 0) + (sampling_summary.incomplete ?? 0);
    if (leakedUnknown > 0 && (sampling_summary.passed ?? 0) > 0) {
      failures.push({
        gate: 'unknown_not_pass',
        detail: `${leakedUnknown} unknown/incomplete verdicts exist alongside ${sampling_summary.passed} passed; unknown is neither pass nor fail and must be reported as its own bucket`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * 批准：仅 reviewing → approved，且硬闸必须全过。
 * 闸失败时状态停在 reviewing、审计记 approve_blocked（失败明细随审计落盘），
 * 调用方拿到带 failures 的错误——阻断必须可解释，不能只抛"不行"两个字。
 */
export function approveReport(doc, { actor, note, gates } = {}) {
  if (doc?.kind !== 'report-approval') throw new Error('Expected a report-approval document');
  if (doc.status !== STATUS.REVIEWING) {
    throw new Error(`approve expects status reviewing, got "${doc.status}"`);
  }
  const evaluation = evaluateHardGates(gates ?? {});
  if (!evaluation.passed) {
    appendAudit(doc, 'approve_blocked', {
      actor,
      note: note ?? undefined,
      gate_failures: evaluation.failures,
    });
    const detail = evaluation.failures.map(f => `${f.gate}: ${f.detail}`).join(' | ');
    const error = new Error(`hard gates blocked approval — ${detail}`);
    error.gate_failures = evaluation.failures;
    throw error;
  }
  doc.status = STATUS.APPROVED;
  appendAudit(doc, 'approved', { actor, note });
  return doc;
}

/* ── 审计校验 ─────────────────────────────────────────────────── */

/**
 * 审计连续性校验：seq 必须从 1 起连续递增。
 * 断档/重复 = 记录被插入或删除，文档不可信——返回 false 而不是静默忽略。
 */
export function verifyAudit(doc) {
  if (doc?.kind !== 'report-approval') throw new Error('Expected a report-approval document');
  return doc.audit.every((entry, index) => entry.seq === index + 1);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const usage = [
    '用法：node scripts/report-approval.mjs check <approval.json> [replay-comparison.json]',
    '  check          对已落盘的审批文档做审计连续性校验',
    '  check+gates    连同重放对比文档一起评估硬闸（不修改文档，只输出评估结果）',
  ].join('\n');
  const [command, approvalPath, replayPath] = process.argv.slice(2);
  if (!command || !approvalPath || (command === 'check+gates' && !replayPath)) {
    console.error(usage);
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const doc = JSON.parse(readFileSync(resolve(approvalPath), 'utf8'));
  if (command === 'check') {
    console.log(JSON.stringify({ audit_intact: verifyAudit(doc), status: doc.status }, null, 2));
  } else {
    const replay = JSON.parse(readFileSync(resolve(replayPath), 'utf8'));
    console.log(JSON.stringify(evaluateHardGates({ replay_comparison: replay }), null, 2));
  }
}
