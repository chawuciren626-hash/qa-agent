import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, symlinkSync, renameSync } from 'node:fs';
import { readControllerSession } from '../../scripts/controller-command-session.mjs';
import { resolve } from 'node:path';
import { executeAction, actionCommand } from '../../scripts/structured-actions.mjs';
import { inspectIndependentArtifacts, taskResultPath } from '../../scripts/independent-task.mjs';
import { assertCompletedArtifacts } from '../../scripts/artifact-contracts.mjs';
import { inspectHandoff, reconcileHandoff } from '../../scripts/controller-handoff.mjs';
import { createServer } from 'node:http';
import { validateExplorationTarget } from '../../scripts/explore-task-url.mjs';
const root=resolve(import.meta.dirname,'../..');
const roles={analysis:['requirement_analysis_agent','requirement-analysis'],test_points:['test_point_agent','test-point-design'],test_cases:['test_case_agent','test-case-writing'],execution:['automation_execution_agent','playwright-execution'],defects:['defect_analysis_agent','bug-reporting'],report:['test_report_agent','test-report-writing']};

test('URL sources accept archived extensionless text but reject binary, traversal and absent URLs',()=>{
  const url='http://127.0.0.1:4317/healthy?scope=acceptance';
  for(const name of ['user-request','exploration-url','request.txt','request.md','request.json']) {
    assert.equal(validateExplorationTarget(url,`inputs/${name}`,`Visit ${url}`).href,url);
  }
  for(const name of ['../request.txt','sub/request.txt','request.docx','request.pdf','request.exe']) {
    assert.throws(()=>validateExplorationTarget(url,`inputs/${name}`,url),/archived/);
  }
  assert.throws(()=>validateExplorationTarget(url,'inputs/request',`PK\u0000${url}`),/UTF-8/);
  assert.throws(()=>validateExplorationTarget(url,'inputs/request','No target here'),/not present/);
});

async function fixture(stage,{source_mode,requested=[stage]}={}) {
  const parent=`session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',randomUUID());
  const traces=resolve(agentRoot,'test_agent/traces/2026-10-13');mkdirSync(traces,{recursive:true});
  const parentFile=resolve(traces,`${parent}_001.jsonl`);
  writeFileSync(parentFile,JSON.stringify({type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}));
  const call=r=>executeAction(root,parent,()=>JSON.stringify(r),{agentRoot});
  const created=await call({action:'create_run'});assert.equal(created.exit_code,0);
  const id=created.run_id,dir=resolve(root,'output/runs',id);
  const send=r=>call({run_id:id,...r});
  assert.equal((await send({action:'archive_input',name:'request.txt',text:'Generate only this professional deliverable. Expected: empty phone is rejected. No product tests were executed.'})).exit_code,0);
  const planned=await send({action:'plan_run',stages:requested,...(source_mode?{source_mode}:{})});assert.equal(planned.exit_code,0,JSON.stringify(planned));
  const exactRequest='Generate exactly 3 items; no product execution.';
  writeFileSync(parentFile,readFileSync(parentFile,'utf8')+'\n'+JSON.stringify({type:'model_msg',timestamp:'2026-10-13T00:00:01.000Z',payload:{type:'text',role:'user',text:exactRequest}})+'\n'+JSON.stringify({type:'model_msg',timestamp:'2026-10-13T00:00:02.000Z',payload:{type:'text',role:'user',sender:'harness',text:'Internal notice, not a user request'}}));
  const manifest=()=>JSON.parse(readFileSync(resolve(dir,'manifest.json')));
  assert.equal(manifest().orchestration.plan.workflow_mode,'task');
  assert.deepEqual(manifest().orchestration.plan.stages.filter(s=>s.selected).map(s=>s.id),source_mode==='live_product'?['execution',...requested.filter(s=>s!=='execution')]:requested);
  const dispatched=await send({action:'dispatch',stage,agent:roles[stage][0],skills:[roles[stage][1]]});assert.equal(dispatched.exit_code,0,JSON.stringify(dispatched));
  assert.ok(dispatched.delegation.prompt.includes('INDEPENDENT TASK CONTRACT'));
  const contract=readFileSync(dispatched.delegation_contract_path,'utf8');
  assert.deepEqual(dispatched.skill_files,[{skill:roles[stage][1],read_file_path:resolve(root,'skills',roles[stage][1],'SKILL.md')}]);
  assert.ok(contract.includes(JSON.stringify(dispatched.skill_files)));
  if(stage==='report') {
    assert.match(contract,/tool-generated evidence index/);
    const index=JSON.parse(readFileSync(dispatched.delegation_contract_path.replace('.prompt.txt','.evidence.json'),'utf8'));
    assert.ok(index.files.some(f=>f.path==='inputs/request.txt'));
  }
  assert.ok(contract.includes(JSON.stringify(exactRequest)));
  assert.ok(!contract.includes('Internal notice, not a user request'));
  assert.ok(contract.includes(`Your complete assignment is ONLY stage=${stage}`));
  assert.match(contract,/do not run mkdir/);
  assert.match(contract,/Never repair a wrong location with mv, cp/);
  assert.ok(contract.includes(`--request=output/action-requests/${dispatched.data.event.dispatch_id}.json`));
  assert.match(contract,/Never pass bare Windows backslash paths/);
  const put=(p,v)=>writeFileSync(resolve(dir,p),typeof v==='string'?v:JSON.stringify(v));
  put(taskResultPath(stage),{run_id:id,stage,outcome:'completed',summary:'Synthetic independent delivery',source_paths:['inputs/request.txt'],questions:[],limitations:['No product execution in this engineering fixture']});
  return {id,dir,parent,agentRoot,parentFile,send,dispatched,put,manifest};
}
test('independent data diagnosis measures Unicode and rejects declared bad data without predecessors or writes',async()=>{
  const f=await fixture('test_cases');
  const row={case_id:'TC-DATA',title:'Boundary',priority:'P1',preconditions:[],steps:['Enter sample'],expected:'Source-defined result',test_data:{title:'\u{1F600}e\u0301',empty:'',gross:100,discount:20,total:79},design_contract:{data_checks:[
    {kind:'length',key:'title',unit:'code_points',expected:51},
    {kind:'minor_unit_sum',currency:'CNY',terms:[{key:'gross',sign:1},{key:'discount',sign:-1}],total_key:'total'}
  ]}};
  f.put('design/test_cases.json',[row]);
  const before=readFileSync(resolve(f.dir,'manifest.json'));
  const bytes=readFileSync(resolve(f.dir,'design/test_cases.json'));
  const result=await f.send({action:'diagnose_test_cases'});
  assert.equal(result.exit_code,0);assert.equal(result.result.status,'blocked');
  assert.match(result.result.errors.join('\n'),/expected length 51, actual 3/);
  assert.match(result.result.errors.join('\n'),/calculated 80, declared 79/);
  assert.deepEqual(result.result.data_diagnostics[0].measurements,[
    {key:'title',code_points:3,utf16:4,utf8_bytes:7,graphemes:2},
    {key:'empty',code_points:0,utf16:0,utf8_bytes:0,graphemes:0}
  ]);
  assert.ok(!JSON.stringify(result.result.data_diagnostics).includes(row.test_data.title));
  assert.equal(result.result.data_diagnostics[0].semantic_review.blocking,false);
  assert.match(result.result.data_diagnostics[0].data_usage.find(x=>x.key==='empty').preparation_check,/empty value explicitly/);
  assert.deepEqual(readFileSync(resolve(f.dir,'manifest.json')),before);
  assert.deepEqual(readFileSync(resolve(f.dir,'design/test_cases.json')),bytes);
  assert.equal(existsSync(resolve(f.dir,'design/test_cases.xlsx')),false);
  assert.equal(existsSync(resolve(f.dir,'design/test_points.json')),false);
  row.test_data.title='a'.repeat(51);row.test_data.total=80;f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
  row.design_contract.data_checks[0].unit='unknown';f.put('design/test_cases.json',[row]);
  assert.match((await f.send({action:'diagnose_test_cases'})).result.errors.join('\n'),/Explicit length unit/);
  delete row.design_contract;f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
});

test('independent optional point references need actual sources and data references need existing keys',async()=>{
  const f=await fixture('test_cases');
  const row={case_id:'TC-REF',title:'Input',priority:'P1',preconditions:[],steps:['Enter test_data.title'],test_data:{title:''},expected:'Rejected'};
  f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
  row.steps=['Enter test_data.missing'];row.related_test_point='TP-1';f.put('design/test_cases.json',[row]);
  let result=(await f.send({action:'diagnose_test_cases'})).result;
  assert.match(result.errors.join('\n'),/missing test_data.missing/);
  assert.match(result.errors.join('\n'),/Remove this optional reference/);
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  assert.equal(existsSync(resolve(f.dir,'design/test_points.json')),false);
  row.steps=['Enter test_data.title'];
  await f.send({action:'archive_input',name:'points.json',text:JSON.stringify({points:[{id:'TP-1',description:'Empty input is rejected'}]})});
  f.put(taskResultPath('test_cases'),{run_id:f.id,stage:'test_cases',outcome:'completed',summary:'Reference test',source_paths:['inputs/request.txt','inputs/points.json'],questions:[],limitations:[]});
  f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
  row.related_test_point='TP';f.put('design/test_cases.json',[row]);
  assert.match((await f.send({action:'diagnose_test_cases'})).result.errors.join('\n'),/no supplied source/);
  await f.send({action:'archive_input',name:'points.md',text:'TP-1: Empty input is rejected'});
  f.put(taskResultPath('test_cases'),{run_id:f.id,stage:'test_cases',outcome:'completed',summary:'Reference test',source_paths:['inputs/points.md'],questions:[],limitations:[]});
  assert.match((await f.send({action:'diagnose_test_cases'})).result.errors.join('\n'),/no supplied source/);
  row.related_test_point='TP-1';f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
  delete row.related_test_point;row.steps=['Enter a supplied literal'];f.put('design/test_cases.json',[row]);
  assert.equal((await f.send({action:'diagnose_test_cases'})).result.status,'passed');
});

test('live product task routes observations first without adding lifecycle stages or approvals',async()=>{
  const f=await fixture('execution',{source_mode:'live_product',requested:['test_cases','report']});
  const plan=f.manifest().orchestration.plan;
  assert.equal(plan.source_mode,'live_product');
  assert.deepEqual(plan.stages.find(s=>s.id==='test_cases').depends_on,['execution']);
  assert.deepEqual(plan.stages.find(s=>s.id==='report').depends_on,['execution']);
  assert.equal(plan.stages.find(s=>s.id==='analysis').selected,false);
  assert.equal(plan.stages.find(s=>s.id==='test_points').selected,false);
  assert.equal(plan.stages.find(s=>s.id==='execution').confirmation,'none');
  const tooEarly=await f.send({action:'dispatch',stage:'test_cases',agent:'test_case_agent',skills:['test-case-writing']});
  assert.equal(tooEarly.classification,'input_rejected');
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  const independent=await fixture('test_cases');
  assert.deepEqual(independent.manifest().orchestration.plan.stages.find(s=>s.id==='test_cases').depends_on,[]);
});

test('live product planning and execution dispatch require archived current input without stopping the controller',async()=>{
  const parent=`session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`,agentRoot=resolve(root,'output/acceptance',randomUUID());
  const traces=resolve(agentRoot,'test_agent/traces/2026-10-13');mkdirSync(traces,{recursive:true});
  writeFileSync(resolve(traces,`${parent}_001.jsonl`),JSON.stringify({type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}));
  const call=request=>executeAction(root,parent,()=>JSON.stringify(request),{agentRoot});
  const created=await call({action:'create_run'}),run_id=created.run_id;
  const missing=await call({action:'plan_run',run_id,stages:['test_cases'],workflow_mode:'task',source_mode:'live_product'});
  assert.equal(missing.classification,'input_rejected');assert.equal(readControllerSession(root,parent).status,'ready');
  await call({action:'archive_input',run_id,name:'request.txt',text:'Read-only explore http://127.0.0.1:4317/healthy?scope=source-order'});
  const planned=await call({action:'plan_run',run_id,stages:['test_cases'],workflow_mode:'task',source_mode:'live_product'});assert.equal(planned.exit_code,0,JSON.stringify(planned));
  const dispatched=await call({action:'dispatch',run_id,stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution']});
  assert.equal(dispatched.exit_code,0,JSON.stringify(dispatched));assert.deepEqual(dispatched.source_paths,['inputs/request.txt']);
});

test('stage diagnostic aliases honor the saved independent contract and require no lifecycle predecessors',async()=>{
  for(const stage of ['analysis','test_points','test_cases']) {
    const f=await fixture(stage);
    if(stage==='analysis') f.put('analysis/requirement_analysis.md','# Supplied requirements');
    if(stage==='test_points') f.put('design/test_points.json',[{id:'TP-1',module:'Input',feature:'Validation',description:'Empty phone is rejected'}]);
    if(stage==='test_cases') f.put('design/test_cases.json',[{case_id:'TC-1',title:'Empty input',module:'Input',priority:'P1',preconditions:[],steps:['Submit empty phone'],test_data:{phone:''},expected:'Rejected'}]);
    const before=readFileSync(resolve(f.dir,'manifest.json'));
    const direct=await f.send({action:'diagnose_task',stage});
    const alias=await f.send({action:`diagnose_${stage}`});
    assert.equal(alias.exit_code,0,JSON.stringify(alias));
    assert.equal(alias.result.status,'passed',JSON.stringify(alias));
    assert.deepEqual(alias.result,direct.result);
    assert.deepEqual(readFileSync(resolve(f.dir,'manifest.json')),before);
    assert.equal(existsSync(resolve(f.dir,'analysis/requirement-ledger.json')),false);
  }
});

test('stop hook resumes registered but unlaunched children without replaying native calls',async()=>{
  const f=await fixture('test_cases');
  assert.equal(f.dispatched.child_started,false);
  assert.equal(f.dispatched.next_action,'run_subagent');
  const before=readFileSync(resolve(f.dir,'manifest.json'));
  const reminder=await reconcileHandoff(root,f.parent,f.agentRoot);
  assert.equal(reminder.decision,'continue',JSON.stringify(reminder));
  assert.ok(reminder.input.includes(JSON.stringify(f.dispatched.delegation)));
  assert.deepEqual(readFileSync(resolve(f.dir,'manifest.json')),before);
  const row={type:'model_msg',timestamp:new Date().toISOString(),payload:{type:'tool_call',name:'run_subagent',tool_call_id:'native-pending',arguments:f.dispatched.delegation}};
  writeFileSync(f.parentFile,readFileSync(f.parentFile,'utf8')+'\n'+JSON.stringify(row));
  assert.deepEqual(await reconcileHandoff(root,f.parent,f.agentRoot),{});
});

test('unlaunched reminder is bounded and a denied native call does not count as execution',async()=>{
  const f=await fixture('test_cases');
  const rows=[{type:'tool_call',name:'run_subagent',tool_call_id:'native-denied',arguments:f.dispatched.delegation},{type:'tool_call_output',tool_call_id:'native-denied',output:'Tool call denied by the qa-delegation-guard hook: wrong mapping'}];
  writeFileSync(f.parentFile,readFileSync(f.parentFile,'utf8')+'\n'+rows.map(payload=>JSON.stringify({type:'model_msg',timestamp:new Date().toISOString(),payload})).join('\n'));
  assert.equal((await reconcileHandoff(root,f.parent,f.agentRoot)).decision,'continue');
  assert.equal((await reconcileHandoff(root,f.parent,f.agentRoot)).decision,'continue');
  assert.equal((await reconcileHandoff(root,f.parent,f.agentRoot)).decision,'stop');
  assert.equal(f.manifest().stages.test_cases.status,'in_progress');
  assert.equal(readControllerSession(root,f.parent).status,'ready');
});

test('independent report missing or malformed draft stays correctable and then exports',async()=>{
  for(const malformed of [false,true]) {
    const f=await fixture('report');
    const path=resolve(f.dir,taskResultPath('report'));const saved=readFileSync(path);
    if(malformed) writeFileSync(path,'{broken');else unlinkSync(path);
    const result=await f.send({action:'export_report'});
    assert.equal(result.classification,'input_rejected',JSON.stringify(result));
    assert.equal(result.recovery.retry_allowed,true);
    assert.equal(readControllerSession(root,f.parent).status,'ready');
    assert.match(result.error,/Correct the run-local draft/);
    assert.equal(existsSync(resolve(f.dir,'report/test_report.docx')),false);
    writeFileSync(path,saved);
    f.put('report/test_report.md','# Report\nNo product tests executed.');
    f.put('report/reportable-results.json',{run_id:f.id,status:'blocked',summary:{total:0,passed:0,failed:0,blocked:0,skipped:0},cases:[]});
    f.put('report/issues.json',[]);
    const retry=await f.send({action:'export_report'});
    assert.equal(retry.exit_code,0,JSON.stringify(retry));
    assert.equal(existsSync(resolve(f.dir,'report/test_report.pdf')),true);
    assert.match(readFileSync(resolve(f.dir,'report/test_report.html'),'utf8'),/执行事实（工具提取）/);
    assert.equal(readFileSync(resolve(f.dir,'report/test_report.md'),'utf8'),'# Report\nNo product tests executed.');
  }
});

test('report export includes imported timing facts and preserves source and agent draft',async()=>{
  const f=await fixture('report');
  const row={case_id:'CASE2',status:'passed',evidence_paths:['inputs/request.txt'],timing:{mode:'standalone_observation',delay_after_action_ms:13306,preceding_action:{request_id:'click-code'}}};
  const result={run_id:f.id,status:'completed',summary:{total:1,passed:1,failed:0,blocked:0,skipped:0},cases:[row]};
  f.put('inputs/results.json',result);
  const task=JSON.parse(readFileSync(resolve(f.dir,taskResultPath('report'))));
  task.source_paths.push('inputs/results.json');f.put(taskResultPath('report'),task);
  f.put('report/test_report.md','# Timing report\nImported observations.');
  f.put('report/reportable-results.json',result);f.put('report/issues.json',[]);
  const before=readFileSync(resolve(f.dir,'inputs/results.json'));
  const exported=await f.send({action:'export_report'});
  assert.equal(exported.exit_code,0,JSON.stringify(exported));
  const html=readFileSync(resolve(f.dir,'report/test_report.html'),'utf8');
  assert.match(html,/独立观察/);assert.match(html,/13306/);assert.match(html,/用户导入/);
  assert.match(html,/结果记录/);assert.ok(!html.includes('执行用例'));
  assert.deepEqual(readFileSync(resolve(f.dir,'inputs/results.json')),before);
  assert.equal(readFileSync(resolve(f.dir,'report/test_report.md'),'utf8'),'# Timing report\nImported observations.');
});

test('report draft diagnostics identify the exact file and recover without changing test facts',async()=>{
  const f=await fixture('report');
  f.put('report/test_report.md','# Report\nNo product tests executed.');
  f.put('report/reportable-results.json',{run_id:f.id,status:'completed',summary:{total:0,passed:0,failed:0,blocked:0,skipped:0},cases:[]});
  const facts=readFileSync(resolve(f.dir,'report/reportable-results.json'));
  for(const issues of [{issues:[]},{bugs:[]},null,[null]]) {
    f.put('report/issues.json',issues);
    const result=await f.send({action:'export_report'});
    assert.equal(result.classification,'input_rejected',JSON.stringify(result));
    assert.equal(result.recovery.retry_allowed,true);
    assert.match(result.error,/report\/issues.json/);
    assert.equal(readControllerSession(root,f.parent).status,'ready');
    assert.equal(existsSync(resolve(f.dir,'report/test_report.docx')),false);
    assert.deepEqual(readFileSync(resolve(f.dir,'report/reportable-results.json')),facts);
  }
  writeFileSync(resolve(f.dir,'report/issues.json'),'{broken');
  const syntax=await f.send({action:'export_report'});
  assert.equal(syntax.classification,'input_rejected',JSON.stringify(syntax));
  assert.match(syntax.error,/report\/issues.json: invalid JSON/);
  f.put('report/issues.json',[]);
  const lifecycle=await f.send({action:'build_report_metrics'});
  assert.equal(lifecycle.classification,'input_rejected',JSON.stringify(lifecycle));
  assert.match(lifecycle.error,/lifecycle-only/);
  assert.match(lifecycle.error,/export_report/);
  assert.equal(existsSync(resolve(f.dir,'report/quality-metrics.json')),false);
  const exported=await f.send({action:'export_report'});
  assert.equal(exported.exit_code,0,JSON.stringify(exported));
  assert.deepEqual(readFileSync(resolve(f.dir,'report/reportable-results.json')),facts);
});

test('independent export does not recover foreign dispatches or escaped draft files',async()=>{
  for(const foreign of [false,true]) {
    const f=await fixture('report');
    if(foreign) {
      const m=f.manifest();m.orchestration.events.filter(e=>e.type==='dispatched').at(-1)['parent-session-id']='foreign-parent';
      f.put('manifest.json',m);
    } else {
      const path=resolve(f.dir,'report');const outside=resolve(f.dir,'..',`escaped-${randomUUID()}`);
      renameSync(path,outside);symlinkSync(outside,path,'junction');
    }
    const result=await f.send({action:'export_report'});
    assert.notEqual(result.exit_code,0);
    assert.equal(result.recovery,null);
    assert.equal(existsSync(resolve(f.dir,'report/test_report.docx')),false);
  }
});

async function returnChild(f,stage) {
  const child=`session-2026-10-13-00-00-01-${randomUUID().replaceAll('-','')}`;
  const at=new Date().toISOString();
  const rows=[{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:'synthetic-task-child',arguments:f.dispatched.delegation}},{type:'event_msg',payload:{type:'subagent',session_id:child}},{type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'synthetic-task-child',stop_reason:'completed',output:'Synthetic professional return'}}];
  writeFileSync(f.parentFile,readFileSync(f.parentFile,'utf8')+'\n'+rows.map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
  const agent=roles[stage][0],traces=resolve(f.agentRoot,agent,'traces/2026-10-13');mkdirSync(traces,{recursive:true});
  writeFileSync(resolve(traces,`${child}_001.jsonl`),[
    {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(f.agentRoot,agent,'agent_state'),workspace:root}},
    {type:'model_msg',payload:{type:'text',role:'user',text:f.dispatched.delegation.prompt}},
    {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic independent task complete'}},
    {type:'event_msg',payload:{type:'request_end',status:'completed'}}
  ].map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
}

test('independent execution failure closes only its own returned dispatch without fake artifacts',async()=>{
  const f=await fixture('execution');
  await returnChild(f,'execution');
  const rows=readFileSync(f.parentFile,'utf8').split('\n').map(JSON.parse);
  const output=rows.find(r=>r.payload?.type==='tool_call_output');
  output.payload.stop_reason='fatal';
  output.payload.output='[subagent failed: rejected - provider unavailable]';
  writeFileSync(f.parentFile,rows.map(JSON.stringify).join('\n'));
  const resolved=await f.send({action:'resolve_child',stage:'execution'});
  assert.equal(resolved.result.outcome,'failed');
  assert.equal(existsSync(resolve(f.dir,'execution/exploration.json')),false);
  assert.equal((await reconcileHandoff(root,f.parent,f.agentRoot)).decision,'stop');
  assert.equal(f.manifest().stages.execution.status,'failed');
  const status=await f.send({action:'run_status'});
  assert.equal(status.data.controller_status,'ready');
  assert.equal(f.manifest().orchestration.events.some(e=>e.type==='completed'),false);
});
for(const stage of Object.keys(roles).filter(s=>s!=='execution')) test(`independent ${stage}: supplied text -> dispatch -> export -> handoff without predecessor files`,async()=>{
  const f=await fixture(stage);
  if(stage==='analysis') f.put('analysis/requirement_analysis.md','# Analysis\nEmpty phone must be rejected.');
  if(stage==='test_points') f.put('design/test_points.json',[{id:'TP-1',module:'Login',feature:'Phone validation',description:'Reject empty phone'}]);
  if(stage==='test_cases') f.put('design/test_cases.json',[{case_id:'TC-1',module:'Login',title:'Empty phone',priority:'P1',preconditions:[],steps:['Leave phone empty','Submit'],expected:'Rejected'}]);
  if(stage==='defects') {f.put('defects/defect-records.json',{records:[]});f.put('defects/bugs.md','# Analysis\nNo execution evidence supplied; no confirmed product defect.');}
  if(stage==='report') {
    f.put('report/test_report.md','# Report\nNo product tests executed. This report summarizes supplied materials only.');
    f.put('report/reportable-results.json',{run_id:f.id,status:'blocked',summary:{total:0,passed:0,failed:0,blocked:0,skipped:0},cases:[]});
    f.put('report/issues.json',[]);
  }
  assert.equal((await f.send({action:'diagnose_task',stage})).result.status,'passed');
  const action={test_points:'export_test_points',test_cases:'export_test_cases',report:'export_report'}[stage];
  if(action) {const r=await f.send({action});assert.equal(r.exit_code,0,JSON.stringify(r));}
  const checked=await f.send({action:'validate_artifacts',stage});assert.equal(checked.exit_code,0,JSON.stringify(checked));
  assert.equal(existsSync(resolve(f.dir,'analysis/requirement-ledger.json')),false);
  if(stage==='test_cases') assert.equal(existsSync(resolve(f.dir,'design/test_points.json')),false);
  if(stage==='report') assert.equal(existsSync(resolve(f.dir,'execution/execution-state.json')),false);
  await returnChild(f,stage);
  assert.ok(inspectHandoff(root,f.parent,f.agentRoot));
  const done=await f.send(f.dispatched.handoff_template);assert.equal(done.exit_code,0,JSON.stringify(done));
  assert.equal(done.data.stage_status,'completed');assert.equal(done.data.presentation.status,'ready');
  assert.equal(done.data.presentation.run_status.workflow_closed,true);
  assert.equal(done.data.presentation.task_result.summary,'Synthetic independent delivery');
  assert.ok(done.data.presentation.delivery.artifacts.length>0);
  assert.ok(done.data.presentation.delivery.artifacts.every(a=>a.path.startsWith(`output/runs/${f.id}/`)));
  assert.equal(f.manifest().confirmations?.length ?? 0,0);
  const repeated=await f.send(f.dispatched.handoff_template);assert.equal(repeated.data.already_recorded,true);
  f.put('inputs/request.txt','Changed input');
  assert.throws(()=>assertCompletedArtifacts(root,f.id,f.manifest(),stage),/changed after completion/);
});

test('task extension adds only requested task; lifecycle remains explicit; execution does not silently expand',async()=>{
  const f=await fixture('analysis');
  const r=await f.send({action:'extend_plan',stages:['report'],reason:'User requested a report as an independent task'});
  assert.equal(r.exit_code,0,JSON.stringify(r));
  assert.deepEqual(f.manifest().orchestration.plan.stages.filter(s=>s.selected).map(s=>s.id),['analysis','report']);
  assert.ok(actionCommand({action:'plan_run',run_id:'run-x',stages:['execution']},'parent').args.includes('--workflow-mode=task'));
  assert.ok(actionCommand({action:'plan_run',run_id:'run-x',stages:['execution'],workflow_mode:'lifecycle'},'parent').args.includes('--workflow-mode=lifecycle'));
});

test('independent contracts reject invented passing results and unrelated sources',async()=>{
  const f=await fixture('report');
  f.put('report/test_report.md','# Report');f.put('report/issues.json',[]);
  f.put('report/reportable-results.json',{run_id:f.id,summary:{total:1,passed:1,failed:0,blocked:0,skipped:0},cases:[{case_id:'TC-1',status:'passed',evidence_paths:[]}]});
  assert.match(inspectIndependentArtifacts(root,f.id,'report',{draft:true}).errors.join(' '),/need supplied evidence/);
  f.put(taskResultPath('report'),{run_id:f.id,stage:'report',outcome:'completed',summary:'Test',source_paths:['report/test_report.md'],questions:[],limitations:[]});
  assert.match(inspectIndependentArtifacts(root,f.id,'report',{draft:true}).errors.join(' '),/supplied inputs/);
});

test('URL-only independent exploration uses an actual browser, blocks POST and closes without prior design/config',async()=>{
  let posts=0;
  const server=createServer((req,res)=>{
    if(req.method==='POST') posts++;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><title>Exploration fixture</title><h1>Test target</h1><label>Phone<input name="phone" placeholder="Phone"></label><button>Submit</button><script>fetch("/mutate",{method:"POST"}).catch(()=>{})</script>');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try {
    const url=`http://127.0.0.1:${server.address().port}/`;
    const f=await fixture('execution');
    const archived=await f.send({action:'archive_input',name:'exploration-url',text:`Explore ${url}`});
    assert.equal(archived.exit_code,0);
    const source_path=archived.result.path;
    const result=await f.send({action:'explore_url',url,source_path});
    assert.equal(result.exit_code,0,JSON.stringify(result));
    const observation=JSON.parse(readFileSync(resolve(f.dir,'execution/exploration.json')));
    assert.equal(observation.http_status,200,JSON.stringify(observation));
    assert.equal(observation.title,'Exploration fixture');
    assert.equal(observation.structure.fields[0].name,'phone');
    assert.equal(posts,0);assert.ok(observation.blocked_requests>=1);
    assert.equal(existsSync(resolve(f.dir,'execution/exploration.lock')),false);
    assert.equal(existsSync(resolve(f.dir,'execution/execution-plan.json')),false);
    assert.equal(existsSync(resolve(f.dir,'design/test_cases.json')),false);
    f.put(taskResultPath('execution'),{run_id:f.id,stage:'execution',outcome:'completed',summary:'Read-only page explored, no business-flow claims',source_paths:[source_path],questions:[],limitations:observation.limitations});
    const check=await f.send({action:'validate_artifacts',stage:'execution'});assert.equal(check.exit_code,0,JSON.stringify(check));
    await returnChild(f,'execution');
    const handoff=await f.send(f.dispatched.handoff_template);assert.equal(handoff.exit_code,0,JSON.stringify(handoff));
    assert.equal(handoff.data.presentation.run_status.workflow_closed,true);
    const duplicate=await f.send({action:'explore_url',url,source_path});assert.equal(duplicate.exit_code,2);
    assert.equal(posts,0);
  } finally {await new Promise(done=>server.close(done));}
});

test('exploration rejects guessed URLs, credentials and non-web targets',()=>{
  const target='https://provided.test/users/index';
  assert.equal(validateExplorationTarget(target,'inputs/url.txt',`${target}帮我测一下这个页面的添加用户功能`).href,target);
  assert.equal(validateExplorationTarget(target,'inputs/url.txt',`url:${target}，账号另行提供`).href,target);
  assert.throws(()=>validateExplorationTarget(target,'inputs/url.txt',`${target}/other帮我测一下`),/not present/);
  assert.throws(()=>validateExplorationTarget(target,'inputs/url.txt',`${target}用户详情`),/not present/);
  assert.equal(validateExplorationTarget('https://provided.test/用户详情','inputs/url.txt','https://provided.test/用户详情').pathname,'/%E7%94%A8%E6%88%B7%E8%AF%A6%E6%83%85');
  assert.equal(validateExplorationTarget('https://provided.test/','inputs/url.txt','[https://provided.test/](https://provided.test/)').href,'https://provided.test/');
  assert.throws(()=>validateExplorationTarget('https://other.test/','inputs/url.txt','https://provided.test/'),/not present/);
  assert.throws(()=>validateExplorationTarget('https://user:secret@provided.test/','inputs/url.txt','https://user:secret@provided.test/'),/credentials/);
  assert.throws(()=>validateExplorationTarget('file:///C:/secret','inputs/url.txt','file:///C:/secret'),/HTTP/);
  assert.throws(()=>validateExplorationTarget('https://provided.test/','report/report.md','https://provided.test/'),/archived/);
});
