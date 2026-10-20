import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findParentDispatch, resolveDispatchedChild, recordedChildHandle, readSession, partialBrowserDelivery, partialBrowserFailureVerifier, draftHandoffReconciliation } from '../../scripts/stage-evidence.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertChildCommands, childCommandPolicy } from '../../scripts/child-command-policy.mjs';

const request = { runId: 'run-synthetic-a', agent: 'requirement_analysis_agent', childId: 'session-2026-10-09-10-05-30-a8bced7d', dispatchedAt: '2026-10-09T02:05:25.179Z' };

test('read-only shell inspection rejects substitutions and rg preprocessors',()=>{
  const inspect=cmd=>assertChildCommands([
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:'inspect',arguments:{cmd}}},
    {payload:{type:'tool_call_output',tool_call_id:'inspect',output:'files',stop_reason:'completed'}}
  ],{allowRecovery:true,requireControlledCommands:true});
  for(const cmd of ['rg "foo|bar" docs','find output/runs/run-example -type f | sort']) assert.doesNotThrow(()=>inspect(cmd));
  for(const cmd of ['rg "$(touch marker)" docs','rg "`touch marker`" docs','rg "--pre" tool docs',"rg '--pre=tool' docs",'rg --"pre"=tool docs','find output/runs/run-example -delete','ls "$(touch marker)" 2>/dev/null']) assert.throws(()=>inspect(cmd),/uncontrolled/);
});

test('native truncated command output reads only the same session archive and preserves failure status',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'qa-truncated-'));const agent=request.agent,id=request.childId;
  const dir=resolve(root,agent,'traces/2026-10-09');mkdirSync(dir,{recursive:true});
  const archiveDir=resolve(root,agent,'scratchpad',id,'truncated-tool-output');mkdirSync(archiveDir,{recursive:true});
  const archive=resolve(archiveDir,'exec_command-abc.log');
  const full=JSON.stringify({status:'completed',exit_code:0,execution_mode:'in_process',launches_child:false,action_receipt:'synthetic',result:{text:'x'.repeat(20000)}});
  writeFileSync(archive,full);
  const tracePath=resolve(dir,`${id}_001.jsonl`);
  const save=(path,stop='completed')=>writeFileSync(tracePath,[{payload:{type:'tool_call',name:'exec_command',tool_call_id:'x',arguments:{cmd:'node project-action.mjs'}}},{payload:{type:'tool_call_output',tool_call_id:'x',stop_reason:stop,output:'{ truncated JSON\n[output archived: '+path+']'}}].map(JSON.stringify).join('\n'));
  save(archive);const rows=readSession(root,agent,id);assert.equal(rows[1].payload.output,full);assert.doesNotThrow(()=>assertChildCommands(rows));
  save(archive,'fatal');assert.throws(()=>assertChildCommands(readSession(root,agent,id)));
  save(resolve(root,'foreign.log'));assert.throws(()=>readSession(root,agent,id),/another session/);
  save(resolve(archiveDir,'exec_command-missing.log'));assert.throws(()=>readSession(root,agent,id));
  const foreign=resolve(root,'foreign-archive');renameSync(archiveDir,foreign);symlinkSync(foreign,archiveDir,process.platform==='win32'?'junction':'dir');save(archive);assert.throws(()=>readSession(root,agent,id),/redirected/);
});
function trace() {
  return [
    { timestamp: '2026-10-09T02:05:30.804Z', type: 'model_msg', payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'call-a', arguments: JSON.stringify({ agent_id: request.agent, prompt: `Analyze ${request.runId}` }) } },
    { timestamp: '2026-10-09T02:05:30.856Z', type: 'event_msg', payload: { type: 'subagent', session_id: request.childId } },
    { timestamp: '2026-10-09T02:05:54.651Z', type: 'model_msg', payload: { type: 'tool_call_output', tool_call_id: 'call-a', output: 'Analysis delivered.', stop_reason: 'completed' } }
  ];
}

test('binds actual PenguinHarness layout with ID in structured event, not response text', () => {
  assert.equal(findParentDispatch(trace(), request)?.tool_call_id, 'call-a');
});

test('interrupted child is diagnostic only, never a successful handoff',()=>{
  const rows=trace();rows[2].payload.stop_reason='aborted';rows[2].payload.output='[interrupted: tool aborted by user]';
  assert.equal(findParentDispatch(rows,request),null);
  assert.equal(findParentDispatch(rows,{...request,includeInterrupted:true}).outcome,'interrupted');
  assert.equal(findParentDispatch(rows,{...request,includeInterrupted:true,childId:'session-2026-10-09-10-05-30-ffff'}),null);
  rows[2].payload.output='Tool call denied by a hook';
  assert.equal(findParentDispatch(rows,{...request,includeInterrupted:true}),null);
});

test('only native retained-handle continuation can complete an interrupted binding',()=>{
  const rows=trace();rows[2].payload.stop_reason='aborted';
  rows[2].payload.output='[subagent retained with subagent_id subagent-native; continuation only]\n[interrupted]';
  const call={timestamp:'2026-10-09T02:06:00Z',type:'model_msg',payload:{type:'tool_call',name:'input_subagent',tool_call_id:'resume',arguments:{subagent_id:'subagent-native',prompt:'continue'}}};
  const output={timestamp:'2026-10-09T02:06:30Z',type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'resume',stop_reason:'completed',output:'Delivered'}};
  assert.equal(findParentDispatch([...rows,call],request),null);
  assert.equal(findParentDispatch([...rows,call,output],request)?.tool_call_id,'call-a');
  assert.equal(findParentDispatch([...rows,{...call,payload:{...call.payload,arguments:{subagent_id:'subagent-other'}}},output],request),null);
  assert.equal(findParentDispatch([...rows,call,{...output,payload:{...output.payload,output:'[input_subagent error: unknown subagent_id subagent-native]'}}],request),null);
  assert.equal(findParentDispatch([...rows,call,{...output,payload:{...output.payload,stop_reason:'aborted'}}],request),null);
});

test('handle lookup distinguishes interrupted, returned and pending; denied redispatch is ignored',()=>{
  const dispatch={agent:request.agent,at:request.dispatchedAt,dispatch_id:'dispatch-a',child_command_policy:'policy-a'};
  const rows=trace();rows[0].payload.arguments={agent_id:request.agent,prompt:`${request.runId} dispatch-a policy-a`};
  assert.equal(recordedChildHandle(rows.slice(0,2),dispatch,request.runId).status,'unavailable');
  assert.equal(recordedChildHandle(rows,dispatch,request.runId).status,'returned');
  rows[2].payload.stop_reason='aborted';
  assert.equal(recordedChildHandle(rows,dispatch,request.runId).status,'interrupted');
  rows[2].payload.output='[subagent retained with subagent_id subagent-native; continuation only]\n[interrupted]';
  const denied=[{...rows[0],payload:{...rows[0].payload,tool_call_id:'denied'}},{...rows[2],payload:{...rows[2].payload,tool_call_id:'denied',output:'Tool call denied by the qa-delegation-guard hook'}}];
  const result=recordedChildHandle([...rows,...denied],dispatch,request.runId);
  assert.equal(result.subagent_id,'subagent-native');assert.equal(result.call_state,'interrupted');
  assert.equal(result.completion_verified,false);
});

test('fatal child binding is opt-in, identity-bound and never a successful return',()=>{
  const rows=trace();
  rows[2].payload.stop_reason='fatal';
  rows[2].payload.output='[subagent failed: rejected - 451 provider rejection]';
  assert.equal(findParentDispatch(rows,request),null);
  assert.equal(findParentDispatch(rows,{...request,includeFailed:true}).outcome,'failed');
  const retained=structuredClone(rows);retained[2].payload.output='[subagent retained with subagent_id subagent-owned; continuation only]\n'+retained[2].payload.output;
  assert.equal(findParentDispatch(retained,{...request,includeFailed:true}).outcome,'failed');
  assert.equal(findParentDispatch(rows,{...request,includeFailed:true,agent:'another_agent'}),null);
  rows[2].payload.stop_reason='aborted';
  assert.equal(findParentDispatch(rows,{...request,includeFailed:true}),null);
  rows[2].payload.stop_reason='fatal';
  rows[2].payload.output='Transport interrupted; final execution state unknown';
  assert.equal(findParentDispatch(rows,{...request,includeFailed:true}),null);
  rows.pop();
  assert.equal(findParentDispatch(rows,{...request,includeFailed:true}),null);
});

test('new dispatch binding requires the exact dispatch token in the actual child prompt', () => {
  const token = '09fa16d0-676c-4b11-9983-e857606b9a5f';
  const binding = { ...request, dispatchId: token };
  assert.equal(findParentDispatch(trace(), binding), null);
  const rows = trace();
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId} ${token}-old` });
  assert.equal(findParentDispatch(rows, binding), null);
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId} dispatch_id=${token}` });
  assert.equal(findParentDispatch(rows, binding)?.tool_call_id, 'call-a');
});

test('rejects text-only IDs, old or missing events and missing/mismatched responses', () => {
  for (const mutate of [
    rows => { rows.splice(1, 1); rows[1].payload.output = request.childId; },
    rows => { rows[1].timestamp = '2026-10-09T02:05:20Z'; },
    rows => { rows[1].payload.session_id = 'another-session'; },
    rows => { rows.pop(); },
    rows => { rows[2].payload.tool_call_id = 'other-call'; },
    rows => { rows[2].payload.stop_reason = 'fatal'; },
    rows => { rows[2].payload.stop_reason = 'aborted'; },
    rows => { rows.push(structuredClone(rows[2])); },
    rows => { rows.splice(1, 0, structuredClone(rows[1])); }
  ]) { const rows = trace(); mutate(rows); assert.equal(findParentDispatch(rows, request), null); }
});

test('resolve child uses trace events and real child identity, never prose or guessed IDs',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'qa-child-binding-'));
  const agentRoot=resolve(root,'agents');
  const parentId='session-2026-10-09-10-00-00-abcd';
  const runDir=resolve(root,'output/runs',request.runId);mkdirSync(runDir,{recursive:true});
  const dispatchId='binding-token';const policy=childCommandPolicy(dispatchId);
  writeFileSync(resolve(runDir,'manifest.json'),JSON.stringify({orchestration:{events:[{type:'dispatched',stage:'analysis',agent:request.agent,at:request.dispatchedAt,dispatch_id:dispatchId,'parent-session-id':parentId,child_command_policy:policy}]}}));
  const rows=trace();rows[0].payload.arguments=JSON.stringify({agent_id:request.agent,prompt:`${request.runId} ${dispatchId} ${policy}`});
  const parentDir=resolve(agentRoot,'test_agent/traces/2026-10-09');mkdirSync(parentDir,{recursive:true});
  const parentFile=resolve(parentDir,`${parentId}_001.jsonl`);
  const meta={type:'session_meta',payload:{session_id:parentId,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}};
  const writeParent=events=>writeFileSync(parentFile,[meta,...events].map(r=>JSON.stringify(r)).join('\n'));
  writeParent(rows);
  const childDir=resolve(agentRoot,request.agent,'traces/2026-10-09');mkdirSync(childDir,{recursive:true});
  const childMeta={type:'session_meta',payload:{session_id:request.childId,source:'subagent',agent_state:resolve(agentRoot,request.agent,'agent_state'),workspace:root}};
  const childFile=resolve(childDir,`${request.childId}_001.jsonl`);writeFileSync(childFile,JSON.stringify(childMeta));
  assert.equal(resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot).child_session,request.childId);
  assert.equal(resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot).completion_verified,false);
  writeFileSync(childFile,[childMeta,{type:'event_msg',payload:{type:'abort',error_code:'user_abort'}}].map(JSON.stringify).join('\n'));
  assert.equal(resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot,{includeInterrupted:true}).outcome,'interrupted');
  writeFileSync(childFile,JSON.stringify(childMeta));
  const aborted=structuredClone(rows);aborted[2].payload.stop_reason='aborted';writeParent(aborted);
  const interrupted=resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot,{includeInterrupted:true});
  assert.equal(interrupted.outcome,'interrupted');assert.equal(interrupted.continuation.status,'interrupted');
  assert.throws(()=>resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot),/No unique returned/);
  writeParent(rows.slice(0,2));assert.throws(()=>resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot),/No unique returned/);
  writeParent(rows);childMeta.payload.source='user';writeFileSync(childFile,JSON.stringify(childMeta));
  assert.throws(()=>resolveDispatchedChild(root,request.runId,'analysis',parentId,agentRoot),/identity/);
});

test('direct generator success cannot replace controlled delivery evidence',()=>{
  const rows=[{payload:{type:'tool_call',name:'exec_command',tool_call_id:'direct',arguments:{cmd:'node scripts/generate-analysis-markdown.mjs run-example'}}},{payload:{type:'tool_call_output',tool_call_id:'direct',stop_reason:'completed',output:'passed'}}];
  assert.throws(()=>assertChildCommands(rows,{requireControlledCommands:true}),/bypassed/);
});

test('stage delivery rejects arbitrary shell generators and compound controlled commands',()=>{
  const pair=cmd=>[{payload:{type:'tool_call',name:'exec_command',tool_call_id:'direct',arguments:{cmd}}},{payload:{type:'tool_call_output',tool_call_id:'direct',stop_reason:'completed',output:'ok'}}];
  assert.throws(()=>assertChildCommands(pair('cd "E:/workspace/output/runs/run-a" && python generate-artifacts.py'),{requireControlledCommands:true}),/uncontrolled shell command/);
  assert.throws(()=>assertChildCommands(pair('python generate-artifacts.py'),{requireControlledCommands:true}),/uncontrolled shell command/);
  assert.throws(()=>assertChildCommands(pair('node scripts/project-action.mjs catalog && python generate-artifacts.py'),{requireControlledCommands:true}),/uncontrolled shell command/);
});

test('successful read-only shell inspections do not require extra artifact validation',()=>{
  const pair=(id,cmd,output,stop_reason='completed')=>[
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:id,arguments:{cmd}}},
    {payload:{type:'tool_call_output',tool_call_id:id,stop_reason,output}}
  ];
  const detours=[
    ...pair('catalog-filter',`node scripts/project-action.mjs catalog | grep -A 20 '"explore_url"'`,'catalog excerpt'),
    ...pair('workspace-probe','pwd && ls -la output/action-requests/ 2>/dev/null || echo "no action-requests"','/workspace\naction.json'),
    ...pair('run-files','find E:/QAWorkspaces/run-a -maxdepth 3 -type f | head -50','manifest.json'),
    ...pair('schema-search','find E:/Codex/AITestWorker -maxdepth 4 -type f -name "*test_case*schema*" -o -name "*schema*test_case*" 2>/dev/null | head -20','schemas/test_case.schema.json'),
    ...pair('quoted-find','find "E:/QAWorkspaces/run-a" -name "*.schema.json" -o -name "test_case.schema.json"',''),
    ...pair('compound-read','ls -la "E:/Codex/AITestWorker" && find "E:/Codex/AITestWorker" -maxdepth 3 -name "schemas" -type d','schemas'),
    ...pair('directory-chain','ls -la E:/QAWorkspaces/run-a && ls -la E:/QAWorkspaces/run-a/output && ls -la E:/QAWorkspaces/run-a/output/runs/run-a && ls -la E:/QAWorkspaces/run-a/scripts','directories'),
    ...pair('posix-skill-search','find /c -path "*/skills/playwright-execution/SKILL.md" 2>/dev/null | head -20','/c/skills/playwright-execution/SKILL.md'),
    ...pair('optional-directory','ls -la "C:/Users/test/.penguin/agent_state/skills/" 2>/dev/null || echo "Not found"','Not found'),
    ...pair('quiet-directory','ls -la "E:/QAWorkspaces/run-a/scripts/" 2>/dev/null','scripts'),
    ...pair('source-search','rg -n "report-task.json|independent_required_artifacts|report" E:/Codex/AITestWorker/docs -S','')
  ];
  const result={status:'completed',exit_code:0,script:'validate-artifacts.mjs',task_key:'run-a:validate_artifacts:execution',action_receipt:'receipt',execution_mode:'in_process',launches_child:false,result:{termination_confirmed:true}};
  const validation=pair('validated','node scripts/project-action.mjs execute --controller-session=session-a --request=request.json',JSON.stringify(result));
  const options={allowRecovery:true,requireControlledCommands:true,verifyRecovery:()=>true};
  assert.doesNotThrow(()=>assertChildCommands([...detours,...validation],options));
  assert.doesNotThrow(()=>assertChildCommands(detours,options));
  assert.throws(()=>assertChildCommands(pair('unsafe','node scripts/project-action.mjs catalog | python generate.py','ok'),options),/uncontrolled shell command/);
  assert.throws(()=>assertChildCommands(pair('delete','find E:/QAWorkspaces/run-a -type f -delete','ok'),options),/uncontrolled shell command/);
  assert.throws(()=>assertChildCommands(pair('write','find E:/QAWorkspaces/run-a -type f -fprint E:/out.txt','ok'),options),/uncontrolled shell command/);
  assert.throws(()=>assertChildCommands(pair('third-command','ls -la "E:/run" && find "E:/run" -type f && python generate.py','ok'),options),/uncontrolled shell command/);
});

test('rejected lifecycle metrics in an independent report task require verified report validation',()=>{
  const pair=(id,output)=>[
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:id,arguments:{cmd:'node scripts/project-action.mjs execute --controller-session=session-a --request=request.json'}}},
    {payload:{type:'tool_call_output',tool_call_id:id,stop_reason:'fatal',output:JSON.stringify(output)}}
  ];
  const rejected={status:'rejected',classification:'input_rejected',action:'build_report_metrics',error:'Lifecycle metrics/normalization are not prerequisites for independent tasks',exit_code:2,recovery:{retry_allowed:true},action_receipt:'rejected-receipt'};
  const validated={status:'completed',exit_code:0,script:'validate-artifacts.mjs',task_key:'run-a:validate_artifacts:report',action_receipt:'validated-receipt',execution_mode:'in_process',launches_child:false,result:{termination_confirmed:true}};
  const options={allowRecovery:true,requireControlledCommands:true,verifyRecovery:()=>true};
  const validation=pair('validated',validated);
  validation[1].payload.stop_reason='completed';
  assert.doesNotThrow(()=>assertChildCommands([...pair('rejected',rejected),...validation],options));
  assert.throws(()=>assertChildCommands(pair('rejected',rejected),options),/not followed by verified artifact validation/);
});

test('a rejected child self-handoff does not replace or block the parent handoff',()=>{
  const rows=[
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:'handoff',arguments:{cmd:'node scripts/project-action.mjs execute --controller-session=session-a --request=handoff.json'}}},
    {payload:{type:'tool_call_output',tool_call_id:'handoff',stop_reason:'fatal',output:JSON.stringify({status:'rejected',classification:'input_rejected',action:'handoff',error:'Stage handoff not ready: No unique returned child for this dispatch; wait for the tool return, do not guess or scan directories.',exit_code:2,recovery:{category:'handoff_correction',retry_allowed:true},action_receipt:'receipt'})}}
  ];
  assert.doesNotThrow(()=>assertChildCommands(rows,{allowRecovery:true,requireControlledCommands:true,verifyRecovery:()=>true}));
  assert.throws(()=>assertChildCommands(rows,{allowRecovery:true,requireControlledCommands:true,verifyRecovery:()=>false}));
});

test('read routing correction needs exact native read followed by same-stage verified validation',()=>{
  const workspace=resolve('synthetic-workspace'),runDirectory=resolve(workspace,'output/runs/run-a');
  const rejected={run_id:'run-a',task_key:'run-a:read_source:',status:'rejected',classification:'input_rejected',action:'read_source',error:'Source must be a run-relative inputs path',read_path:'execution/test_results.json',exit_code:2,recovery:{category:'read_correction',retry_allowed:true},action_receipt:'rejected'};
  const validated={status:'completed',exit_code:0,script:'validate-artifacts.mjs',task_key:'run-a:validate_artifacts:report',action_receipt:'validated',execution_mode:'in_process',launches_child:false};
  const command=(id,result)=>[
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:id,arguments:{cmd:'node scripts/project-action.mjs execute --request=request.json'}}},
    {payload:{type:'tool_call_output',tool_call_id:id,stop_reason:result.exit_code?'fatal':'completed',output:JSON.stringify(result)}}
  ];
  const read=(path='execution/test_results.json',stop='completed')=>[
    {payload:{type:'tool_call',name:'read_file',tool_call_id:'native-read',arguments:{file_path:resolve(runDirectory,path)}}},
    {payload:{type:'tool_call_output',tool_call_id:'native-read',stop_reason:stop,output:'synthetic file content'}}
  ];
  const options={allowRecovery:true,requireControlledCommands:true,verifyRecovery:()=>true,stageWriteBoundary:{stage:'report',workspace,runDirectory,actionRequestDirectory:resolve(workspace,'output/action-requests')}};
  const failed=command('rejected',rejected),success=command('validated',validated);
  assert.doesNotThrow(()=>assertChildCommands([...failed,...read(),...success],options));
  const malformed={payload:{type:'tool_call',name:'read_file',tool_call_id:'bad-native-read',arguments:'{invalid'}};
  assert.doesNotThrow(()=>assertChildCommands([...failed,malformed,...read(),...success],options));
  assert.throws(()=>assertChildCommands([...failed,malformed,...success],options));
  for(const rows of [
    [...failed,...success], [...failed,...read()], [...read(),...failed,...success],
    [...failed,...read('execution/other.json'),...success], [...failed,...read(undefined,'fatal'),...success],
    [...failed,...success,...read()],
    [...failed,...read(),...command('wrong-run',{...validated,task_key:'run-b:validate_artifacts:report'})],
    [...failed,...read(),...command('wrong-stage',{...validated,task_key:'run-a:validate_artifacts:execution'})],
    [...failed,...read(),...command('unverified',{...validated,action_receipt:'forged'})]
  ]) assert.throws(()=>assertChildCommands(rows,{...options,verifyRecovery:r=>r.action_receipt!=='forged'}));
  assert.throws(()=>assertChildCommands([...failed,...read(),...success],{...options,verifyRecovery:()=>false}));
  assert.throws(()=>assertChildCommands([...command('unknown',{...rejected,error:'Operation outcome unknown',recovery:null}),...read(),...success],options));
  const engineDirectory=resolve(workspace,'engine'),doc='docs/interactive-browser-tasks.md';
  const docsOptions={...options,stageWriteBoundary:{...options.stageWriteBoundary,engineDirectory}};
  const docsFailed=command('docs-rejected',{...rejected,read_path:doc});
  const docsRead=read();docsRead[0].payload.arguments.file_path=resolve(engineDirectory,doc);
  assert.doesNotThrow(()=>assertChildCommands([...docsFailed,...docsRead,...success],docsOptions));
  assert.throws(()=>assertChildCommands([...docsFailed,...read(),...success],docsOptions));
  assert.throws(()=>assertChildCommands([...docsFailed,...docsRead,...success],options));
});

test('closed partial browser delivery retains owned failures without accepting cancellation, unrelated failures or changed evidence',t=>{
  const root=mkdtempSync(resolve(tmpdir(),'qa-partial-handoff-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const runId='run-partial',parent='session-parent',child='session-child',dispatch='dispatch-one',closure=randomUUID(),failed=randomUUID();
  const dir=resolve(root,'output/runs',runId),write=(path,value)=>{mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(value));};
  const put=(path,value)=>write(resolve(dir,path),value),sha=path=>createHash('sha256').update(readFileSync(resolve(dir,path))).digest('hex');
  const manifest={run_id:runId,orchestration:{plan:{workflow_mode:'task'},events:[{type:'dispatched',stage:'execution',dispatch_id:dispatch,at:'2026-10-20T00:00:00Z'}]}};
  put('manifest.json',manifest);put('inputs/request.json',{scope:'synthetic'});
  put('execution/execution-task.json',{run_id:runId,stage:'execution',outcome:'partial',summary:'Not executed',questions:[],limitations:['Engineering failure'],source_paths:['inputs/request.json']});
  put('execution/test_results.json',{run_id:runId,invocation_id:'attempt',status:'partial',cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}});
  const observation={mode:'interactive_browser',run_id:runId,invocation_id:'attempt',dispatch_id:dispatch,status:'closed',partial:true,command_id:closure,source_path:'inputs/request.json',source_sha256:sha('inputs/request.json'),evidence:['inputs/request.json','execution/test_results.json'].map(path=>({path,sha256:sha(path)}))};
  put('execution/exploration.json',observation);
  put(`audit/commands/${closure}/command.json`,{run_id:runId,script:'browser-task.mjs',status:'completed',finished_at:'2026-10-20T00:10:00Z',result:{termination_confirmed:true}});
  put(`audit/commands/${closure}/command.log`,{status:'closed',exploration_sha256:sha('execution/exploration.json')});
  const command={run_id:runId,script:'browser-task.mjs',status:'failed',host_binding:{session_id:child,tool_call_id:'failed'},result:{code:1,termination_confirmed:true,termination:null}};
  put(`audit/commands/${failed}/command.json`,command);
  const path=resolve(root,'output/action-audit',parent,'failure.json');
  const saved={session_id:parent,host_binding:command.host_binding,run_id:runId,at:'2026-10-20T00:01:00Z',finished_at:'2026-10-20T00:02:00Z',action:'browser_task',status:'failed',exit_code:1,task_key:`${runId}:browser_task:`,classification:'script_failure',command_evidence:resolve(dir,`audit/commands/${failed}`)};
  write(path,saved);
  const result={status:'failed',exit_code:1,run_id:runId,task_key:saved.task_key,action_receipt:path,script:'browser-task.mjs',command_id:failed,evidence_dir:saved.command_evidence};
  const row={payload:{tool_call_id:'failed'}};
  const verify=()=>partialBrowserFailureVerifier(root,runId,parent,child,manifest);
  assert.equal(partialBrowserDelivery(root,runId,manifest).contract.execution_outcome.status,'blocked');
  assert.equal(verify()(result,row),true);
  for(const changed of [{...result,script:'other.mjs'},{...result,exit_code:0},{...result,evidence_dir:root},{...result,run_id:'run-other'}]) assert.equal(verify()(changed,row),false);
  assert.equal(verify()(result,{payload:{tool_call_id:'other'}}),false);
  put(`audit/commands/${failed}/command.json`,{...command,result:{...command.result,termination:'interrupted'}});assert.equal(verify()(result,row),false);
  put(`audit/commands/${failed}/command.json`,command);
  const timeoutCommand={...command,status:'timeout',result:{code:null,termination_confirmed:true,termination:'timeout'}};
  put(`audit/commands/${failed}/command.json`,timeoutCommand);
  write(path,{...saved,status:'timeout',exit_code:124});
  assert.equal(verify()({...result,status:'timeout',exit_code:124},row),true);
  put(`audit/commands/${failed}/command.json`,{...timeoutCommand,result:{...timeoutCommand.result,termination_confirmed:false}});
  assert.equal(verify()({...result,status:'timeout',exit_code:124},row),false);
  put(`audit/commands/${failed}/command.json`,command);
  const rejected={...saved,status:'rejected',exit_code:2,classification:'session_stopped',command_evidence:undefined};write(path,rejected);
  assert.equal(verify()({status:'rejected',exit_code:2,classification:'session_stopped',run_id:runId,task_key:saved.task_key,action_receipt:path},row),true);
  write(path,{...saved,finished_at:'2026-10-20T00:11:00Z'});assert.equal(verify()(result,row),false);
  write(path,saved);put('execution/exploration.json',{...observation,status:'ready'});assert.equal(verify()(result,row),false);
  put('execution/exploration.json',observation);put('execution/test_results.json',{status:'completed',cases:[]});assert.equal(verify()(result,row),false);
});

test('stage delivery enforces file ownership for write, edit and patch tools',()=>{
  const workspace=mkdtempSync(resolve(tmpdir(),'qa-stage-write-'));
  const runDirectory=resolve(workspace,'output/runs/run-a');
  const actionRequestDirectory=resolve(workspace,'output/action-requests');
  const options={stageWriteBoundary:{stage:'execution',workspace,runDirectory,actionRequestDirectory}};
  const call=(name,args,id=name)=>({payload:{type:'tool_call',name,tool_call_id:id,arguments:JSON.stringify(args)}});
  assert.doesNotThrow(()=>assertChildCommands([
    call('write_file',{file_path:'output/action-requests/explore.json',content:'{}'},'request'),
    call('write_file',{file_path:'output/runs/run-a/execution/execution-task.json',content:'{}'},'execution'),
    call('edit_file',{file_path:resolve(runDirectory,'environment/test-env.json'),old_string:'a',new_string:'b'},'environment')
  ],options));
  assert.throws(()=>assertChildCommands([call('write_file',{file_path:'output/runs/run-a/generate-artifacts.py',content:'pass'})],options),/stage ownership/);
  assert.throws(()=>assertChildCommands([call('write_file',{file_path:'output/runs/run-a/design/test_cases.json',content:'[]'})],options),/stage ownership/);
  assert.throws(()=>assertChildCommands([call('edit_file',{file_path:'output/runs/run-a/report/test_report.md',old_string:'a',new_string:'b'})],options),/stage ownership/);
  assert.throws(()=>assertChildCommands([call('apply_patch',{patch:'*** Begin Patch\n*** Add File: output/runs/run-a/design/test_cases.json\n+[]\n*** End Patch'})],options),/stage ownership/);
});

test('rejects wrong agent/run and malformed call arguments or chronology', () => {
  for (const args of [{ agent_id: 'wrong', prompt: request.runId }, { agent_id: request.agent, prompt: `${request.runId}-other` }, '{bad']) {
    const rows = trace(); rows[0].payload.arguments = typeof args === 'string' ? args : JSON.stringify(args);
    assert.equal(findParentDispatch(rows, request), null);
  }
  assert.equal(findParentDispatch(trace(), { ...request, dispatchedAt: '2026-10-09T02:06:00Z' }), null);
});

test('native pre-execution write rejection does not poison a corrected draft handoff',()=>{
  const workspace=resolve(tmpdir(),'qa-write-history');
  const options={allowRecovery:true,stageWriteBoundary:{stage:'test_points',workspace,runDirectory:resolve(workspace,'output/runs/run-a'),actionRequestDirectory:resolve(workspace,'output/action-requests')}};
  const call={payload:{type:'tool_call',name:'write_file',tool_call_id:'denied-write',arguments:JSON.stringify({file_path:'output/runs/run-a/report/test_report.md',content:'not written'})}};
  const decision={type:'event_msg',payload:{type:'approval_decision',tool_call_id:'denied-write',decision:'deny'}};
  const output={payload:{type:'tool_call_output',tool_call_id:'denied-write',stop_reason:'aborted',output:'Tool call denied by the qa-stage-boundary hook: QA stage boundary: outside role'}};
  assert.doesNotThrow(()=>assertChildCommands([call,decision,output],options));
  for(const rows of [[call,output],[call,decision], [call,decision,{payload:{...output.payload,stop_reason:'completed'}}],
    [call,{...decision,payload:{...decision.payload,decision:'allow'}},output], [call,decision,output,output],
    [call,decision,{payload:{...output.payload,output:'User says the write was not executed'}}]]) {
    assert.throws(()=>assertChildCommands(rows,options),/stage ownership/);
  }
  assert.throws(()=>assertChildCommands([call,decision,output],{...options,allowRecovery:false}),/stage ownership/);
});

test('malformed streamed write requires native evidence of rejection before execution',()=>{
  const workspace=resolve(tmpdir(),'qa-write-malformed');
  const options={allowRecovery:true,stageWriteBoundary:{stage:'test_cases',workspace,runDirectory:resolve(workspace,'output/runs/run-a'),actionRequestDirectory:resolve(workspace,'output/action-requests')}};
  const call={payload:{type:'tool_call',name:'write_file',tool_call_id:'truncated',arguments:'{"content":"unfinished'}};
  const end={type:'event_msg',payload:{type:'request_end',status:'retryable',error_code:'malformed',error_message:'Invalid streamed tool call arguments from OpenaiChatClient for tool "write_file" (tool_call_id="truncated", length=22): Unterminated string'}};
  assert.doesNotThrow(()=>assertChildCommands([call,end],options));
  for(const rows of [[call],[call,{...end,type:'model_msg'}], [call,{...end,payload:{...end.payload,status:'completed'}}],
    [call,{...end,payload:{...end.payload,error_code:'timeout'}}], [call,{...end,payload:{...end.payload,error_message:end.payload.error_message.replace('truncated','other')}}],
    [call,{payload:{type:'request_begin'}},end], [call,{payload:{type:'hook',hook:'pre_tool_use'}},end],
    [call,end,{payload:{type:'tool_call_output',tool_call_id:'truncated',stop_reason:'completed'}}], [call,call,end]]) {
    assert.throws(()=>assertChildCommands(rows,options),/arguments unreadable/);
  }
  assert.throws(()=>assertChildCommands([call,end],{...options,allowRecovery:false}),/arguments unreadable/);
});

test('malformed streamed command is not execution failure, but missing output alone never excuses a command',()=>{
  const call={type:'model_msg',payload:{type:'tool_call',name:'exec_command',tool_call_id:'truncated',arguments:'{"cmd":"unfinished',stop_reason:'retryable'}};
  const end={type:'event_msg',payload:{type:'request_end',status:'retryable',error_code:'malformed',error_message:'Invalid streamed tool call arguments from OpenaiChatClient for tool "exec_command" (tool_call_id="truncated", length=18): Unterminated string'}};
  const options={allowRecovery:true,requireControlledCommands:true};
  assert.doesNotThrow(()=>assertChildCommands([call,end],options));
  for(const rows of [[call],[call,{...end,payload:{...end.payload,error_code:'timeout'}}],[call,{...end,payload:{...end.payload,error_message:end.payload.error_message.replace('truncated','wrong')}}],
    [call,{payload:{type:'hook',hook:'pre_tool_use'}},end],[call,end,{payload:{type:'tool_call_output',tool_call_id:'truncated',stop_reason:'completed'}}],[call,call,end]]) assert.throws(()=>assertChildCommands(rows,options));
  assert.throws(()=>assertChildCommands([call,end],{...options,allowRecovery:false}));
  assert.throws(()=>assertChildCommands([{...call,payload:{...call.payload,arguments:'{"cmd":"node scripts/project-action.mjs catalog"}'}},end],options),/unknown terminal/);
});

test('draft reconciliation uses current owned child rather than historic error text, never execution or human rejection',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'qa-malformed-delivery-')),agentRoot=resolve(root,'agents');
  const runId=request.runId,parentId='session-2026-10-09-10-00-00-abcd',stage='test_cases',agent='test_case_agent';
  const dispatch={type:'dispatched',stage,agent,at:request.dispatchedAt,dispatch_id:'dispatch-1','parent-session-id':parentId,child_command_policy:'policy-1'};
  const manifest={stages:{[stage]:{status:'blocked'}},orchestration:{events:[dispatch,{type:'blocked',stage,at:'2026-10-09T02:07:00Z','dispatch-id':dispatch.dispatch_id}]}};
  const dir=resolve(root,'output/runs',runId);mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest));
  const parent=trace();parent[0].payload.arguments={agent_id:agent,prompt:`${runId} dispatch-1 policy-1`};
  const call={type:'model_msg',payload:{type:'tool_call',name:'exec_command',tool_call_id:'truncated',arguments:'{"cmd":"unfinished',stop_reason:'retryable'}};
  const end={type:'event_msg',payload:{type:'request_end',status:'retryable',error_code:'malformed',error_message:'Invalid streamed tool call arguments from OpenaiChatClient for tool "exec_command" (tool_call_id="truncated", length=18): Unterminated string'}};
  const write=(role,id,rows)=>{const d=resolve(agentRoot,role,'traces/2026-10-09');mkdirSync(d,{recursive:true});writeFileSync(resolve(d,`${id}_001.jsonl`),rows.map(JSON.stringify).join('\n'));};
  const meta=(role,id,source)=>({type:'session_meta',payload:{session_id:id,agent_state:resolve(agentRoot,role,'agent_state'),workspace:root,source}});
  write(agent,request.childId,[meta(agent,request.childId,'subagent'),call,end]);
  const base=resolve(root,'output/action-audit',parentId);mkdirSync(base,{recursive:true});const path=resolve(base,`${randomUUID()}.json`);
  const receipt={action:'handoff',status:'rejected',exit_code:2,classification:'input_rejected',run_id:runId,session_id:parentId,at:'2026-10-09T02:06:00Z',task_key:`${runId}:handoff:${stage}`,error:'Stage handoff not ready: Child command arguments unreadable.',host_binding:{session_id:parentId,tool_call_id:'handoff'},recovery:null};
  writeFileSync(path,JSON.stringify(receipt));
  parent.push({payload:{type:'tool_call',name:'exec_command',tool_call_id:'handoff'}},{payload:{type:'tool_call_output',tool_call_id:'handoff',output:JSON.stringify({...receipt,action_receipt:path})}});
  write('test_agent',parentId,[meta('test_agent',parentId),...parent]);
  assert.deepEqual(draftHandoffReconciliation(root,runId,manifest,stage,parentId,agentRoot).unexecuted_tool_calls,['truncated']);
  assert.throws(()=>draftHandoffReconciliation(root,runId,manifest,'execution',parentId,agentRoot));
  assert.throws(()=>draftHandoffReconciliation(root,runId,{...manifest,confirmations:[{status:'rejected'}]},stage,parentId,agentRoot));
  writeFileSync(path,JSON.stringify({...receipt,task_key:`${runId}:handoff:report`}));
  assert.equal(draftHandoffReconciliation(root,runId,manifest,stage,parentId,agentRoot).kind,'current_dispatch_revalidation');
  writeFileSync(path,JSON.stringify(receipt));write(agent,request.childId,[meta(agent,request.childId,'subagent'),call]);
  assert.deepEqual(draftHandoffReconciliation(root,runId,manifest,stage,parentId,agentRoot).unexecuted_tool_calls,[]);
  // Eligibility never excuses an unresolved command in the subsequent full evidence check.
  assert.throws(()=>assertChildCommands([call],{allowRecovery:true}),/unreadable/);
});

test('historical writes enforce registered reading copies, rename destinations and controlled evidence',()=>{
  const workspace=resolve(tmpdir(),'qa-history-boundary');
  const boundary={workspace,runDirectory:resolve(workspace,'output/runs/run-a'),actionRequestDirectory:resolve(workspace,'output/action-requests')};
  const call=(name,args)=>({payload:{type:'tool_call',name,tool_call_id:'write',arguments:args}});
  assert.doesNotThrow(()=>assertChildCommands([call('write_file',{file_path:'output/runs/run-a/design/test_points.md'})],{stageWriteBoundary:{...boundary,stage:'test_points'}}));
  const patch='*** Begin Patch\n*** Update File: output/runs/run-a/design/test_points.md\n*** Move to: output/runs/run-a/report/test_report.md\n@@\n-old\n+new\n*** End Patch';
  assert.throws(()=>assertChildCommands([call('apply_patch',{patch})],{stageWriteBoundary:{...boundary,stage:'test_points'}}),/stage ownership/);
  assert.throws(()=>assertChildCommands([call('write_file',{file_path:'output/runs/run-a/execution/test_results.json'})],{stageWriteBoundary:{...boundary,stage:'execution'}}),/controlled execution evidence/);
});

test('does not guess among overlapping calls, but supports completed sequential calls', () => {
  const rows = trace();
  const other = structuredClone(rows[0]); other.payload.tool_call_id = 'call-b';
  rows.splice(1, 0, other);
  assert.equal(findParentDispatch(rows, request), null);
  const first = trace();
  first[0].payload.tool_call_id = first[2].payload.tool_call_id = 'old';
  first[1].payload.session_id = 'old-session';
  first.forEach(row => { row.timestamp = '2026-10-09T02:00:00Z'; });
  assert.equal(findParentDispatch([...first, ...trace()], request)?.tool_call_id, 'call-a');
});

test('dispatch requires exact stop policy in the actual parent prompt', () => {
  const rows = trace(); const policy = childCommandPolicy('synthetic-token');
  assert.equal(findParentDispatch(rows, { ...request, commandPolicy: policy }), null);
  rows[0].payload.arguments = JSON.stringify({ agent_id: request.agent, prompt: `${request.runId}\n${policy}` });
  assert.ok(findParentDispatch(rows, { ...request, commandPolicy: policy }));
  assert.equal(findParentDispatch(rows, { ...request, commandPolicy: childCommandPolicy('other-token') }), null);
});

test('failed, rejected, unknown and timed-out child commands cannot be hidden by later success', () => {
  const pair = (id, output) => [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: id, arguments: JSON.stringify({ cmd: 'node scripts/project-command.mjs run node validate-artifacts.mjs -- run-synthetic analysis' }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output, stop_reason: 'completed' } }
  ];
  const success = JSON.stringify({ status: 'completed', exit_code: 0, result: { termination_confirmed: true } });
  assert.doesNotThrow(() => assertChildCommands(pair('ok', `/etc/profile warning\n${success}`)));
  for (const status of ['failed', 'input_rejected', 'timeout', 'interrupted', 'cleanup_required', 'runner_error']) {
    assert.throws(() => assertChildCommands([...pair('bad', JSON.stringify({ status, exit_code: 2 })), ...pair('ok', success)]));
  }
  assert.throws(() => assertChildCommands(pair('bad', 'unparseable')));
  assert.throws(() => assertChildCommands(pair('bad', success).slice(0, 1)));
  assert.throws(() => assertChildCommands(pair('bad', JSON.stringify({ status: 'completed', exit_code: 0 }))));
});

test('reading controlled entry source is not treated as an action receipt', () => {
  const rows = [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: 'read', arguments: JSON.stringify({ cmd: "Get-Content 'E:\\Codex\\AITestWorker\\scripts\\project-action.mjs' -TotalCount 320" }) } },
    { payload: { type: 'tool_call_output', tool_call_id: 'read', output: 'export function run() {}', stop_reason: 'completed' } }
  ];
  assert.doesNotThrow(() => assertChildCommands(rows));
  const search = [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: 'search', arguments: JSON.stringify({ cmd: "Select-String -Path 'E:\\Codex\\AITestWorker\\scripts\\validate-artifacts.mjs' -Pattern 'test_cases'" }) } },
    { payload: { type: 'tool_call_output', tool_call_id: 'search', output: 'test_cases', stop_reason: 'completed' } }
  ];
  assert.doesNotThrow(() => assertChildCommands(search, { requireControlledCommands: true }));
});

test('a failed read-only directory inspection can be corrected without hiding command failures', () => {
  const pair = (id, cmd, stop_reason) => [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: id, arguments: JSON.stringify({ cmd }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output: stop_reason === 'fatal' ? 'Get-ChildItem: invalid /s' : 'analysis', stop_reason } }
  ];
  const failed = pair('bad', 'dir "E:\\QAWorkspaces\\run" /b /s', 'fatal');
  const corrected = pair('good', 'Get-ChildItem -Recurse "E:\\QAWorkspaces\\run" | Select-Object -ExpandProperty FullName', 'completed');
  assert.doesNotThrow(() => assertChildCommands([...failed, ...corrected], { allowRecovery: true }));
  assert.doesNotThrow(() => assertChildCommands([
    ...pair('shell-mismatch', 'Get-ChildItem -Recurse "E:\\QAWorkspaces\\run" | Select-Object FullName', 'fatal'),
    ...pair('posix-correction', 'find "E:/QAWorkspaces/run" -type f | head -100', 'completed')
  ], { allowRecovery: true }));
  assert.doesNotThrow(() => assertChildCommands([
    ...pair('shell-mismatch', 'Get-ChildItem -Recurse -Name "E:\\QAWorkspaces\\run" | Select-Object -First 60', 'fatal'),
    ...pair('posix-correction', 'find "E:/QAWorkspaces/run" -maxdepth 3 -type f | head -60', 'completed')
  ], { allowRecovery: true }));
  assert.doesNotThrow(() => assertChildCommands([
    ...pair('shell-mismatch', 'Get-ChildItem -Path "E:\\QAWorkspaces\\run" -Recurse | Select-Object FullName, Length | Format-Table -AutoSize', 'fatal'),
    ...pair('posix-correction', 'find "E:/QAWorkspaces/run" -maxdepth 4 -type f | sort', 'completed')
  ], { allowRecovery: true }));
  assert.throws(() => assertChildCommands([
    ...pair('shell-mismatch', 'Get-ChildItem -Recurse "E:\\QAWorkspaces\\run" | Select-Object FullName', 'fatal'),
    ...pair('unsafe-correction', 'find "E:/QAWorkspaces/run" -exec rm {} \\;', 'completed')
  ], { allowRecovery: true }), /not corrected/);
  assert.doesNotThrow(() => assertChildCommands([
    ...pair('read-bad', 'Get-Content "E:\\QAWorkspaces\\run\\input.md"', 'fatal'),
    ...pair('read-good', 'Get-Content "E:\\QAWorkspaces\\run\\input.md" | Select-Object -First 5', 'completed')
  ], { allowRecovery: true }));
  assert.throws(() => assertChildCommands(failed, { allowRecovery: true }), /not corrected/);
  assert.throws(() => assertChildCommands([...failed, ...pair('different', 'Get-ChildItem "E:\\QAWorkspaces\\other"', 'completed')], { allowRecovery: true }), /not corrected/);
  assert.throws(() => assertChildCommands([...failed, ...corrected]));
  assert.throws(() => assertChildCommands([...pair('bad', 'node destructive-script.mjs', 'fatal'), ...corrected], { allowRecovery: true }));
  assert.throws(() => assertChildCommands([...pair('bad', 'dir x; Remove-Item x', 'fatal'), ...corrected], { allowRecovery: true }));
});

test('missing shell inspection tools require a verified later artifact validation', () => {
  const pair = (id, cmd, output, stop_reason) => [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: id, arguments: JSON.stringify({ cmd }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output, stop_reason } }
  ];
  const failed = [
    ...pair('directory', "Get-ChildItem -Path 'E:\\QAWorkspaces\\run' -Recurse | Select-Object FullName,Length", '/usr/bin/sh: Get-ChildItem: command not found', 'fatal'),
    ...pair('header', 'xxd -l 8 E:/QAWorkspaces/run/report/test_report.docx; xxd -l 8 E:/QAWorkspaces/run/report/test_report.pdf', '/usr/bin/sh: xxd: command not found', 'fatal')
  ];
  const result = { status: 'completed', exit_code: 0, script: 'validate-artifacts.mjs', task_key: 'run-a:validate_artifacts:report', action_receipt: 'receipt', execution_mode: 'in_process', launches_child: false, result: { termination_confirmed: true } };
  const validation = pair('validated', 'node scripts/project-action.mjs execute --controller-session=session-a --request=request.json', JSON.stringify(result), 'completed');
  assert.doesNotThrow(() => assertChildCommands([...failed, ...validation], { allowRecovery: true, verifyRecovery: () => true }));
  assert.throws(() => assertChildCommands(failed, { allowRecovery: true }), /not followed by verified artifact validation/);
  assert.throws(() => assertChildCommands([...failed, ...validation], { allowRecovery: true, verifyRecovery: () => false }), /not followed by verified artifact validation/);
  assert.throws(() => assertChildCommands([...pair('unsafe', 'xxd -l 8 E:/x; rm E:/x', 'xxd: command not found', 'fatal'), ...validation], { allowRecovery: true, verifyRecovery: () => true }), /Child command failed/);
  const header = "python - <<'PY'\nfrom pathlib import Path\nfor name in ['test_report.docx','test_report.pdf']:\n    p = Path('E:/QAWorkspaces/run/report')/name\n    data = p.read_bytes()[:8]\n    print(name, data.hex())\nPY";
  assert.doesNotThrow(() => assertChildCommands([...validation, ...failed, ...pair('header-ok', header, 'test_report.docx 504b030414000000\ntest_report.pdf 255044462d312e34', 'completed')], { allowRecovery: true, verifyRecovery: () => true }));
  assert.throws(() => assertChildCommands([...validation, ...failed, ...pair('header-bad', header, 'test_report.docx bad\ntest_report.pdf bad', 'completed')], { allowRecovery: true, verifyRecovery: () => true }), /not followed by verified artifact validation/);
});

test('a missing catalog entry path is resolved only by a later successful catalog', () => {
  const pair = (id, cmd, output, stop_reason) => [
    { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: id, arguments: JSON.stringify({ cmd }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output, stop_reason } }
  ];
  const missing = "Error: Cannot find module 'E:\\run\\scripts\\project-action.mjs'\n    at Function.executeUserEntryPoint\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []";
  const bad = pair('bad', 'node "E:/run/scripts/project-action.mjs" catalog', missing, 'fatal');
  const good = pair('good', 'node "E:/engine/scripts/project-action.mjs" catalog', JSON.stringify({ status: 'help' }), 'completed');
  assert.doesNotThrow(() => assertChildCommands([...bad, ...good], { allowRecovery: true }));
  assert.throws(() => assertChildCommands(bad, { allowRecovery: true }), /not corrected/);
  assert.throws(() => assertChildCommands([...bad, ...pair('wrong', 'node "E:/engine/scripts/project-action.mjs" execute', JSON.stringify({ status: 'help' }), 'completed')], { allowRecovery: true }), /not corrected/);
  assert.throws(() => assertChildCommands(pair('bad', 'node "E:/run/scripts/project-action.mjs" execute', missing, 'fatal'), { allowRecovery: true }));
  assert.throws(() => assertChildCommands(pair('bad', 'node "E:/run/scripts/project-action.mjs" catalog', missing.replace('requireStack: []', "requireStack: ['dependency']"), 'fatal'), { allowRecovery: true }));
});

test('long controlled command requires a matching terminal process poll', () => {
  const command = { payload: { type: 'tool_call', name: 'exec_command', tool_call_id: 'launch', arguments: JSON.stringify({ cmd: 'node scripts/project-action.mjs execute' }) } };
  const started = { payload: { type: 'tool_call_output', tool_call_id: 'launch', output: '[process running with process_id proc-a1; use input_command to send input or poll for output]', stop_reason: 'completed' } };
  const poll = (id, output, stop_reason = 'completed') => [
    { payload: { type: 'tool_call', name: 'input_command', tool_call_id: id, arguments: JSON.stringify({ process_id: 'proc-a1' }) } },
    { payload: { type: 'tool_call_output', tool_call_id: id, output, stop_reason } }
  ];
  const waiting = poll('wait', '[process still running with process_id proc-a1]');
  const finished = poll('finish', JSON.stringify({ status: 'completed', exit_code: 0, result: { termination_confirmed: true } }));
  assert.doesNotThrow(() => assertChildCommands([command, started, ...waiting, ...finished]));
  assert.throws(() => assertChildCommands([command, started, ...waiting]), /no terminal response/);
  assert.throws(() => assertChildCommands([command, started, ...poll('wrong', '[process still running with process_id proc-other]')]), /failed|unreadable/);
  assert.throws(() => assertChildCommands([command, started, ...poll('failed', 'process failed', 'fatal')]), /unreadable|failed/);
});
