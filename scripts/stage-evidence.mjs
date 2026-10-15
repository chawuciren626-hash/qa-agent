import { dataPath, assertContextSession, sessionWorkspaces } from './directory-context.mjs';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { requiredArtifacts, stageRequiredArtifacts } from './artifact-contracts.mjs';
import { assertChildCommands, childCommandPolicy } from './child-command-policy.mjs';
import { CommandUsageError } from './command-contracts.mjs';
export { requiredArtifacts } from './artifact-contracts.mjs';

export function verifyActionRecoveryReceipt(root, runId, parentId, dispatchedAt, result) {
  const base=dataPath(root, 'output/action-audit',parentId);
  const path=resolve(result.action_receipt ?? '');
  if (resolve(path,'..')!==base) return false;
  const receipt=JSON.parse(readFileSync(path,'utf8'));
  if(result.action==='read_source' && (receipt.action!==result.action || receipt.error!==result.error || receipt.read_path!==result.read_path)) return false;
  const unboundRequest=receipt.run_id===null && (['input_correction','request_correction'].includes(receipt.recovery?.category) || (receipt.classification==='task_paused' && receipt.action===null && receipt.task_key==='unbound:request:'));
  if(result.classification==='task_paused' && (receipt.classification!==result.classification || receipt.error!==result.error)) return false;
  return receipt.session_id===parentId && (receipt.run_id===runId || unboundRequest) && receipt.run_id===result.run_id && Date.parse(receipt.at)>=Date.parse(dispatchedAt) && typeof receipt.task_key==='string' && receipt.status===result.status && receipt.exit_code===result.exit_code && receipt.task_key===result.task_key && JSON.stringify(receipt.recovery ?? null)===JSON.stringify(result.recovery ?? null);
}

export function readSession(agentRoot, agent, id) {
  const match = /^session-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.exec(id ?? '');
  if (!match || !/^[a-z0-9_-]+$/.test(agent)) throw new Error('Valid agent and session ID required');
  const dir = resolve(agentRoot, agent, 'traces', match[1]);
  const files = readdirSync(dir).filter(name => name.startsWith(`${id}_`) && name.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error('PenguinHarness session trace missing');
  const rows=files.flatMap(name => readFileSync(resolve(dir, name), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  const commandIds=new Set(rows.filter(r=>r.payload?.type==='tool_call' && r.payload.name==='exec_command').map(r=>r.payload.tool_call_id));
  return rows.map(row=>{
    const p=row.payload;
    if(p?.type!=='tool_call_output' || !commandIds.has(p.tool_call_id) || typeof p.output!=='string') return row;
    const archived=/\n\[output archived: ([^\r\n]+)\]\s*$/.exec(p.output);
    if(!archived) return row;
    const base=resolve(agentRoot,agent,'scratchpad',id,'truncated-tool-output');
    const path=resolve(archived[1]);
    if(!isAbsolute(archived[1]) || resolve(path,'..')!==base || !/^exec_command-[a-z0-9-]+\.log$/i.test(basename(path))) throw new Error('Archived command output belongs to another session or has an invalid path');
    if(realpathSync(base)!==base || realpathSync(path)!==path || !statSync(path).isFile() || statSync(path).size>8*1024*1024) throw new Error('Archived command output is redirected, invalid or too large');
    const full=readFileSync(path,'utf8');
    if(!full.trim()) throw new Error('Archived command output is empty');
    return {...row,payload:{...p,output:full,archived_output_path:path}};
  });
}

export function assertParentSession(root, runId, id, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents')) {
  assertContextSession(root,id);
  const rows = readSession(agentRoot, 'test_agent', id);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (meta?.session_id !== id || resolve(meta.agent_state ?? '') !== resolve(agentRoot, 'test_agent/agent_state') || !sessionWorkspaces(root,runDirectory(root, runId)).includes(resolve(meta.workspace ?? ''))) throw new Error('Parent session identity or workspace mismatch');
  return rows;
}

export function findParentDispatch(parent, { runId, agent, childId, dispatchedAt, dispatchId, commandPolicy, parallel = false, includeFailed = false }) {
  const calls = [];
  for (const [index, row] of parent.entries()) {
    if (row.type !== 'model_msg' || row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent') continue;
    if(parallel) {
      let args;try {args=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;} catch {continue;}
      if(!dispatchId || args?.agent_id!==agent || !String(args.prompt).split(/[^A-Za-z0-9-]+/).includes(dispatchId)) continue;
    }
    const outputs = parent.map((output, position) => ({ output, position })).filter(({ output, position }) => position > index && output.type === 'model_msg' && output.payload?.type === 'tool_call_output' && output.payload.tool_call_id === row.payload.tool_call_id);
    // Independent tasks bind within the exact dispatch; legacy traces remain globally unambiguous.
    calls.push({ row, index, outputs, end: outputs[0]?.position ?? parent.length });
  }
  const events = parent.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'event_msg' && row.payload?.type === 'subagent' && row.payload.session_id === childId);
  if (events.length !== 1) return null;
  const event = events[0];
  const active = calls.filter(call => call.index < event.index && event.index < call.end);
  if (active.length !== 1) return null;
  const call = active[0];
  if (call.outputs.length !== 1) return null;
  const returned=call.outputs[0].output.payload;
  const failed=returned.stop_reason==='fatal' && String(returned.output).startsWith('[subagent failed:');
  if (returned.stop_reason !== 'completed' && !(includeFailed && failed)) return null;
  let args;
  try { args = typeof call.row.payload.arguments === 'string' ? JSON.parse(call.row.payload.arguments) : call.row.payload.arguments; } catch { return null; }
  if (args?.agent_id !== agent || typeof args.prompt !== 'string' || !args.prompt.split(/[^A-Za-z0-9-]+/).includes(runId)) return null;
  if (dispatchId && !args.prompt.split(/[^A-Za-z0-9-]+/).includes(dispatchId)) return null;
  if (commandPolicy && !args.prompt.includes(commandPolicy)) return null;
  const times = [dispatchedAt, call.row.timestamp, event.row.timestamp, call.outputs[0].output.timestamp].map(Date.parse);
  if (times.some(time => !Number.isFinite(time)) || times.some((time, i) => i > 0 && time < times[i - 1])) return null;
  return { tool_call_id: call.row.payload.tool_call_id, binding: parallel?'dispatch_scoped_active_call_subagent_event':'unique_active_call_subagent_event', subagent_event_at: event.row.timestamp, ...(failed?{outcome:'failed'}:{}) };
}

export function resolveDispatchedChild(root, runId, stage, parentId, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents'), {includeFailed=false}={}) {
  const parent=assertParentSession(root,runId,parentId,agentRoot);
  const manifest=JSON.parse(readRunFile(runDirectory(root,runId),'manifest.json').data);
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
  if (!dispatch || dispatch['parent-session-id']!==parentId) throw new Error('No current dispatch owned by this parent');
  const candidates=[...new Set(parent.filter(r=>r.type==='event_msg' && r.payload?.type==='subagent').map(r=>r.payload.session_id))];
  const parallel=manifest.orchestration?.plan?.workflow_mode==='task';
  const owned=candidates.filter(childId=>{
    if(!parallel) return true;
    try {return readSession(agentRoot,dispatch.agent,childId).some(r=>r.payload?.type==='text' && r.payload.role==='user' && r.payload.text?.split(/[^A-Za-z0-9-]+/).includes(dispatch.dispatch_id) && r.payload.text.includes(dispatch.child_command_policy));} catch {return false;}
  });
  const matches=owned.map(childId=>({childId,binding:findParentDispatch(parent,{runId,agent:dispatch.agent,childId,dispatchedAt:dispatch.at,dispatchId:dispatch.dispatch_id,commandPolicy:dispatch.child_command_policy,parallel,includeFailed})})).filter(m=>m.binding);
  if (matches.length!==1) throw new CommandUsageError('No unique returned child for this dispatch; wait for the tool return, do not guess or scan directories');
  const child=readSession(agentRoot,dispatch.agent,matches[0].childId);
  const meta=child.find(r=>r.type==='session_meta')?.payload;
  if (meta?.session_id!==matches[0].childId || meta.source!=='subagent' || resolve(meta.agent_state ?? '')!==resolve(agentRoot,dispatch.agent,'agent_state') || !sessionWorkspaces(root,runDirectory(root,runId)).includes(resolve(meta.workspace ?? ''))) throw new Error('Resolved child identity or workspace mismatch');
  const failed=matches[0].binding.outcome==='failed';
  return {child_session:matches[0].childId,agent:dispatch.agent,dispatch_id:dispatch.dispatch_id,binding:matches[0].binding,completion_verified:false,...(failed?{outcome:'failed',next_action:'record_failed_dispatch',failure_template:{action:'fail',run_id:runId,stage,dispatch_id:dispatch.dispatch_id,reason:'Professional child returned an explicit failure; preserve its trace. No completion or execution retry authorized.'}}:{})};
}

export function verifyStageEvidence(root, runId, manifest, options, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents')) {
  const dispatch = manifest.orchestration.events.filter(e => e.stage === options.stage && e.type === 'dispatched').at(-1);
  if (!dispatch) throw new Error('Dispatch event required');
  const childId = options['session-id'];
  const parentId = options['parent-session-id'];
  if (dispatch.dispatch_id && (options['dispatch-id'] !== dispatch.dispatch_id || parentId !== dispatch['parent-session-id'])) throw new Error('Completion does not belong to the current dispatch');
  const child = readSession(agentRoot, dispatch.agent, childId);
  const parent = readSession(agentRoot, 'test_agent', parentId);
  if (dispatch.dispatch_id) {
    const matchingCalls = parent.filter(row => {
      if (row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent' || Date.parse(row.timestamp) < Date.parse(dispatch.at)) return false;
      if (parent.some(r=>r.payload?.type==='tool_call_output' && r.payload.tool_call_id===row.payload.tool_call_id && String(r.payload.output).startsWith('Tool call denied by the qa-delegation-guard hook'))) return false;
      let args;
      try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; } catch { return false; }
      return args?.agent_id === dispatch.agent && String(args.prompt).split(/[^A-Za-z0-9-]+/).includes(runId);
    });
    if (matchingCalls.length !== 1) throw new Error('Dispatch must bind exactly one child call; retries need failure and explicit recovery');
  }
  const meta = child.find(row => row.type === 'session_meta');
  if (meta?.payload.session_id !== childId || meta.payload.source !== 'subagent' || resolve(meta.payload.agent_state) !== resolve(agentRoot, dispatch.agent, 'agent_state')) throw new Error('Wrong child agent or session source');
  if (!sessionWorkspaces(root,runDirectory(root,runId)).includes(resolve(meta.payload.workspace))) throw new Error('Child workspace mismatch');
  if (dispatch.child_command_policy && ![1,2,3].some(version=>dispatch.child_command_policy === childCommandPolicy(dispatch.dispatch_id,version))) throw new Error('Dispatch command policy differs from supported contract');
  const called = findParentDispatch(parent, { runId, agent: dispatch.agent, childId, dispatchedAt: dispatch.at, dispatchId: dispatch.dispatch_id, commandPolicy: dispatch.child_command_policy, parallel:manifest.orchestration?.plan?.workflow_mode==='task' });
  if (!called) throw new Error('No matching parent dispatch response for this run');
  if (dispatch.child_command_policy) {
    if (!child.some(row => row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.text?.includes(dispatch.child_command_policy))) throw new Error('Child did not receive the dispatch stop policy');
    const runDir=runDirectory(root,runId);
    const workspace=resolve(runDir,'../../..');
    assertChildCommands(child, {
      requireControlledCommands:true,
      allowRecovery:/^QA_COMMAND_POLICY_V[23] /.test(dispatch.child_command_policy),
      verifyRecovery:result=>verifyActionRecoveryReceipt(root,runId,parentId,dispatch.at,result),
      stageWriteBoundary:{
        stage:options.stage,
        runDirectory:runDir,
        workspace,
        actionRequestDirectory:resolve(workspace,'output/action-requests'),
        scratchpadDirectory:resolve(agentRoot,dispatch.agent,'scratchpad',childId)
      }
    });
  }
  if (!child.some(row => row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.text?.includes(runId))) throw new Error('Child task does not reference current run');
  const lastMessage = child.filter(row => row.type === 'model_msg' && row.payload?.role === 'assistant').at(-1);
  if (lastMessage?.payload.type !== 'text' || !lastMessage.payload.text?.trim() || Date.parse(lastMessage.timestamp) < Date.parse(dispatch.at)) throw new Error('Child has no completed response after dispatch');
  const lastRequest = child.filter(row => row.type === 'event_msg' && ['request_begin', 'request_end'].includes(row.payload?.type)).at(-1);
  if (lastRequest?.payload.type !== 'request_end' || lastRequest.payload.status !== 'completed') throw new Error('Child request is not complete');
  if (manifest.orchestration.events.some(e => e.evidence?.session_id === childId)) throw new Error('Child session already used to complete a stage');
  const artifacts = (options.artifacts ?? '').split(',').filter(Boolean);
  const preparation = options.stage === 'execution' && dispatch.mode === 'prepare';
  const required = stageRequiredArtifacts(root, runId, options.stage, preparation ? 'prepare' : 'execute') ?? [];
  if (!required.length || required.some(path => !artifacts.includes(path))) throw new Error('Required stage artifacts missing from completion');
  if (preparation && !artifacts.some(path => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path))) throw new Error('Preparation must return generated test scripts');
  const hashes = artifacts.map(path => {
    const file = readRunFile(runDirectory(root, runId), path);
    return { path: file.path, sha256: file.sha256 };
  });
  return { verified_at: new Date().toISOString(), parent_session_id: parentId, session_id: childId, dispatch_binding: called, artifacts: hashes };
}
