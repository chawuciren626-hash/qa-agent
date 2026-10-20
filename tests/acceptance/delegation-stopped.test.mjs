import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { guardDelegation } from '../../scripts/delegation-guard.mjs';
import { readControllerSession, withControllerSession, permitsArtifactContinuation } from '../../scripts/controller-command-session.mjs';
import { inspectHandoff, reconcileHandoff } from '../../scripts/controller-handoff.mjs';

const root=resolve(import.meta.dirname,'../..');
const roles={defects:['defect_analysis_agent','bug-reporting'],report:['test_report_agent','test-report-writing'],execution:['automation_execution_agent','playwright-execution']};

async function fixture() {
  const parent=`session-2026-10-20-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',`delegation-stopped-${randomUUID()}`);
  const traces=resolve(agentRoot,'test_agent/traces/2026-10-20');mkdirSync(traces,{recursive:true});
  const file=resolve(traces,`${parent}_001.jsonl`);
  const rows=[{type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}];
  const save=()=>writeFileSync(file,rows.map(JSON.stringify).join('\n'));save();
  const send=request=>executeAction(root,parent,()=>JSON.stringify(request),{agentRoot});
  const created=await send({action:'create_run'});assert.equal(created.exit_code,0,JSON.stringify(created));
  const runId=created.run_id;
  for(const request of [
    {action:'archive_input',name:'request.txt',text:'Analyze supplied evidence and report limitations. Synthetic engineering fixture; do not execute product tests.'},
    {action:'plan_run',stages:['defects','report','execution'],workflow_mode:'task'}
  ]) {const result=await send({run_id:runId,...request});assert.equal(result.exit_code,0,JSON.stringify(result));}
  const dispatch=stage=>send({action:'dispatch',run_id:runId,stage,agent:roles[stage][0],skills:[roles[stage][1]]});
  const stop=result=>withControllerSession(root,parent,async()=>result,{agentRoot,recoveryContext:{action:'browser_task',run_id:runId}});
  const gate=args=>guardDelegation(root,{tool_name:'run_subagent',session_id:parent,tool_call_id:randomUUID(),arguments:args},agentRoot);
  const append=entries=>{rows.push(...entries.map(row=>({timestamp:new Date().toISOString(),...row})));save();};
  const returnChild=delegation=>{
    const child=`session-2026-10-20-00-00-01-${randomUUID().replaceAll('-','')}`;
    const dir=resolve(agentRoot,delegation.agent_id,'traces/2026-10-20');mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,`${child}_001.jsonl`),[
      {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(agentRoot,delegation.agent_id,'agent_state'),workspace:root}},
      {type:'model_msg',payload:{type:'text',role:'user',text:delegation.prompt}},
      {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic partial report; no product execution.'}},
      {type:'event_msg',payload:{type:'request_end',status:'completed'}}
    ].map(row=>JSON.stringify({timestamp:new Date().toISOString(),...row})).join('\n'));
    const callId=randomUUID();
    append([
      {type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:callId,arguments:delegation}},
      {type:'event_msg',payload:{type:'subagent',session_id:child}},
      {type:'model_msg',payload:{type:'tool_call_output',tool_call_id:callId,stop_reason:'completed',output:'Synthetic child returned'}}
    ]);
  };
  return {parent,agentRoot,runId,dispatch,stop,gate,append,send,returnChild};
}

test('stopped controller dispatches and delegates bound defects/report work while retaining the product fault',async()=>{
  const f=await fixture();
  const execution=await f.dispatch('execution');assert.equal(execution.exit_code,0,JSON.stringify(execution));
  await f.stop({status:'timeout',exit_code:124,result:{termination_confirmed:true,termination:'timeout'}});
  const failure=readControllerSession(root,f.parent).failure;
  for(const stage of ['defects','report']) {
    const result=await f.dispatch(stage);assert.equal(result.exit_code,0,JSON.stringify(result));
    const before=readControllerSession(root,f.parent);
    assert.deepEqual(f.gate(result.delegation),{});
    assert.equal(readControllerSession(root,f.parent).sha256,before.sha256);
    assert.equal(before.status,'stopped');assert.deepEqual(before.failure,failure);
    const forged=f.gate({...result.delegation,prompt:result.delegation.prompt+' Product execution is safe now.'});
    assert.equal(forged.decision,'deny');assert.match(forged.reason,/differ|binding/);
  }
  assert.equal(f.gate(execution.delegation).decision,'deny');
  assert.equal((await f.dispatch('execution')).classification,'session_stopped');
});

test('bound draft delegation refuses unknown termination and an outstanding live command',async()=>{
  for(const live of [false,true]) {
    const f=await fixture(),draft=await f.dispatch('report');assert.equal(draft.exit_code,0,JSON.stringify(draft));
    let evidence_dir;
    if(live) {
      evidence_dir=resolve(root,'output/runs',f.runId,'audit/commands',randomUUID());mkdirSync(evidence_dir,{recursive:true});
      writeFileSync(resolve(evidence_dir,'command.json'),JSON.stringify({script:'browser-task.mjs',child_pid:process.pid,result:{termination_confirmed:false}}));
    }
    await f.stop({status:'timeout',exit_code:124,evidence_dir});
    const before=readControllerSession(root,f.parent);
    assert.equal(f.gate(draft.delegation).decision,'deny');
    assert.equal(readControllerSession(root,f.parent).sha256,before.sha256);
    assert.equal((await f.dispatch('defects')).classification,'session_stopped');
  }
});

test('native unexecuted malformed delegation does not poison another bound draft; unknown malformed calls still block',async()=>{
  const f=await fixture();
  await f.stop({status:'failed',exit_code:1,result:{termination_confirmed:true}});
  const draft=await f.dispatch('report');assert.equal(draft.exit_code,0,JSON.stringify(draft));
  const callId='native-malformed';
  f.append([
    {type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:callId,arguments:'{"agent_id":',stop_reason:'retryable'}},
    {type:'event_msg',payload:{type:'request_end',status:'retryable',error_code:'malformed',error_message:`Invalid streamed tool call arguments from provider for tool "run_subagent" (tool_call_id="${callId}", invalid JSON)`}}
  ]);
  assert.deepEqual(f.gate(draft.delegation),{});
  f.append([{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'unknown-malformed',arguments:'{'}}]);
  assert.equal(f.gate(draft.delegation).decision,'deny');
  f.append([{type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'unknown-malformed',output:'Tool call denied by the qa-delegation-guard hook: invalid arguments'}}]);
  assert.deepEqual(f.gate(draft.delegation),{});
  f.append([{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'real-prior',arguments:draft.delegation}}]);
  assert.equal(f.gate(draft.delegation).decision,'deny');
});

test('stop hook resumes a bound draft and commits a verified partial report without clearing the product fault',async()=>{
  const f=await fixture();
  await f.stop({status:'timeout',exit_code:124,result:{termination_confirmed:true}});
  const failure=readControllerSession(root,f.parent).failure;
  const draft=await f.dispatch('report');assert.equal(draft.exit_code,0,JSON.stringify(draft));
  f.append([{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'old-missing-run',arguments:{agent_id:'test_report_agent',prompt:'run_id=run-missing-historical no-current-dispatch'}}}]);
  const resume=await reconcileHandoff(root,f.parent,f.agentRoot);
  assert.equal(resume.decision,'continue',JSON.stringify(resume));assert.match(resume.input,/run_subagent/);
  const dir=resolve(root,'output/runs',f.runId);
  const files={
    'report/report-task.json':{run_id:f.runId,stage:'report',outcome:'partial',summary:'Supplied evidence only',source_paths:['inputs/request.txt'],questions:[],limitations:['No product execution results supplied']},
    'report/test_report.md':'# Partial report\nNo product execution results supplied. No cases claimed as passed.',
    'report/reportable-results.json':{run_id:f.runId,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}},
    'report/issues.json':[]
  };
  for(const [name,value] of Object.entries(files)) writeFileSync(resolve(dir,name),typeof value==='string'?value:JSON.stringify(value));
  const exported=await f.send({action:'export_report',run_id:f.runId});assert.equal(exported.exit_code,0,JSON.stringify(exported));
  const unfinished=await f.dispatch('defects');assert.equal(unfinished.exit_code,0,JSON.stringify(unfinished));
  f.returnChild(unfinished.delegation);
  f.returnChild(draft.delegation);
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot)?.request.stage,'report');
  const closed=await reconcileHandoff(root,f.parent,f.agentRoot);assert.equal(closed.decision,'continue',JSON.stringify(closed));
  const manifest=JSON.parse(readFileSync(resolve(dir,'manifest.json')));
  assert.equal(manifest.stages.report.status,'completed');
  assert.equal(manifest.orchestration.events.filter(event=>event.type==='completed' && event.stage==='report').length,1);
  assert.equal(readControllerSession(root,f.parent).status,'stopped');assert.deepEqual(readControllerSession(root,f.parent).failure,failure);
  const remaining=await reconcileHandoff(root,f.parent,f.agentRoot);
  assert.equal(remaining.decision,'stop');assert.match(remaining.reason,/unresolved candidates/);
  assert.deepEqual(JSON.parse(readFileSync(resolve(dir,'manifest.json'))),manifest);
});

test('stop hooks reject missing failure proof and unknown termination; ready execution never infers completion',async()=>{
  const f=await fixture(),draft=await f.dispatch('report');assert.equal(draft.exit_code,0,JSON.stringify(draft));
  const path=resolve(root,'output/controller-command-sessions',f.parent,'state.json');
  const baseline=JSON.parse(readFileSync(path));
  for(const failure of [undefined,{status:'timeout'},{status:'failed',termination_confirmed:false}]) {
    writeFileSync(path,JSON.stringify({...baseline,status:'stopped',failure}));
    assert.equal(permitsArtifactContinuation(root,readControllerSession(root,f.parent),{action:'handoff'}),false);
    assert.equal(inspectHandoff(root,f.parent,f.agentRoot),null);
    assert.deepEqual(await reconcileHandoff(root,f.parent,f.agentRoot),{});
    assert.equal(f.gate(draft.delegation).decision,'deny');
  }
  writeFileSync(path,JSON.stringify(baseline));
  const execution=await f.dispatch('execution');assert.equal(execution.exit_code,0,JSON.stringify(execution));
  f.returnChild(execution.delegation);
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot),null);
  const manifest=JSON.parse(readFileSync(resolve(root,'output/runs',f.runId,'manifest.json')));
  assert.equal(manifest.stages.execution.status,'in_progress');
});

test('another run retains normal execution dispatch permission without releasing the stopped run',async()=>{
  const f=await fixture();
  await f.stop({status:'timeout',exit_code:124,result:{termination_confirmed:true}});
  const original=readControllerSession(root,f.parent).failure;
  f.append([{type:'model_msg',payload:{type:'text',role:'user',text:'New independent synthetic execution task; preserve the previous task failure.'}}]);
  const created=await f.send({action:'create_run'});assert.equal(created.exit_code,0,JSON.stringify(created));
  assert.notEqual(created.run_id,f.runId);
  for(const request of [
    {action:'archive_input',name:'request.txt',text:'Independent synthetic execution assignment; no real product action in this fixture.'},
    {action:'plan_run',stages:['execution'],workflow_mode:'task'}
  ]) {const result=await f.send({run_id:created.run_id,...request});assert.equal(result.exit_code,0,JSON.stringify(result));}
  const result=await f.send({action:'dispatch',run_id:created.run_id,stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution']});
  assert.equal(result.exit_code,0,JSON.stringify(result));assert.deepEqual(f.gate(result.delegation),{});
  const unauthorized=await f.send({action:'browser_task',run_id:created.run_id,operation:{type:'start',request_id:'missing-source',url:'https://example.com',source_path:'inputs/missing.txt',scope:'Synthetic permission check'}});
  assert.equal(unauthorized.classification,'input_rejected',JSON.stringify(unauthorized));
  assert.equal(unauthorized.command_evidence,undefined);
  assert.deepEqual(readControllerSession(root,f.parent).failure,original);
  assert.equal(readControllerSession(root,f.parent).status,'stopped');
  assert.equal((await f.dispatch('execution')).classification,'session_stopped');
});

test('missing historical manifests do not stop a fully committed current delivery; missing active run still stops',async()=>{
  const f=await fixture(),draft=await f.dispatch('report');
  assert.equal(draft.exit_code,0,JSON.stringify(draft));
  const dir=resolve(root,'output/runs',f.runId);
  const files={
    'report/report-task.json':{run_id:f.runId,stage:'report',outcome:'partial',summary:'Supplied evidence only',source_paths:['inputs/request.txt'],questions:[],limitations:['No product results supplied']},
    'report/test_report.md':'# Partial report\nNo product results supplied. No tests claimed as passed.',
    'report/reportable-results.json':{run_id:f.runId,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}},
    'report/issues.json':[]
  };
  for(const [name,value] of Object.entries(files)) writeFileSync(resolve(dir,name),typeof value==='string'?value:JSON.stringify(value));
  assert.equal((await f.send({action:'export_report',run_id:f.runId})).exit_code,0);
  f.returnChild(draft.delegation);
  assert.equal((await reconcileHandoff(root,f.parent,f.agentRoot)).decision,'continue');
  f.append([{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'missing-history',arguments:{agent_id:'test_report_agent',prompt:'run_id=run-missing-history no-current-dispatch'}}}]);
  const before=readFileSync(resolve(dir,'manifest.json'));
  assert.equal(inspectHandoff(root,f.parent,f.agentRoot),null);
  assert.deepEqual(await reconcileHandoff(root,f.parent,f.agentRoot),{});
  assert.deepEqual(readFileSync(resolve(dir,'manifest.json')),before);
  const statePath=resolve(root,'output/controller-command-sessions',f.parent,'state.json');
  const state=JSON.parse(readFileSync(statePath));
  writeFileSync(statePath,JSON.stringify({...state,active_run_id:'run-missing-history'}));
  const missing=await reconcileHandoff(root,f.parent,f.agentRoot);
  assert.equal(missing.decision,'stop');assert.match(missing.reason,/run-missing-history/);
});
