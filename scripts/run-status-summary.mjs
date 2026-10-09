import { createHash } from 'node:crypto';
import { assertStageHistory, recomputeRunStatus, stageStatuses } from './orchestration-state.mjs';

export function summarizeRun(raw, runId) {
  const manifest = JSON.parse(raw);
  if (manifest.run_id !== runId) throw new Error('Manifest run ID mismatch');
  const plan = manifest.orchestration?.plan?.stages ?? [];
  if (!Array.isArray(plan) || new Set(plan.map(s => s.id)).size !== plan.length) throw new Error('Invalid or duplicate plan stages');
  const issues = [];
  if (!plan.some(s => s.selected)) issues.push('No selected plan stages');
  const stages = plan.map(stage => {
    const state = manifest.stages?.[stage.id] ?? {};
    const confirmation = (manifest.confirmations ?? []).filter(c => c.stage === stage.id).at(-1);
    const latestEvent = (manifest.orchestration?.events ?? []).filter(e => e.stage === stage.id).at(-1);
    if (!stageStatuses.has(state.status)) issues.push(`${stage.id}: missing or unknown state`);
    try { assertStageHistory(manifest, stage.id); } catch (error) { issues.push(`${stage.id}: ${error.message}`); }
    const pending = (manifest.confirmations ?? []).filter(c => c.stage === stage.id && c.status === 'pending');
    if (pending.length > 1 || (state.status === 'awaiting_confirmation') !== (pending.length === 1) || (pending.length && confirmation?.status !== 'pending')) issues.push(`${stage.id}: confirmation state mismatch`);
    let next = 'review_unknown_state';
    if (!stage.selected) next = 'outside_scope';
    else if (['blocked', 'failed'].includes(state.status)) next = 'review_before_recovery';
    else if (state.status === 'awaiting_confirmation') next = 'wait_for_confirmation';
    else if (state.status === 'in_progress') next = 'inspect_active_dispatch';
    else if (state.status === 'revision_requested') next = 'review_revision_before_dispatch';
    else if (state.status === 'completed') next = stage.confirmation === 'after' && confirmation?.status !== 'approved' ? 'request_confirmation' : 'stage_recorded_complete';
    else if (state.status === 'planned') next = stage.confirmation === 'before' && confirmation?.status !== 'approved' ? 'review_preparation_and_request_confirmation' : 'check_dispatch_readiness';
    else if (state.status === 'skipped') next = 'skipped';
    return { id: stage.id, selected: Boolean(stage.selected), status: state.status ?? 'unknown', mode: state.mode ?? null,
      confirmation: confirmation ? { id: confirmation.id, status: confirmation.status, reason: confirmation.reason ?? null } : null,
      dispatch_id: state.dispatch_id ?? null, latest_event: latestEvent?.type ?? null,
      reason: ['blocked', 'failed', 'revision_requested'].includes(state.status) ? state.reason ?? latestEvent?.reason ?? null : null,
      next_action: next };
  });
  const derived = recomputeRunStatus(manifest);
  if (manifest.status !== derived) issues.push('Recorded aggregate differs from derived stage aggregate');
  const unfinished = stages.filter(s => s.selected && !['stage_recorded_complete', 'skipped'].includes(s.next_action));
  const focus = unfinished.find(s => ['blocked', 'failed'].includes(s.status)) ?? unfinished[0];
  const summary = { run_id: runId, manifest_sha256: createHash('sha256').update(raw).digest('hex'),
    recorded_status: manifest.status ?? null, derived_status: derived, consistency: issues.length ? 'review_required' : 'consistent', issues,
    scope: stages.filter(s => s.selected).map(s => s.id), stages,
    workflow_closed: !issues.length && !unfinished.length,
    next_action: issues.length ? 'review_manifest_inconsistency' : focus?.next_action ?? 'review_deliverables',
    focus_stage: focus?.id ?? null,
    limitations: ['Manifest snapshot only; not execution authorization', 'No artifact, process, product quality or semantic revalidation'] };
  summary.user_summary = renderSummary(summary);
  return summary;
}

function renderSummary(summary) {
  const lines = [`运行：${summary.run_id}`, `清单状态：${summary.recorded_status}；按阶段汇总：${summary.derived_status}。`,
    `一致性：${summary.consistency}；本次流程记录${summary.workflow_closed ? '已收口' : '未收口'}。`];
  for (const stage of summary.stages) lines.push(`${stage.id}：${stage.status}；${stage.selected ? '本次范围内' : '范围外'}；最新确认：${stage.confirmation?.status ?? '无'}${stage.reason ? `；原因：${JSON.stringify(stage.reason)}` : ''}。`);
  lines.push(`下一步：${summary.next_action}${summary.focus_stage ? `（${summary.focus_stage}）` : ''}。`,
    '此摘要仅反映清单快照，不代表产品测试通过、语义审查通过或获得执行授权。', `清单SHA256：${summary.manifest_sha256}`);
  if (summary.issues.length) lines.push(`需审查：${summary.issues.join('; ')}`);
  return lines.join('\n');
}
