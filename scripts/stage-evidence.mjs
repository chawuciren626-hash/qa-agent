import { dataPath, assertContextSession, sessionWorkspaces } from './directory-context.mjs';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { requiredArtifacts, stageRequiredArtifacts, assertArtifactContract } from './artifact-contracts.mjs';
import { assertChildCommands, childCommandPolicy, toolWasNotExecuted } from './child-command-policy.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { assertRecoveryDecisions } from './orchestration-state.mjs';
export { requiredArtifacts } from './artifact-contracts.mjs';

// Eligibility only: completion still validates the child and artifacts under lock.
// Historical failure wording must not permanently invalidate a recovered draft.
export function draftHandoffReconciliation(root,runId,manifest,stage,parentId,agentRoot) {
  if(!['analysis','test_points','test_cases','defects','report'].includes(stage) || !['blocked','failed'].includes(manifest.stages?.[stage]?.status)) throw new Error('Only blocked or failed draft delivery can reconcile');
  assertRecoveryDecisions(manifest,stage);
  const events=manifest.orchestration?.events ?? [];
  const dispatch=events.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
  const block=events.filter(e=>e.stage===stage).at(-1);
  if(!dispatch || !['blocked','failed'].includes(block?.type) || block['dispatch-id']!==dispatch.dispatch_id || dispatch['parent-session-id']!==parentId) throw new Error('Current blocked or failed dispatch required');
  const child=resolveDispatchedChild(root,runId,stage,parentId,agentRoot);
  const rows=readSession(agentRoot ?? process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(),'.penguin/data/default_project/agents'),dispatch.agent,child.child_session);
  const unexecuted=rows.filter((row,index)=>row.payload?.type==='tool_call' && row.payload.stop_reason==='retryable' && toolWasNotExecuted(rows,index)).map(row=>row.payload.tool_call_id);
  return {kind:'current_dispatch_revalidation',previous_stage:structuredClone(manifest.stages[stage]),child_session:child.child_session,
    dispatch_id:dispatch.dispatch_id,binding:child.binding,unexecuted_tool_calls:unexecuted,
    product_actions_replayed:false,approval_granted:false};
}

export function partialBrowserDelivery(root,runId,manifest) {
  const dir=runDirectory(root,runId),dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  const read=path=>JSON.parse(readRunFile(dir,path).data);
  const observation=read('execution/exploration.json'),task=read('execution/execution-task.json');
  if(!['interactive_browser','recovered_browser'].includes(observation.mode) || observation.partial!==true || task.outcome!=='partial' || observation.dispatch_id!==dispatch?.dispatch_id) throw new Error('Only verified partial browser results may reconcile an execution failure');
  const contract=assertArtifactContract(root,runId,'execution');
  if(contract.execution_outcome?.disposition!=='report_actual_assertions' || contract.execution_outcome.status!=='blocked') throw new Error('Partial execution outcome required');
  const command=read(`audit/commands/${observation.command_id}/command.json`);
  return {dispatch_id:dispatch.dispatch_id,closure_command_id:observation.command_id,closed_at:command.finished_at ?? observation.finished_at,contract};
}

export function partialBrowserFailureVerifier(root,runId,parentId,childId,manifest,failures=[]) {
  let delivery;
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  return (result,row)=>{
    if(!result || !['failed','timeout','rejected'].includes(result.status)) return false;
    try {
      delivery ??= partialBrowserDelivery(root,runId,manifest);
      if(!verifyActionRecoveryReceipt(root,runId,parentId,dispatch.at,result)) return false;
      const receipt=JSON.parse(readFileSync(result.action_receipt,'utf8'));
      if(receipt.action!=='browser_task' || receipt.host_binding?.session_id!==childId || receipt.host_binding.tool_call_id!==row.payload.tool_call_id || !(Date.parse(receipt.finished_at)<=Date.parse(delivery.closed_at))) return false;
      if(result.status==='rejected') {
        if(receipt.classification!=='session_stopped' || result.classification!==receipt.classification || result.exit_code!==2 || receipt.command_evidence || result.command_id) return false;
      } else {
        if(receipt.classification!=='script_failure' || result.script!=='browser-task.mjs' || !/^[a-f0-9-]{36}$/.test(result.command_id ?? '')) return false;
        const dir=runDirectory(root,runId),base=`audit/commands/${result.command_id}`;
        if(resolve(receipt.command_evidence ?? '')!==resolve(dir,base) || resolve(result.evidence_dir ?? '')!==resolve(dir,base)) return false;
        const command=JSON.parse(readRunFile(dir,`${base}/command.json`).data);
        if(command.run_id!==runId || command.script!=='browser-task.mjs' || command.host_binding?.session_id!==childId || command.host_binding.tool_call_id!==row.payload.tool_call_id || command.status!==result.status || command.result?.termination_confirmed!==true) return false;
        if(result.status==='timeout' ? command.result.termination!=='timeout' || result.exit_code!==124 : command.result.termination || command.result.code!==result.exit_code || result.exit_code===0) return false;
      }
      failures.push({action_receipt:result.action_receipt,status:result.status,command_id:result.command_id ?? null,closure_command_id:delivery.closure_command_id});
      return true;
    } catch {return false;}
  };
}

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
  const commands=new Map(rows.filter(r=>r.payload?.type==='tool_call' && ['exec_command','input_command'].includes(r.payload.name)).map(r=>[r.payload.tool_call_id,r]));
  return rows.map(row=>{
    const p=row.payload;
    if(p?.type!=='tool_call_output' || !commands.has(p.tool_call_id) || typeof p.output!=='string') return row;
    const call=commands.get(p.tool_call_id),name=call.payload.name;
    const archived=/\n\[output archived: ([^\r\n]+)\]([^]*?)$/.exec(p.output);
    if(!archived) return row;
    const suffix=archived[2].trim();
    if(name==='input_command') {
      const args=typeof call.payload.arguments==='string'?JSON.parse(call.payload.arguments):call.payload.arguments;
      const processId=args?.process_id;
      if(!/^proc-[A-Za-z0-9-]+$/.test(processId??'')) throw new Error('Archived poll process identity missing');
      const launches=rows.slice(0,rows.indexOf(call)).filter(r=>r.payload?.type==='tool_call_output' && commands.get(r.payload.tool_call_id)?.payload.name==='exec_command' && String(r.payload.output).endsWith(`[process running with process_id ${processId}; use input_command to send input or poll for output]`));
      if(launches.length!==1) throw new Error('Archived poll has no unique originating command');
      if(suffix && suffix!==`[process ${processId} had already exited (exit code 0); session removed]`) throw new Error('Archived poll has an unverified terminal suffix');
    } else if(suffix) throw new Error('Archived command has an unverified suffix');
    const base=resolve(agentRoot,agent,'scratchpad',id,'truncated-tool-output');
    const path=resolve(archived[1]);
    if(!isAbsolute(archived[1]) || resolve(path,'..')!==base || !new RegExp(`^${name}-[a-z0-9-]+\\.log$`,'i').test(basename(path))) throw new Error('Archived command output belongs to another session or has an invalid path');
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

export function findParentDispatch(parent, { runId, agent, childId, dispatchedAt, dispatchId, commandPolicy, parallel = false, includeFailed = false, includeInterrupted = false }) {
  const calls = [];
  for (const [index, row] of parent.entries()) {
    if (row.type !== 'model_msg' || row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent') continue;
    if(parallel || dispatchId) {
      let args;try {args=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;} catch {continue;}
      if(!dispatchId || args?.agent_id!==agent || !String(args.prompt).split(/[^A-Za-z0-9-]+/).includes(dispatchId)) continue;
    }
    const outputs = parent.map((output, position) => ({ output, position })).filter(({ output, position }) => position > index && output.type === 'model_msg' && output.payload?.type === 'tool_call_output' && output.payload.tool_call_id === row.payload.tool_call_id);
    // Token-bearing tasks bind to the dispatch; legacy traces require global uniqueness.
    calls.push({ row, index, outputs, end: outputs[0]?.position ?? parent.length });
  }
  const events = parent.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'event_msg' && row.payload?.type === 'subagent' && row.payload.session_id === childId);
  if (events.length !== 1) return null;
  const event = events[0];
  const active = calls.filter(call => call.index < event.index && event.index < call.end);
  if (active.length !== 1) return null;
  const call = active[0];
  if (call.outputs.length !== 1) return null;
  let returned=call.outputs[0].output.payload;
  // A continuation must use the native retained handle from this exact call.
  const retained=/^\[subagent retained with subagent_id (subagent-[A-Za-z0-9-]+);[^\r\n]*\]/.exec(String(returned.output));
  if(retained) {
    const continuations=parent.filter(row=>{
      if(row.payload?.type!=='tool_call' || row.payload.name!=='input_subagent' || Date.parse(row.timestamp)<=Date.parse(call.outputs[0].output.timestamp)) return false;
      try {const args=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;return args?.subagent_id===retained[1];} catch {return false;}
    });
    const latest=continuations.at(-1);
    if(latest) {
      const results=parent.filter(row=>row.payload?.type==='tool_call_output' && row.payload.tool_call_id===latest.payload.tool_call_id);
      if(results.length!==1 || Date.parse(results[0].timestamp)<Date.parse(latest.timestamp)) return null;
      if(String(results[0].payload.output).startsWith('Tool call denied') || String(results[0].payload.output).includes('[input_subagent error:')) return null;
      returned=results[0].payload;
    }
  }
  const failed=returned.stop_reason==='fatal' && /(?:^|\n)\[subagent failed:[^\r\n]*\](?: \[subagent idle[^\r\n]*\])?\s*$/.test(String(returned.output));
  const interrupted=returned.stop_reason==='aborted' && !String(returned.output).startsWith('Tool call denied');
  if (returned.stop_reason !== 'completed' && !(includeFailed && failed) && !(includeInterrupted && interrupted)) return null;
  let args;
  try { args = typeof call.row.payload.arguments === 'string' ? JSON.parse(call.row.payload.arguments) : call.row.payload.arguments; } catch { return null; }
  if (args?.agent_id !== agent || typeof args.prompt !== 'string' || !args.prompt.split(/[^A-Za-z0-9-]+/).includes(runId)) return null;
  if (dispatchId && !args.prompt.split(/[^A-Za-z0-9-]+/).includes(dispatchId)) return null;
  if (commandPolicy && !args.prompt.includes(commandPolicy)) return null;
  const times = [dispatchedAt, call.row.timestamp, event.row.timestamp, call.outputs[0].output.timestamp].map(Date.parse);
  if (times.some(time => !Number.isFinite(time)) || times.some((time, i) => i > 0 && time < times[i - 1])) return null;
  return { tool_call_id: call.row.payload.tool_call_id, binding: parallel?'dispatch_scoped_active_call_subagent_event':'unique_active_call_subagent_event', subagent_event_at: event.row.timestamp, ...(failed?{outcome:'failed'}:{}), ...(interrupted?{outcome:'interrupted'}:{}) };
}

export function matchingDispatchCalls(parent, runId, dispatch) {
  return parent.filter(row => {
    if (row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent' || !(Date.parse(row.timestamp) >= Date.parse(dispatch.at))) return false;
    if (parent.some(result => result.payload?.type === 'tool_call_output' && result.payload.tool_call_id === row.payload.tool_call_id && String(result.payload.output).startsWith('Tool call denied by the qa-delegation-guard hook'))) return false;
    let args;
    try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; } catch { return false; }
    const tokens = String(args?.prompt).split(/[^A-Za-z0-9-]+/);
    return args?.agent_id === dispatch.agent && tokens.includes(runId) && (!dispatch.dispatch_id || tokens.includes(dispatch.dispatch_id));
  });
}

export function resolveDispatchedChild(root, runId, stage, parentId, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents'), {includeFailed=false,includeInterrupted=false}={}) {
  const parent=assertParentSession(root,runId,parentId,agentRoot);
  const manifest=JSON.parse(readRunFile(runDirectory(root,runId),'manifest.json').data);
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
  if (!dispatch || dispatch['parent-session-id']!==parentId) throw new Error('No current dispatch owned by this parent');
  if (matchingDispatchCalls(parent,runId,dispatch).length!==1) throw new CommandUsageError('Dispatch must bind exactly one child call; retries need failure and explicit recovery');
  const candidates=[...new Set(parent.filter(r=>r.type==='event_msg' && r.payload?.type==='subagent').map(r=>r.payload.session_id))];
  const parallel=manifest.orchestration?.plan?.workflow_mode==='task' || (manifest.orchestration?.plan?.execution_branches?.length??0)>1;
  const owned=candidates.filter(childId=>{
    if(!parallel) return true;
    try {return readSession(agentRoot,dispatch.agent,childId).some(r=>r.payload?.type==='text' && r.payload.role==='user' && r.payload.text?.split(/[^A-Za-z0-9-]+/).includes(dispatch.dispatch_id) && r.payload.text.includes(dispatch.child_command_policy));} catch {return false;}
  });
  const matches=owned.map(childId=>({childId,binding:findParentDispatch(parent,{runId,agent:dispatch.agent,childId,dispatchedAt:dispatch.at,dispatchId:dispatch.dispatch_id,commandPolicy:dispatch.child_command_policy,parallel,includeFailed,includeInterrupted})})).filter(m=>m.binding);
  if (matches.length!==1) throw new CommandUsageError('No unique returned child for this dispatch; wait for the tool return, do not guess or scan directories');
  const child=readSession(agentRoot,dispatch.agent,matches[0].childId);
  const meta=child.find(r=>r.type==='session_meta')?.payload;
  if (meta?.session_id!==matches[0].childId || meta.source!=='subagent' || resolve(meta.agent_state ?? '')!==resolve(agentRoot,dispatch.agent,'agent_state') || !sessionWorkspaces(root,runDirectory(root,runId)).includes(resolve(meta.workspace ?? ''))) throw new Error('Resolved child identity or workspace mismatch');
  const failed=matches[0].binding.outcome==='failed';
  const lifecycle=child.filter(row=>row.type==='event_msg' && ['request_begin','request_end','abort'].includes(row.payload?.type)).at(-1)?.payload;
  const childInterrupted=lifecycle?.type==='abort' || (lifecycle?.type==='request_end' && lifecycle.status==='aborted');
  if(includeInterrupted && (matches[0].binding.outcome==='interrupted' || childInterrupted)) return {child_session:matches[0].childId,agent:dispatch.agent,dispatch_id:dispatch.dispatch_id,binding:matches[0].binding,completion_verified:false,outcome:'interrupted',continuation:recordedChildHandle(parent,dispatch,runId),next_action:'原调用已中断，不再等待旧回执；用户要求继续时，将补充输入送入原生续接句柄，不重新run_subagent。没有句柄时需要宿主恢复原会话；不得猜句柄、重派发或把中断记为完成。'};
  return {child_session:matches[0].childId,agent:dispatch.agent,dispatch_id:dispatch.dispatch_id,binding:matches[0].binding,completion_verified:false,...(failed?{outcome:'failed',next_action:'record_failed_dispatch',failure_template:{action:'fail',run_id:runId,stage,dispatch_id:dispatch.dispatch_id,reason:'Professional child returned an explicit failure; preserve its trace. No completion or execution retry authorized.'}}:{})};
}

export function recordedChildHandle(rows, dispatch, runId) {
  const calls = rows.filter(row => row.type === 'model_msg' && row.payload?.type === 'tool_call' && row.payload.name === 'run_subagent').filter(row => {
    if(rows.some(r=>r.payload?.type==='tool_call_output' && r.payload.tool_call_id===row.payload.tool_call_id && String(r.payload.output).startsWith('Tool call denied'))) return false;
    let args; try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; } catch { return false; }
    return args?.agent_id === dispatch.agent && typeof args.prompt === 'string' &&
      [runId, dispatch.dispatch_id].every(id => args.prompt.split(/[^A-Za-z0-9-]+/).includes(id)) && args.prompt.includes(dispatch.child_command_policy) && Date.parse(row.timestamp) >= Date.parse(dispatch.at);
  });
  const absent = { status: 'unavailable', subagent_id: null, completion_verified: false,
    next_action: '等待原工具返回；不要从dispatch_id或子会话ID推导句柄，不重复派发。正常结束的子任务使用handoff，人工登录等待使用宿主卡片续接原子会话，禁止重新派发。' };
  if (calls.length !== 1) return absent;
  const call = calls[0], outputs = rows.filter(row => row.type === 'model_msg' && row.payload?.type === 'tool_call_output' && row.payload.tool_call_id === call.payload.tool_call_id && Date.parse(row.timestamp) >= Date.parse(call.timestamp));
  if (outputs.length !== 1) return absent;
  const output=outputs[0].payload;
  const interrupted=output.stop_reason==='aborted';
  const ended={...absent,status:interrupted?'interrupted':output.stop_reason==='completed'?'returned':'failed',next_action:interrupted?'原工具已中断，没有可用原生句柄；需要宿主恢复原子会话，不等待旧回执，不重复派发。':'原工具已返回；使用resolve_child核对交付或失败，不反复等待。'};
  if(!['completed','aborted'].includes(output.stop_reason)) return ended;
  // Only use the host's returned running marker, never derive a handle from IDs.
  const matches = [...String(output.output).matchAll(/(?:^|\n)\[subagent (?:retained|running(?: in background)?) with subagent_id (subagent-[A-Za-z0-9-]+);[^\]\r\n]*\]/g)];
  const handles=[...new Set(matches.map(match=>match[1]))];
  if (handles.length !== 1) return ended;
  const subagent_id = handles[0];
  const invalidated = rows.slice(rows.indexOf(outputs[0]) + 1).some(row => row.payload?.type === 'tool_call_output' && String(row.payload.output).includes(`[input_subagent error: unknown subagent_id ${subagent_id} `));
  if (invalidated) return { ...absent, next_action: '宿主已返回此句柄不可用；不要重复input_subagent或猜新ID。保留现有结果，按真实结束状态进行交接或可恢复修订。' };
  return { status: 'recorded', subagent_id, source_tool_call_id: call.payload.tool_call_id, completion_verified: false,
    call_state:interrupted?'interrupted':'returned',
    availability: '宿主历史返回值，不保证应用重启后的可用性', next_action: '需要补充任务信息时可使用原样句柄；后台运行无需反复轮询，未知操作不得重放。' };
}

export function resolveChildHandle(root, runId, stage, parentId, agentRoot) {
  const rows = assertParentSession(root, runId, parentId, agentRoot);
  const manifest = JSON.parse(readRunFile(runDirectory(root, runId), 'manifest.json').data);
  const dispatch = manifest.orchestration?.events?.filter(event => event.type === 'dispatched' && event.stage === stage).at(-1);
  if (!dispatch || dispatch['parent-session-id'] !== parentId) throw new CommandUsageError('没有当前父会话所属派发；不猜测子任务ID。');
  return recordedChildHandle(rows, dispatch, runId);
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
    const matchingCalls = matchingDispatchCalls(parent,runId,dispatch);
    if (matchingCalls.length !== 1) throw new Error('Dispatch must bind exactly one child call; retries need failure and explicit recovery');
  }
  const meta = child.find(row => row.type === 'session_meta');
  if (meta?.payload.session_id !== childId || meta.payload.source !== 'subagent' || resolve(meta.payload.agent_state) !== resolve(agentRoot, dispatch.agent, 'agent_state')) throw new Error('Wrong child agent or session source');
  if (!sessionWorkspaces(root,runDirectory(root,runId)).includes(resolve(meta.payload.workspace))) throw new Error('Child workspace mismatch');
  if (dispatch.child_command_policy && ![1,2,3].some(version=>dispatch.child_command_policy === childCommandPolicy(dispatch.dispatch_id,version))) throw new Error('Dispatch command policy differs from supported contract');
  const called = findParentDispatch(parent, { runId, agent: dispatch.agent, childId, dispatchedAt: dispatch.at, dispatchId: dispatch.dispatch_id, commandPolicy: dispatch.child_command_policy, parallel:manifest.orchestration?.plan?.workflow_mode==='task' || (manifest.orchestration?.plan?.execution_branches?.length??0)>1 });
  if (!called) throw new Error('No matching parent dispatch response for this run');
  const partialFailures=[];
  if (dispatch.child_command_policy) {
    if (!child.some(row => row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.text?.includes(dispatch.child_command_policy))) throw new Error('Child did not receive the dispatch stop policy');
    const runDir=runDirectory(root,runId);
    const workspace=resolve(runDir,'../../..');
    assertChildCommands(child, {
      requireControlledCommands:true,
      allowRecovery:/^QA_COMMAND_POLICY_V[23] /.test(dispatch.child_command_policy),
      verifyRecovery:result=>verifyActionRecoveryReceipt(root,runId,parentId,dispatch.at,result),
      verifyPartialBrowserFailure:options.stage==='execution'?partialBrowserFailureVerifier(root,runId,parentId,childId,manifest,partialFailures):undefined,
      stageWriteBoundary:{
        stage:options.stage,
        engineDirectory:root,
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
  return { verified_at: new Date().toISOString(), parent_session_id: parentId, session_id: childId, dispatch_binding: called, artifacts: hashes,...(partialFailures.length?{partial_browser_failures:partialFailures,product_actions_replayed:false}:{}) };
}
