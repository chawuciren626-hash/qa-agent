import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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

async function fixture(url) {
  const parent=`session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',randomUUID()), traces=resolve(agentRoot,'test_agent/traces/2026-10-13');mkdirSync(traces,{recursive:true});
  const parentFile=resolve(traces,`${parent}_001.jsonl`);
  writeFileSync(parentFile,JSON.stringify({type:'session_meta',payload:{session_id:parent,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}));
  const call=r=>executeAction(root,parent,()=>JSON.stringify(r),{agentRoot});
  const created=await call({action:'create_run'});assert.equal(created.exit_code,0);
  const id=created.run_id,dir=resolve(root,'output/runs',id),send=r=>call({run_id:id,...r});
  assert.equal((await send({action:'archive_input',name:'request.txt',text:`${url} Please test adding a synthetic record in this engineering fixture.`})).exit_code,0);
  assert.equal((await send({action:'plan_run',stages:['execution']})).exit_code,0);
  const dispatch=()=>send({action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution']});
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
    const childDir=resolve(agentRoot,'automation_execution_agent/traces/2026-10-13');mkdirSync(childDir,{recursive:true});
    writeFileSync(resolve(childDir,`${child}_001.jsonl`),[
      {type:'session_meta',payload:{session_id:child,source:'subagent',agent_state:resolve(agentRoot,'automation_execution_agent/agent_state'),workspace:root}},
      {type:'model_msg',payload:{type:'text',role:'user',text:delegation.prompt}},
      {type:'model_msg',payload:{type:'text',role:'assistant',text:'Synthetic browser task return'}},
      {type:'event_msg',payload:{type:'request_end',status:'completed'}}
    ].map(r=>JSON.stringify({timestamp:at,...r})).join('\n'));
  };
  return {id,dir,parent,agentRoot,send,browser,dispatched,append,returnChild};
}

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
