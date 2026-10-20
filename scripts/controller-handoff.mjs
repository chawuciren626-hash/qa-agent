import { dataPath } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertParentSession, resolveDispatchedChild, partialBrowserDelivery } from './stage-evidence.mjs';
import { readControllerSession, permitsArtifactContinuation } from './controller-command-session.mjs';
import { inspectStageHandoff } from './stage-handoff.mjs';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertArtifactContract, stageRequiredArtifacts } from './artifact-contracts.mjs';
import { writeJson } from './orchestration-state.mjs';
import { guardDelegation } from './delegation-guard.mjs';

export function inspectHandoff(root,parentId,agentRoot) {
  const rows=assertParentSession(root,'run-command-session',parentId,agentRoot);
  const state=readControllerSession(root,parentId);
  if(state.status!=='ready' && !(state.status==='stopped' && permitsArtifactContinuation(root,state,{action:'handoff'}))) return null;
  const runIds=new Set();
  for(const row of rows) {
    if(row.payload?.type!=='tool_call' || row.payload.name!=='run_subagent') continue;
    let args;try {args=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;} catch {continue;}
    // Only delegation metadata identifies a run; prose such as "run-relative" is not an ID.
    for(const match of String(args.prompt).matchAll(/\brun_id=(run-[A-Za-z0-9-]+)\b/g)) runIds.add(match[1]);
  }
  const pending=[],unavailable=[];
  for(const runId of runIds) {
    let manifest;
    try {
      manifest=JSON.parse(readRunFile(runDirectory(root,runId),'manifest.json').data);
      if(!manifest || typeof manifest!=='object') throw new Error('Invalid run manifest');
    }
    catch(error) {
      // A removed historical run is not evidence that the current delivery failed.
      if(runId===state.active_run_id) unavailable.push(`${runId}: ${error.message}`);
      continue;
    }
    for(const [stage,current] of Object.entries(manifest.stages ?? {})) {
      try {
      if(!['in_progress','completed','blocked','failed'].includes(current.status)) continue;
      const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
      const decision=(manifest.confirmations ?? []).filter(c=>c.stage===stage).at(-1);
      if(dispatch?.['parent-session-id']!==parentId || ['pending','approved','rejected'].includes(decision?.status)) continue;
      const artifacts=stageRequiredArtifacts(root,runId,stage);if(!artifacts?.length) continue;
      if(['in_progress','blocked','failed'].includes(current.status)) {
        {
          const calls=rows.filter(r=>{
            if(r.payload?.type!=='tool_call' || r.payload.name!=='run_subagent') return false;
            if(rows.some(output=>output.payload?.type==='tool_call_output' && output.payload.tool_call_id===r.payload.tool_call_id && String(output.payload.output).startsWith('Tool call denied by the qa-delegation-guard hook'))) return false;
            let args;try {args=typeof r.payload.arguments==='string'?JSON.parse(r.payload.arguments):r.payload.arguments;} catch {return false;}
            return args?.agent_id===dispatch.agent && String(args.prompt).split(/[^A-Za-z0-9-]+/).includes(dispatch.dispatch_id);
          });
          if(!calls.some(call=>rows.some(r=>r.payload?.type==='tool_call_output' && r.payload.tool_call_id===call.payload.tool_call_id))) continue;
        }
        let child;
        try { child=resolveDispatchedChild(root,runId,stage,parentId,agentRoot,{includeFailed:true}); }
        catch(error) { if(stage==='execution') continue; throw error; }
        if(child.outcome==='failed') {
          if(current.status==='in_progress') pending.push({dispatch_id:dispatch.dispatch_id,request:child.failure_template});
          continue;
        }
        if(stage==='execution') {
          try {partialBrowserDelivery(root,runId,manifest);} catch {continue;}
        }
        inspectStageHandoff(root,parentId,{run_id:runId,stage,artifacts},agentRoot);
        pending.push({dispatch_id:dispatch.dispatch_id,request:{action:'complete',run_id:runId,stage,dispatch_id:dispatch.dispatch_id,artifacts}});
      } else if(stage!=='execution' && manifest.orchestration.plan.stages.find(s=>s.id===stage)?.confirmation==='after') {
        const completed=manifest.orchestration.events.filter(e=>e.type==='completed' && e.stage===stage).at(-1);
        if(completed?.evidence?.parent_session_id!==parentId || completed['dispatch-id']!==dispatch.dispatch_id) continue;
        assertArtifactContract(root,runId,stage);
        pending.push({dispatch_id:dispatch.dispatch_id,request:{action:'request_confirmation',run_id:runId,stage}});
      }
      } catch(error) {unavailable.push(`${runId}/${stage}: ${error.message}`);}
    }
  }
  // Finalize ready returns one at a time; several completed independent children are not an error.
  if(!pending.length && unavailable.length) throw new Error(`No verified handoff available; unresolved candidates: ${unavailable.join('; ')}`);
  return pending[0] ?? null;
}

function resumeUnlaunchedDispatch(root,parentId,agentRoot) {
  if(!['ready','stopped'].includes(readControllerSession(root,parentId).status)) return {};
  const audit=dataPath(root,'output/action-audit',parentId);
  if(!existsSync(audit)) return {};
  const receipts=readdirSync(audit).filter(name=>name.endsWith('.json')).flatMap(name=>{
    try {return [JSON.parse(readFileSync(resolve(audit,name),'utf8'))];} catch {return [];}
  });
  for(const receipt of receipts) {
    if(!receipt || receipt.action!=='dispatch' || receipt.status!=='completed' || receipt.exit_code!==0 || receipt.session_id!==parentId || !receipt.delegation || !receipt.dispatch_id) continue;
    let manifest;
    try {
      manifest=JSON.parse(readRunFile(runDirectory(root,receipt.run_id),'manifest.json').data);
      if(!manifest || typeof manifest!=='object') continue;
    }
    catch {continue;}
    const current=manifest.stages?.[receipt.stage];
    const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===receipt.stage).at(-1);
    if(current?.status!=='in_progress' || current.dispatch_id!==receipt.dispatch_id || dispatch?.dispatch_id!==receipt.dispatch_id) continue;
    // The same native preflight rejects prior, active, failed and uncertain calls. Never replay them.
    const check=guardDelegation(root,{session_id:parentId,tool_name:'run_subagent',tool_call_id:`launch-check-${receipt.dispatch_id}`,arguments:receipt.delegation},agentRoot);
    if(check.decision==='deny') continue;
    const dir=dataPath(root,'output/handoff-checks',parentId);mkdirSync(dir,{recursive:true});
    const file=resolve(dir,'launch-reminders.json');
    const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{counts:{},events:[]};
    const used=journal.counts[receipt.dispatch_id] ?? 0;
    if(used>=2) return {decision:'stop',reason:'Registered child was not launched after two internal reminders. No product request or stage completion occurred; report the engineering limitation without user unlock paperwork.'};
    journal.counts[receipt.dispatch_id]=used+1;
    journal.events.push({at:new Date().toISOString(),dispatch_id:receipt.dispatch_id});writeJson(file,journal);
    return {decision:'continue',reason:'Registered professional task has no native child invocation',input:`Internal bookkeeping, NOT a user message or approval. This dispatch is registered but has NOT started. Invoke run_subagent now with these exact arguments: ${JSON.stringify(receipt.delegation)}. Do not register another dispatch or report background work before invoking it. Existing scope, role and execution safeguards remain unchanged.`};
  }
  return {};
}

// Host bookkeeping only: never approve, repair artifacts, dispatch or run tests.
export async function reconcileHandoff(root,parentId,agentRoot) {
  try {
    const next=inspectHandoff(root,parentId,agentRoot);
    if (!next) return resumeUnlaunchedDispatch(root,parentId,agentRoot);
    const {executeAction}=await import('./structured-actions.mjs');
    const request=next.request.action==='fail'?next.request:{action:'handoff',run_id:next.request.run_id,stage:next.request.stage,artifacts:next.request.artifacts ?? stageRequiredArtifacts(root,next.request.run_id,next.request.stage)};
    const result=await executeAction(root,parentId,()=>JSON.stringify(request),{agentRoot});
    if(result.status!=='completed') return {decision:'stop',reason:`Stage handoff incomplete: ${result.error ?? result.status}. No approval or downstream dispatch performed.`,handoff_receipt:result.action_receipt};
    if(request.action==='fail') return {decision:'stop',reason:'Professional child failed; stage failure recorded. No completion, approval or retry performed.',handoff_receipt:result.action_receipt};
    const awaiting=result.data?.stage_status==='awaiting_confirmation';
    return {decision:'continue',reason:'Verified stage handoff recorded',input:`Internal bookkeeping, NOT a user message or approval. ${JSON.stringify(result.data)}. ${awaiting?'Present the deliverables and the specific pending decision, then wait for the user.':'Continue the next selected stage in this run when dependencies are ready. Present the accumulated result at a real business decision or the final deliverable.'} Do not invent a business decision or bypass execution authorization.`,handoff_receipt:result.action_receipt};
  } catch(error) {
    try {
      const launch=resumeUnlaunchedDispatch(root,parentId,agentRoot);
      if(launch.decision==='continue') return launch;
    } catch { /* Preserve the original handoff issue when no verified launch is available. */ }
    return {decision:'stop',reason:`Handoff not verified: ${error.message}. Keep this stage incomplete; report the actual draft issue, not successful delivery. No approval or state change was performed by this check.`};
  }
}

export function handoffReminder(root,parentId,agentRoot) {
  try {
    const next=inspectHandoff(root,parentId,agentRoot);if(!next) return {};
    if(next.request.action==='fail') return {decision:'stop',reason:'Professional child returned an explicit failure; do not present its artifacts as completed or retry this dispatch.'};
    const dir=dataPath(root, 'output/handoff-checks',parentId);mkdirSync(dir,{recursive:true});
    const file=resolve(dir,'reminders.json');const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{counts:{},events:[]};
    const key=`${next.dispatch_id}:${next.request.action}`;const used=journal.counts[key] ?? 0;
    if(used>=2) return {decision:'stop',reason:'Controller handoff remains incomplete after two reminders; no approval or state change was performed.'};
    journal.counts[key]=used+1;journal.events.push({at:new Date().toISOString(),key,request:next.request});writeJson(file,journal);
    return {decision:'continue',reason:'Verified professional result needs controller bookkeeping',input:`Internal handoff check, NOT user approval. The real child and artifacts passed precheck. Write this request to output/action-requests/${next.dispatch_id}-handoff.json using the file tool: ${JSON.stringify(next.request)}. Execute node scripts/project-action.mjs execute --controller-session=${parentId} --request=output/action-requests/${next.dispatch_id}-handoff.json . After handoff, follow the saved plan: continue when no confirmation is required, otherwise present the business decision. Do not bypass execution authorization. If a command fails, report its actual evidence; this reminder grants no retry or recovery permission.`};
  } catch(error) {return {decision:'stop',reason:`Handoff not verified: ${error.message}. No completion or approval was recorded by this hook.`};}
}
