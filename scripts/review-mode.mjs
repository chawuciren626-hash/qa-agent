import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCompletedArtifacts } from './artifact-contracts.mjs';
import { assertStageHistory, getRunContext, recomputeRunStatus, withRunLock, writeJson } from './orchestration-state.mjs';

// A workflow preference is not a business approval. Existing review requests stay in the audit trail.
export function setReviewMode(root, runId, mode) {
  if (mode !== 'auto') throw new Error('Only autonomous continuation is supported');
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
  return withRunLock(root,project,runId,()=>{
    const {manifest,manifestPath}=getRunContext(root,project,runId);
    const plan=manifest.orchestration?.plan;
    if (!plan?.stages?.length) throw new Error('Plan the run before changing review mode');
    if (Object.values(manifest.stages ?? {}).some(s=>s.status==='in_progress')) throw new Error('Wait for the current child to finish');
    const changes=[];
    for (const stage of plan.stages.filter(s=>s.selected && s.confirmation==='after')) {
      assertStageHistory(manifest,stage.id);
      const state=manifest.stages[stage.id];
      const latest=(manifest.confirmations ?? []).filter(c=>c.stage===stage.id).at(-1);
      if (state.status==='awaiting_confirmation') {
        if (latest?.status!=='pending') throw new Error(`${stage.id} confirmation record mismatch`);
        const receipt=assertCompletedArtifacts(root,runId,manifest,stage.id);
        if (!isDeepStrictEqual(receipt,latest.artifact_contract)) throw new Error(`${stage.id} deliverable changed since review request`);
        changes.push({stage:stage.id,confirmation:latest});
      } else if (['blocked','failed'].includes(state.status)) {
        throw new Error(`${stage.id} needs its recorded recovery before autonomous continuation`);
      }
    }
    if (plan.review_mode==='auto' && !changes.length) return {run_id:runId,review_mode:'auto',unchanged:true,continued_stages:[],starts_execution:false,approval_granted:false};
    const at=new Date().toISOString();
    for (const stage of plan.stages.filter(s=>s.confirmation==='after')) stage.confirmation='none';
    for (const {stage,confirmation} of changes) {
      confirmation.status='not_required';
      confirmation.resolved_at=at;
      confirmation.reason='Autonomous workflow preference; no business approval granted';
      manifest.stages[stage]={...manifest.stages[stage],status:'completed',updated_at:at};
      manifest.orchestration.events.push({type:'review_mode_continued',at,stage,confirmation_id:confirmation.id,decision:'not_required'});
    }
    plan.review_mode='auto';
    plan.updated_at=at;
    manifest.orchestration.events.push({type:'review_mode_changed',at,mode:'auto',continued_stages:changes.map(c=>c.stage)});
    manifest.orchestration.resume_from=plan.stages.find(s=>s.selected && !['completed','skipped'].includes(manifest.stages[s.id]?.status))?.id ?? 'completed';
    manifest.status=recomputeRunStatus(manifest);
    manifest.updated_at=at;
    writeJson(manifestPath,manifest);
    return {run_id:runId,review_mode:'auto',unchanged:false,continued_stages:changes.map(c=>c.stage),resume_from:manifest.orchestration.resume_from,starts_execution:false,approval_granted:false};
  });
}
