import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { executeApiPlan, validateApiCases, apiTarget } from '../../scripts/api-engine.mjs';
import { inspectApiContract, apiHash } from '../../scripts/api-contract.mjs';
import { assertDispatchScheduling } from '../../scripts/orchestration-state.mjs';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { inspectIndependentArtifacts } from '../../scripts/independent-task.mjs';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { protectedInputs } from '../../scripts/protected-inputs.mjs';
import { apiTask } from '../../scripts/api-task.mjs';
import { createApiSnapshotReport, verifySnapshotReport } from '../../scripts/api-snapshot.mjs';
import { extendRunPlan } from '../../scripts/run-plan-extension.mjs';

async function fixture(fn) {
  const calls = [], server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url === '/api/slow') { await new Promise(r => setTimeout(r, 500)); }
    if (req.url === '/api/redirect') { res.writeHead(302, { location: 'http://unrelated.invalid/' }); res.end(); return; }
    if (req.url === '/api/empty') { res.writeHead(204); res.end(); return; }
    if (req.url === '/api/text') { res.setHeader('content-type','text/plain'); res.end('observed text'); return; }
    if (req.url === '/api/bad-json') { res.setHeader('content-type','application/json'); res.end('{oops'); return; }
    if (req.url.startsWith('/api/media/')) {
      const types={parameter:'Application/JSON; charset=utf-8',suffix:'application/problem+json',misleading:'application/jsonp',parameterOnly:'text/plain; format=json',invalid:'application/json, text/plain'};
      const variant=req.url.slice('/api/media/'.length);
      if(types[variant])res.setHeader('Content-Type',types[variant]);
      res.setHeader('set-cookie','private-response-cookie=secret');
      res.end(variant==='parameterOnly'?'observed text':'{"code":0}');return;
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: req.url === '/api/fail' ? 7 : 0, data: { id: 42, token: 'response-secret' }, list: [1, 2] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  try { await fn({ url, calls }); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
function plan(url, steps) {
  return { version:1, scope:[{url,source_path:'inputs/request.txt',quote:`请测试 ${url}`}], interval_ms:0, write_authorization:{source_path:'inputs/request.txt',quote:'允许创建、修改和删除测试数据'},scenarios:[{scenario_id:'s1',case_id:'C1',expected:'业务码为0',source_refs:[{source_path:'inputs/contract.txt',quote:'业务码为0'}],resources:['test-record'],steps}] };
}
const step = (url, request_id='r1', method='GET') => ({ url,request_id,method,assertions:[{type:'status',value:200},{type:'equals',path:'code',value:0}] });
function options(receipts={}) { const secrets=new Map();return {prior:receipts,saveReceipt:r=>{receipts[r.request_id]=structuredClone(r);},saveSecret:value=>{const ref=`qa-secret://test/${secrets.size}`;secrets.set(ref,value);return ref;},resolveSecret:ref=>{assert(secrets.has(ref));return secrets.get(ref);}}; }

test('Content-Type assertions compare exact media types, keep evidence and never replay',()=>fixture(async({url,calls})=>{
  for(const [variant,expected,actual,status] of [
    ['parameter','APPLICATION/JSON','application/json','passed'],
    ['suffix','application/problem+json','application/problem+json','passed'],
    ['suffix','application/json','application/problem+json','failed'],
    ['misleading','application/json','application/jsonp','failed'],
    ['missing','application/json',null,'failed'],
    ['invalid','application/json',null,'failed'],
    ['parameterOnly','text/plain','text/plain','passed']
  ]) {
    const receipts={},opts=options(receipts),p=plan(url,[{...step(`${url}/media/${variant}`),assertions:[{type:'status',value:200},{type:'content_type',value:expected}]}]);
    const result=await executeApiPlan(p,opts);assert.equal(result[0].status,status);
    assert.deepEqual(result[0].assertions[1],{type:'content_type',path:'',status,actual_type:actual===null?'null':'string',actual,expected:expected.toLowerCase()});
    const count=calls.length;await executeApiPlan(p,opts);assert.equal(calls.length,count,'An existing media-type verdict cannot trigger another request');
    assert(!JSON.stringify(receipts).includes('private-response-cookie'));
  }
}));

test('invalid Content-Type expectations are rejected before sending any request',()=>fixture(async({url,calls})=>{
  for(const assertion of [
    {type:'content_type'},...[null,42,{},'', 'application/*','application/json; charset=utf-8',' application/json','application/json\r\nX: injected'].map(value=>({type:'content_type',value})),
    {type:'content_type',value:'application/json',path:'code'},
    {type:'content_type',value:'application/json',min:1}
  ]) await assert.rejects(()=>executeApiPlan(plan(url,[{...step(`${url}/items`),assertions:[assertion]}]),options()),/Assertion expected value|Content-Type/);
  assert.equal(calls.length,0);
}));

test('malformed JSON retains header assertions without claiming body assertions passed',()=>fixture(async({url})=>{
  const receipts={},p=plan(url,[{...step(`${url}/bad-json`),assertions:[{type:'status',value:200},{type:'content_type',value:'application/json'},{type:'equals',path:'code',value:0}]}]);
  const result=await executeApiPlan(p,options(receipts));
  assert.equal(result[0].status,'blocked');assert.equal(receipts.r1.error_category,'response_parse_failure');
  assert.deepEqual(result[0].assertions.map(a=>[a.type,a.status]),[['status','passed'],['content_type','passed']]);
  assert.equal(receipts.r1.http_status,200);
}));

test('OpenAPI JSON/YAML local refs, operation selection and unsupported dialect are explicit',()=>{
  const doc='openapi: 3.0.3\npaths:\n  /items:\n    get:\n      responses:\n        "200":\n          $ref: "#/components/responses/Good"\ncomponents:\n  responses:\n    Good:\n      description: ok\n';
  const result=inspectApiContract(doc,{operations:['GET /items']});
  assert.equal(result.operations[0].responses['200'].description,'ok');assert.equal(result.source_sha256,apiHash(doc));
  assert.throws(()=>inspectApiContract('openapi: 3.1.0\npaths: {}'),/3.1/);
  assert.throws(()=>inspectApiContract(doc,{operations:['POST /items']}),/not found/);
  const remote=inspectApiContract(JSON.stringify({swagger:'2.0',paths:{'/x':{get:{responses:{200:{$ref:'https://outside.invalid/schema'}}}}}}));assert(remote.limitations.some(x=>x.startsWith('external_ref')));
});
test('CRUD response association, business assertion and request receipts work without browser',()=>fixture(async({url,calls})=>{
  const p=plan(url,[{...step(`${url}/items`,'create','POST'),extract:[{name:'id',path:'data.id'}]},step(`${url}/items/${'${id}'}`,'read'),step(`${url}/items/${'${id}'}`,'update','PATCH'),step(`${url}/items/${'${id}'}`,'delete','DELETE')]);
  const receipts={},result=await executeApiPlan(p,options(receipts));
  assert.equal(result[0].status,'passed');assert.equal(calls.length,4);assert.equal(calls[1].url,'/api/items/42');assert.equal(Object.keys(receipts).length,4);
  assert.equal(result[0].assertions.length,8);assert(!JSON.stringify(receipts).includes('response-secret'));
}));
test('HTTP 200 business failure remains failed; no expectation mutation',()=>fixture(async({url})=>{
  const p=plan(url,[step(`${url}/fail`)]),before=JSON.stringify(p);const rows=await executeApiPlan(p,options());assert.equal(rows[0].status,'failed');assert.equal(JSON.stringify(p),before);
}));
test('same request receipt is reused; changed content and unknown writes never replay',()=>fixture(async({url,calls})=>{
  const p=plan(url,[step(`${url}/items`)]),receipts={}; await executeApiPlan(p,options(receipts));await executeApiPlan(p,options(receipts));assert.equal(calls.length,1);
  p.scenarios[0].steps[0].url=`${url}/fail`;assert.equal((await executeApiPlan(p,options(receipts)))[0].status,'blocked');assert.equal(calls.length,1);
  const w=plan(url,[step(`${url}/slow`,'write','POST')]);w.timeout_ms=100;const wr={};assert.equal((await executeApiPlan(w,options(wr)))[0].status,'unknown');await executeApiPlan(w,options(wr));assert.equal(calls.filter(c=>c.method==='POST').length,1);
}));
test('204, text, parse failure and redirect retain appropriate outcomes',()=>fixture(async({url,calls})=>{
  for(const [path,assertions,expected] of [['empty',[{type:'status',value:204}],'passed'],['text',[{type:'contains',value:'observed'}],'passed'],['bad-json',[{type:'status',value:200}],'blocked'],['redirect',[{type:'status',value:200}],'blocked']]) {
    const p=plan(url,[{...step(`${url}/${path}`),assertions}]);assert.equal((await executeApiPlan(p,options()))[0].status,expected);
  }
  assert.equal(calls.length,4);
}));
test('independent scenarios overlap and one failure does not freeze another',()=>fixture(async({url,calls})=>{
  const p=plan(url,[step(`${url}/slow`)]);p.scenarios[0].resources=[];p.scenarios.push({...structuredClone(p.scenarios[0]),scenario_id:'s2',steps:[step(`${url}/fail`,'r2')]});
  const receipts={},rows=await executeApiPlan(p,options(receipts));assert.equal(rows[0].status,'passed');assert.equal(rows[1].status,'failed');assert(Date.parse(receipts.r2.started_at)<Date.parse(receipts.r1.finished_at));assert.equal(calls.length,2);
}));
test('cancellation retains pending scenarios and never launches later steps',()=>fixture(async({url,calls})=>{
  let cancel=false;const timer=setTimeout(()=>{cancel=true;},80);const p=plan(url,[step(`${url}/slow`),step(`${url}/items`,'r2')]);try{const rows=await executeApiPlan(p,{...options(),cancelled:()=>cancel});assert.equal(rows[0].status,'blocked');assert.equal(calls.length,1);}finally{clearTimeout(timer);}
}));
test('scope, schemas, cycles and write authority are checked before requests',()=>{
  assert.throws(()=>apiTarget('http://169.254.169.254/',[{url:'http://169.254.169.254/'}]),/Metadata/);
  assert.throws(()=>apiTarget('https://other.invalid/',[{url:'https://example.invalid/api'}]),/scope/);
  const p=plan('https://example.invalid/api',[step('https://example.invalid/api','r','POST')]);delete p.write_authorization;assert.throws(()=>validateApiCases(p),/authorization/);
  const s=plan('https://example.invalid/api',[{...step('https://example.invalid/api'),assertions:[{type:'schema',value:{madeUpKeyword:true}}]}]);assert.throws(()=>validateApiCases(s),/unknown keyword/);
});
test('selected lifecycle execution branches may overlap; duplicate and unrelated stages remain blocked',()=>{
  const m={orchestration:{plan:{workflow_mode:'lifecycle',execution_branches:['execution','api_execution']}},stages:{execution:{status:'in_progress'}}};
  assert.doesNotThrow(()=>assertDispatchScheduling(m,'api_execution'));assert.throws(()=>assertDispatchScheduling(m,'execution'));assert.throws(()=>assertDispatchScheduling(m,'report'));
  m.stages.execution.resource_keys=['account:1'];assert.throws(()=>assertDispatchScheduling(m,'api_execution',{resourceKeys:['account:1']}),/resource conflict/);
  m.stages.execution.status='completed';m.stages.execution.execution_outcome={unknown_resources:['account:1']};assert.throws(()=>assertDispatchScheduling(m,'api_execution',{resourceKeys:['account:1']}),/unknown write/);
});

test('path parameters and referenced Basic, Cookie and API Key authentication stay in transport',()=>fixture(async({url,calls})=>{
  for(const [type,value,location] of [['basic','user:password'],['cookie','session=private'],['api_key','private-key','query']]) {
    const opts=options(),ref=opts.saveSecret(value),p=plan(url,[{...step(`${url}/items/{id}`),path_params:{id:42},auth:{type,ref,name:'api_key',...(location?{in:location}:{})}}]);
    assert.equal((await executeApiPlan(p,opts))[0].status,'passed');
  }
  assert.equal(calls[0].url,'/api/items/42');assert.equal(calls[0].auth,'Basic '+Buffer.from('user:password').toString('base64'));assert(calls[2].url.includes('api_key=private-key'));
}));

test('lost worker collects original partial receipts without replaying an uncertain write',()=>fixture(async({url,calls})=>{
  const root=resolve(import.meta.dirname,'../..'),run_id=`run-${randomUUID()}`,owner=`session-2026-10-21-00-00-00-${randomUUID().replaceAll('-','')}`,dispatch_id=randomUUID(),dir=resolve(root,'output/runs',run_id);
  mkdirSync(resolve(dir,'inputs'),{recursive:true});
  const text=`请测试 ${url}，允许创建、修改和删除测试数据，业务码为0。`,p=plan(url,[step(`${url}/slow`,'uncertain-write','POST')]);p.write_authorization.quote=text;p.scenarios[0].source_refs=[{source_path:'inputs/request.txt',quote:'业务码为0'}];
  writeFileSync(resolve(dir,'inputs/request.txt'),text);writeFileSync(resolve(dir,'inputs/cases.json'),JSON.stringify(p));
  writeFileSync(resolve(dir,'manifest.json'),JSON.stringify({run_id,stages:{api_execution:{status:'in_progress',dispatch_id}},orchestration:{plan:{execution_branches:['api_execution']},events:[{type:'dispatched',stage:'api_execution',dispatch_id,'parent-session-id':owner}]}}));
  const previous=process.env.QA_APP_DATA_ROOT;process.env.QA_APP_DATA_ROOT=mkdtempSync(resolve(tmpdir(),'qa-api-crash-'));
  try {
    const action=op=>apiTask(root,run_id,owner,op,{nativeMessages:[text]});await action({type:'prepare',cases_path:'inputs/cases.json'});const started=await action({type:'start'});
    for(let i=0;i<100 && !calls.length;i++)await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,1);
    const snapshot=await action({type:'collect',partial:true});
    const frozen=JSON.parse(readFileSync(resolve(dir,snapshot.result_path)));
    assert.equal(frozen.cases[0].result_unknown,true);assert.equal(frozen.cases[0].status,'blocked');assert.equal(frozen.finished_at,null);assert.equal(calls.length,1);
    process.kill(started.worker_pid);await new Promise(r=>setTimeout(r,100));
    assert.equal((await action({type:'status'})).status,'interrupted');await action({type:'collect'});await action({type:'start'});
    const result=JSON.parse(readFileSync(resolve(dir,'execution/api/test_results.json')));assert.equal(result.status,'partial');assert.equal(result.cases[0].result_unknown,true);assert.equal(result.cases[0].status,'blocked');assert.equal(calls.length,1);
  } finally {if(previous===undefined)delete process.env.QA_APP_DATA_ROOT;else process.env.QA_APP_DATA_ROOT=previous;}
}));

for(const mismatch of [false,true]) test(mismatch?'structured worker and HTML report preserve failed Content-Type verdicts':'immutable snapshot report completes during authentication wait, then original execution and final report continue',()=>fixture(async({url,calls})=>{
  const root=resolve(import.meta.dirname,'../..'),owner=`session-2026-10-21-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',randomUUID()),trace=resolve(agentRoot,'test_agent/traces/2026-10-21');mkdirSync(trace,{recursive:true});
  const text=`请测试 ${url}，业务码为0。`,file=resolve(trace,`${owner}_001.jsonl`);
  writeFileSync(file,[{type:'session_meta',payload:{session_id:owner,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}},{type:'model_msg',timestamp:new Date().toISOString(),payload:{role:'user',type:'text',text}}].map(JSON.stringify).join('\n'));
  const invoke=r=>executeAction(root,owner,()=>JSON.stringify(r),{agentRoot});
  const created=await invoke({action:'create_run'});assert.equal(created.exit_code,0,JSON.stringify(created));const run_id=created.run_id,dir=resolve(root,'output/runs',run_id);
  const call=async r=>{const result=await invoke({run_id,...r});assert.equal(result.exit_code,0,JSON.stringify(result));return result;};
  await call({action:'plan_run',stages:['api_execution'],workflow_mode:'task'});
  await call({action:'archive_input',name:'request.txt',text});
  const p=plan(url,[step(`${url}/items`),{...step(`${url}/private`,'authenticated'),auth:{type:'bearer',credential_key:'api-token'}}]);delete p.write_authorization;p.scenarios[0].source_refs=[{source_path:'inputs/request.txt',quote:'业务码为0'}];
  p.scenarios[0].steps[0].assertions.push({type:'content_type',value:'application/json'});
  if(mismatch)p.scenarios[0].steps.push({...step(`${url}/items`,'wrong-media'),assertions:[{type:'status',value:200},{type:'content_type',value:'text/plain'}]});
  await call({action:'archive_input',name:'cases.json',text:JSON.stringify(p)});
  await call({action:'dispatch',stage:'api_execution',agent:'api_automation_agent',skills:['api-test-execution','api-testing']});
  const previous=process.env.QA_APP_DATA_ROOT;process.env.QA_APP_DATA_ROOT=mkdtempSync(resolve(tmpdir(),'qa-api-private-'));
  try {
    const action=operation=>call({action:'api_task',operation});
    assert.equal((await action({type:'prepare',cases_path:'inputs/cases.json'})).result.status,'prepared');
    const start=await action({type:'start'});assert.equal(start.result.status,'starting');
    let waiting;for(let i=0;i<100;i++){waiting=(await action({type:'status'})).result;if(waiting.status==='waiting_human')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(waiting.status,'waiting_human');assert.equal(calls.length,1,'No authenticated request before credentials');
    let snapshotReport;
    if(!mismatch) {
      const snapshot=(await action({type:'collect',partial:true})).result;
      const captured=JSON.parse(readFileSync(resolve(dir,snapshot.result_path)));
      assert.equal(captured.status,'partial');assert.equal(captured.finished_at,null);
      assert.equal(captured.summary.blocked,1);assert.equal(captured.cases[0].assertions.length,3,'Completed request assertions survive an unfinished scenario');
      assert.equal(captured.cases[0].evidence_paths.length,1);
      const receiptPath=resolve(dir,'execution/api/evidence/r1.json'),originalReceipt=readFileSync(receiptPath);
      writeFileSync(receiptPath,'{}');
      await assert.rejects(()=>apiTask(root,run_id,owner,{type:'collect',partial:true}),/consistent API snapshot/);
      writeFileSync(receiptPath,originalReceipt);
      await assert.rejects(()=>apiTask(root,run_id,owner,{type:'collect',partial:'yes'}),/boolean/);
      const request=snapshot.report_template;
      assert.throws(()=>createApiSnapshotReport(root,run_id,owner,'execution/api/snapshots/'+'0'.repeat(64)+'/snapshot.json'),/missing/);
      snapshotReport=(await call(request)).result;
      assert.deepEqual((await call(request)).result,snapshotReport,'Same snapshot reuses one report run');
      assert.deepEqual((await call({action:'create_api_snapshot_report'})).result,snapshotReport,'Controller can capture current progress without resuming the worker');
      assert.throws(()=>createApiSnapshotReport(root,run_id,'another-controller',snapshot.snapshot_path),/owned/);
      const reportDir=resolve(root,'output/runs',snapshotReport.run_id),manifest=JSON.parse(readFileSync(resolve(reportDir,'manifest.json')));
      const project=JSON.parse(readFileSync(resolve(root,'config/project.json')));
      assert.throws(()=>extendRunPlan(root,project,snapshotReport.run_id,['api_execution'],'Cannot replay'),/cannot execute/);
      const raw=readFileSync(resolve(reportDir,'inputs/api-snapshot.json'));
      writeFileSync(resolve(reportDir,'inputs/api-snapshot.json'),JSON.stringify({...captured,status:'completed'}));
      assert.throws(()=>verifySnapshotReport(reportDir,manifest),/changed/);
      writeFileSync(resolve(reportDir,'inputs/api-snapshot.json'),raw);
      const delegated=await call(snapshotReport.dispatch_template);
      const put=(path,value)=>writeFileSync(resolve(reportDir,path),typeof value==='string'?value:JSON.stringify(value));
      put('report/report-task.json',{run_id:snapshotReport.run_id,stage:'report',outcome:'partial',summary:'认证等待期间的时点报告',source_paths:['inputs/api-snapshot.json'],questions:[],limitations:['原接口任务仍在等待认证，未测部分不计通过']});
      put('report/reportable-results.json',{run_id:snapshotReport.run_id,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}});
      put('report/issues.json',[]);put('report/test_report.md','# 接口部分报告\n截至快照时刻。');
      await call({action:'export_report',run_id:snapshotReport.run_id});
      const report=JSON.parse(readFileSync(resolve(reportDir,'report/reportable-results.json')));
      assert.equal(report.status,'partial');assert.equal(report.finished_at,null);assert.equal(report.snapshot_at,captured.snapshot_at);
      assert.deepEqual(report.cases[0].assertions,captured.cases[0].assertions);
      assert.match(readFileSync(resolve(reportDir,'report/test_report.html'),'utf8'),/接口时点快照/);
      assert.match(readFileSync(resolve(reportDir,'report/test_report.html'),'utf8'),/非最终结果/);
      assert.equal(inspectIndependentArtifacts(root,snapshotReport.run_id,'report').status,'passed');
      const child=`session-2026-10-21-00-00-01-${randomUUID().replaceAll('-','')}`,at=new Date().toISOString(),tool=randomUUID();
      const childDir=resolve(agentRoot,'test_report_agent/traces/2026-10-21');mkdirSync(childDir,{recursive:true});
      writeFileSync(resolve(childDir,`${child}_001.jsonl`),[
        {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(agentRoot,'test_report_agent/agent_state'),workspace:root}},
        {type:'model_msg',payload:{type:'text',role:'user',text:delegated.delegation.prompt}},
        {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic partial snapshot report is ready.'}},
        {type:'event_msg',payload:{type:'request_end',status:'completed'}}
      ].map(row=>JSON.stringify({timestamp:at,...row})).join('\n'));
      writeFileSync(file,readFileSync(file,'utf8')+'\n'+[
        {type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:tool,arguments:delegated.delegation}},
        {type:'event_msg',payload:{type:'subagent',session_id:child}},
        {type:'model_msg',payload:{type:'tool_call_output',tool_call_id:tool,stop_reason:'completed',output:'Synthetic snapshot report returned'}}
      ].map(row=>JSON.stringify({timestamp:at,...row})).join('\n'));
      const handedSnapshot=await call(delegated.handoff_template);
      assert.match(JSON.stringify(handedSnapshot),/接口时点快照测试报告\.html/);
      assert.equal(JSON.parse(readFileSync(resolve(reportDir,'manifest.json'))).stages.report.status,'completed');
      assert.equal(JSON.parse(readFileSync(resolve(dir,'manifest.json'))).stages.api_execution.status,'in_progress');
      assert.equal((await action({type:'status'})).result.status,'waiting_human');assert.equal(calls.length,1);
      snapshotReport={...snapshotReport,reportDir,sourceHash:apiHash(raw)};
    }
    const credential=protectedInputs().put(owner,'synthetic-private-token');
    await action({type:'resume',credentials:{'api-token':credential}});
    let state;for(let i=0;i<100;i++){state=(await action({type:'status'})).result;if(['completed','failed','interrupted'].includes(state.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(state.status,'completed',JSON.stringify(state));
    await action({type:'start'});assert.equal(calls.length,mismatch?3:2);assert.equal(calls[1].auth,'Bearer synthetic-private-token');
    await action({type:'collect'});
    const results=JSON.parse(readFileSync(resolve(dir,'execution/api/test_results.json')));assert.equal(results.summary[mismatch?'failed':'passed'],1);
    if(snapshotReport){assert.equal(apiHash(readFileSync(resolve(snapshotReport.reportDir,'inputs/api-snapshot.json'))),snapshotReport.sourceHash);assert.equal(inspectIndependentArtifacts(root,snapshotReport.run_id,'report').status,'passed');}
    assert.equal(results.cases[0].assertions.find(a=>a.type==='content_type')?.status,'passed');
    if(mismatch)assert.deepEqual(results.cases[0].assertions.at(-1),{type:'content_type',path:'',status:'failed',actual_type:'string',actual:'application/json',expected:'text/plain'});
    assert(!readFileSync(resolve(dir,'execution/api/evidence/authenticated.json'),'utf8').includes('synthetic-private-token'));
    const inspected=inspectIndependentArtifacts(root,run_id,'api_execution');assert.equal(inspected.status,'passed',JSON.stringify(inspected.errors));
    const summary=JSON.parse(readFileSync(resolve(dir,'quality/execution-summary.json')));assert.deepEqual(summary.selected_branches,['api_execution']);assert.equal(summary.cases.length,1);
    // Synthetic completion metadata only: this is an engineering exporter test, not a native Agent acceptance.
    const manifest=JSON.parse(readFileSync(resolve(dir,'manifest.json')));
    manifest.stages.api_execution.status='completed';manifest.orchestration.events.push({type:'completed',stage:'api_execution',dispatch_id:results.dispatch_id,at:new Date().toISOString(),evidence:{artifact_contract:inspected}});
    writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest));
    await call({action:'extend_plan',stages:['report'],reason:'合成工程报告导出验证'});
    await call({action:'dispatch',stage:'report',agent:'test_report_agent',skills:['test-report-writing']});
    const put=(path,data)=>writeFileSync(resolve(dir,path),typeof data==='string'?data:JSON.stringify(data));
    put('report/report-task.json',{run_id,stage:'report',outcome:'completed',summary:'接口工程合成结果',source_paths:['execution/api/test_results.json'],questions:[],limitations:[]});
    put('report/test_report.md','# 接口工程合成报告\n仅验证工具和导出，不代表实际业务验收。');
    put('report/reportable-results.json',{run_id,cases:[],summary:{total:0,passed:0,failed:0,blocked:0,skipped:0}});put('report/issues.json',[]);
    await call({action:'export_report'});
    const report=JSON.parse(readFileSync(resolve(dir,'report/reportable-results.json')));assert.equal(report.cases[0].source_case_id,'C1');assert.equal(report.summary[mismatch?'failed':'passed'],1);
    assert.deepEqual(report.cases[0].assertions.find(a=>a.type==='content_type'),results.cases[0].assertions.find(a=>a.type==='content_type'));
    assert.deepEqual(report.cases[0].assertions,results.cases[0].assertions);
    assert.match(readFileSync(resolve(dir,'report/test_report.html'),'utf8'),/<!doctype html>/i);
    assert.equal(existsSync(resolve(dir,'report/test_report.pdf')),false);
    assert.equal(inspectIndependentArtifacts(root,run_id,'report').status,'passed');
  } finally {if(previous===undefined)delete process.env.QA_APP_DATA_ROOT;else process.env.QA_APP_DATA_ROOT=previous;}
}));
