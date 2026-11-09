import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {localBrowserSpawn,executeLocalBrowser} from '../../scripts/local-browser-executor.mjs';
import {browserExecutionContext} from '../../scripts/browser-privacy.mjs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {executeAction} from '../../scripts/structured-actions.mjs';

function fixture(t) {
  const base=mkdtempSync(resolve(tmpdir(),'aith-browser-boundary-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=resolve(base,'engine'),workspace=resolve(base,'workspaces'),cwd=resolve(workspace,'session');
  mkdirSync(root);mkdirSync(resolve(cwd,'output/action-requests'),{recursive:true});
  const session='session-2026-11-09-10-00-00-abcdef';
  const context={version:1,engine_root:root,workspace_root:workspace,session_root:cwd,session_id:session};
  const controlEnv={QA_DIRECTORY_CONTEXT:JSON.stringify(context),PENGUIN_SESSION_ID:session};
  const hostEnv={AITEST_BROWSER_EXECUTION:'local',PLAYWRIGHT_BROWSERS_PATH:resolve(base,'browsers'),NODE_OPTIONS:'--import=untrusted',API_KEY:'private-value',PATH:process.env.PATH};
  const cmd=`node scripts/project-action.mjs execute --controller-session=${session} --request=output/action-requests/request.json`;
  const request={action:'explore_url',run_id:'run-synthetic',url:'http://127.0.0.1:12345/',source_path:'inputs/request.txt'};
  const file=resolve(cwd,'output/action-requests/request.json');writeFileSync(file,JSON.stringify(request));
  return {root,cwd,session,controlEnv,hostEnv,cmd,file,request};
}

test('local browser dispatch freezes only browser requests and removes arbitrary code environment',t=>{
  const f=fixture(t),spec=localBrowserSpawn(f.root,f);
  assert.deepEqual(spec.argv,[process.execPath,resolve(f.root,'scripts/local-browser-executor.mjs')]);
  assert.equal(spec.env.NODE_OPTIONS,undefined);assert.equal(spec.env.API_KEY,undefined);
  assert.equal(spec.env.QA_BROWSER_EXECUTION,'local');
  assert.equal(spec.env.PLAYWRIGHT_BROWSERS_PATH,f.hostEnv.PLAYWRIGHT_BROWSERS_PATH);
  writeFileSync(f.file,JSON.stringify({action:'create_run'}));
  assert.deepEqual(JSON.parse(spec.input).request,f.request);
  assert.equal(localBrowserSpawn(f.root,f),null);
  assert.deepEqual(browserExecutionContext(spec.env),{execution_location:'local_machine',execution_backend:'local_browser_executor',agent_sandbox_applied:false});
});

test('browser routing requires host opt-in and bound session; never routes arbitrary shell',t=>{
  const f=fixture(t);
  for(const change of [
    {hostEnv:{}},{controlEnv:{}},{cmd:f.cmd+'; whoami'},
    {cmd:'node -e "process.exit()"'},
    {cmd:f.cmd.replace(f.session,'session-2026-11-09-10-00-00-bad')},
    {cmd:f.cmd.replace('execute','catalog')},
  ]) assert.equal(localBrowserSpawn(f.root,{...f,...change}),null);
  assert.throws(()=>localBrowserSpawn(f.root,{...f,cmd:f.cmd.replace('output/action-requests/request.json','../outside.json')}),/plain current-session/);
});

test('privileged executor rejects nonbrowser actions and mismatched sessions before calling action engine',async t=>{
  const f=fixture(t),previous=process.env.QA_DIRECTORY_CONTEXT;
  process.env.QA_DIRECTORY_CONTEXT=f.controlEnv.QA_DIRECTORY_CONTEXT;
  t.after(()=>{if(previous===undefined)delete process.env.QA_DIRECTORY_CONTEXT;else process.env.QA_DIRECTORY_CONTEXT=previous;});
  let calls=0;
  const execute=async(root,session,read)=>{calls++;assert.equal(session,f.session);assert.deepEqual(JSON.parse(read()),f.request);return {status:'synthetic_only'};};
  await assert.rejects(()=>executeLocalBrowser(f.root,{session:f.session,request:{action:'create_run'}},{execute}),/Only controlled browser/);
  await assert.rejects(()=>executeLocalBrowser(f.root,{session:'other',request:f.request},{execute}),/session mismatch/);
  assert.equal(calls,0);
  assert.equal((await executeLocalBrowser(f.root,{session:f.session,request:f.request},{execute})).status,'synthetic_only');
  assert.equal(calls,1);
});

test('local executor launches Chromium for an owned synthetic exploration and records its boundary',async t=>{
  const f=fixture(t),root=resolve(import.meta.dirname,'../..');
  const context={...JSON.parse(f.controlEnv.QA_DIRECTORY_CONTEXT),engine_root:root};
  const previous=process.env.QA_DIRECTORY_CONTEXT;
  process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(context);
  t.after(()=>{if(previous===undefined)delete process.env.QA_DIRECTORY_CONTEXT;else process.env.QA_DIRECTORY_CONTEXT=previous;});
  const agentRoot=resolve(f.cwd,'synthetic-agents'),traces=resolve(agentRoot,'test_agent/traces/2026-11-09');mkdirSync(traces,{recursive:true});
  writeFileSync(resolve(traces,`${f.session}_001.jsonl`),JSON.stringify({type:'session_meta',payload:{session_id:f.session,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:f.cwd}}));
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<title>Local executor fixture</title><h1>Synthetic test</h1>');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/`;
  const call=request=>executeAction(root,f.session,()=>JSON.stringify(request),{agentRoot});
  const created=await call({action:'create_run'});assert.equal(created.exit_code,0,JSON.stringify(created));
  const run_id=created.run_id;
  for(const request of [
    {action:'archive_input',name:'request.txt',text:`Read-only engineering fixture ${url}`},
    {action:'plan_run',stages:['execution']},
    {action:'dispatch',stage:'execution',agent:'automation_execution_agent',skills:['playwright-execution']},
  ]) {const result=await call({...request,run_id});assert.equal(result.exit_code,0,JSON.stringify(result));}
  const request={action:'explore_url',run_id,url,source_path:'inputs/request.txt'};
  writeFileSync(f.file,JSON.stringify(request));
  const spec=localBrowserSpawn(root,{...f,hostEnv:{...process.env,AITEST_BROWSER_EXECUTION:'local'},controlEnv:{...f.controlEnv,QA_DIRECTORY_CONTEXT:JSON.stringify(context),PENGUIN_AGENT_ROOT:agentRoot}});
  const result=await new Promise((done,reject)=>{
    const child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:f.cwd,env:spec.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
    child.on('close',code=>done({code,out,err}));child.stdin.end(spec.input);
  });
  assert.equal(result.code,0,JSON.stringify(result));
  const observation=JSON.parse(readFileSync(resolve(f.cwd,'output/runs',run_id,'execution/exploration.json'),'utf8'));
  assert.equal(observation.error,null,JSON.stringify(observation));
  assert.equal(observation.title,'Local executor fixture');
  assert.equal(observation.browser_runtime.execution_backend,'local_browser_executor');
  assert.equal(observation.browser_runtime.agent_sandbox_applied,false);
  assert.equal(observation.browser_cleanup.status,'close_acknowledged');
});
