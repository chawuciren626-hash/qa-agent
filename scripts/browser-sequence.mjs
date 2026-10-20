import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRunFile } from './design-quality.mjs';
import { writeJson } from './orchestration-state.mjs';

const id=value=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value ?? '');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateSequence(op,validate) {
  if(!id(op.request_id) || !id(op.observed_request_id) || !Array.isArray(op.steps) || op.steps.length<2 || op.steps.length>4 || Object.keys(op).some(k=>!['type','request_id','observed_request_id','steps'].includes(k))) throw new Error('sequence requires 2-4 steps and an observed_request_id');
  if(new Set([op.request_id,...op.steps.map(s=>s?.request_id)]).size!==op.steps.length+1) throw new Error('Sequence and step request IDs must be distinct');
  for(const [i,step] of op.steps.entries()) {
    if(!['fill','select','check','assert','click','press'].includes(step?.type) || (['click','press'].includes(step.type) && (i!==op.steps.length-1 || !step.assertion))) throw new Error('Sequence supports input/check/assert steps, with at most one final submit plus assertion');
    validate(step);
    if(step.target?.by!=='css') throw new Error('Sequence steps require CSS targets from the observed snapshot; use individual browser operations for role/text/label targets');
  }
}

export async function runBrowserSequence(dir,op,{validate,binding,invoke,cancelled=()=>false}) {
  validateSequence(op,validate);
  const dispatch=binding(),relative=`execution/browser-evidence/${op.request_id}.sequence.json`,path=resolve(dir,relative),digest=hash(op);
  if(existsSync(path)) {
    const prior=JSON.parse(readRunFile(dir,relative).data);
    if(prior.request_sha256!==digest || prior.dispatch_id!==dispatch.dispatch_id) return {status:'invalid_request',operation_started:false,next_action:'inspect_sequence_identity_conflict'};
    return {...prior.result,status:prior.status==='completed'?prior.result.status:'sequence_interrupted',replayed:false,next_action:'inspect_saved_step_receipts_never_replay_batch'};
  }
  // Preflight precedes every step and receipt: a bad/stale observation is not a worker failure.
  let observed,state;
  try {
    observed=JSON.parse(readRunFile(dir,`execution/browser-evidence/${op.observed_request_id}.json`).data);
    state=JSON.parse(readRunFile(dir,'execution/browser-state.json').data);
  } catch {return {status:'invalid_operation',operation_started:false,diagnostic:{category:'sequence_observation_unavailable'},next_action:'snapshot_existing_browser_then_correct_sequence_no_steps_executed'};}
  const snapshot=observed.result?.snapshot;
  if(observed.status!=='completed' || observed.dispatch_id!==dispatch.dispatch_id || !snapshot || state.status!=='ready' || state.invocation_id!==observed.invocation_id || snapshot.unchanged || !Number.isSafeInteger(snapshot.page_epoch) || snapshot.page_epoch!==state.page_epoch) return {status:'invalid_operation',operation_started:false,diagnostic:{category:'sequence_observation_stale'},next_action:'snapshot_existing_browser_then_correct_sequence_no_steps_executed'};
  const selectors=new Set(['fields','controls','buttons','links'].flatMap(k=>snapshot[k] ?? []).filter(e=>e.visible).map(e=>e.selector));
  if(op.steps.some(step=>!selectors.has(step.target.value))) return {status:'invalid_operation',operation_started:false,diagnostic:{category:'sequence_target_unobserved'},next_action:'use_visible_css_targets_from_snapshot_or_individual_operations_no_steps_executed'};
  const record={version:1,dispatch_id:dispatch.dispatch_id,request_sha256:digest,status:'started',result:{status:'sequence_running',steps:[]}};
  writeFileSync(path,JSON.stringify(record),{flag:'wx'});
  for(const step of op.steps) {
    if(cancelled()) {record.result.status='sequence_cancelled';break;}
    try {
      if(binding().dispatch_id!==dispatch.dispatch_id) throw new Error('dispatch_changed');
      const result=await invoke(step);
      record.result.steps.push({request_id:step.request_id,status:result.status,receipt:`execution/browser-evidence/${step.request_id}.json`,assertion_status:result.assertion?.status ?? null});
      const passed=['ready','passed'].includes(result.status) && ['assertion','response_assertion'].every(key=>!result[key] || result[key].status==='passed');
      if(!passed) record.result.status='sequence_stopped';
    } catch {record.result.status='sequence_stopped';record.result.diagnostic='step_failed_or_unconfirmed';}
    writeJson(path,record);
    if(record.result.status!=='sequence_running') break;
  }
  if(record.result.status==='sequence_running') record.result.status='sequence_completed';
  record.status='completed';record.result.next_action='inspect_step_receipts_no_batch_replay';writeJson(path,record);
  return record.result;
}
