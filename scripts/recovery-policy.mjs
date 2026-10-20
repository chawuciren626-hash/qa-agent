import { CommandUsageError } from './command-contracts.mjs';
import { createHash } from 'node:crypto';

// Retained only for reading legacy review records; no longer an execution gate.
export const correctionLimit = 2;
export const draftStages = ['analysis', 'test_points', 'test_cases', 'defects', 'report'];
export const stageRevisionLimit = null;

export class ArtifactSafetyError extends Error {
  constructor(message, options) {
    super(message,options);
    this.name='ArtifactSafetyError';
    this.code='artifact_safety_violation';
  }
}

// These actions operate on local evidence and artifacts, never on the product.
// Dispatch (including preparation) and execute deliberately have no exemption.
export function isSafeArtifactAction(context) {
  return ['extract_word','generate_analysis','validate_analysis','validate_artifacts',
    'export_test_points','export_test_cases','assess_evidence','normalize_defects',
    'build_report_metrics','export_report','handoff','complete'].includes(context?.action);
}

export function safeStoppedOperation(context) {
  if(isSafeArtifactAction(context)) return true;
  const agents={analysis:'requirement_analysis_agent',test_points:'test_point_agent',test_cases:'test_case_agent',
    defects:'defect_analysis_agent',report:'test_report_agent'};
  return context?.action==='dispatch' && Object.hasOwn(agents,context.stage) &&
    context.agent===agents[context.stage];
}

const progressIdentity = context => context?.progress_sha256 ?? context?.request_sha256 ?? null;

export function stalledCorrection(state, context) {
  const previous = state.correction_progress?.[context?.key];
  if (!previous || previous.consecutive < 3 || previous.progress !== progressIdentity(context,previous.recovery?.category)) return null;
  return { ...previous.recovery, retry_allowed:false, stalled:true,
    next_action:'inspect_and_repair_artifacts_or_handoff_partial', policy:'progress_based' };
}

export function stageRevisionBudget(events, stage) {
  const used = events.filter(e => e.type === 'stage_recovered' && e.stage === stage && e.actor === 'controller_auto_revision').length;
  return { limit: null, used, remaining: null, policy: 'progress_based' };
}

export function recordCorrection(state, category, context, error, result) {
  const key=context.key;
  state.corrections ??= {}; state.correction_progress ??= {};
  const used=(state.corrections[key] ?? 0)+1; state.corrections[key]=used;
  let diagnostics=result?.data?.errors ?? result?.result?.errors ?? null;
  if(!diagnostics && result?.output_tail) {
    try { const data=JSON.parse(result.output_tail); diagnostics=data.errors ?? data.issues ?? data.status; }
    catch { diagnostics=result.output_tail; }
  }
  const signature=createHash('sha256').update(JSON.stringify({request:progressIdentity(context,category),error:error?.message ?? null,status:result?.status ?? null,diagnostics})).digest('hex');
  const previous=state.correction_progress[key];
  const consecutive=previous?.signature===signature?previous.consecutive+1:1;
  const recovery={category,key,failure_number:used,retry_allowed:consecutive<3,remaining_corrections:null,policy:'progress_based',consecutive_same_failure:consecutive,stalled:consecutive>=3,next_action:consecutive>=3?'inspect_and_repair_artifacts_or_handoff_partial':'correct_and_retry'};
  state.correction_progress[key]={signature,consecutive,progress:progressIdentity(context,category),recovery};
  return recovery;
}

export function upstreamDraftRevision(manifest, stage) {
  if (!draftStages.includes(stage)) return null;
  const current = manifest.stages?.[stage];
  const events = manifest.orchestration?.events ?? [];
  const event = events.filter(e => e.type === 'quality_revision_required' && e.stage === stage && e.revision_id === current?.invalidated_by).at(-1);
  const source = event && events.find(e => e.type === 'confirmation_resolved' && e.stage === 'analysis' && e.decision === 'revision_requested' && e.revision_id === event.revision_id && e.archive === event.archive && e.affected_stages?.includes(stage));
  return current?.status === 'revision_requested' && event?.archive && source && events.indexOf(source) < events.indexOf(event) && events.filter(e=>e.stage===stage).at(-1)===event ? event : null;
}

// A new key requires a recorded revision followed by a matching owned dispatch.
// Merely changing action arguments, filenames or spawning another child is not a reset.
export function revisedDispatchId(manifest, stage, parent) {
  if (!draftStages.includes(stage) && stage !== 'execution') return null;
  const events = manifest.orchestration?.events ?? [];
  const dispatch = events.filter(e => e.type === 'dispatched' && e.stage === stage).at(-1);
  if (!dispatch?.dispatch_id || dispatch['parent-session-id'] !== parent || manifest.stages?.[stage]?.dispatch_id !== dispatch.dispatch_id) return null;
  if (stage === 'execution') {
    const preparation = events.filter(e => e.type==='stage_recovered' && e.stage===stage && e.actor==='controller_auto_revision' && e.parent_session_id===parent && e.preparation_safety?.kind==='verified_preparation_only' && e.preparation_safety.dispatch_id===e.dispatch_id && e.preparation_safety.approval_granted===false).at(-1);
    if(preparation?.archive && dispatch.mode==='prepare' && events.indexOf(dispatch)>events.indexOf(preparation) && dispatch.revision_context?.archive===preparation.archive && manifest.stages.execution.revision_archive===preparation.archive) return dispatch.dispatch_id;
    const recovery = events.filter(e => e.type === 'stage_recovered' && e.stage === stage && e.parent_session_id === parent && e.evidence?.sha256 && e.approval_ref).at(-1);
    return recovery?.archive && events.indexOf(dispatch) > events.indexOf(recovery) && manifest.stages.execution.revision_archive === recovery.archive ? dispatch.dispatch_id : null;
  }
  const revision = events.filter(e => e.stage === stage && (
    (e.type === 'confirmation_resolved' && e.decision === 'revision_requested') ||
    (e.type === 'stage_recovered' && (e.actor === 'controller_auto_revision' || (e.parent_session_id === parent && e.evidence?.sha256 && e.approval_ref))) ||
    (e.type === 'quality_revision_required' && events.some(a => a.type === 'confirmation_resolved' && a.stage === 'analysis' && a.decision === 'revision_requested' && a.revision_id === e.revision_id && a.archive === e.archive && a.affected_stages?.includes(stage)))
  )).at(-1);
  return revision?.archive && events.indexOf(dispatch) > events.indexOf(revision) && dispatch.revision_context?.archive === revision.archive && dispatch.revision_context?.revision_id === manifest.stages[stage].revision_id ? dispatch.dispatch_id : null;
}
export function classifyRecoverable(error, result, context) {
  if (!context) return null;
  const seen=new Set();
  for(let cause=error;cause && !seen.has(cause);cause=cause.cause) {
    if(cause instanceof ArtifactSafetyError) return null;
    seen.add(cause);
  }
  if (error instanceof CommandUsageError && ['handoff','complete'].includes(context.action)) return 'handoff_correction';
  if (error instanceof CommandUsageError && context.readOnly) return 'read_correction';
  if (error instanceof CommandUsageError && context.action === null) return 'request_correction';
  if (error instanceof CommandUsageError) return 'input_correction';
  if (isSafeArtifactAction(context) && error && !result) return 'artifact_revision';
  if (isSafeArtifactAction(context) && ['failed','timeout'].includes(result?.status) && result.result?.termination_confirmed===true &&
    !['interrupted','cleanup_required'].includes(result.result.termination)) return 'artifact_revision';
  // Preparation remains correctable in a ready session but never unlocks stopped execution.
  if (['prepare_execution_plan','validate_execution_prepare'].includes(context.action) && context.stage==='execution' &&
    result?.status==='failed' && result.result?.termination_confirmed===true &&
    !['interrupted','cleanup_required'].includes(result.result.termination)) return 'artifact_revision';
  return null;
}
