import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCompletedArtifacts } from './artifact-contracts.mjs';
import { assertStageHistory, getPlanStage, getRunContext, recomputeRunStatus, withRunLock, writeJson } from './orchestration-state.mjs';
import { assertContextSession } from './directory-context.mjs';

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
