import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { guardDelegation } from '../../scripts/delegation-guard.mjs';
import { resolveDispatchedChild } from '../../scripts/stage-evidence.mjs';
import { inspectHandoff } from '../../scripts/controller-handoff.mjs';
import { readControllerSession, withControllerSession } from '../../scripts/controller-command-session.mjs';
import { inspectIndependentArtifacts } from '../../scripts/independent-task.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root=resolve(import.meta.dirname,'../..');
const roles={execution:['automation_execution_agent','playwright-execution'],test_cases:['test_case_agent','test-case-writing'],report:['test_report_agent','test-report-writing'],analysis:['requirement_analysis_agent','requirement-analysis']};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));

async function fixture(workflow_mode='task') {
  const parent=`session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',randomUUID()),traces=resolve(agentRoot,'test_agent/traces/2026-10-13');mkdirSync(traces,{recursive:true});
  const parentFile=resolve(traces,`${parent}_001.jsonl`);
  const parentMeta={type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}};
  const rows=[];const save=()=>writeFileSync(parentFile,[parentMeta,...rows].map(JSON.stringify).join('\n'));save();
  const send=r=>executeAction(root,parent,()=>JSON.stringify(r),{agentRoot});
  const created=await send({action:'create_run'});assert.equal(created.exit_code,0);
  const id=created.run_id,dir=resolve(root,'output/runs',id),call=r=>send({run_id:id,...r});
  assert.equal((await call({action:'archive_input',name:'request.txt',text:'Synthetic requirement: reject an empty name. No product tests executed.'})).exit_code,0);
  assert.equal((await call({action:'plan_run',stages:workflow_mode==='task'?['execution','test_cases','report','analysis']:['analysis','test_points'],workflow_mode})).exit_code,0);
  const dispatch=stage=>call({action:'dispatch',stage,agent:roles[stage][0],skills:[roles[stage][1]]});
  const append=row=>{rows.push({timestamp:new Date().toISOString(),...row});save();};
  const makeChild=(delegation,ended)=>{
    const child=`session-2026-10-13-00-00-01-${randomUUID().replaceAll('-','')}`,traces=resolve(agentRoot,delegation.agent_id,'traces/2026-10-13');mkdirSync(traces,{recursive:true});
    const path=resolve(traces,`${child}_001.jsonl`);
    const write=completed=>writeFileSync(path,[
      {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(agentRoot,delegation.agent_id,'agent_state'),workspace:root}},
      {type:'model_msg',payload:{type:'text',role:'user',text:delegation.prompt}},
      {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic child evidence'}},
      {type:'event_msg',payload:{type:completed?'request_end':'request_begin',...(completed?{status:'completed'}:{})}}
    ].map(r=>JSON.stringify({timestamp:new Date().toISOString(),...r})).join('\n'));
    write(ended);return {id:child,finish:()=>write(true)};
  };
  const put=(p,v)=>writeFileSync(resolve(dir,p),typeof v==='string'?v:JSON.stringify(v));
  return {id,dir,parent,parentFile,agentRoot,call,dispatch,append,makeChild,put,rows};
}

test('parallel execution and cases bind their own children; unfinished and ready handoffs do not conflict',async()=>{
  const f=await fixture();
  const [execution,cases]=await Promise.all([f.dispatch('execution'),f.dispatch('test_cases')]);
  for(const r of [execution,cases]) assert.equal(r.exit_code,0,JSON.stringify(r));
  const gate=r=>guardDelegation(root,{tool_name:'run_subagent',tool_call_id:randomUUID(),session_id:f.parent,arguments:r.delegation},f.agentRoot);
  assert.deepEqual(gate(execution),{});assert.deepEqual(gate(cases),{});
  assert.equal(gate({...cases,delegation:{...cases.delegation,prompt:cases.delegation.prompt+' '+execution.data.event.dispatch_id}}).decision,'deny');
  const duplicate=await f.dispatch('execution');assert.equal(duplicate.classification,'input_rejected');
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  const report=await f.dispatch('report');assert.equal(report.exit_code,0);
  f.append({type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'denied-case-call',arguments:cases.delegation}});
  f.append({type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'denied-case-call',stop_reason:'completed',output:'Tool call denied by the qa-delegation-guard hook: synthetic prelaunch refusal'}});
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot),null,'Denied call did not launch a child and needs no handoff');
  const a=f.makeChild(execution.delegation,false),b=f.makeChild(cases.delegation,true);
  f.append({type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'exec',arguments:execution.delegation}});
  f.append({type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'cases',arguments:cases.delegation}});
  f.append({type:'event_msg',payload:{type:'subagent',session_id:a.id}});
  f.append({type:'event_msg',payload:{type:'subagent',session_id:b.id}});
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot),null,'No returned child must not cause an internal review');
  f.put('design/test_cases.json',[{case_id:'CASE-1',module:'Form',title:'Reject empty name',priority:'P1',preconditions:[],steps:['Submit empty name'],expected:'Rejected'}]);
  f.put('design/test_cases-task.json',{run_id:f.id,stage:'test_cases',outcome:'completed',summary:'Synthetic case design',source_paths:['inputs/request.txt'],questions:[],limitations:[]});
  assert.equal((await f.call({action:'export_test_cases'})).exit_code,0);
  f.append({type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'cases',stop_reason:'completed',output:'Synthetic cases returned'}});
  assert.equal(resolveDispatchedChild(root,f.id,'test_cases',f.parent,f.agentRoot).child_session,b.id);
  const analysis=await f.dispatch('analysis');assert.equal(analysis.exit_code,0);
  const d=f.makeChild(analysis.delegation,true);
  f.put('analysis/requirement_analysis.md','# Synthetic analysis\nReject an empty name.');
  f.put('analysis/analysis-task.json',{run_id:f.id,stage:'analysis',outcome:'completed',summary:'Synthetic analysis',source_paths:['inputs/request.txt'],questions:[],limitations:[]});
  f.append({type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'analysis',arguments:analysis.delegation}});
  f.append({type:'event_msg',payload:{type:'subagent',session_id:d.id}});
  f.append({type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'analysis',stop_reason:'completed',output:'Synthetic analysis returned'}});
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot).request.stage,'analysis','Two ready returns are drained without requiring user review');
  assert.equal((await f.call(analysis.handoff_template)).exit_code,0);
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot).request.stage,'test_cases');
  const done=await f.call(cases.handoff_template);assert.equal(done.exit_code,0,JSON.stringify(done));
  const manifest=JSON.parse(readFileSync(resolve(f.dir,'manifest.json')));
  assert.equal(manifest.stages.test_cases.status,'completed');assert.equal(manifest.stages.execution.status,'in_progress');
  // Report was dispatched before case completion: no moving implicit upstream contract.
  f.put('report/report-task.json',{run_id:f.id,stage:'report',outcome:'partial',summary:'Report supplied source only',source_paths:['inputs/request.txt'],questions:[],limitations:['No execution results supplied']});
  f.put('report/test_report.md','# Synthetic report\nNo execution results supplied.');
  f.put('report/reportable-results.json',{run_id:f.id,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}});f.put('report/issues.json',[]);
  const contract=inspectIndependentArtifacts(root,f.id,'report',{draft:true});assert.equal(contract.status,'passed',JSON.stringify(contract.errors));
  assert.equal(contract.files.some(item=>item.path==='design/test_cases.json'),false);
  const c=f.makeChild(report.delegation,true);
  f.append({type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'report',arguments:report.delegation}});
  f.append({type:'event_msg',payload:{type:'subagent',session_id:c.id}});
  assert.equal((await f.call({action:'export_report'})).exit_code,0);
  f.append({type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'report',stop_reason:'completed',output:'Synthetic independent report'}});
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot).request.stage,'report');
  assert.equal((await f.call(report.handoff_template)).exit_code,0);
  a.finish();f.append({type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'exec',stop_reason:'completed',output:'Synthetic execution return; no product tests'}});
  assert.equal(resolveDispatchedChild(root,f.id,'execution',f.parent,f.agentRoot).child_session,a.id);
  assert.equal(gate(execution).decision,'deny','Same dispatch cannot launch twice');
});

test('live command contention queues internally and queued cancellation never runs the action',async()=>{
  const f=await fixture();const execution=await f.dispatch('execution');
  let release;
  const first=withControllerSession(root,f.parent,()=>new Promise(done=>{release=()=>done({status:'completed',exit_code:0});}),{agentRoot:f.agentRoot,recoveryContext:{action:'browser_task',key:'synthetic-browser-operation'}});
  await sleep(10);
  assert.deepEqual(guardDelegation(root,{tool_name:'run_subagent',tool_call_id:'new-call',session_id:f.parent,arguments:execution.delegation},f.agentRoot),{},'Unrelated active command is not an unknown stopped session');
  let ran=false;
  const abort=new AbortController();
  const cancelled=withControllerSession(root,f.parent,async()=>{ran=true;return {status:'completed',exit_code:0};},{agentRoot:f.agentRoot,queue:true,signal:abort.signal});
  abort.abort();await assert.rejects(cancelled,/cancelled/);assert.equal(ran,false);
  const waiting=f.call({action:'archive_input',name:'parallel-followup.txt',text:'Synthetic supplied clarification'});
  await sleep(150);assert.equal(readControllerSession(root,f.parent).status,'running');
  release();await first;
  assert.equal((await waiting).exit_code,0);assert.equal(readControllerSession(root,f.parent).status,'ready');
});

test('lifecycle conflicts remain serial but are preflight refusals, not global stopped failures',async()=>{
  const f=await fixture('lifecycle');assert.equal((await f.dispatch('analysis')).exit_code,0);
  const rejected=await f.call({action:'dispatch',stage:'test_points',agent:'test_point_agent',skills:['test-point-design']});
  assert.equal(rejected.classification,'input_rejected');assert.match(rejected.error,/lifecycle stage is active/);
  assert.equal(readControllerSession(root,f.parent).status,'ready');
});

test('separate native command processes queue the same controller without losing either dispatch',async()=>{
  const f=await fixture();
  const invoke=async stage=>{
    const path=resolve(f.dir,`synthetic-${stage}-request.json`);
    writeFileSync(path,JSON.stringify({action:'dispatch',run_id:f.id,stage,agent:roles[stage][0],skills:[roles[stage][1]]}));
    const result=await promisify(execFile)(process.execPath,[resolve(root,'scripts/project-action.mjs'),'execute',`--controller-session=${f.parent}`,`--request=${path}`],{cwd:root,env:{...process.env,PENGUIN_AGENT_ROOT:f.agentRoot},windowsHide:true});
    return JSON.parse(result.stdout);
  };
  const results=await Promise.all([invoke('execution'),invoke('test_cases')]);
  for(const result of results) assert.equal(result.exit_code,0,JSON.stringify(result));
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  const manifest=JSON.parse(readFileSync(resolve(f.dir,'manifest.json')));
  assert.equal(manifest.orchestration.events.filter(e=>e.type==='dispatched').length,2);
  assert.equal(manifest.stages.execution.status,'in_progress');assert.equal(manifest.stages.test_cases.status,'in_progress');
});

test('run status surfaces stopped controller even when the manifest itself is consistent',async()=>{
  const f=await fixture();
  await withControllerSession(root,f.parent,async()=>({status:'failed',exit_code:1}),{agentRoot:f.agentRoot});
  const status=await f.call({action:'run_status'});
  assert.equal(status.exit_code,0);assert.equal(status.data.consistency,'consistent');
  assert.equal(status.data.controller_status,'stopped');
  assert.equal(status.data.next_action,'report_engineering_issue_without_user_unlock');
});
