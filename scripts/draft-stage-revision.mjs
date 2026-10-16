import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sessionWorkspaces } from './directory-context.mjs';
import { getRunContext, withRunLock, writeJson, recomputeRunStatus, assertStageHistory } from './orchestration-state.mjs';
import { assertParentSession, readSession, findParentDispatch, requiredArtifacts, verifyActionRecoveryReceipt } from './stage-evidence.mjs';
import { assertChildCommands, childCommandPolicy } from './child-command-policy.mjs';
import { readRunFile } from './design-quality.mjs';
import { draftStages, stageRevisionBudget } from './recovery-policy.mjs';
import { isIndependent, taskRequiredArtifacts } from './independent-task.mjs';
import { stageWriteRules } from './stage-registry.mjs';
import { inspectPreparationSafety, preparationDraftFiles } from './preparation-recovery.mjs';

export function draftStageFiles(stage) {
  const sources={test_points:['design/test_points.md'],test_cases:['design/test_cases.md'],defects:['defects/bugs.json'],report:['report/test_report.md']};
  return [...new Set([...(requiredArtifacts[stage] ?? []),...stageWriteRules(stage).exact,...(sources[stage] ?? [])])];
}

export function inspectDraftRevision(root,runId,stage,parentId,reason,agentRoot=process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(),'.penguin/data/default_project/agents')) {
  if (!reason?.trim() || (!draftStages.includes(stage) && stage !== 'execution')) throw new Error('Only non-executing draft stages or verified preparation may be revised with a reason');
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
  const {manifest,manifestPath}=getRunContext(root,project,runId);
  const current=manifest.stages?.[stage];
  assertStageHistory(manifest,stage);
  if (!['in_progress','blocked','failed','completed'].includes(current?.status)) throw new Error('Stage is not eligible for controller revision');
  if ((manifest.confirmations ?? []).some(c=>c.status === 'pending') || (manifest.confirmations ?? []).filter(c=>c.stage===stage).at(-1)?.status === 'rejected') throw new Error('Pending/rejected user decision must be respected');
  if (Object.entries(manifest.stages).some(([id,s])=>id!==stage && s.status==='in_progress')) throw new Error('Another stage is active');
  const approved=(manifest.confirmations ?? []).filter(c=>c.stage===stage).at(-1)?.status === 'approved';
  if (approved) throw new Error('Already approved content requires user revision decision');
  const events=manifest.orchestration?.events ?? [];
  const dispatch=events.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
  if (!dispatch || ![2,3].some(version=>dispatch.child_command_policy===childCommandPolicy(dispatch.dispatch_id,version)) || dispatch['parent-session-id']!==parentId) throw new Error('Automatic revision requires a current owned V2/V3 dispatch');
  if(stage==='execution' && (dispatch.mode!=='prepare' || current.mode!=='prepare' || !['failed','blocked','in_progress'].includes(current.status))) throw new Error('Execution recovery requires a preparation-only dispatch, never actual or unknown product execution');
  const parent=assertParentSession(root,runId,parentId,agentRoot);
  const calls=parent.filter(r=>r.payload?.type==='tool_call' && r.payload.name==='run_subagent' && Date.parse(r.timestamp)>=Date.parse(dispatch.at));
  const bound=[];
  for (const call of calls) {
    const args=typeof call.payload.arguments==='string' ? JSON.parse(call.payload.arguments) : call.payload.arguments;
    if (!String(args?.prompt).split(/[^A-Za-z0-9-]+/).includes(runId)) continue;
    const index=parent.indexOf(call);
    const end=parent.findIndex((r,i)=>i>index && r.payload?.type==='tool_call_output' && r.payload.tool_call_id===call.payload.tool_call_id);
    if (end<0) throw new Error('Child has not returned');
    for (const event of parent.slice(index+1,end).filter(r=>r.payload?.type==='subagent')) bound.push({agent:args.agent_id,id:event.payload.session_id});
  }
  if (bound.length!==1 || bound[0].agent!==dispatch.agent) throw new Error('Exactly one real child return required');
  const childId=bound[0].id;
  if (!findParentDispatch(parent,{runId,agent:dispatch.agent,childId,dispatchedAt:dispatch.at,dispatchId:dispatch.dispatch_id,commandPolicy:dispatch.child_command_policy})) throw new Error('Child dispatch binding missing');
  const child=readSession(agentRoot,dispatch.agent,childId);
  const meta=child.find(row=>row.type==='session_meta')?.payload;
  if (meta?.session_id!==childId || meta.source!=='subagent' || resolve(meta.agent_state ?? '')!==resolve(agentRoot,dispatch.agent,'agent_state') || !sessionWorkspaces(root,resolve(manifestPath,'..')).includes(resolve(meta.workspace ?? ''))) throw new Error('Child identity or workspace mismatch');
  const end=child.filter(r=>['request_begin','request_end'].includes(r.payload?.type)).at(-1);
  if (end?.payload.type!=='request_end' || end.payload.status!=='completed') throw new Error('Child termination requires review');
  assertChildCommands(child,{allowRecovery:true,allowUnresolvedRecovery:true,verifyRecovery:result=>verifyActionRecoveryReceipt(root,runId,parentId,dispatch.at,result)});
  const dir=resolve(manifestPath,'..');
  const preparation=stage==='execution'?inspectPreparationSafety(root,dir,runId,parentId,dispatch,child,parent):null;
  if(preparation) assertChildCommands(child,{requireControlledCommands:true,allowRecovery:true,allowUnresolvedRecovery:true,verifyRecovery:result=>verifyActionRecoveryReceipt(root,runId,parentId,dispatch.at,result),stageWriteBoundary:{stage,runDirectory:dir,workspace:resolve(dir,'../../..'),actionRequestDirectory:resolve(dir,'../../../output/action-requests'),scratchpadDirectory:resolve(agentRoot,dispatch.agent,'scratchpad',childId)}});
  if (existsSync(resolve(dir,'execution/execution.lock.json'))) throw new Error('Execution cleanup pending');
  const executionState=resolve(dir,'execution/execution-state.json');
  if (existsSync(executionState) && JSON.parse(readFileSync(executionState)).status==='running') throw new Error('Execution still running');
  // Resolve all source paths before changing state; preserve originals in a unique revision directory.
  const paths=[...new Set(preparation?preparationDraftFiles(dir):[...draftStageFiles(stage),...(isIndependent(root,runId)?taskRequiredArtifacts(stage):[])])];
  const files=paths.filter(p=>existsSync(resolve(dir,p))).map(p=>readRunFile(dir,p));
  return {manifest,manifestPath,current,events,dispatch,childId,dir,files,preparation};
}

export function previewDraftRevision(root,runId,stage,parentId,reason,agentRoot) {
  try {
    const checked=inspectDraftRevision(root,runId,stage,parentId,reason,agentRoot);
    return {status:'eligible',run_id:runId,stage,dispatch_id:checked.dispatch.dispatch_id,child_session:checked.childId,revision_budget:stageRevisionBudget(checked.events,stage),starts_execution:false,approval_granted:false};
  } catch(error) {
    return {status:'ineligible',run_id:runId,stage,reason:error.message,starts_execution:false,approval_granted:false};
  }
}

export function reviseDraftStage(root,runId,stage,parentId,reason,agentRoot) {
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
  return withRunLock(root,project,runId,()=>{
  // Recheck under the write lock; a preview is never a mutation permit.
  let checked;
  try { checked=inspectDraftRevision(root,runId,stage,parentId,reason,agentRoot); }
  catch(error) { return {status:'ineligible',run_id:runId,stage,reason:error.message,starts_execution:false,approval_granted:false}; }
  const {manifest,manifestPath,current,events,dispatch,childId,dir,files,preparation}=checked;
  const archive=`audit/revisions/${stage}-${randomUUID()}`;
  mkdirSync(resolve(dir,archive),{recursive:true});
  const archiveRelative=relative(realpathSync(dir),realpathSync(resolve(dir,archive)));
  if (!archiveRelative || isAbsolute(archiveRelative) || archiveRelative==='..' || archiveRelative.startsWith('../') || archiveRelative.startsWith('..\\')) throw new Error('Revision directory redirected');
  const at=new Date().toISOString();
  // Snapshot before recording the transition; keep the working draft available
  // for incremental edits. Never replace a historical snapshot.
  for (const file of files) {
    const target=resolve(dir,archive,file.path); mkdirSync(resolve(target,'..'),{recursive:true});
    writeFileSync(target,file.data,{flag:'wx'});
    if(readRunFile(dir,file.path).sha256!==file.sha256 || readRunFile(dir,`${archive}/${file.path}`).sha256!==file.sha256) {
      throw new Error('Draft changed during revision snapshot; working files preserved');
    }
  }
  events.push({type:'stage_recovered',at,stage,from:current.status,to:'revision_requested',actor:'controller_auto_revision',reason,dispatch_id:dispatch.dispatch_id,parent_session_id:parentId,...(preparation?{preparation_safety:preparation}:{}),verified_children:[childId],archive,files:files.map(f=>({path:f.path,sha256:f.sha256}))});
  manifest.stages[stage]={...current,status:'revision_requested',updated_at:at,reason,revision_id:archive.split('/').at(-1),revision_archive:archive};
  manifest.orchestration.resume_from=stage;
  manifest.status=recomputeRunStatus(manifest); manifest.updated_at=at;
  writeJson(manifestPath,manifest);
  return {status:'revision_requested',run_id:runId,stage,archive,revision_budget:stageRevisionBudget(events,stage),starts_execution:false,approval_granted:false};
  });
}
