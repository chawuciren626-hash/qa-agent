import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { directoryContext } from '../../scripts/directory-context.mjs';
import { designArtifacts } from './artifact-fixtures.mjs';

const root=resolve(import.meta.dirname,'../..');
test('Playwright collects external TypeScript and ESM scripts using shared dependencies without running bodies',()=>{
  const outside=mkdtempSync(resolve(tmpdir(),'qa-collection-'));
  for(const extension of ['ts','mts']) {
    const imports=extension==='mts'?"import playwright from '@playwright/test'; const {test,expect}=playwright;":"import {test,expect} from '@playwright/test';";
    writeFileSync(resolve(outside,`external.spec.${extension}`),`${imports}\ntest('collection ${extension}',()=>{throw new Error('MUST NOT EXECUTE');});\n`);
  }
  const result=spawnSync(process.execPath,[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config',resolve(root,'playwright.config.ts'),'--list','--reporter=list'],{cwd:outside,env:{...process.env,QA_TEST_DIR:outside,QA_RUN_DIR:resolve(outside,'evidence')},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Total: 2 tests/);
  assert.equal(existsSync(resolve(outside,'node_modules')),false);
});
function fixture(name) {
  const workspace=mkdtempSync(resolve(tmpdir(),'qa-context-'));
  const session=resolve(workspace,name);mkdirSync(session);
  const id=`session-2026-10-10-00-00-00-${randomUUID().replaceAll('-','')}`;
  const context={version:1,engine_root:root,workspace_root:workspace,session_root:session,session_id:id};
  const agents=resolve(workspace,'agents');const trace=resolve(agents,'test_agent/traces/2026-10-10');mkdirSync(trace,{recursive:true});
  writeFileSync(resolve(trace,`${id}_001.jsonl`),JSON.stringify({type:'session_meta',payload:{session_id:id,agent_state:resolve(agents,'test_agent/agent_state'),workspace:session}}));
  return {context,id,session,env:{...process.env,QA_DIRECTORY_CONTEXT:JSON.stringify(context),PENGUIN_AGENT_ROOT:agents}};
}
test('preflight rejects unsupported browsers and invalid URLs without granting execution approval',()=>{
  const registry=resolve(root,'config',`preflight-${randomUUID()}.json`);
  writeFileSync(registry,JSON.stringify({default_environment:'fixture',environments:{fixture:{authorized_for_execution:true,execution_enabled:true,browser:'firefox',base_url:'file:///not-a-web-target'}}}));
  const result=spawnSync(process.execPath,['scripts/preflight-test-environment.mjs',`--registry=${registry}`],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,2,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.checks.find(c=>c.name==='browser_channel').status,'missing');
  assert.equal(report.checks.find(c=>c.name==='environment_url').status,'missing');
  assert.equal(report.browser_started,false);
  assert.equal(report.network_checked,false);
  assert.equal(report.approval_granted,false);
});
function launch(f,code) {
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:root,env:f.env,windowsHide:true});let output='';
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);
    child.on('exit',status=>status===0?done(output):reject(new Error(output)));
  });
}

test('engineering review resolves evidence in the isolated session and cannot clear counters or use foreign evidence',async()=>{
  const f=fixture('review space');
  mkdirSync(resolve(f.session,'output'),{recursive:true});writeFileSync(resolve(f.session,'output/review.md'),'Synthetic technical review');
  await launch(f,`import assert from 'node:assert/strict';import {readControllerSession,withControllerSession,reviewControllerSession} from './scripts/controller-command-session.mjs';
    const id=${JSON.stringify(f.id)},root=process.cwd();
    await withControllerSession(root,id,async()=>({status:'failed',exit_code:1}));
    const before=readControllerSession(root,id);
    const options={'expected-sha256':before.sha256,actor:'synthetic-engineer',reason:'Synthetic terminated failure','approval-ref':'synthetic-technical-only',evidence:'output/review.md'};
    assert.throws(()=>reviewControllerSession(root,id,{...options,evidence:${JSON.stringify(resolve(root,'README.md'))}}));
    assert.equal(readControllerSession(root,id).sha256,before.sha256);
    const result=reviewControllerSession(root,id,options);assert.equal(result.status,'ready');
    const after=readControllerSession(root,id);assert.deepEqual(after.corrections,before.corrections);assert.equal(after.events.at(-1).type,'review_accepted');`);
});
test('legacy directories remain unchanged; isolated contexts reject invalid roots and linked session directories',()=>{
  assert.equal(directoryContext(root,{}).run_root,resolve(root,'output/runs'));
  const f=fixture('session space');assert.equal(directoryContext(root,f.env).session_root,f.session);
  for(const changed of [{session_root:f.context.workspace_root},{engine_root:f.session},{session_id:'bad'},{session_root:root}]) {
    assert.throws(()=>directoryContext(root,{QA_DIRECTORY_CONTEXT:JSON.stringify({...f.context,...changed})}));
  }
  const linked=resolve(f.context.workspace_root,'link');symlinkSync(f.session,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>directoryContext(root,{QA_DIRECTORY_CONTEXT:JSON.stringify({...f.context,session_root:linked})}),/redirect/);
});

test('catalog publishes bound parent identity and engine docs without changing execution identity rules',async()=>{
  const f=fixture('catalog space');
  await launch(f,`import assert from 'node:assert/strict';import {actionCatalog,executeAction} from './scripts/structured-actions.mjs';
    const c=actionCatalog(process.cwd());
    assert.equal(c.runtime_context.controller_session,${JSON.stringify(f.id)});
    assert.equal(c.runtime_context.shared_docs_root,${JSON.stringify(resolve(root,'docs'))});
    assert.equal(c.runtime_context.shared_skills_root,${JSON.stringify(resolve(root,'skills'))});
    assert.equal(c.runtime_context.shared_schemas_root,${JSON.stringify(resolve(root,'schemas'))});
    assert.equal(c.runtime_context.session_root,${JSON.stringify(f.session)});
    assert.ok(c.invocation.includes('--controller-session='+${JSON.stringify(f.id)}));
    await assert.rejects(executeAction(process.cwd(),${JSON.stringify(f.id+'ff')},()=>JSON.stringify({action:'create_run'})),/another controller/);
    process.env.QA_DIRECTORY_CONTEXT='invalid';
    assert.throws(()=>actionCatalog(process.cwd()));
    delete process.env.QA_DIRECTORY_CONTEXT;
    assert.equal(actionCatalog(process.cwd()).runtime_context.controller_session,null);
    assert.ok(actionCatalog(process.cwd()).invocation.includes('<parent_session>'));`);
});
test('concurrent session processes keep identical run IDs, input names, locks and command receipts isolated',async()=>{
  const a=fixture('session A'),b=fixture('session B');const run=`run-context-${randomUUID()}`;
  const code=f=>`import assert from 'node:assert/strict';import {executeAction} from './scripts/structured-actions.mjs';
    const call=r=>executeAction(process.cwd(),${JSON.stringify(f.id)},()=>JSON.stringify({run_id:${JSON.stringify(run)},...r}));
    for(const r of [{action:'create_run'},{action:'plan_run',stages:['analysis']},{action:'archive_input',name:'same.txt',text:${JSON.stringify(f.id)}},{action:'read_source',path:'inputs/same.txt',start_line:1,end_line:200}]) {const result=await call(r);assert.equal(result.exit_code,0,JSON.stringify(result));}
    const bad=await call({action:'validate_analysis'});assert.equal(bad.status,'failed');assert.equal(bad.recovery.retry_allowed,true);`;
  await Promise.all([launch(a,code(a)),launch(b,code(b))]);
  for(const f of [a,b]) {
    const dir=resolve(f.session,'output/runs',run);
    assert.equal(readFileSync(resolve(dir,'inputs/same.txt'),'utf8'),f.id);
    assert.equal(JSON.parse(readFileSync(resolve(dir,'manifest.json'))).directory_context.session_id,f.id);
    assert.ok(existsSync(resolve(f.session,'output/controller-command-sessions',f.id,'state.json')));
    assert.ok(existsSync(resolve(f.session,'output/command-runs')));
  }
  assert.equal(existsSync(resolve(root,'output/runs',run)),false);
  await launch(a,`import assert from 'node:assert/strict';import {executeAction} from './scripts/structured-actions.mjs';
    await assert.rejects(executeAction(process.cwd(),${JSON.stringify(b.id)},()=>JSON.stringify({action:'run_status',run_id:${JSON.stringify(run)}})),/another controller/);`);
});

test('external design artifacts validate and execution snapshots bind both session inputs and shared engine',async()=>{
  const f=fixture('external design');const id=`run-context-design-${randomUUID()}`;
  const legacy=designArtifacts(root,id);const target=resolve(f.session,'output/runs',id);cpSync(legacy.dir,target,{recursive:true});
  writeFileSync(resolve(target,'manifest.json'),JSON.stringify({run_id:id,directory_context:directoryContext(root,f.env)}));
  const plan=JSON.parse(readFileSync(resolve(target,'execution/execution-plan.json')));
  plan.source=resolve(target,'design/test_cases.json');plan.environment_config=resolve(target,'environment/runtime.json');plan.execution_policy.test_dir=resolve(target,'execution/scripts');
  writeFileSync(resolve(target,'execution/execution-plan.json'),JSON.stringify(plan));
  const runtime=JSON.parse(readFileSync(resolve(target,'environment/runtime.json')));runtime.environment_registry=resolve(target,'environment/registry.json');
  writeFileSync(resolve(target,'environment/runtime.json'),JSON.stringify(runtime));
  await launch(f,`import assert from 'node:assert/strict';import {inspectStageArtifacts} from './scripts/artifact-contracts.mjs';import {executionSnapshot} from './scripts/execution-authorization.mjs';import {runProjectCommand} from './scripts/command-runtime.mjs';
    const root=process.cwd(),id=${JSON.stringify(id)};
    for(const stage of ['analysis','test_points','test_cases']) {const r=inspectStageArtifacts(root,id,stage);assert.equal(r.status,'passed',JSON.stringify(r));}
    const snapshot=executionSnapshot(root,id);assert.ok(snapshot.files.some(f=>f.path==='package.json'));assert.ok(snapshot.files.some(f=>f.path.includes('external design')));
    const result=await runProjectCommand(root,{kind:'node',script:'generate-analysis-markdown.mjs',args:[id],runId:id});assert.equal(result.exit_code,0,JSON.stringify(result));`);
});
