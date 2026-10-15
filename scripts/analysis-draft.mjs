import { existsSync, mkdirSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { withRunLock, writeJson } from './orchestration-state.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');

// Replacement requires an intact active-dispatch snapshot or a reviewed recovery archive.
export function publishAnalysisDraft(root,runId,output,parentId) {
  const dir=runDirectory(root,runId);
  return withRunLock(root,{run_root:'output/runs'},runId,()=>{
    const manifest=JSON.parse(readRunFile(dir,'manifest.json').data);
    const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='analysis').at(-1);
    const confirmations = (manifest.confirmations ?? []).filter(c => c.stage === 'analysis');
    const latest = confirmations.at(-1);
    const revision = manifest.orchestration?.events?.filter(e => e.stage === 'analysis' && e.type === 'confirmation_resolved' && e.decision === 'revision_requested').at(-1);
    const revisionBeforeDispatch = revision?.revision_id && revision.revision_id === latest?.revision_id && manifest.orchestration.events.indexOf(revision) < manifest.orchestration.events.indexOf(dispatch);
    const confirmationAllowsDraft = !confirmations.length || (latest.status === 'revision_requested' && revisionBeforeDispatch && !confirmations.some(c => c.status === 'pending'));
    if (!parentId || dispatch?.['parent-session-id']!==parentId || !dispatch.dispatch_id || manifest.stages?.analysis?.status!=='in_progress' || !confirmationAllowsDraft) throw new Error('Draft update requires the owning active analysis dispatch and no current confirmation; historical decisions require an explicit revision');
    const target=resolve(dir,'analysis/requirement_analysis.md');
    if (realpathSync(resolve(dir,'analysis'))!==resolve(realpathSync(dir),'analysis')) throw new Error('Analysis directory must not redirect writes');
    const ledger=readRunFile(dir,'analysis/requirement-ledger.json').data;
    const index='audit/analysis-generations/current.json';
    const before=existsSync(target)?readRunFile(dir,'analysis/requirement_analysis.md').data:null;
    if (before?.equals(Buffer.from(output))) return {unchanged:true};
    let previous;
    const currentGeneration=existsSync(resolve(dir,index))?JSON.parse(readRunFile(dir,index).data):null;
    const recovery=manifest.orchestration.events.filter(e=>e.type==='stage_recovered' && e.stage==='analysis').at(-1);
    const reviewedBase=before && currentGeneration?.dispatch_id!==dispatch.dispatch_id && recovery?.archive && recovery.evidence?.sha256 && recovery.parent_session_id===parentId && manifest.orchestration.events.indexOf(recovery)<manifest.orchestration.events.indexOf(dispatch) && dispatch.revision_context?.archive===recovery.archive;
    if(reviewedBase) {
      const oldMarkdown=readRunFile(dir,`${recovery.archive}/analysis/requirement_analysis.md`);
      const oldLedger=readRunFile(dir,`${recovery.archive}/analysis/requirement-ledger.json`);
      if(!oldMarkdown.data.equals(before) || !recovery.files.some(f=>f.path===oldMarkdown.path.slice(recovery.archive.length+1) && f.sha256===oldMarkdown.sha256) || !recovery.files.some(f=>f.path==='analysis/requirement-ledger.json' && f.sha256===oldLedger.sha256)) throw new Error('Reviewed draft archive changed');
    }
    if (before && !reviewedBase) {
      if (!existsSync(resolve(dir,index))) throw new Error('Existing analysis has no controlled generation snapshot; reviewed revision required');
      previous=JSON.parse(readRunFile(dir,index).data);
      if (previous.dispatch_id!==dispatch.dispatch_id || previous.parent_session!==parentId || previous.markdown_sha256!==hash(before) || !/^[a-f0-9-]{36}$/.test(previous.snapshot_id)) throw new Error('Existing analysis generation ownership or hash mismatch');
      const oldMarkdown=readRunFile(dir,`audit/analysis-generations/${previous.snapshot_id}/requirement_analysis.md`).data;
      const oldLedger=readRunFile(dir,`audit/analysis-generations/${previous.snapshot_id}/requirement-ledger.json`).data;
      if (hash(oldMarkdown)!==previous.markdown_sha256 || hash(oldLedger)!==previous.ledger_sha256) throw new Error('Previous analysis snapshot changed');
      if (!Number.isSafeInteger(previous.revision) || previous.revision<0) throw new Error('Invalid draft revision record');
    }
    const base=resolve(dir,'audit/analysis-generations');
    mkdirSync(base,{recursive:true});
    if (realpathSync(base)!==resolve(realpathSync(dir),'audit/analysis-generations')) throw new Error('Generation archive must not redirect writes');
    const snapshotId=randomUUID();const snapshot=resolve(base,snapshotId);mkdirSync(snapshot);
    writeFileSync(resolve(snapshot,'requirement-ledger.json'),ledger,{flag:'wx'});
    writeFileSync(resolve(snapshot,'requirement_analysis.md'),output,{flag:'wx'});
    const record={dispatch_id:dispatch.dispatch_id,parent_session:parentId,snapshot_id:snapshotId,revision:previous?previous.revision+1:0,markdown_sha256:hash(output),ledger_sha256:hash(ledger),...(reviewedBase?{reviewed_base:recovery.archive}:{})};
    const temporary=`${target}.${snapshotId}.tmp`;
    try { writeFileSync(temporary,output,{flag:'wx'});renameSync(temporary,target); }
    finally { if(existsSync(temporary)) unlinkSync(temporary); }
    writeJson(resolve(dir,index),record);
    return {snapshot:`audit/analysis-generations/${snapshotId}`,revision:record.revision,approval_granted:false};
  });
}
