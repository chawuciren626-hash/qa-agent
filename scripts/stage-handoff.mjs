import { readRunFile, runDirectory } from './design-quality.mjs';
import { resolveDispatchedChild, verifyStageEvidence } from './stage-evidence.mjs';
import { assertArtifactContract, assertCompletedArtifacts, assertDependencyArtifacts } from './artifact-contracts.mjs';
import { assertStageHistory } from './orchestration-state.mjs';
import { executionSnapshot } from './execution-authorization.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { runProjectCommand } from './command-runtime.mjs';
import { summarizeRun } from './run-status-summary.mjs';
import { analysisSummary } from './analysis-summary.mjs';
import { isIndependent, usesTaskArtifacts, inspectIndependentArtifacts } from './independent-task.mjs';
import { deliveryPresentation } from './delivery-presentation.mjs';

export class HandoffInputError extends CommandUsageError {}

// Precheck is read-only. The existing locked writers revalidate before each commit.
export function inspectStageHandoff(root, parent, request, agentRoot) {
  const {run_id: runId, stage, artifacts} = request;
  const manifest = JSON.parse(readRunFile(runDirectory(root,runId),'manifest.json').data);
  assertStageHistory(manifest,stage);
  const current = manifest.stages?.[stage];
  const plan = manifest.orchestration?.plan?.stages.find(s=>s.id===stage && s.selected);
  const dispatch = manifest.orchestration?.events.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
  if (!plan || dispatch?.['parent-session-id'] !== parent) throw new Error('No selected stage dispatch owned by this parent');
  const prepare = stage==='execution' && dispatch.mode==='prepare';
  const completionType = prepare ? 'preparation_completed' : 'completed';
  const completed = manifest.orchestration.events.filter(e=>e.type===completionType && e.stage===stage).at(-1);
  const recorded = completed?.['dispatch-id']===dispatch.dispatch_id;
  const commands = [];
  if (current.status==='in_progress') {
    const child = resolveDispatchedChild(root,runId,stage,parent,agentRoot);
    verifyStageEvidence(root,runId,manifest,{stage,'dispatch-id':dispatch.dispatch_id,'parent-session-id':parent,'session-id':child.child_session,artifacts:artifacts.join(',')},agentRoot);
    assertDependencyArtifacts(root,runId,manifest,stage);
    assertArtifactContract(root,runId,stage,{mode:prepare?'prepare':'execute',artifacts});
    commands.push({script:'record-orchestration-event.mjs',args:[runId,'completed',`--stage=${stage}`,`--dispatch-id=${dispatch.dispatch_id}`,`--parent-session-id=${parent}`,`--session-id=${child.child_session}`,`--artifacts=${artifacts.join(',')}`]});
  } else {
    if (!recorded || !['completed','awaiting_confirmation','planned'].includes(current.status)) throw new Error('No current completed handoff to resume; do not infer completion from files');
    if (completed.evidence?.parent_session_id!==parent) throw new Error('Completion owner mismatch');
    if (prepare) {
      if (current.mode!=='prepared') throw new Error('Execution preparation state mismatch');
      for (const file of completed.evidence.artifact_contract.files) {
        if (readRunFile(runDirectory(root,runId),file.path).sha256!==file.sha256) throw new Error('Preparation changed after completion');
      }
    } else assertCompletedArtifacts(root,runId,manifest,stage);
  }
  const confirmation = (manifest.confirmations ?? []).filter(c=>c.stage===stage).at(-1);
  const needsConfirmation = prepare || plan.confirmation==='after';
  if (needsConfirmation) {
    const decisionForDispatch = manifest.orchestration.events.some(e=>e.type==='confirmation_requested' && e.stage===stage && e.confirmation_id===confirmation?.id && manifest.orchestration.events.indexOf(e)>manifest.orchestration.events.indexOf(dispatch));
    if (decisionForDispatch && ['rejected','revision_requested'].includes(confirmation.status)) throw new Error('Respect the user revision or rejection; do not reuse the old delivery');
    if (!decisionForDispatch || !['pending','approved'].includes(confirmation?.status)) {
      if (prepare) executionSnapshot(root,runId);
      commands.push({script:'request-stage-confirmation.mjs',args:[runId,stage]});
    }
  }
  return {commands,dispatch_id:dispatch.dispatch_id,needs_confirmation:needsConfirmation};
}

export async function handoffStage(root,parent,request,{agentRoot,signal}={}) {
  let inspection;
  try { inspection=inspectStageHandoff(root,parent,request,agentRoot); }
  catch(error) { throw new HandoffInputError(`Stage handoff not ready: ${error.message}. Keep this stage incomplete; correct the professional draft through revise_stage when eligible. Do not self-unlock or draft downstream artifacts.`); }
  const receipts=[];
  const env={...process.env,...(agentRoot?{PENGUIN_AGENT_ROOT:agentRoot}:{})};
  delete env.QA_CONTROLLER_SESSION;
  for (const command of inspection.commands) {
    const result=await runProjectCommand(root,{kind:'node',...command,runId:request.run_id,timeoutMs:20000,env,signal});
    receipts.push(result);
    if (result.status!=='completed' || result.exit_code!==0) return {...result,handoff_receipts:receipts,approval_granted:false};
  }
  const raw=readRunFile(runDirectory(root,request.run_id),'manifest.json').data;
  const manifest=JSON.parse(raw);
  // Presentation failures do not undo a committed handoff or request another confirmation.
  const presentation={run_status:null,analysis_summary:null,errors:[],approval_granted:false};
  try { presentation.run_status=summarizeRun(raw,request.run_id); }
  catch(error) { presentation.errors.push({action:'run_status',message:error.message}); }
  if(request.stage==='analysis' && !isIndependent(root,request.run_id)) {
    try { presentation.analysis_summary=analysisSummary(root,request.run_id); }
    catch(error) { presentation.errors.push({action:'analysis_summary',message:error.message}); }
  }
  presentation.status=presentation.errors.length?'unavailable':presentation.run_status.consistency==='consistent'?'ready':'review_required';
  if(usesTaskArtifacts(root,request.run_id,request.stage)) presentation.task_result=inspectIndependentArtifacts(root,request.run_id,request.stage).delivery;
    presentation.delivery=deliveryPresentation(root,request.run_id,manifest);
  presentation.note='Read-only snapshots after handoff, not semantic approval. Use these summaries for the current reply; refresh run_status/analysis_summary after later changes. If unavailable, inspect the named read action only; do not repeat completion or invent a summary.';
  return {status:'completed',exit_code:0,execution_mode:'in_process',launches_child:receipts.length>0,result:{termination_confirmed:true},
    data:{run_id:request.run_id,stage:request.stage,stage_status:manifest.stages[request.stage].status,dispatch_id:inspection.dispatch_id,
      presentation,next_action:presentation.status!=='ready'?'inspect_presentation':manifest.stages[request.stage].status==='awaiting_confirmation'?'present_result_and_wait_for_user':'follow_saved_plan_or_deliver',approval_granted:false,execution_started:false,already_recorded:!receipts.length},handoff_receipts:receipts};
}
