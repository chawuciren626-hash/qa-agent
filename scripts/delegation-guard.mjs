import { dataPath } from './directory-context.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertParentSession } from './stage-evidence.mjs';
import { assertStageHistory } from './orchestration-state.mjs';
import { readControllerSession, controllerCommandIsLive, permitsArtifactContinuation, permitsIndependentRunContinuation } from './controller-command-session.mjs';
import { verifyDelegationBinding } from './delegation-binding.mjs';
import { toolWasNotExecuted } from './child-command-policy.mjs';

export function guardDelegation(root,input,agentRoot) {
  if(input.tool_name==='input_subagent') {
    try {
      const args=typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
      if(!/^subagent-[A-Za-z0-9-]+$/.test(args?.subagent_id ?? '')) throw new Error('Use only a native subagent-... running handle returned by resolve_child_handle; session-... identifies trace history, not a running handle. A normally returned child uses handoff. No task was resumed; do not guess or redispatch.');
      return {};
    } catch(error) {return {decision:'deny',reason:`QA delegation: ${error.message}`};}
  }
  if (input.tool_name !== 'run_subagent') return {};
  try {
    const rows=assertParentSession(root,'run-command-session',input.session_id,agentRoot);
    const args=typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
    const prompt=args?.prompt;
    if (typeof prompt!=='string' || !input.tool_call_id) throw new Error('Dispatch prompt and tool call ID required');
    const runIds=[...new Set([...prompt.matchAll(/\brun_id=(run-[A-Za-z0-9-]+)\b/g)].map(match=>match[1]))];
    if (runIds.length!==1) throw new Error('Use exactly one current run_id from delegation.prompt');
    const manifest=JSON.parse(readFileSync(dataPath(root, 'output/runs',runIds[0],'manifest.json'),'utf8'));
    const active=Object.entries(manifest.stages ?? {}).filter(([id,s])=>{
      const d=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===id).at(-1);
      return s.status==='in_progress' && d?.dispatch_id && prompt.split(/[^A-Za-z0-9-]+/).includes(d.dispatch_id);
    });
    if (active.length!==1) throw new Error('Copy exactly one current dispatch ID; task identity, not the number of concurrent tasks, selects the child');
    const [stage]=active[0]; assertStageHistory(manifest,stage);
    const dispatch=manifest.orchestration.events.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
    const planned=manifest.orchestration.plan.stages.find(s=>s.id===stage && s.selected);
    if (!dispatch || dispatch['parent-session-id']!==input.session_id || dispatch.agent!==planned?.agent) throw new Error('Dispatch owner or planned role mismatch');
    if (args.agent_id!==dispatch.agent) throw new Error(`Use agent_id=${dispatch.agent}, not ${args.agent_id ?? '(omitted)'}. Caller agent is not the target. Use returned delegation fields.`);
    if (!prompt.includes(dispatch.dispatch_id) || !prompt.includes(dispatch.child_command_policy) || !prompt.includes(input.session_id)) throw new Error('Copy delegation.prompt with exact dispatch ID, policy and parent session');
    verifyDelegationBinding(root,{session:input.session_id,runId:runIds[0],stage,dispatchId:dispatch.dispatch_id,args});
    const state=readControllerSession(root,input.session_id);
    const historicalFailure=state.status==='ready' && !state.failure && state.events?.filter(event=>
      ['browser_failure_closed','browser_failure_recovered_partial','review_accepted','validation_stop_recovered'].includes(event.type) && event.previous_failure).at(-1)?.previous_failure;
    const restricted=state.failure || historicalFailure;
    const liveAction=!restricted && state.active_action && controllerCommandIsLive(state) && Date.now()-Date.parse(state.command_started_at)<180000;
    const context={action:'dispatch',run_id:runIds[0],stage,agent:dispatch.agent};
    const restrictedState={...state,failure:restricted};
    const safeContinuation=state.status!=='running' && restricted && (permitsArtifactContinuation(root,restrictedState,context) ||
      permitsIndependentRunContinuation(root,restrictedState,context));
    if (!safeContinuation && (restricted || state.status!=='ready' && !liveAction)) throw new Error('Controller is not ready; only a bound draft dispatch with verified termination may continue a stopped session');
    const prior=rows.some((row,index)=>{
      if (row.payload?.type!=='tool_call' || row.payload.name!=='run_subagent' || row.payload.tool_call_id===input.tool_call_id || Date.parse(row.timestamp)<Date.parse(dispatch.at)) return false;
      if(toolWasNotExecuted(rows,index)) return false;
      // Native hook refusal is also prelaunch evidence, including malformed arguments.
      const outputs=rows.slice(index+1).filter(r=>r.payload?.type==='tool_call_output' && r.payload.tool_call_id===row.payload.tool_call_id);
      if(outputs.length===1 && rows.filter(r=>r.payload?.type==='tool_call' && r.payload.tool_call_id===row.payload.tool_call_id).length===1 &&
        String(outputs[0].payload.output).startsWith('Tool call denied by the qa-delegation-guard hook')) return false;
      let call; try {call=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;} catch {return true;}
      if (!String(call?.prompt).includes(dispatch.dispatch_id)) return false;
      return true;
    });
    if (prior) throw new Error('This dispatch already has a child call; use resolve_child and resolve_child_handle to distinguish active, returned and interrupted. Send new information through the original native input_subagent handle when continuation is requested. Do not spawn twice or wait for an already interrupted call.');
    return {};
  } catch(error) {return {decision:'deny',reason:`QA delegation: ${error.message}`};}
}
