import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { inspectIndependentArtifacts, taskResultPath } from '../../scripts/independent-task.mjs';
import { trackPlan, assertTrackRows, assertSiblingResources, publishTrackDelivery, testTrackStatus, safeDeliveryScope } from '../../scripts/test-tracks.mjs';
import { extendRunPlan } from '../../scripts/run-plan-extension.mjs';
import { assertStageReady, assertDesignMutable } from '../../scripts/orchestration-state.mjs';
import { assertConfirmedExecutionCases } from '../../scripts/design-quality.mjs';
import { reviseDraftStage } from '../../scripts/draft-stage-revision.mjs';
import { requestAnalysisRevision } from '../../scripts/analysis-revision.mjs';

const root=resolve(import.meta.dirname,'../..');
async function fixture(types=['functional','api'],stages=['test_cases'],extra={},ordinary=false) {
  const session=`session-2026-10-22-00-00-00-${randomUUID().replaceAll('-','')}`,agentRoot=resolve(root,'output/acceptance',randomUUID());
  const traces=resolve(agentRoot,'test_agent/traces/2026-10-22');mkdirSync(traces,{recursive:true});
  const trace=resolve(traces,session+'_001.jsonl');
  writeFileSync(trace,[{type:'session_meta',payload:{session_id:session,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}},{type:'model_msg',timestamp:'2026-10-22T00:00:00.000Z',payload:{type:'text',role:'user',text:'根据功能需求和接口资料分别设计，不实际执行。'}}].map(JSON.stringify).join('\n'));
  const call=request=>executeAction(root,session,()=>JSON.stringify(request),{agentRoot});
  const creation=await call({action:'create_run'});assert.equal(creation.status,'completed',JSON.stringify(creation));
  const id=creation.run_id;
  for(const type of types)assert.equal((await call({action:'archive_input',run_id:id,name:type+'.txt',text:type==='api'?'接口查询返回业务码0。':'功能页面空手机号应提示必填。'})).status,'completed');
  const request={action:'plan_test_tracks',run_id:id,scope_name:'登录模块',tracks:types.map(type=>({type,source_paths:[`inputs/${type}.txt`],reason:type==='api'?'明确的接口响应约定':'明确的页面功能需求'})),stages,...extra};
  const planned=await call(ordinary?{action:'plan_run',run_id:id,stages,workflow_mode:'task'}:request);assert.equal(planned.status,'completed',JSON.stringify(planned));
  return {id,call,request,planned,agentRoot,trace,dir:run=>resolve(root,'output/runs',run),manifest:run=>JSON.parse(readFileSync(resolve(root,'output/runs',run,'manifest.json'))),put(run,path,value){writeFileSync(resolve(root,'output/runs',run,path),typeof value==='string'?value:JSON.stringify(value));}};
}

function syntheticChildReturn(f,dispatch) {
  // Native trace fixture, not a model invocation or real Agent acceptance.
  const child=`session-2026-10-22-00-00-01-${randomUUID().replaceAll('-','')}`,at=new Date().toISOString(),call=randomUUID();
  const rows=[{type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:call,arguments:dispatch.delegation}},{type:'event_msg',payload:{type:'subagent',session_id:child}},{type:'model_msg',payload:{type:'tool_call_output',tool_call_id:call,stop_reason:'completed',output:'Synthetic typed task return'}}];
  writeFileSync(f.trace,readFileSync(f.trace,'utf8')+'\n'+rows.map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
  const agent=dispatch.delegation.agent_id,traces=resolve(f.agentRoot,agent,'traces/2026-10-22');mkdirSync(traces,{recursive:true});
  writeFileSync(resolve(traces,child+'_001.jsonl'),[
    {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(f.agentRoot,agent,'agent_state'),workspace:root}},
    {type:'model_msg',payload:{type:'text',role:'user',text:dispatch.delegation.prompt}},
    {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic engineering fixture complete'}},
    {type:'event_msg',payload:{type:'request_end',status:'completed'}}
  ].map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
}

test('single material selects only its track; design-only never schedules either execution role',async()=>{
  for(const type of ['functional','api']){
    const f=await fixture([type],['analysis','test_points','test_cases']);
    assert.equal(f.planned.data.tracks.length,1);
    const t=f.planned.data.tracks[0],m=f.manifest(t.run_id);
    assert.deepEqual(m.orchestration.plan.execution_branches,[]);
    assert.deepEqual(m.orchestration.plan.stages.filter(s=>s.selected).map(s=>s.id),['analysis','test_points','test_cases']);
    assert.equal(existsSync(f.dir(f.id+'-'+(type==='api'?'functional':'api'))),false);
    assert.throws(()=>assertStageReady(m,'test_cases'),/前置/);
    assert.equal((await f.call({action:'run_status',run_id:f.id})).data.tracks[0].type,type);
  }
});

test('both execution channels reject pending design before registering dispatch or product activity',async()=>{
  const f=await fixture(['functional','api'],['execution']);
  for(const type of ['functional','api']) {
    const id=f.id+'-'+type,stage=type==='api'?'api_execution':'execution';
    const row={case_id:'C1',execution_layer:type==='api'?'api':'ui',design_contract:{basis:[{status:'confirmed'}],assumptions:[{statement:'Business outcome ambiguous',status:'pending'}]}};
    f.put(id,'design/test_cases.json',{test_cases:[row]});
    const before=readFileSync(resolve(f.dir(id),'manifest.json'));
    const template=f.planned.data.tracks.find(t=>t.type===type).dispatch_templates.find(t=>t.stage===stage);
    const result=await f.call(template);
    assert.match(result.error,/before any product operation/);assert.equal(result.classification,'input_rejected');
    assert.deepEqual(readFileSync(resolve(f.dir(id),'manifest.json')),before);
    row.design_contract.assumptions=[];row.preconditions=['Observe service availability'];row.steps=['Clear input before checking empty validation'];
    assert.doesNotThrow(()=>assertConfirmedExecutionCases([row]));
    row.design_contract.basis[0].status='conflicted';assert.throws(()=>assertConfirmedExecutionCases([row]),/C1/);
  }
});

test('execution freezes upstream revisions before snapshots, state transitions or overwritten design',async()=>{
  const f=await fixture(['functional'],['test_cases']),id=f.id+'-functional';
  const manifest=f.manifest(id);
  for(const execution of ['execution','api_execution']) {
    manifest.orchestration.events.push({type:'dispatched',stage:execution});
    f.put(id,'manifest.json',manifest);
    const before=readFileSync(resolve(f.dir(id),'manifest.json'));
    for(const stage of ['analysis','test_points','test_cases'])assert.throws(()=>assertDesignMutable(manifest,stage),/frozen/);
    const revised=reviseDraftStage(root,id,'test_cases','owner','Correct draft',f.agentRoot);
    assert.equal(revised.status,'ineligible');assert.match(revised.reason,/frozen/);
    assert.throws(()=>requestAnalysisRevision(root,id,manifest,'Change requirement'),/frozen/);
    assert.deepEqual(readFileSync(resolve(f.dir(id),'manifest.json')),before);
    assert.equal(existsSync(resolve(f.dir(id),'audit/revisions')),false);
    manifest.orchestration.events.pop();
  }
  manifest.orchestration.events.push({type:'dispatched',stage:'execution',mode:'prepare'});
  assert.doesNotThrow(()=>assertDesignMutable(manifest,'test_cases'));
  assert.doesNotThrow(()=>assertDesignMutable(manifest,'report'));
});

test('delivery names keep Chinese module names and reject unusable input',()=>{
  assert.equal(safeDeliveryScope(' 登录模块 '),'登录模块');
  assert.equal(safeDeliveryScope('../订单/退款:#%'),'_订单_退款___');
  for(const value of ['', '   ', '/:*?', null])assert.throws(()=>safeDeliveryScope(value),/scope_name/);
});

test('ordinary runs configure module names and seal the name at first completed delivery',async()=>{
  const f=await fixture(['functional'],['analysis'],{},true),id=f.id;
  const configured=await f.call({action:'configure_delivery',run_id:id,scope_name:'订单模块'});
  assert.equal(configured.status,'completed',JSON.stringify(configured));
  const dispatch=await f.call({action:'dispatch',run_id:id,stage:'analysis',agent:'requirement_analysis_agent',skills:['requirement-analysis']});
  assert.equal(dispatch.status,'completed',JSON.stringify(dispatch));
  f.put(id,'analysis/requirement_analysis.md','# 订单模块需求分析\n合成需求分析。');
  f.put(id,taskResultPath('analysis'),{run_id:id,stage:'analysis',outcome:'completed',summary:'订单模块需求分析',source_paths:['inputs/functional.txt'],questions:[],limitations:[]});
  syntheticChildReturn(f,dispatch);
  const delivered=await f.call(dispatch.handoff_template);assert.equal(delivered.status,'completed',JSON.stringify(delivered));
  assert.deepEqual(delivered.typed_delivery.files.map(x=>x.label),['订单模块需求分析.md']);
  assert.equal((await f.call({action:'configure_delivery',run_id:id,scope_name:'订单模块'})).status,'completed');
  const changed=await f.call({action:'configure_delivery',run_id:id,scope_name:'其他模块'});
  assert.equal(changed.status,'rejected');assert.match(changed.error,/sealed/);
});

test('analysis handoff publishes a named Markdown only for each material type',async()=>{
  const f=await fixture(['functional','api'],['analysis']);
  for(const t of f.planned.data.tracks){
    const dispatch=await f.call(t.dispatch_templates[0]);assert.equal(dispatch.status,'completed',JSON.stringify(dispatch));
    f.put(t.run_id,'analysis/requirement_analysis.md','# 登录模块需求分析\n依据归档资料分析，未执行产品测试。');
    f.put(t.run_id,taskResultPath('analysis'),{run_id:t.run_id,stage:'analysis',outcome:'completed',summary:'登录模块需求分析',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:[]});
    syntheticChildReturn(f,dispatch);
    const result=await f.call(dispatch.handoff_template);assert.equal(result.status,'completed',JSON.stringify(result));
    assert.deepEqual(result.typed_delivery.files.map(x=>x.label),['登录模块需求分析.md']);
    assert.deepEqual(readFileSync(result.typed_delivery.files[0].absolute_path),readFileSync(resolve(f.dir(t.run_id),'analysis/requirement_analysis.md')));
  }
});

test('typed task and lifecycle map execution, dependencies and reports without adding missing channels',()=>{
  for(const mode of ['task','lifecycle'])for(const type of ['functional','api']){
    const execution=type==='api'?'api_execution':'execution';
    const p=trackPlan({stages:['analysis','test_points','test_cases','execution','defects','report'],workflow_mode:mode},type);
    assert.deepEqual(p.execution_branches,[execution]);
    assert.equal(p.stages.find(s=>s.id===(type==='api'?'execution':'api_execution')).selected,false);
    assert.deepEqual(p.stages.find(s=>s.id==='defects').depends_on,[execution]);
    assert.deepEqual(p.stages.find(s=>s.id==='report').depends_on,['defects']);
  }
  const live=trackPlan({stages:['report'],source_mode:'live_product'},'api');
  assert.deepEqual(live.execution_branches,['api_execution']);assert.deepEqual(live.stages.find(s=>s.id==='report').depends_on,['api_execution']);
});

test('group creation is idempotent, preserves dispatches and does not import the other material',async()=>{
  const f=await fixture();
  const first=f.planned.data.tracks[0];
  const dispatched=await f.call(first.dispatch_templates[0]);assert.equal(dispatched.status,'completed',JSON.stringify(dispatched));
  const contract=readFileSync(dispatched.delegation_contract_path,'utf8');
  assert.match(contract,new RegExp('test_type='+first.type));
  assert.match(dispatched.delegation.description,/功能|接口/);
  assert.equal(dispatched.source_paths.includes('inputs/'+(first.type==='api'?'functional':'api')+'.txt'),false);
  assert.ok(dispatched.input_context.user_messages.length>0);
  const repeated=await f.call(f.request);assert.equal(repeated.status,'completed');
  assert.equal(f.manifest(first.run_id).stages.test_cases.status,'in_progress');
  assert.deepEqual(repeated.data.tracks.map(t=>t.run_id),f.planned.data.tracks.map(t=>t.run_id));
  const changed=await f.call({...f.request,tracks:f.request.tracks.slice(0,1)});assert.equal(changed.status,'rejected');
  assert.match(changed.error,/already planned/);
  assert.equal((await f.call({action:'plan_run',run_id:f.id,stages:['execution']})).status,'rejected');
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json')));
  assert.throws(()=>extendRunPlan(root,project,first.run_id,[first.type==='api'?'execution':'api_execution'],'wrong channel'),/channel differs/);
});

test('dual case design creates different JSON and real Excel, rejects mixed layers, publishes separately named files',async()=>{
  const f=await fixture();
  const published=[];
  for(const t of f.planned.data.tracks){
    const d=await f.call(t.dispatch_templates[0]);assert.equal(d.status,'completed',JSON.stringify(d));
    const expected=t.type==='api'?'接口查询返回业务码0。':'功能页面空手机号应提示必填。';
    const row={case_id:'CASE-1',title:t.type==='api'?'查询接口':'手机号必填',priority:'P1',module:t.label,preconditions:[],steps:[t.type==='api'?'查询接口':'清空手机号后提交'],expected,expected_basis:[{expected,kind:'requirement',source_path:`inputs/${t.type}.txt`,quote:expected}],execution_layer:t.type==='api'?'api':'ui'};
    f.put(t.run_id,'design/test_cases.json',{cases:[row]});
    f.put(t.run_id,taskResultPath('test_cases'),{run_id:t.run_id,stage:'test_cases',outcome:'completed',summary:t.label+'测试用例',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:['仅合成工程设计验证，未执行产品测试']});
    assert.equal(inspectIndependentArtifacts(root,t.run_id,'test_cases',{draft:true}).status,'passed');
    row.execution_layer=t.type==='api'?'ui':'api';f.put(t.run_id,'design/test_cases.json',{cases:[row]});
    assert.match(inspectIndependentArtifacts(root,t.run_id,'test_cases',{draft:true}).errors.join(' '),/execution_layer/);
    row.execution_layer=t.type==='api'?'api':'ui';f.put(t.run_id,'design/test_cases.json',{cases:[row]});
    const exported=await f.call({action:'export_test_cases',run_id:t.run_id});assert.equal(exported.status,'completed',JSON.stringify(exported));
    const receipt=inspectIndependentArtifacts(root,t.run_id,'test_cases');assert.equal(receipt.status,'passed',JSON.stringify(receipt));
    syntheticChildReturn(f,d);
    const handoff=await f.call(d.handoff_template);assert.equal(handoff.status,'completed',JSON.stringify(handoff));
    const delivery=handoff.typed_delivery;
    assert.ok(delivery.files.some(p=>p.label==='登录模块'+t.label+'测试用例.xlsx'));
    published.push(delivery.files.find(p=>p.label.endsWith('.xlsx')).absolute_path);
    assert.deepEqual(publishTrackDelivery(root,t.run_id,'test_cases'),delivery);
  }
  assert.notEqual(published[0],published[1]);assert.notDeepEqual(readFileSync(published[0]),readFileSync(published[1]));
  assert.equal(testTrackStatus(root,f.id).tracks.every(t=>t.deliveries.length>0),true);
});

test('shared mutable resource waits across typed runs; independent resources continue and unknown writes remain blocked',async()=>{
  const f=await fixture(['functional','api'],['execution']);
  const api=f.planned.data.tracks.find(t=>t.type==='api'),ui=f.planned.data.tracks.find(t=>t.type==='functional');
  const m=f.manifest(api.run_id);m.stages.api_execution.status='in_progress';m.stages.api_execution.resource_keys=['account-1'];m.orchestration.events.push({type:'dispatched',stage:'api_execution',dispatch_id:'synthetic'});f.put(api.run_id,'manifest.json',m);
  assert.throws(()=>assertSiblingResources(root,f.manifest(ui.run_id),'execution',['account-1']),/Shared resource/);
  assert.doesNotThrow(()=>assertSiblingResources(root,f.manifest(ui.run_id),'execution',['account-2']));
  m.stages.api_execution.status='failed';f.put(api.run_id,'manifest.json',m);
  mkdirSync(resolve(f.dir(api.run_id),'execution/api'),{recursive:true});f.put(api.run_id,'execution/api/test_results.json',{cases:[{result_unknown:true}]});
  assert.throws(()=>assertSiblingResources(root,f.manifest(ui.run_id),'execution',['account-1']),/unknown effects/);
});

test('row boundaries preserve legacy runs but reject opposing result evidence and API scenarios in functional design',()=>{
  assert.doesNotThrow(()=>assertTrackRows(null,[{execution_layer:'both'}],{design:true}));
  assert.throws(()=>assertTrackRows({type:'functional',label:'功能'},[{execution_layer:'ui',api_scenario:{}}],{design:true}),/API scenarios/);
  assert.throws(()=>assertTrackRows({type:'api',label:'接口'},[{layer:'ui'}]),/Result layer/);
});

test('both point sets export independent XMind and empty defects/reports stay separate without invented executions',async()=>{
  const points=await fixture(['functional','api'],['test_points']);
  for(const t of points.planned.data.tracks){
    const dispatch=await points.call(t.dispatch_templates[0]);assert.equal(dispatch.status,'completed',JSON.stringify(dispatch));
    points.put(t.run_id,'design/test_points.json',{points:[{id:'TP-1',module:t.label,feature:t.type==='api'?'接口响应':'页面表单',description:t.type==='api'?'查询业务码':'必填校验',execution_layer:t.type==='api'?'api':'ui'}]});
    points.put(t.run_id,taskResultPath('test_points'),{run_id:t.run_id,stage:'test_points',outcome:'completed',summary:t.label+'测试点',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:[]});
    const out=await points.call({action:'export_test_points',run_id:t.run_id});assert.equal(out.status,'completed',JSON.stringify(out));
    assert.equal(inspectIndependentArtifacts(root,t.run_id,'test_points').status,'passed');
    syntheticChildReturn(points,dispatch);
    const delivered=await points.call(dispatch.handoff_template);assert.equal(delivered.status,'completed',JSON.stringify(delivered));
    assert.deepEqual(delivered.typed_delivery.files.map(f=>f.label),['登录模块'+t.label+'测试点.xmind']);
  }
  const defects=await fixture(['functional','api'],['defects']);
  for(const t of defects.planned.data.tracks){
    assert.equal((await defects.call(t.dispatch_templates[0])).status,'completed');
    defects.put(t.run_id,'defects/defect-records.json',{records:[]});defects.put(t.run_id,'defects/bugs.md',`# ${t.label}缺陷分析\n未执行产品测试，没有可确认缺陷。`);
    defects.put(t.run_id,taskResultPath('defects'),{run_id:t.run_id,stage:'defects',outcome:'partial',summary:t.label+'缺陷分析',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:['未执行，不能据此断言无缺陷']});
    assert.equal(inspectIndependentArtifacts(root,t.run_id,'defects').status,'passed');
  }
  const reports=await fixture(['functional','api'],['report']);
  const files=[];
  for(const t of reports.planned.data.tracks){
    const dispatch=await reports.call(t.dispatch_templates[0]);assert.equal(dispatch.status,'completed');
    reports.put(t.run_id,'report/reportable-results.json',{run_id:t.run_id,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}});
    reports.put(t.run_id,'report/issues.json',[]);reports.put(t.run_id,'report/test_report.md',`# ${t.label}测试报告\n\n本报告为工程合成导出验证，产品未执行，不能推断通过或无缺陷。`);
    reports.put(t.run_id,taskResultPath('report'),{run_id:t.run_id,stage:'report',outcome:'partial',summary:t.label+'测试报告',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:['产品未执行；仅工程合成验证']});
    const out=await reports.call({action:'export_report',run_id:t.run_id});assert.equal(out.status,'completed',JSON.stringify(out));
    const receipt=inspectIndependentArtifacts(root,t.run_id,'report');assert.equal(receipt.status,'passed',JSON.stringify(receipt));
    files.push(resolve(reports.dir(t.run_id),'report/test_report.html'));
    for(const ext of ['docx','pdf'])assert.equal(existsSync(resolve(reports.dir(t.run_id),'report/test_report.'+ext)),false);
    assert.match(readFileSync(files.at(-1),'utf8'),new RegExp('<title>登录模块'+t.label+'测试报告</title>'));
    assert.doesNotMatch(readFileSync(files.at(-1),'utf8'),/href="test_(report\.(docx|pdf)|cases\.xlsx)"/);
    syntheticChildReturn(reports,dispatch);
    const delivered=await reports.call(dispatch.handoff_template);assert.equal(delivered.status,'completed',JSON.stringify(delivered));
    assert.deepEqual(delivered.typed_delivery.files.map(f=>f.label),['登录模块'+t.label+'测试报告.html']);
  }
  assert.equal(new Set(files).size,2);for(const file of files)assert.ok(readFileSync(file).length>100);
});

test('continuation adds the matching execution and keeps report dependencies ahead of delivery',async()=>{
  const f=await fixture(['functional','api'],['test_cases']);
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json')));
  for(const t of f.planned.data.tracks){
    const execution=t.type==='api'?'api_execution':'execution';
    const r=extendRunPlan(root,project,t.run_id,[execution,'defects','report'],'用户要求继续对应链路的执行、缺陷及报告');
    assert.ok(r.selected_stages.includes(execution));
    const m=f.manifest(t.run_id);assert.deepEqual(m.orchestration.plan.execution_branches,[execution]);
    assert.deepEqual(m.orchestration.plan.stages.find(s=>s.id==='report').depends_on,['defects']);
    assert.deepEqual(m.orchestration.plan.stages.find(s=>s.id==='defects').depends_on,[execution]);
    assert.throws(()=>assertStageReady(m,'report'),/前置/);
  }
});

test('terminal execution failure allows a truthful limited report, not rerunning or completing the failed stage',async()=>{
  const f=await fixture(['functional','api'],['execution','report']);
  for(const t of f.planned.data.tracks){
    const stage=t.type==='api'?'api_execution':'execution';
    const m=f.manifest(t.run_id);m.stages[stage].status='failed';m.orchestration.events.push({type:'failed',stage,reason:'synthetic terminal failure'});f.put(t.run_id,'manifest.json',m);
    assert.doesNotThrow(()=>assertStageReady(m,'report'));
    assert.throws(()=>assertStageReady(m,stage),/不能派发/);
    const out=await f.call(t.dispatch_templates.find(s=>s.stage==='report'));assert.equal(out.status,'completed',JSON.stringify(out));
    assert.equal(f.manifest(t.run_id).stages[stage].status,'failed');
    f.put(t.run_id,taskResultPath('report'),{run_id:t.run_id,stage:'report',outcome:'completed',summary:'incorrect success claim',source_paths:[`inputs/${t.type}.txt`],questions:[],limitations:[]});
    assert.match(inspectIndependentArtifacts(root,t.run_id,'report',{draft:true}).errors.join(' '),/requires a partial/);
  }
});
