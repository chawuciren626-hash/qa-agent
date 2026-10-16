import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { chromium } from '@playwright/test';
import { writeJson } from '../../scripts/orchestration-state.mjs';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { inspectIndependentArtifacts } from '../../scripts/independent-task.mjs';
import { readControllerSession } from '../../scripts/controller-command-session.mjs';
import { validateBrowserOperation, browserErrorDiagnostic, browserRecoveryHint, browserRequestPolicy, captureBrowserEvidence, browserWorkerResponse, waitForBrowserContent, observeFeedbackPaint, beginDynamicFeedback, endDynamicFeedback } from '../../scripts/browser-task.mjs';
const root=resolve(import.meta.dirname,'../..');
const pause=ms=>new Promise(done=>setTimeout(done,ms));

test('worker HTTP rejection is distinct from an uncertain action outcome',async()=>{
  const response=(status,body)=>new Response(body===undefined?null:JSON.stringify(body),{status});
  const rejected={status:'invalid_operation',operation_started:false,diagnostic:{category:'duplicate_case_id'}};
  assert.deepEqual(await browserWorkerResponse(response(400,rejected),'same-id'),rejected);
  assert.equal((await browserWorkerResponse(response(403),'same-id')).status,'worker_access_rejected');
  const busy=await browserWorkerResponse(response(409),'same-id');
  assert.equal(busy.status,'worker_busy');assert.equal(busy.request_id,'same-id');
  assert.equal(busy.operation_started,false);
  await assert.rejects(()=>browserWorkerResponse(response(400,{status:'invalid_operation'}),'same-id'));
  await assert.rejects(()=>browserWorkerResponse(response(500,rejected),'same-id'));
  await assert.rejects(()=>browserWorkerResponse(new Response('broken',{status:400}),'same-id'));
});

test('private connection publication remains complete JSON during concurrent polling',async t=>{
  const dir=resolve(root,'output/acceptance',randomUUID());mkdirSync(dir,{recursive:true});
  const path=resolve(dir,'browser-private.json');
  writeJson(path,{port:null,token:'synthetic'},{mode:0o600});
  const writer=new Worker(`const {workerData}=require('node:worker_threads');
    import(workerData.module).then(({writeJson})=>{
      for(let i=0;i<300;i++) writeJson(workerData.path,{port:10000+i,token:'synthetic',padding:'x'.repeat(32000)},{mode:0o600});
    });`,{eval:true,workerData:{path,module:new URL('../../scripts/orchestration-state.mjs',import.meta.url).href}});
  t.after(()=>writer.terminate());
  let done=false,error,exit;
  writer.on('error',value=>{error=value;done=true;});
  writer.on('exit',code=>{exit=code;done=true;});
  let reads=0;
  while(!done) {
    const value=JSON.parse(readFileSync(path,'utf8'));assert.equal(value.token,'synthetic');reads++;
    await pause(1);
  }
  assert.ifError(error);assert.equal(exit,0);assert.ok(reads>0);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).port,10299);
  if(process.platform!=='win32') assert.equal(statSync(path).mode & 0o777,0o600);
});

async function fixture(url,{lifecycle=false}={}) {
  const parent=`session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',randomUUID()), traces=resolve(agentRoot,'test_agent/traces/2026-10-13');mkdirSync(traces,{recursive:true});
  const parentFile=resolve(traces,`${parent}_001.jsonl`);
  writeFileSync(parentFile,JSON.stringify({type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}));
  const sourceText=`请对 ${url} 执行全流程测试，登录时由我处理。仅使用本地合成页面。`;
  if(lifecycle) writeFileSync(parentFile,readFileSync(parentFile,'utf8')+'\n'+JSON.stringify({type:'model_msg',timestamp:new Date().toISOString(),payload:{type:'text',role:'user',text:sourceText}}));
  const call=r=>executeAction(root,parent,()=>JSON.stringify(r),{agentRoot});
  const created=await call({action:'create_run'});assert.equal(created.exit_code,0);
  const id=created.run_id,dir=resolve(root,'output/runs',id),send=r=>call({run_id:id,...r});
  assert.equal((await send({action:'archive_input',name:'request.txt',text:`${url} Please test adding a synthetic record in this engineering fixture.`})).exit_code,0);
  assert.equal((await send({action:'plan_run',stages:['execution']})).exit_code,0);
  if(lifecycle) {
    // Synthetic sealed design isolates the execution adapter; this is not a real Agent design run.
    const path=resolve(dir,'manifest.json'),m=JSON.parse(readFileSync(path));
    writeJson(resolve(dir,'design/test_cases.json'),[{case_id:'TC-1',title:'Observed case',expected:'Visible fixture',steps:['Inspect heading'],preconditions:[],priority:'P1'},{case_id:'TC-2',title:'Unexecuted case',expected:'Not tested',steps:['Not run'],preconditions:[],priority:'P2'}]);
    const hash=createHash('sha256').update(readFileSync(resolve(dir,'design/test_cases.json'))).digest('hex');
    m.orchestration.plan.workflow_mode='lifecycle';
    const execution=m.orchestration.plan.stages.find(s=>s.id==='execution');execution.depends_on=['test_cases'];execution.confirmation='before';
    const design=m.orchestration.plan.stages.find(s=>s.id==='test_cases');Object.assign(design,{selected:true,depends_on:[],confirmation:'none'});m.stages.test_cases.status='completed';
    m.orchestration.events.push({type:'completed',stage:'test_cases',evidence:{artifact_contract:{version:1,run_id:id,stage:'test_cases',status:'passed',files:[{path:'design/test_cases.json',sha256:hash}]}}});
    writeJson(path,m);
    const denied=await send({action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution'],mode:'browser'});
    assert.equal(denied.status,'rejected','Native authorization cannot be omitted');
  }
  const dispatch=()=>send({action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution'],...(lifecycle?{mode:'browser',source_text:sourceText}:{})});
  const dispatched=await dispatch();assert.equal(dispatched.exit_code,0,JSON.stringify(dispatched));
  const browser=async operation=>{
    const result=await send({action:'browser_task',operation});assert.equal(result.exit_code,0,JSON.stringify(result));return result.data;
  };
  const append=rows=>writeFileSync(parentFile,readFileSync(parentFile,'utf8')+'\n'+rows.map(r=>JSON.stringify(r)).join('\n'));
  const returnChild=async delegation=>{
    const child=`session-2026-10-13-00-00-01-${randomUUID().replaceAll('-','')}`,at=new Date().toISOString(),toolId=randomUUID();
    append([
      {timestamp:at,type:'model_msg',payload:{type:'tool_call',name:'run_subagent',tool_call_id:toolId,arguments:delegation}},
      {timestamp:at,type:'event_msg',payload:{type:'subagent',session_id:child}},
      {timestamp:at,type:'model_msg',payload:{type:'tool_call_output',tool_call_id:toolId,stop_reason:'completed',output:'Synthetic child returned'}}
    ]);
    const childDir=resolve(agentRoot,delegation.agent_id,'traces/2026-10-13');mkdirSync(childDir,{recursive:true});
    writeFileSync(resolve(childDir,`${child}_001.jsonl`),[
      {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(agentRoot,delegation.agent_id,'agent_state'),workspace:root}},
      {type:'model_msg',payload:{type:'text',role:'user',text:delegation.prompt}},
      {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic browser task return'}},
      {type:'event_msg',payload:{type:'request_end',status:'completed'}}
    ].map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
  };
  return {id,dir,parent,agentRoot,send,browser,dispatched,append,returnChild};
}

test('lifecycle browser execution resumes human login and hands partial truthful results to defects and Word/PDF reports',async t=>{
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Lifecycle fixture</h1>');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url,{lifecycle:true});
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic local heading checks only',headless:true});
  await f.browser({type:'pause',request_id:'login',kind:'access',question:'Synthetic login completed?'});
  await f.returnChild(f.dispatched.delegation);
  f.append([{timestamp:new Date().toISOString(),type:'model_msg',payload:{type:'text',role:'user',text:'已登录，继续'}}]);
  const resumed=await f.send({action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution'],mode:'resume_browser'});
  assert.equal(resumed.exit_code,0,JSON.stringify(resumed));
  assert.equal((await f.browser({type:'snapshot',request_id:'continue'})).status,'ready');
  await f.browser({type:'assert',request_id:'passed',target:{by:'role',value:'heading'},condition:'text',value:'Lifecycle fixture',case_id:'CHECK-1',title:'Observed heading',expected:'Lifecycle fixture',case_ref:{source_path:'design/test_cases.json',case_id:'TC-1'}});
  await f.browser({type:'assert',request_id:'failed',target:{by:'role',value:'heading'},condition:'text',value:'Intentionally wrong',case_id:'CHECK-2',title:'Synthetic failure',expected:'Intentionally wrong',case_ref:{source_path:'design/test_cases.json',case_id:'TC-1'}});
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'One mapped case, one untested',limitations:['Synthetic checks only']});
  assert.equal(finished.partial,true);
  const task=(stage,source_paths)=>({run_id:f.id,stage,outcome:'partial',summary:'Synthetic lifecycle delivery',questions:[],limitations:['Not all designed cases were tested'],source_paths});
  writeJson(resolve(f.dir,'execution/execution-task.json'),task('execution',['inputs/request.txt','design/test_cases.json']));
  await f.returnChild(resumed.delegation);
  const handed=await f.send(resumed.handoff_template);assert.equal(handed.exit_code,0,JSON.stringify(handed));
  assert.equal(handed.data.stage_status,'completed');
  assert.equal(existsSync(resolve(f.dir,'execution/execution-plan.json')),false);
  assert.equal(existsSync(resolve(f.dir,'environment/test-env.json')),false);
  const extended=await f.send({action:'extend_plan',stages:['defects','report'],reason:'Complete originally requested lifecycle'});assert.equal(extended.exit_code,0,JSON.stringify(extended));
  const defects=await f.send(extended.dispatch_templates.find(r=>r.stage==='defects'));assert.equal(defects.exit_code,0,JSON.stringify(defects));
  const actual=JSON.parse(readFileSync(resolve(f.dir,'execution/test_results.json'))),failure=actual.cases.find(r=>r.status==='failed');
  const records=[{defect_id:'BUG-1',title:'Synthetic assertion failure',category:'needs_review',related_cases:[failure.case_id],evidence_refs:failure.evidence_paths}];
  writeJson(resolve(f.dir,'defects/defect-records.json'),records);
  writeFileSync(resolve(f.dir,'defects/bugs.md'),'# Synthetic failure classification\nNeeds review; not a confirmed product bug.');
  const defectTaskPath=JSON.parse(readFileSync(resolve(root,'config/orchestration-workflow.json'))).stages.find(s=>s.id==='defects').task_result;
  writeJson(resolve(f.dir,defectTaskPath),task('defects',['execution/test_results.json']));
  await f.returnChild(defects.delegation);
  assert.equal((await f.send(defects.handoff_template)).exit_code,0);
  const report=await f.send(extended.dispatch_templates.find(r=>r.stage==='report'));assert.equal(report.exit_code,0,JSON.stringify(report));
  const rows=actual.cases;
  writeJson(resolve(f.dir,'report/reportable-results.json'),{run_id:f.id,cases:rows,summary:{total:rows.length,...Object.fromEntries(['passed','failed','blocked','skipped'].map(s=>[s,rows.filter(r=>r.status===s).length]))}});
  writeJson(resolve(f.dir,'report/issues.json'),records);
  writeFileSync(resolve(f.dir,'report/test_report.md'),'# Synthetic lifecycle report\nOne passing assertion, one failing assertion; TC-2 was not tested. Linked assertions do not prove completion of all case steps.');
  writeJson(resolve(f.dir,'report/report-task.json'),task('report',['execution/test_results.json','execution/browser-coverage.json','defects/defect-records.json']));
  const exported=await f.send({action:'export_report'});assert.equal(exported.exit_code,0,JSON.stringify(exported));
  await f.returnChild(report.delegation);
  const delivered=await f.send(report.handoff_template);assert.equal(delivered.exit_code,0,JSON.stringify(delivered));
  for(const path of ['report/test_report.docx','report/test_report.pdf']) assert.ok(statSync(resolve(f.dir,path)).size>100);
  assert.equal(existsSync(resolve(f.dir,'execution/execution-state.json')),false,'Browser evidence is not fabricated as a script invocation');
  const forged=JSON.parse(readFileSync(resolve(f.dir,'report/reportable-results.json')));assert.equal(forged.summary.total,2);assert.equal(forged.design_coverage.untested_cases[0].case_id,'TC-2');delete forged.design_coverage;writeJson(resolve(f.dir,'report/reportable-results.json'),forged);
  assert.match(inspectIndependentArtifacts(root,f.id,'report').errors.join(' '),/coverage/);
});

test('preconditions prevent writes; business response checks distinguish HTTP success, delayed persistence and missing evidence',async t=>{
  let writes=0,stored='';
  const server=createServer(async(req,res)=>{
    if(req.url==='/save') {
      writes++;const payload=JSON.stringify(writes===1?{code:400,token:'DO_NOT_EXPORT_SECRET'}:writes===2?{code:0}:{});
      if(writes===2) stored='Saved record';
      await pause(150);res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(payload)});res.end(payload);return;
    }
    res.setHeader('content-type','text/html');res.end(`<!doctype html><input id="title" value="ready"><button id="save">Save</button><p id="toast" hidden></p><p id="stored">${stored}</p><script>document.querySelector('#save').onclick=()=>{fetch('/save',{method:'POST'});let e=document.querySelector('#toast');e.hidden=false;e.textContent='UI accepted';}</script>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  const quote='HTTP 200 and code 0 mean accepted; saved records appear after reload.';
  assert.equal((await f.send({action:'archive_input',name:'contract.txt',text:`${url}save ${quote}`})).exit_code,0);
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic response checks',headless:true});
  const target={by:'css',value:'#save'},field={by:'css',value:'#title'};
  const response_check={url:`${url}save`,method:'POST',http_status:200,field:'code',equals:0,source_path:'inputs/contract.txt',quote,case_id:'API1',title:'API contract',expected:'Code 0'};
  const missing=await f.browser({type:'click',request_id:'precondition',target,preconditions:[{target:field,condition:'value',value:''}],response_check});
  assert.equal(missing.status,'precondition_not_met');assert.equal(writes,0);assert.equal(missing.operation_started,false);
  const op={type:'click',request_id:'rejected',target,preconditions:[{target:field,condition:'value',value:'ready'}],response_check,
    assertion:{target:{by:'css',value:'#toast'},condition:'text',value:'UI accepted',case_id:'UI1',title:'UI feedback',expected:'UI accepted'}};
  const failed=await f.browser(op);assert.equal(failed.assertion.status,'passed');assert.equal(failed.response_assertion.status,'failed');assert.equal(writes,1);
  assert.equal(failed.assertion.verification_scope.layer,'ui');
  assert.deepEqual(await f.browser(op),failed);assert.equal(writes,1);
  const passed=await f.browser({type:'click',request_id:'accepted',target,response_check:{...response_check,case_id:'API2'}});
  assert.equal(passed.response_assertion.status,'passed');assert.equal(writes,2);
  await f.browser({type:'goto',request_id:'reload',url,source_path:'inputs/request.txt'});
  const persisted=await f.browser({type:'assert',request_id:'stored',target:{by:'css',value:'#stored'},condition:'text',value:'Saved record',case_id:'RELOAD1',title:'Reloaded view',expected:'Saved record'});
  assert.equal(persisted.assertion.status,'passed');assert.equal(writes,2);
  const absent=await f.browser({type:'click',request_id:'missing-code',target,response_check:{...response_check,case_id:'API3'}});
  assert.equal(absent.response_assertion.status,'blocked');assert.equal(writes,3);
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'Separate UI, API and reloaded-view evidence',limitations:['One response missing code']});
  assert.equal(finished.partial,true);assert.deepEqual(finished.summary,{total:5,passed:3,failed:1,blocked:1,skipped:0});
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'partial',summary:'Synthetic response checks',source_paths:['inputs/request.txt'],questions:[],limitations:['Missing response field']}));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'passed');
  for(const name of ['rejected.response.json','accepted.response.json','missing-code.response.json']) assert.ok(!readFileSync(resolve(f.dir,'execution/browser-evidence',name),'utf8').includes('DO_NOT_EXPORT_SECRET'));
});

test('owned data cleanup preserves pre-existing records, refuses unrelated controls and never replays uncertainty',async t=>{
  let writes=0,deletes=0;
  const server=createServer((req,res)=>{
    if(req.url==='/created') {writes++;res.end('ok');return;}
    if(req.url==='/deleted') {deletes++;res.end('ok');return;}
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><input id="title"><button id="add">Add</button><button id="unrelated">Delete all</button><button id="identity">Change identity</button><ul id="records"><li id="original">Existing user record</li></ul><script>
      let count=0;
      document.querySelector('#identity').onclick=()=>{let li=document.querySelector('#records').lastElementChild;li.dataset.id=li.dataset.id==='changed'?String(count):'changed';};
      document.querySelector('#unrelated').onclick=()=>fetch('/deleted',{method:'POST'});
      document.querySelector('#add').onclick=()=>{
        count++;let marker=document.querySelector('#title').value,li=document.createElement('li');li.dataset.id=String(count);li.dataset.marker=marker;li.append(document.createTextNode(marker));
        let button=document.createElement('button');button.textContent='Remove';const removable=count===1;
        button.onclick=()=>{fetch('/deleted',{method:'POST'});if(removable)li.remove();};li.append(button);document.querySelector('#records').append(li);fetch('/created',{method:'POST'});
      };</script>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  await f.send({action:'archive_input',name:'cleanup-scope.txt',text:'Synthetic test scope includes creating and removing only records created in this task. Preserve existing records.'});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic create and cleanup checks',headless:true});
  const input={by:'css',value:'#title'};
  for(const key of ['one','two']) {
    const prepared=await f.browser({type:'data_prepare',request_id:`prepare-${key}`,key});
    const marker=prepared.data.marker,record_target={by:'css',value:`li[data-marker="${marker}"]`};
    await f.browser({type:'fill',request_id:`fill-${key}`,target:input,value:marker});
    if(key==='one') {
      const absent=await f.browser({type:'click',request_id:'unowned',target:{by:'css',value:'#unrelated'},data_effect:{kind:'cleanup',key:'foreign',record_target:{by:'css',value:'#original'}}});
      assert.equal(absent.status,'data_tracking_unavailable');assert.equal(deletes,0);
      const unprepared=await f.browser({type:'click',request_id:'without-input-check',target:{by:'css',value:'#add'},data_effect:{kind:'create',key,record_target}});
      assert.equal(unprepared.status,'correctable_error');assert.equal(writes,0);
      const collision=await f.browser({type:'click',request_id:'existing-record',target:{by:'css',value:'#add'},preconditions:[{target:input,condition:'value',value:marker}],data_effect:{kind:'create',key,record_target:{by:'css',value:'#original'}}});
      assert.equal(collision.status,'correctable_error');assert.equal(writes,0);
    }
    const created=await f.browser({type:'click',request_id:`create-${key}`,target:{by:'css',value:'#add'},preconditions:[{target:input,condition:'value',value:marker}],data_effect:{kind:'create',key,record_target}});
    assert.equal(created.test_data.status,'created_observed');
    const invalid=await f.browser({type:'click',request_id:`outside-${key}`,target:{by:'css',value:'#unrelated'},data_effect:{kind:'cleanup',key,record_target}});
    assert.equal(invalid.status,'correctable_error');assert.equal(deletes,key==='one'?0:1);
    const operation={type:'click',request_id:`remove-${key}`,target:{by:'css',value:`${record_target.value} button`},data_effect:{kind:'cleanup',key,record_target}};
    if(key==='two') {
      await f.browser({type:'click',request_id:'identity-change',target:{by:'css',value:'#identity'}});
      const changed=await f.browser({...operation,request_id:'changed-record'});
      assert.equal(changed.status,'correctable_error');assert.equal(deletes,1);
      await f.browser({type:'click',request_id:'identity-restore',target:{by:'css',value:'#identity'}});
    }
    const removed=await f.browser(operation);
    assert.equal(removed.test_data.status,key==='one'?'removed_from_view':'cleanup_uncertain');
    assert.deepEqual(await f.browser(operation),removed);
    const repeated=await f.browser({...operation,request_id:`retry-${key}`});
    assert.equal(repeated.status,'data_tracking_unavailable');assert.equal(repeated.operation_started,false);
  }
  assert.equal(writes,2);assert.equal(deletes,2);
  const original=await f.browser({type:'assert',request_id:'original',target:{by:'css',value:'#original'},condition:'text',value:'Existing user record',case_id:'KEEP',title:'Preserved existing record',expected:'Existing user record'});
  assert.equal(original.assertion.status,'passed');
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'Preserve existing data and report uncertain cleanup',limitations:['Second synthetic removal did not change the page']});
  assert.equal(finished.cleanup.tracked,2);assert.equal(finished.cleanup.possible_residuals,1);assert.equal(finished.cleanup.removed_from_view,1);
  assert.equal(finished.summary.total,1);assert.equal(finished.partial,false);
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'completed',summary:'Synthetic cleanup evidence',source_paths:['inputs/request.txt','inputs/cleanup-scope.txt'],questions:[],limitations:['One tracked residual']}));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'passed');
  const ledgerPath=resolve(f.dir,'execution/browser-data-ledger.json'),ledger=JSON.parse(readFileSync(ledgerPath));
  assert.equal(ledger.run_id,f.id);assert.equal(ledger.items[1].status,'cleanup_uncertain');
  writeFileSync(ledgerPath,JSON.stringify({...ledger,items:[]}));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'blocked');
});

test('case references and read-only rechecks preserve failures without inflating cases or replaying actions',async t=>{
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><input id="value" value="not ready"><input id="other" value="ready">');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  await f.send({action:'archive_input',name:'cases.json',text:JSON.stringify({cases:[{case_id:'DESIGN1',expected:'Field value is ready'}]})});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic read-only recheck statistics',headless:true});
  const check={type:'assert',request_id:'first',target:{by:'css',value:'#value'},condition:'value',value:'ready',case_id:'A1',title:'Ready',expected:'Field value is ready',case_ref:{source_path:'inputs/cases.json',case_id:'DESIGN1'}};
  const failed=await f.browser(check);assert.equal(failed.assertion.status,'failed');
  const invalid=await f.browser({...check,request_id:'invalid',case_id:'A2',recheck_of:'A1',target:{by:'css',value:'#other'}});
  assert.equal(invalid.status,'invalid_operation');assert.equal(invalid.operation_started,false);
  await f.browser({type:'fill',request_id:'prepare',target:check.target,value:'ready'});
  const second={...check,request_id:'second',case_id:'A2',recheck_of:'A1'};
  const passed=await f.browser(second);assert.equal(passed.assertion.status,'passed');
  assert.deepEqual(await f.browser(second),passed);
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'One design case with two observations',limitations:['Only the stated field assertion was observed, not whole-case completion']});
  assert.equal(finished.summary.total,2);assert.equal(finished.summary.failed,1);assert.equal(finished.statistics.linked_case_count,1);
  assert.equal(finished.statistics.read_only_rechecks,1);assert.equal(finished.statistics.rechecks_passed_after_failure,1);
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'completed',summary:'Synthetic statistics',source_paths:['inputs/request.txt','inputs/cases.json'],questions:[],limitations:['Original failure retained']}));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'passed');
});

test('scoped API checks and one-shot GET faults retain real/simulated evidence and restore routing',async t=>{
  let gets=0,heads=0,writes=0;
  const server=createServer((req,res)=>{
    if(!['GET','HEAD'].includes(req.method)) writes++;
    if(req.url==='/data') {if(req.method==='HEAD') heads++;else gets++;res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,token:'SECRET_RESPONSE_MUST_NOT_BE_EXPORTED'}));return;}
    if(req.url==='/redirect') {res.writeHead(302,{location:'/data'});res.end();return;}
    if(req.url==='/oversized') {res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,large:'x'.repeat(70000)}));return;}
    res.setHeader('content-type','text/html');res.end(`<!doctype html><button id="load">Load</button><button id="no-request">No request</button><p id="status">Idle</p><script>
      document.querySelector('#load').onclick=async()=>{try{let r=await fetch('/data');document.querySelector('#status').textContent=r.ok?'Loaded':'Load failed';}catch{document.querySelector('#status').textContent='Load failed';}};
      document.querySelector('#no-request').onclick=()=>{document.querySelector('#status').textContent='Load failed';};</script>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  const quote='Authorize GET/HEAD checks and one-request read failure simulation. HTTP 200 and code 0 mean accepted. Show Load failed on read error.';
  await f.send({action:'archive_input',name:'api.txt',text:`${url}data ${url}redirect ${url}oversized ${quote}`});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic read checks and explicitly requested fault simulation',headless:true});
  const check={url:`${url}data`,method:'GET',http_status:200,field:'code',equals:0,source_path:'inputs/api.txt',quote,case_id:'API',title:'Data API',expected:'Contract matched'};
  const missingSource=await f.browser({type:'api_check',request_id:'bad-source',check:{...check,quote:'not in current source'}});
  assert.equal(missingSource.operation_started,false);assert.equal(gets,0);
  const foreign=await f.browser({type:'api_check',request_id:'foreign',check:{...check,url:'http://outside.invalid/data'}});
  assert.equal(foreign.operation_started,false);assert.equal(gets,0);
  const op={type:'api_check',request_id:'api',check};const api=await f.browser(op);assert.equal(api.response_assertion.status,'passed');assert.equal(gets,1);
  assert.deepEqual(await f.browser(op),api);assert.equal(gets,1);
  const head=await f.browser({type:'api_check',request_id:'head',check:{...check,method:'HEAD',field:undefined,equals:undefined,case_id:'HEAD'}});assert.equal(head.response_assertion.status,'passed');assert.equal(heads,1);
  const redirect=await f.browser({type:'api_check',request_id:'redirect',check:{...check,url:`${url}redirect`,case_id:'REDIRECT'}});assert.equal(redirect.response_assertion.status,'blocked');assert.equal(gets,1);
  const large=await f.browser({type:'api_check',request_id:'large',check:{...check,url:`${url}oversized`,case_id:'LARGE'}});assert.equal(large.response_assertion.status,'blocked');
  const fault={url:`${url}data`,method:'GET',mode:'http_error',http_status:503,source_path:'inputs/api.txt',quote};
  const assertion={target:{by:'css',value:'#status'},condition:'text',value:'Load failed',case_id:'SIM',title:'Simulated read failure',expected:'Load failed'};
  const simulated=await f.browser({type:'click',request_id:'simulate',target:{by:'css',value:'#load'},fault,assertion});
  assert.equal(simulated.simulation.applied,true);assert.equal(simulated.simulation.disabled,true);assert.equal(simulated.assertion.evidence_mode,'simulated');assert.equal(gets,1);
  const later=await f.browser({type:'assert',request_id:'later',...assertion,case_id:'LATER'});assert.equal(later.assertion.evidence_mode,'simulation_affected');
  const real=await f.browser({type:'api_check',request_id:'real-after',check:{...check,case_id:'AFTER'}});assert.equal(real.response_assertion.status,'passed');assert.equal(gets,2);
  await f.browser({type:'goto',request_id:'reload',url,source_path:'inputs/request.txt'});
  const missed=await f.browser({type:'click',request_id:'missed',target:{by:'css',value:'#no-request'},fault,assertion:{...assertion,case_id:'MISSED'}});
  assert.equal(missed.simulation.applied,false);assert.equal(missed.assertion.status,'blocked');assert.equal(missed.simulation.disabled,true);
  await f.browser({type:'goto',request_id:'reload-abort',url,source_path:'inputs/request.txt'});
  const aborted=await f.browser({type:'click',request_id:'abort',target:{by:'css',value:'#load'},fault:{...fault,mode:'abort',http_status:undefined},assertion:{...assertion,case_id:'ABORT'}});
  assert.equal(aborted.simulation.applied,true);assert.equal(aborted.assertion.status,'passed');assert.equal(gets,2);assert.equal(writes,0);
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'Separate synthetic faults and real API checks',limitations:['Redirect and oversized response not evaluated']});
  assert.equal(finished.partial,true);assert.equal(finished.statistics.evidence_modes.simulated,3);assert.equal(finished.statistics.evidence_modes.simulation_affected,1);
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'partial',summary:'Synthetic API controls',source_paths:['inputs/request.txt','inputs/api.txt'],questions:[],limitations:['Some checks inconclusive']}));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'passed');
  assert.ok(!readFileSync(resolve(f.dir,'execution/browser-evidence/api.api.json'),'utf8').includes('SECRET_RESPONSE_MUST_NOT_BE_EXPORTED'));
});

test('operation contract rejects arbitrary evaluation, ambiguous targets and unknown fields',()=>{
  assert.throws(()=>validateBrowserOperation({type:'eval',request_id:'x',code:'alert(1)'}));
  assert.throws(()=>validateBrowserOperation({type:'fill',request_id:'../x',target:{by:'css',value:'#a'},value:'x'}));
  assert.throws(()=>validateBrowserOperation({type:'click',request_id:'x',target:{by:'css',value:'#a'},approval:true}));
  assert.throws(()=>validateBrowserOperation({type:'pause',request_id:'x',kind:'unlock',question:'Repair state'}));
  assert.throws(()=>validateBrowserOperation({type:'assert',request_id:'x',case_id:'C1',title:'x',expected:'x',target:{by:'css',value:'#a'},condition:'count',value:-1}));
  assert.throws(()=>validateBrowserOperation({type:'click',request_id:'x',target:{by:'css',value:'#a'},assertion:{type:'click'}}));
  assert.throws(()=>validateBrowserOperation({type:'click',request_id:'x',target:{by:'css',value:'#a'},assertion:{target:{by:'css',value:'#b'},condition:'text'}}));
  const base={type:'assert',request_id:'text-check',target:{by:'text',value:'Observed message'},condition:'text',case_id:'TEXT1',title:'Message',expected:'Observed message'};
  assert.doesNotThrow(()=>validateBrowserOperation(base));
  assert.throws(()=>validateBrowserOperation({...base,target:{by:'css',value:'#message'}}));
  assert.throws(()=>validateBrowserOperation({...base,value:null}));
  assert.throws(()=>validateBrowserOperation({...base,condition:'value'}));
  assert.throws(()=>validateBrowserOperation({...base,request_id:undefined}),/No operation performed/);
  assert.equal(browserErrorDiagnostic(new Error('Browser already started'),'start').category,'browser_already_started');
  assert.match(browserRecoveryHint('browser_already_started').message,/not refresh/);
  assert.match(browserRecoveryHint('stale_result').message,/Do not change click to press/);
});

test('action assertions capture transient feedback, reject stale results and never replay failed or successful clicks',async t=>{
  let submissions=0;
  const server=createServer((req,res)=>{
    if(req.url==='/submit') {submissions++;res.end('ok');return;}
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><button id="submit">Submit</button><button id="silent">Silent</button><p id="old">Old feedback</p><p id="toast" hidden></p><script>
      document.querySelector('#submit').onclick=()=>{fetch('/submit');const e=document.querySelector('#toast');e.hidden=false;e.textContent='Fresh feedback';setTimeout(()=>e.hidden=true,1200)};
      document.querySelector('#silent').onclick=()=>fetch('/submit');
    </script>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{
    if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Fixture cleanup',limitations:[]}).catch(()=>{});
    await pause(1300);await new Promise(done=>server.close(done));
  });
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic feedback checks',headless:true});
  const mixed=await f.send({action:'explore_url',url,source_path:'inputs/request.txt'});
  assert.equal(mixed.classification,'input_rejected');
  assert.match(mixed.error,/interactive browser/);
  assert.equal(existsSync(resolve(f.dir,'execution/exploration.json')),false);
  const repeatStart=await f.browser({type:'start',request_id:'start-again',url,source_path:'inputs/request.txt',scope:'Synthetic feedback checks',headless:true});
  assert.equal(repeatStart.status,'correctable_error');
  assert.equal(repeatStart.diagnostic.category,'browser_already_started');
  assert.equal(repeatStart.next_action,'snapshot_existing_browser_or_goto_for_new_page_state');
  assert.equal(repeatStart.action_completed,false);
  const check=(case_id,selector,value)=>({case_id,title:case_id,expected:value,target:{by:'css',value:selector},condition:'text',value});
  const stale=await f.browser({type:'click',request_id:'stale',target:{by:'css',value:'#submit'},assertion:check('OLD','#old','Old feedback')});
  assert.equal(stale.status,'correctable_error');assert.equal(stale.diagnostic.category,'stale_result');assert.equal(submissions,0);
  const click={type:'click',request_id:'submit-once',target:{by:'css',value:'#submit'},assertion:{case_id:'FRESH',title:'Fresh feedback',expected:'Fresh feedback',target:{by:'text',value:'Fresh feedback'},condition:'text'}};
  const result=await f.browser(click);assert.equal(result.assertion.status,'passed');
  assert.equal(result.assertion.timing.mode,'same_operation');
  assert.equal(result.assertion.timing.preceding_action.request_id,click.request_id);
  assert.equal(result.network_summary.recent_errors_scope,'session_history_not_causal');
  assert.ok(Array.isArray(result.network_summary.operation_events));
  await pause(1500);
  assert.deepEqual(await f.browser(click),result);assert.equal(submissions,1);
  const duplicate=await f.browser({...click,request_id:'duplicate-case'});
  assert.equal(duplicate.status,'invalid_operation');assert.equal(duplicate.operation_started,false);
  assert.equal(duplicate.diagnostic.category,'duplicate_case_id');assert.equal(submissions,1);
  assert.equal(existsSync(resolve(f.dir,'execution/browser-evidence/duplicate-case.json')),false);
  const late=await f.browser({type:'assert',request_id:'late-observation',...check('LATE','#toast','Fresh feedback')});
  assert.equal(late.assertion.status,'failed');assert.equal(late.assertion.timing.mode,'standalone_observation');
  assert.ok(late.assertion.timing.delay_after_action_ms>=1500);
  assert.equal(late.assertion.timing.preceding_action.request_id,click.request_id);
  assert.equal(submissions,1);
  const failure={type:'click',request_id:'failed-once',target:{by:'css',value:'#silent'},assertion:check('ABSENT','#toast','Never appears')};
  const failed=await f.browser(failure);assert.equal(failed.assertion.status,'failed');
  assert.deepEqual(await f.browser(failure),failed);assert.equal(submissions,2);
  await f.browser({type:'goto',request_id:'new-page',url,source_path:'inputs/request.txt'});
  const navigated=await f.browser({type:'assert',request_id:'new-page-check',...check('NEWPAGE','#old','Old feedback')});
  assert.equal(navigated.assertion.status,'passed');
  assert.equal(navigated.assertion.timing.preceding_action,undefined,'Navigation must discard the previous page action association');
  const finish=await f.browser({type:'finish',request_id:'finish',summary:'One matched, one unmatched',limitations:[]});
  assert.deepEqual(finish.summary,{total:4,passed:2,failed:2,blocked:0,skipped:0});
  writeJson(resolve(f.dir,'execution/execution-task.json'),{run_id:f.id,stage:'execution',outcome:'completed',summary:'Actual action assertions',source_paths:['inputs/request.txt'],questions:[],limitations:[]});
  const checked=inspectIndependentArtifacts(root,f.id,'execution');
  assert.equal(checked.status,'passed',JSON.stringify(checked));
  assert.equal(checked.execution_outcome.status,'failed','Delivery validation must preserve a failed business assertion');
  const observationPath=resolve(f.dir,'execution/exploration.json');
  const observation=JSON.parse(readFileSync(observationPath,'utf8'));
  writeJson(observationPath,{...observation,mode:'read_only_navigation'});
  assert.match(inspectIndependentArtifacts(root,f.id,'execution').errors.join(' '),/cannot replace an interactive browser run/);
});

test('interactive task persists login/form state across human handoff, never replays submit, and delivers real assertions',async t=>{
  let records=0,manual=false,crossOrigin=0,logins=0,captchaReads=0;
  const other=createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');if(req.method==='OPTIONS') {res.end();return;}if(req.method==='POST') crossOrigin++;else captchaReads++;res.end(req.method==='GET'?'Captcha dependency loaded':'Application API available');});
  await new Promise(done=>other.listen(0,'127.0.0.1',done));
  const server=createServer((req,res)=>{
    if(req.url==='/manual') {res.end(manual?'verified':'pending');return;}
    if(req.url==='/login' && req.method==='POST') {logins++;res.setHeader('set-cookie','fixture=logged-in; Path=/');res.end('Authenticated');return;}
    if(req.url==='/add' && req.method==='POST') {
      if(!req.headers.cookie?.includes('fixture=logged-in')) {res.statusCode=401;res.end('Login required');return;}
      records++;res.end(`Created ${records}`);return;
    }
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><html><body><h1>Interactive fixture</h1><label>User<input id="user"></label><label>Password<input id="password" type="password"></label><button id="login">Login</button><p id="auth">Not logged in</p><label>Name<input id="name"></label><button id="add">Add</button><button id="external">External</button><p id="status">Not submitted</p><p id="manual">pending</p><script>
      fetch('http://127.0.0.1:${other.address().port}/captcha?token=never-log-this-token').then(r=>r.text()).then(text=>{const e=document.createElement('p');e.id='captcha';e.textContent=text;document.body.append(e)});
      setInterval(async()=>document.querySelector('#manual').textContent=await(await fetch('/manual')).text(),100);
      document.querySelector('#login').onclick=async()=>document.querySelector('#auth').textContent=await(await fetch('/login',{method:'POST',body:JSON.stringify({user:document.querySelector('#user').value,password:document.querySelector('#password').value})})).text();
      document.querySelector('#add').onclick=async()=>document.querySelector('#status').textContent=await(await fetch('/add',{method:'POST'})).text();
      document.querySelector('#external').onclick=async()=>document.querySelector('#manual').textContent=await(await fetch('http://127.0.0.1:${other.address().port}/outside?token=never-log-this-token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).text();
      </script></body></html>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{
    if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Fixture cleanup',limitations:[]}).catch(()=>{});
    await pause(1300);await new Promise(done=>server.close(done));await new Promise(done=>other.close(done));
  });
  const target=id=>({by:'css',value:`#${id}`});
  assert.equal((await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Add a synthetic fixture record',headless:true})).status,'ready');
  assert.equal((await f.browser({type:'fill',request_id:'fill-name',target:target('name'),value:'Synthetic'})).status,'ready');
  const secret='synthetic-secret-not-for-logs';
  await f.browser({type:'fill',request_id:'fill-user',target:target('user'),value:'synthetic-user'});
  await f.browser({type:'fill',request_id:'fill-password',target:target('password'),value:secret,secret:true});
  await f.browser({type:'click',request_id:'login-once',target:target('login')});
  assert.equal((await f.browser({type:'assert',request_id:'logged-in',target:target('auth'),condition:'text',value:'Authenticated',case_id:'LOGIN-1',title:'Login',expected:'Authenticated'})).assertion.status,'passed');
  const bad=await f.browser({type:'click',request_id:'wrong-selector',target:target('missing')});assert.equal(bad.status,'correctable_error');
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  const waiting=await f.browser({type:'pause',request_id:'captcha-wait',kind:'captcha',question:'Complete the synthetic manual verification in this browser.'});
  assert.equal(waiting.status,'waiting_human');
  const status=await f.send({action:'run_status'});
  assert.equal(status.data.next_action,'wait_for_human_intervention');
  assert.equal(status.data.human_intervention.browser_retained,true);
  await f.returnChild(f.dispatched.delegation);
  const resume={action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution'],mode:'resume_browser'};
  assert.equal((await f.send(resume)).status,'rejected','No automatic invented human response');
  f.append([{timestamp:new Date().toISOString(),type:'model_msg',payload:{type:'text',role:'user',sender:'harness',text:'Synthetic manual step completed; continue.'}}]);
  assert.equal((await f.send(resume)).status,'rejected','Harness notices cannot confirm human intervention');
  f.append([{timestamp:new Date().toISOString(),type:'model_msg',payload:{type:'text',role:'user',text:'Not yet done; wait.'}}]);
  assert.equal((await f.send(resume)).status,'rejected','A native user pause cannot resume the browser');
  manual=true;await pause(15);
  f.append([{timestamp:new Date().toISOString(),type:'model_msg',payload:{type:'text',role:'user',text:'Synthetic manual step completed; continue.'}}]);
  const resumed=await f.send(resume);assert.equal(resumed.exit_code,0,JSON.stringify(resumed));
  assert.ok(resumed.data.event.resumes_dispatch_id);
  assert.ok(resumed.delegation.prompt.includes('HUMAN CONTINUATION'));
  assert.ok(readFileSync(resumed.delegation_contract_path,'utf8').includes('HUMAN CONTINUATION'));
  const snapshot=await f.browser({type:'snapshot',request_id:'after-human'});assert.equal(snapshot.status,'ready',JSON.stringify(snapshot));
  assert.equal(captchaReads,1);assert.ok(snapshot.snapshot.text.includes('Captcha dependency loaded'));
  assert.equal(snapshot.snapshot.fields.find(field=>field.id==='name').selector,'#name');
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  await f.browser({type:'assert',request_id:'kept-form',target:target('name'),condition:'value',value:'Synthetic',case_id:'KEEP-1',title:'Form persists',expected:'Original form value retained'});
  const verified=await f.browser({type:'assert',request_id:'manual-done',target:target('manual'),condition:'text',value:'verified',case_id:'MANUAL-1',title:'Human continuation',expected:'Manual verification state retained'});
  assert.equal(verified.assertion.status,'passed');
  const submission={type:'click',request_id:'submit-once',target:target('add')};
  await f.browser(submission);await f.browser(submission);
  const changed=await f.browser({...submission,target:target('external')});assert.equal(changed.status,'invalid_request');
  assert.equal(readControllerSession(root,f.parent).status,'ready');
  const checked=await f.browser({type:'assert',request_id:'created',target:target('status'),condition:'text',value:'Created 1',case_id:'ADD-1',title:'Add one record',expected:'Exactly one record created'});
  assert.equal(checked.assertion.status,'passed');assert.equal(records,1);assert.equal(logins,1);
  await f.browser({type:'click',request_id:'application-api',target:target('external')});
  await pause(100);assert.equal(crossOrigin,1,'Application API dependencies must not be blocked');
  const network=readFileSync(resolve(f.dir,'execution/browser-network.json'),'utf8');
  assert.ok(network.includes('application_api'));assert.ok(!network.includes('never-log-this-token'));
  const mismatch=await f.browser({type:'assert',request_id:'failure-is-real',target:target('status'),condition:'text',value:'Not the actual value',case_id:'FAIL-1',title:'Intentional negative assertion',expected:'Known impossible fixture expectation'});
  assert.equal(mismatch.assertion?.status,'failed',JSON.stringify(mismatch));
  const finish={type:'finish',request_id:'finish',summary:'Synthetic browser integration completed',limitations:[]};
  const done=await f.browser(finish);assert.equal(done.status,'closed');assert.equal(done.summary.total,5);assert.equal(done.summary.failed,1);
  await pause(1300);assert.deepEqual(await f.browser(finish),done,'Finish receipt remains available after worker exits');
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'completed',summary:'Synthetic interactive assertions',source_paths:['inputs/request.txt'],questions:[],limitations:[]}));
  const contract=inspectIndependentArtifacts(root,f.id,'execution');assert.equal(contract.status,'passed',JSON.stringify(contract.errors));
  await f.returnChild(resumed.delegation);
  const handoff=await f.send(resumed.handoff_template);assert.equal(handoff.exit_code,0,JSON.stringify(handoff));
  assert.equal(handoff.data.stage_status,'completed');
  const raw=readFileSync(resolve(f.dir,'execution/test_results.json'),'utf8');
  const forged=JSON.parse(raw);forged.cases[0].status='failed';writeFileSync(resolve(f.dir,'execution/test_results.json'),JSON.stringify(forged));
  assert.equal(inspectIndependentArtifacts(root,f.id,'execution').status,'blocked');
  assert.equal(existsSync(resolve(f.dir,'execution/browser-private.json')),false);
  const evidence=readFileSync(resolve(f.dir,'execution/browser-evidence/fill-password.json'),'utf8');assert.ok(!evidence.includes(secret));
});

test('snapshot observes nonsemantic controls and checked state without repeating an already satisfied check',async t=>{
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><body><input id="agreement" type="checkbox" checked hidden onchange="document.querySelector(\'#events\').textContent=\'changed\'"><p id="events">untouched</p><div style="cursor:pointer" onclick="document.querySelector(\'#result\').textContent=\'clicked\'"><span id="custom">Custom action</span></div><div hidden style="cursor:pointer">Hidden action</div><p id="result">waiting</p></body></html>');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Fixture cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  const start=await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Inspect synthetic controls',headless:true});
  const field=start.snapshot.fields.find(item=>item.id==='agreement');
  assert.equal(field.checked,true);assert.equal(field.visible,false);
  assert.ok(start.snapshot.controls.some(item=>item.selector==='#custom' && item.text==='Custom action'));
  assert.ok(!start.snapshot.controls.some(item=>item.text==='Hidden action'));
  const same=await f.browser({type:'check',request_id:'same',target:{by:'css',value:'#agreement'},checked:true});
  assert.equal(same.status,'ready');assert.equal(same.unchanged,true);
  const different=await f.browser({type:'check',request_id:'different',target:{by:'css',value:'#agreement'},checked:false});
  assert.equal(different.status,'correctable_error');
  const unmodified=await f.browser({type:'assert',request_id:'not-toggled',target:{by:'css',value:'#events'},condition:'text',value:'untouched',case_id:'CHECK-1',title:'No checkbox side effect',expected:'untouched'});
  assert.equal(unmodified.assertion.status,'passed');
  await f.browser({type:'click',request_id:'custom-click',target:{by:'css',value:'#custom'}});
  assert.equal((await f.browser({type:'assert',request_id:'custom-result',target:{by:'css',value:'#result'},condition:'text',value:'clicked',case_id:'CLICK-1',title:'Custom control',expected:'clicked'})).assertion.status,'passed');
});

test('network policy permits scoped application APIs but not new documents or untrusted frames',()=>{
  const input={url:'https://api.example.net/captcha?token=secret',origin:'https://app.example.org',frameOrigin:'https://app.example.org',resourceType:'fetch',method:'POST'};
  assert.equal(browserRequestPolicy(input),'application_api');
  assert.equal(browserRequestPolicy({...input,resourceType:'xhr',method:'GET'}),'application_api');
  assert.equal(browserRequestPolicy({...input,resourceType:'document'}),'blocked_new_target');
  assert.equal(browserRequestPolicy({...input,frameOrigin:'https://unrelated.example.org'}),'blocked_new_target');
  assert.equal(browserRequestPolicy({...input,url:'file:///private'}),'blocked_protocol');
  assert.equal(browserRequestPolicy({...input,resourceType:'image',method:'GET'}),'static_dependency');
});

test('content wait is bounded and paint observations never mutate or assert business success',async()=>{
  let disposed=false;
  const ready=await waitForBrowserContent({waitForFunction:async(fn,arg,options)=>{assert.equal(options.timeout,1500);return {dispose:async()=>{disposed=true;}};}});
  assert.equal(ready.content_observed,true);assert.equal(disposed,true);
  const timeout=new Error('private text');timeout.name='TimeoutError';
  assert.equal((await waitForBrowserContent({waitForFunction:async()=>{throw timeout;}})).content_observed,false);
  await assert.rejects(()=>waitForBrowserContent({waitForFunction:async()=>{throw new Error('closed');}}),/closed/);
  assert.equal((await observeFeedbackPaint({count:async()=>0})).status,'not_unique_or_absent');
  const hidden={count:async()=>1,evaluate:async()=>({visible:false,opacity:0})};
  assert.equal((await observeFeedbackPaint(hidden)).status,'not_settled');
  const clipped={count:async()=>1,evaluate:async()=>({visible:true,opacity:1,within_viewport:false,x:0,y:-10,width:10,height:10})};
  const result=await observeFeedbackPaint(clipped);
  assert.equal(result.status,'not_settled');assert.ok(result.wait_ms<1000);
});

test('delayed initial rendering returns usable snapshot and animated feedback is captured without a second submission',async t=>{
  let navigations=0,submissions=0;
  const server=createServer((req,res)=>{
    if(req.url==='/submit'){submissions++;res.end('ok');return;}
    if(req.url!=='/'){res.end('');return;}
    navigations++;res.setHeader('content-type','text/html');
    res.end(`<!doctype html><html><head><style>#feedback{position:fixed;top:20px;left:30px;padding:12px;background:white;color:black;opacity:0;transform:translateY(-12px);transition:opacity 120ms linear,transform 120ms linear}</style></head><body><script>
      setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<input value="private input"><button id="submit">Submit</button>');document.querySelector('#submit').onclick=()=>{
        fetch('/submit');const e=document.createElement('div');e.id='feedback';e.textContent='Observed feedback';document.body.append(e);e.getBoundingClientRect();requestAnimationFrame(()=>{e.style.opacity='1';e.style.transform='translateY(0)'});setTimeout(()=>e.remove(),1500);
      };},300);
    </script></body></html>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  const start=await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic delayed render and animation',headless:true});
  assert.equal(start.navigation_observation.content_observed,true);
  assert.ok(start.snapshot.controls.some(c=>c.selector==='#submit'));
  assert.equal(navigations,1);
  const operation={type:'click',request_id:'submit',target:{by:'css',value:'#submit'},assertion:{target:{by:'text',value:'Observed feedback'},condition:'text',case_id:'ANIMATION',title:'Animated feedback',expected:'Observed feedback'}};
  const result=await f.browser(operation);
  assert.equal(result.assertion.status,'passed');
  assert.equal(result.capture_timing.feedback_paint.status,'settled');
  assert.ok(result.capture_timing.feedback_paint.sample.opacity>=0.95);
  assert.ok(Date.parse(result.capture_timing.started_at)>=Date.parse(result.assertion.timing.matched_at));
  assert.ok(statSync(resolve(f.dir,result.screenshot)).size>0);
  const observation=JSON.parse(readFileSync(resolve(f.dir,'execution/browser-evidence/submit.observation.json')));
  assert.deepEqual(observation.capture_timing,result.capture_timing);
  assert.deepEqual(await f.browser(operation),result);
  assert.equal(submissions,1);assert.equal(navigations,1);
  console.log(JSON.stringify({browser_paint_preview:resolve(f.dir,result.screenshot)}));
  await f.browser({type:'finish',request_id:'finish',summary:'Synthetic check completed',limitations:[]});
});

test('screenshot failure is nonfatal and diagnostics never include raw secrets or selectors',async()=>{
  let calls=0;
  const page={locator:()=>({}),getByText:()=>({}),screenshot:async()=>{calls++;throw new Error('Timeout: selector password=secret-value https://user:pass@example.org/?token=secret');}};
  const result=await captureBrowserEvidence(page,'unused.png',new Set(['secret-value']));
  assert.deepEqual(result,{captured:false,warning:{phase:'screenshot',category:'timeout'}});
  assert.equal(calls,1,'Never retry without privacy masks');
  let options;
  const masks=[{input:true},{secret:true}];
  const captured=await captureBrowserEvidence({locator:()=>masks[0],getByText:()=>masks[1],screenshot:async value=>{options=value;}},'masked.png',new Set(['secret-value']));
  assert.equal(captured.captured,true);assert.deepEqual(options.mask,masks);
  assert.equal(options.animations,undefined,'Do not fast-forward page animations or trigger application events');
  assert.deepEqual(browserErrorDiagnostic(new Error('Target page, context or browser has been closed secret'),'snapshot'),{phase:'snapshot',category:'browser_unavailable'});
  assert.deepEqual(browserErrorDiagnostic(new Error('net::ERR_PROXY_CONNECTION_FAILED https://secret'),'network'),{phase:'network',category:'browser_operation_error',network_code:'net::ERR_PROXY_CONNECTION_FAILED'});
});

test('dynamic feedback caps candidates, retains actual stop time and tolerates document replacement',async()=>{
  const browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  try {
    const page=await browser.newPage();await page.setContent('<p>Existing static text</p>');
    const handle=await beginDynamicFeedback(page);
    await page.evaluate(()=>{for(let i=0;i<30;i++){const e=document.createElement('p');e.textContent=`Update ${i}`;document.body.append(e);}});
    await pause(1700);
    const first=await handle.evaluate(s=>s.stop());
    await pause(50);
    const result=await endDynamicFeedback(handle);
    assert.equal(result.finished_at,first.finished_at);
    assert.equal(result.candidates.length,20);assert.equal(result.truncated,true);
    assert.ok(!result.candidates.some(x=>x.text==='Existing static text'));
    const abandoned=await beginDynamicFeedback(page);
    await page.goto('data:text/html,<p>Replacement</p>');
    const unavailable=await endDynamicFeedback(abandoned);
    assert.equal(unavailable.status,'unavailable');assert.deepEqual(unavailable.candidates,[]);
  } finally {await browser.close();}
});

test('unknown dynamic feedback is observed once, redacted and never promoted to a passing assertion',async t=>{
  let submissions=0;
  const server=createServer((req,res)=>{
    if(req.url==='/submit'){submissions++;res.end('ok');return;}
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><input id="secret"><button id="submit">Submit</button><div role="alert">Old static message</div><div id="hidden" style="display:none">Hidden feedback</div><p id="updated">Old status</p><script>
      document.querySelector('#submit').onclick=()=>{
        fetch('/submit');const e=document.createElement('div');e.textContent='Brief unknown feedback';document.body.append(e);setTimeout(()=>e.remove(),100);
        document.querySelector('#hidden').style.display='block';document.querySelector('#updated').textContent='Changed status';
        const privateNode=document.createElement('span');privateNode.textContent=document.querySelector('#secret').value;document.body.append(privateNode);
      };
    </script>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{if(existsSync(resolve(f.dir,'execution/browser-private.json'))) await f.browser({type:'finish',request_id:'cleanup',summary:'Cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Observe synthetic unknown feedback',headless:true});
  await f.browser({type:'fill',request_id:'secret',target:{by:'css',value:'#secret'},value:'private-"quoted"-value',secret:true});
  const operation={type:'click',request_id:'observe-once',target:{by:'css',value:'#submit'}};
  const result=await f.browser(operation),feedback=result.dynamic_feedback;
  assert.equal(feedback.status,'observed');assert.equal(feedback.action_completed,true);
  assert.equal(result.assertion,undefined);
  assert.ok(feedback.candidates.some(x=>x.text==='Brief unknown feedback' && x.selector && x.observed_at));
  assert.ok(feedback.candidates.some(x=>x.text==='Hidden feedback' && x.change==='became_visible'));
  assert.ok(feedback.candidates.some(x=>x.text==='Changed status' && x.change==='text_changed'));
  assert.ok(!feedback.candidates.some(x=>x.text==='Old static message'));
  assert.ok(feedback.candidates.some(x=>x.text==='[REDACTED]'));
  const bytes=readFileSync(resolve(f.dir,feedback.evidence_path),'utf8');
  assert.ok(!bytes.includes('private-'));assert.deepEqual(JSON.parse(bytes),feedback);
  assert.deepEqual(await f.browser(operation),result);assert.equal(submissions,1);
  const finished=await f.browser({type:'finish',request_id:'finish',summary:'Observed feedback only',limitations:['No business assertions performed']});
  assert.equal(finished.summary.total,0);assert.equal(finished.partial,true);
  const exploration=JSON.parse(readFileSync(resolve(f.dir,'execution/exploration.json')));
  assert.ok(exploration.evidence.some(x=>x.path===feedback.evidence_path));
});

test('finishing without assertions is partial, not a fabricated passing functional test',async t=>{
  const server=createServer((req,res)=>res.end('<html><body>Empty fixture</body></html>'));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,f=await fixture(url);
  t.after(async()=>{await f.browser({type:'finish',request_id:'cleanup',summary:'Cleanup',limitations:[]}).catch(()=>{});await pause(1300);await new Promise(done=>server.close(done));});
  await f.browser({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Inspect fixture',headless:true});
  const done=await f.browser({type:'finish',request_id:'finish',summary:'No assertions executed',limitations:['No functional checks']});
  assert.equal(done.partial,true);assert.equal(done.summary.passed,0);
  writeFileSync(resolve(f.dir,'execution/execution-task.json'),JSON.stringify({run_id:f.id,stage:'execution',outcome:'completed',summary:'Not a valid complete result',source_paths:['inputs/request.txt'],questions:[],limitations:[]}));
  assert.match(inspectIndependentArtifacts(root,f.id,'execution').errors.join(' '),/partial/);
});
