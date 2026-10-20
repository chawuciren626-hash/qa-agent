import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { answerHumanAction, inspectHumanAction, listHumanActions, nativeHumanDecision, humanConfirmationText, isLoginConfirmation } from '../../scripts/browser-human-action.mjs';
import { qaTaskStatus } from '../../penguin/ui/workspace-ui.mjs';
const root=resolve(import.meta.dirname,'../..');
function fixture() {
  const workspace=resolve(root,'output/acceptance/human',randomUUID()), agentRoot=resolve(workspace,'agents');
  const parent=`session-2026-10-20-00-00-00-${randomUUID().replaceAll('-','')}`, child=`session-2026-10-20-00-00-01-${randomUUID().replaceAll('-','')}`;
  const runId=`run-${randomUUID()}`,actionId=randomUUID(),dispatchId=randomUUID(),commandId=randomUUID(),agent='automation_execution_agent';
  const dir=resolve(workspace,'output/runs',runId), time='2026-10-20T00:00:00.000Z';
  const put=(file,data)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));};
  const manifest={run_id:runId,stages:{execution:{status:'in_progress'}},orchestration:{plan:{workflow_mode:'task'},events:[{type:'dispatched',stage:'execution',agent,at:time,dispatch_id:dispatchId,'parent-session-id':parent,child_command_policy:'policy'}]}};
  const state={status:'waiting_human',human_protocol:1,human_kind:'access',question:'请完成登录',waiting_at:time,waiting_command_id:actionId,dispatch_id:dispatchId};
  put(resolve(dir,'manifest.json'),manifest);put(resolve(dir,'execution/browser-state.json'),state);
  put(resolve(dir,`audit/commands/${actionId}/command.json`),{script:'browser-task.mjs',run_id:runId,status:'completed',result:{termination_confirmed:true},host_binding:{session_id:child}});
  put(resolve(dir,`audit/commands/${actionId}/command.log`),{status:'waiting_human',question:state.question});
  put(resolve(dir,`audit/commands/${commandId}/command.json`),{host_binding:{session_id:child}});
  const trace=(a,id,rows)=>put(resolve(agentRoot,a,'traces/2026-10-20',`${id}_001.jsonl`),rows.map(r=>JSON.stringify({timestamp:time,...r})).join('\n'));
  trace('test_agent',parent,[{type:'session_meta',payload:{session_id:parent,workspace}},
    {type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'native-call',arguments:{agent_id:agent,prompt:`${runId} ${dispatchId} policy`}}},
    {type:'event_msg',payload:{type:'subagent',session_id:child}},
    {type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'native-call',stop_reason:'completed',output:'等待人工操作'}}]);
  const childRows=[{type:'session_meta',payload:{session_id:child,source:'subagent',workspace}}];
  trace(agent,child,childRows);
  const human=(decision,sender)=>{childRows.push({timestamp:'2026-10-20T00:01:00.000Z',type:'model_msg',payload:{type:'text',role:'user',text:humanConfirmationText(actionId,decision),...(sender?{sender}:{})}});trace(agent,child,childRows);};
  const options={workspace,parent,runId,actionId,agentRoot,health:async()=>{}};
  return {options,workspace,parent,child,runId,actionId,commandId,dispatchId,dir,manifest,state,agentRoot,put,human};
}
test('waiting card is native-child bound, retains task state, and overrides completed presentation',()=>{
  const f=fixture();assert.equal(listHumanActions(f.workspace,f.parent,f.agentRoot)[0].child_session,f.child);
  assert.throws(()=>inspectHumanAction(f.workspace,'wrong-parent',f.runId,f.agentRoot)??(()=>{throw Error('wrong')})());
  assert.equal(qaTaskStatus({status:'completed'},{humanWaiting:true}).label,'等待人工操作');
  assert.equal(f.manifest.stages.execution.status,'in_progress');
});
test('concurrent and repeated confirmation sends exactly once to the original child',async()=>{
  const f=fixture();let sends=0;
  const send=async(child,text)=>{sends++;assert.equal(child,f.child);assert.equal(text,humanConfirmationText(f.actionId,'continue'));await new Promise(r=>setTimeout(r,20));f.human('continue');return 'started';};
  await Promise.all([answerHumanAction({...f.options,decision:'continue',send}),answerHumanAction({...f.options,decision:'continue',send})]);
  assert.equal((await answerHumanAction({...f.options,decision:'continue',send})).changed,false);assert.equal(sends,1);
  assert.equal(nativeHumanDecision(f.dir,f.state,f.commandId,f.agentRoot).decision,'continue');
  assert.equal(JSON.parse(readFileSync(resolve(f.dir,'manifest.json'))).orchestration.events.length,1);
});
test('wait does not run model or authorize browser; cancel is a distinct native decision',async()=>{
  const f=fixture();let sends=0;
  const send=async()=>{sends++;f.human('cancel');return 'resumed';};
  await answerHumanAction({...f.options,decision:'wait',send});assert.equal(sends,0);assert.equal(nativeHumanDecision(f.dir,f.state,f.commandId,f.agentRoot),null);
  await answerHumanAction({...f.options,decision:'cancel',send});assert.equal(sends,1);assert.equal(nativeHumanDecision(f.dir,f.state,f.commandId,f.agentRoot).decision,'cancel');
});
test('forged model confirmation, wrong worker child, old card and newer dispatch cannot resume',async()=>{
  const f=fixture();await answerHumanAction({...f.options,decision:'continue',send:async()=>{f.human('continue','parent_agent');return 'started';}});
  assert.equal(nativeHumanDecision(f.dir,f.state,f.commandId,f.agentRoot),null);
  f.human('continue');f.put(resolve(f.dir,`audit/commands/${f.commandId}/command.json`),{host_binding:{session_id:'another-child'}});
  assert.equal(nativeHumanDecision(f.dir,f.state,f.commandId,f.agentRoot),null);
  await assert.rejects(answerHumanAction({...f.options,actionId:randomUUID(),decision:'continue',send:async()=>assert.fail('must not send')}),/expired/);
  f.manifest.orchestration.events[0].dispatch_id=randomUUID();f.put(resolve(f.dir,'manifest.json'),f.manifest);
  assert.equal(inspectHumanAction(f.workspace,f.parent,f.runId,f.agentRoot),null);
});
test('transport uncertainty never resends; missing browser never starts a child',async()=>{
  const f=fixture();let sends=0;
  await assert.rejects(answerHumanAction({...f.options,decision:'continue',health:async()=>{throw Error('browser gone');},send:async()=>sends++}),/browser gone/);
  assert.equal(sends,0);
  const send=async()=>{sends++;throw Error('uncertain');};
  await assert.rejects(answerHumanAction({...f.options,decision:'continue',send}),/uncertain/);
  assert.equal((await answerHumanAction({...f.options,decision:'continue',send})).status,'delivery_unknown');assert.equal(sends,1);
});
test('only explicit login completion shortcuts are intercepted',()=>{
  for(const value of ['已登录','登录完成，请继续测试','已完成登录。'])assert.equal(isLoginConfirmation(value),true);
  for(const value of ['未登录','我还没登录完成','继续','已登录，但不要继续','登录完成后删除所有记录'])assert.equal(isLoginConfirmation(value),false);
});
