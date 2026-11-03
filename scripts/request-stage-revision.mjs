import { readFileSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertContextSession } from './directory-context.mjs';
import { getRunContext, withRunLock, assertStageHistory, assertDesignMutable, getPlanStage, recomputeRunStatus, writeJson } from './orchestration-state.mjs';
import { runDirectory, readRunFile } from './design-quality.mjs';
import { assertCompletedArtifacts } from './artifact-contracts.mjs';
import { requestAnalysisRevision } from './analysis-revision.mjs';

const root = resolve(import.meta.dirname, '..');
const [runId, sessionId, stage, confirmationId, actorId] = process.argv.slice(2);
const feedback = process.env.QA_STAGE_FEEDBACK ?? '';
if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || !/^session-[A-Za-z0-9-]+$/.test(sessionId ?? '') ||
    !['analysis','test_points','test_cases','defects','report'].includes(stage) ||
    !/^confirm-[A-Za-z0-9_-]+$/.test(confirmationId ?? '') || !/^[A-Za-z0-9_-]+$/.test(actorId ?? '') ||
    !feedback.trim() || Buffer.byteLength(feedback,'utf8') > 8000) throw new Error('Invalid stage revision request');
assertContextSession(root, sessionId);
const project = JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
const result = withRunLock(root, project, runId, () => {
  const {manifest, manifestPath} = getRunContext(root, project, runId);
  if (manifest.run_id !== runId || manifest.directory_context?.session_id !== sessionId ||
      manifest.orchestration?.plan?.workflow_mode !== 'lifecycle' || manifest.orchestration?.plan?.review_mode !== 'staged') throw new Error('Run identity or review mode changed');
  const plan = getPlanStage(manifest,stage);
  if (!plan?.selected || (plan.confirmation !== 'after' && plan.result_confirmation !== 'after')) throw new Error('Stage has no result review');
  assertDesignMutable(manifest,stage);
  assertStageHistory(manifest,stage);
  if (manifest.stages?.[stage]?.status !== 'awaiting_confirmation' || Object.values(manifest.stages).some(s=>s.status==='in_progress')) throw new Error('Stage is not idle and awaiting review');
  const latest = manifest.confirmations?.filter(c=>c.stage===stage).at(-1);
  if (latest?.id !== confirmationId || latest.status !== 'pending' || latest.kind === 'authorization') throw new Error('Review request changed');
  const receipt=assertCompletedArtifacts(root,runId,manifest,stage);
  if (!isDeepStrictEqual(receipt,latest.artifact_contract)) throw new Error('Stage artifacts changed');
  const timestamp=new Date().toISOString();
  const source={text:feedback,session_id:sessionId,timestamp};
  if(stage==='analysis') return requestAnalysisRevision(root,runId,manifest,feedback,source);
  const dir=runDirectory(root,runId), id=randomUUID(), archive=`audit/stage-revisions/${stage}-${id}`;
  const affected=new Set([stage]);
  let changed;
  do { changed=false; for(const item of manifest.orchestration.plan.stages.filter(s=>s.selected))
    if(!affected.has(item.id) && item.depends_on?.some(id=>affected.has(id))) {affected.add(item.id); changed=true;}
  } while(changed);
  for(const key of affected) assertStageHistory(manifest,key);
  const files=[...new Set(manifest.artifacts?.filter(path=>typeof path==='string' && [...affected].some(key=>path.startsWith(({test_points:'design/',test_cases:'design/',execution:'execution/',api_execution:'execution/api/',defects:'defects/',report:'report/'})[key] ?? 'not-a-stage/')) && existsSync(resolve(dir,path))) ?? [])].map(path=>readRunFile(dir,path));
  const base=resolve(dir,archive);
  mkdirSync(base,{recursive:true});
  if(realpathSync(base)!==resolve(realpathSync(dir),archive)) throw new Error('Revision archive redirected');
  for(const file of files) { const target=resolve(base,file.path); mkdirSync(resolve(target,'..'),{recursive:true}); writeFileSync(target,file.data,{flag:'wx'}); }
  const inputPath=`inputs/user-feedback-${id}.txt`;
  const bytes=Buffer.from(feedback,'utf8');
  writeFileSync(resolve(dir,inputPath),bytes,{flag:'wx'});
  const feedbackInput={path:inputPath,sha256:createHash('sha256').update(bytes).digest('hex'),session_id:sessionId,timestamp,kind:'user_confirmation'};
  writeFileSync(resolve(base,'manifest-before.json'),readRunFile(dir,'manifest.json').data,{flag:'wx'});
  latest.status='revision_requested'; latest.resolved_at=timestamp; latest.reason=feedback; latest.actor_user_id=actorId; latest.revision_id=id;
  manifest.orchestration.events.push({type:'confirmation_resolved',at:timestamp,stage,decision:'revision_requested',kind:'result',reason:feedback,revision_id:id,archive,affected_stages:[...affected],files:files.map(f=>({path:f.path,sha256:f.sha256})),feedback_input:feedbackInput,actor_user_id:actorId});
  manifest.stages[stage]={...manifest.stages[stage],status:'revision_requested',reason:feedback,revision_id:id,revision_archive:archive,feedback_input:feedbackInput,updated_at:timestamp};
  for(const key of affected) { if(key===stage) continue; const current=manifest.stages[key];
    const prior=manifest.confirmations.filter(c=>c.stage===key).at(-1);
    if(prior?.status==='pending') Object.assign(prior,{status:'revision_requested',resolved_at:timestamp,invalidated_by:id});
    else if(prior?.status==='approved') manifest.confirmations.push({id:`invalidated-${key}-${id}`,stage:key,status:'revision_requested',resolved_at:timestamp,invalidated_by:id,supersedes:prior.id});
    if(current && !['planned','skipped'].includes(current.status)) {
      manifest.orchestration.events.push({type:'quality_revision_required',at:timestamp,stage:key,reason:`Upstream ${stage} revision`,revision_id:id,archive});
      manifest.stages[key]={...current,status:'revision_requested',updated_at:timestamp,reason:`Upstream ${stage} revision`,revision_id:id,revision_archive:archive};
    }
  }
  manifest.orchestration.resume_from=stage; manifest.status=recomputeRunStatus(manifest); manifest.updated_at=timestamp;
  writeJson(manifestPath,manifest);
  return {run_id:runId,stage,decision:'revision_requested',archive,affected_stages:[...affected],starts_execution:false,approval_granted:false};
});
console.log(JSON.stringify(result));
