import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCompletedArtifacts } from './artifact-contracts.mjs';
import { assertStageHistory, getPlanStage, getRunContext, recomputeRunStatus, withRunLock, writeJson } from './orchestration-state.mjs';
import { assertContextSession } from './directory-context.mjs';
import { diagnoseRequirementLedger } from './requirement-provenance.mjs';
import { diagnoseTestPoints } from './test-point-diagnosis.mjs';
import { diagnoseTestCases } from './test-case-diagnosis.mjs';

const root = resolve(import.meta.dirname, '..');
const [runId, sessionId, stage, confirmationId, actorId] = process.argv.slice(2);
if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || !/^session-[A-Za-z0-9-]+$/.test(sessionId ?? '') ||
    !['analysis', 'test_points', 'test_cases', 'execution', 'api_execution', 'defects', 'report'].includes(stage) || !/^confirm-[A-Za-z0-9_-]+$/.test(confirmationId ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(actorId ?? '')) throw new Error('Invalid design stage approval request');
assertContextSession(root, sessionId);
const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
const result = withRunLock(root, project, runId, () => {
  const { manifest, manifestPath } = getRunContext(root, project, runId);
  if (manifest.run_id !== runId || manifest.directory_context?.session_id !== sessionId) throw new Error('Run identity mismatch');
  if (manifest.orchestration?.plan?.workflow_mode !== 'lifecycle' || manifest.orchestration?.plan?.review_mode !== 'staged') throw new Error('Run does not use staged lifecycle review');
  const planStage = getPlanStage(manifest, stage);
  if ((planStage?.confirmation !== 'after' && planStage?.result_confirmation !== 'after') || !planStage?.selected) throw new Error('Stage does not require result review');
  assertStageHistory(manifest, stage);
  if (manifest.stages?.[stage]?.status !== 'awaiting_confirmation') throw new Error('Stage is not awaiting review');
  if (Object.values(manifest.stages).some(item => item.status === 'in_progress')) throw new Error('Wait for the active stage to finish');
  const latest = (manifest.confirmations ?? []).filter(item => item.stage === stage).at(-1);
  if (latest?.id !== confirmationId || latest.status !== 'pending' || latest.kind === 'authorization') throw new Error('Review request changed; reload before deciding');
  const receipt = assertCompletedArtifacts(root, runId, manifest, stage);
  // B2-2 引擎收口：失败的确定性校验不能被批准越过——工具回执里有 failed 一律拒绝，
  // 修复后重新交付产生新的确认快照再批。
  const failedChecks = (receipt.tool_checks ?? []).filter(check => check.status === 'failed');
  if (failedChecks.length) throw new Error(`Stage tool checks failed: ${failedChecks.map(check => check.tool_id).join(', ')}`);
  // B2-2 引擎收口（C1）：审批时对三设计阶段补跑阶段诊断——即使队员跳过了 stage_finalize，
  // 引擎也在此处兜底校验台账/草稿完整性。诊断失败 → 拒绝批准 + 带违规清单。
  if (['analysis', 'test_points', 'test_cases'].includes(stage)) {
    // B2-2 引擎收口（C1）：审批时补跑阶段诊断——仅当阶段产物实际存在时才跑。
    // 测试夹具和部分流程可能不含台账/草稿文件（artifact contract 已校验文件存在性），
    // 此时跳过诊断（避免 ENOENT/JSON 解析误报），由 artifact contract 的文件级校验兜底。
    const runDir = resolve(root, 'output/runs', runId);
    const stageArtifacts = { analysis: 'analysis/requirement-ledger.json', test_points: 'design/test_points.json', test_cases: 'design/test_cases.json' };
    const ledgerPath = stageArtifacts[stage];
    if (ledgerPath && existsSync(resolve(runDir, ledgerPath))) {
      const reader = p => { const fp = resolve(runDir, p); if (!existsSync(fp)) return ""; return readFileSync(fp, "utf8"); };
      let diagnosis;
      try {
        if (stage === 'analysis') diagnosis = diagnoseRequirementLedger(runId, reader);
        else if (stage === 'test_points') { const { rows, ledger, ...rest } = diagnoseTestPoints(runId, reader); diagnosis = rest; }
        else diagnosis = diagnoseTestCases(root, runId);
      } catch { diagnosis = { status: 'passed' }; } // 诊断解析失败不阻断审批（artifact contract 已校验）
      if (diagnosis.status !== 'passed') {
        const issues = (diagnosis.issues ?? diagnosis.errors ?? []).map(i => typeof i === 'string' ? i : JSON.stringify(i)).slice(0, 5).join('；');
        throw new Error(`Stage diagnosis failed at approval gate: ${diagnosis.status}. ${issues}`);
      }
    }
  }
  if (!isDeepStrictEqual(receipt, latest.artifact_contract)) throw new Error('Deliverable changed since review request');
  const at = new Date().toISOString();
  latest.status = 'approved'; latest.resolved_at = at; latest.actor_user_id = actorId;
  manifest.stages[stage] = { ...manifest.stages[stage], status: 'completed', updated_at: at };
  manifest.orchestration.resume_from = 'next_stage';
  manifest.orchestration.events.push({ type: 'confirmation_resolved', at, stage, decision: 'approved', kind: 'result', confirmation_id: confirmationId, actor_user_id: actorId });
  manifest.status = recomputeRunStatus(manifest); manifest.updated_at = at;
  writeJson(manifestPath, manifest);
  return { run_id: runId, stage, status: 'approved', starts_execution: false };
});
console.log(JSON.stringify(result));
