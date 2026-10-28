import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {resolveProductLayout,productEnvironment,bindProductCommandPaths} from '../../scripts/product-layout.mjs';
import {classifyHostRelease,checkHostUpdate,hostCompatibility} from '../../scripts/product-updates.mjs';
import {parseProductArguments} from '../../scripts/product-entry.mjs';
import {inspectProductService} from '../../scripts/product-doctor.mjs';
import {planProductMigration} from '../../scripts/product-migration-plan.mjs';
import {initializeProductAgents} from '../../scripts/product-bootstrap.mjs';
import {productAgentTools,configureProductAgentTools} from '../../scripts/product-agent-tools.mjs';

function fixture(t) {
  const root=mkdtempSync(resolve(tmpdir(),'qa-product-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const value={version:1,installation_id:'qa-test',layout:'unified',root,project_id:'default_project',paths:{engine:'app/engine',host_executable:'runtime/penguin/PenguinHarness.exe',host_data:'data/penguin',qa_data:'data/qa',desktop_profile:'data/desktop',workspaces:'workspaces',node:'runtime/node/node.exe'}};
  const file=resolve(root,'installation.json');return {root,value,file,layout:resolveProductLayout(value,file)};
}
test('paths resolve relative to configuration and preserve Chinese and spaces without CWD dependence',t=>{
  const f=fixture(t);f.value.root='./中文 产品';const p=resolveProductLayout(f.value,f.file);
  assert.equal(p.paths.engine,resolve(f.root,'中文 产品/app/engine'));assert.match(p.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(existsSync(p.root),false);assert.equal(p.agent_root,resolve(p.paths.host_data,'default_project/agents'));
});
test('invalid schema, escaped unified roots, data overlap and program overlap are rejected',t=>{
  const f=fixture(t);
  for(const mutate of [v=>v.extra='secret',v=>v.project_id='../escape',v=>v.paths.host_data=v.paths.engine,v=>v.paths.qa_data='data/penguin/sub',v=>v.paths.workspaces='../escape',v=>v.paths.node='workspaces/node.exe',v=>v.paths.engine=' x ',v=>v.paths.host_executable='arbitrary.exe']) {
    const v=structuredClone(f.value);mutate(v);assert.throws(()=>resolveProductLayout(v,f.file));
  }
});
test('existing layout permits external roots while preserving isolation',t=>{
  const f=fixture(t),v=structuredClone(f.value);v.layout='existing';v.paths.workspaces=resolve(f.root,'../external-workspaces');
  assert.equal(resolveProductLayout(v,f.file).paths.workspaces,v.paths.workspaces);
});
test('product environment scopes paths and removes caller session ownership and inherited database routing',t=>{
  const {layout}=fixture(t);const env=productEnvironment(layout,{Path:'old',QA_DIRECTORY_CONTEXT:'private',PENGUIN_WEB_DB:'other.db',PENGUIN_DESKTOP_TOKEN:'secret'});
  assert.equal(env.PENGUIN_HOME,layout.paths.host_data);assert.equal(env.PENGUIN_AGENT_ROOT,layout.agent_root);
  assert.equal(env.QA_DIRECTORY_CONTEXT,undefined);assert.equal(env.PENGUIN_WEB_DB,undefined);assert.equal(env.PENGUIN_DESKTOP_TOKEN,undefined);
  assert.ok(env.Path.startsWith(dirname(layout.paths.node)));assert.equal(env.PATH,undefined);
});
const release=version=>({tag_name:'v'+version,html_url:'https://github.com/Prism-Shadow/penguin-harness/releases/tag/v'+version,draft:false,prerelease:false});
test('agent commands recover stripped trace root from their own installation without copying secrets or session context',t=>{
  const f=fixture(t);writeFileSync(f.file,JSON.stringify(f.value));
  const env={QA_DIRECTORY_CONTEXT:'current-session',PENGUIN_SESSION_ID:'current-child'};
  bindProductCommandPaths(f.layout.paths.engine,env);
  assert.deepEqual(env,{QA_DIRECTORY_CONTEXT:'current-session',PENGUIN_SESSION_ID:'current-child',PENGUIN_AGENT_ROOT:f.layout.agent_root});
  const isolated={PENGUIN_AGENT_ROOT:resolve(f.root,'isolated-agents')};bindProductCommandPaths(f.layout.paths.engine,isolated);
  assert.equal(isolated.PENGUIN_AGENT_ROOT,resolve(f.root,'isolated-agents'));
  assert.throws(()=>bindProductCommandPaths(resolve(f.root,'other/engine'),{}),/engine mismatch/);
  const legacy={};bindProductCommandPaths(resolve(f.root,'legacy/deep/engine'),legacy);assert.deepEqual(legacy,{});
});
test('new upstream releases require compatibility review and never authorize installation',()=>{
  assert.equal(classifyHostRelease(release('0.2.17'),'0.2.16',undefined,'win32-x64').status,'compatibility_review_required');
  const known=classifyHostRelease(release('0.2.16'),'0.2.13',undefined,'win32-x64');assert.equal(known.status,'compatible_update_available');assert.equal(known.automatic_install,false);assert.equal(known.distribution_ready,false);
  assert.equal(classifyHostRelease(release('0.2.16'),'0.2.16').status,'no_newer_release');
  assert.equal(classifyHostRelease(release('0.2.16'),'0.2.99').status,'no_newer_release');
  assert.equal(hostCompatibility('0.2.16',undefined,'linux-x64').status,'unverified');
});
test('release metadata rejects drafts, prereleases, wrong sources and malformed versions',()=>{
  for(const r of [{...release('0.2.17'),draft:true},{...release('0.2.17'),prerelease:true},{...release('0.2.17'),html_url:'https://example.com'},{...release('0.2.17'),tag_name:'v0.2.17-beta'},release('00.2.17')])assert.throws(()=>classifyHostRelease(r,'0.2.16'));
});
test('network, rate limits and oversized metadata report failure instead of up-to-date',async()=>{
  for(const fetcher of [async()=>{throw Error('secret url')},async()=>new Response('{}',{status:429}),async()=>new Response('x'.repeat(1024*1024+1))]) {
    const r=await checkHostUpdate('0.2.16',{fetcher});assert.equal(r.status,'check_failed');assert.equal(JSON.stringify(r).includes('secret'),false);
  }
  const r=await checkHostUpdate('0.2.16',{fetcher:async(url,opts)=>{assert.equal(opts.redirect,'error');return new Response(JSON.stringify(release('0.2.17')));}});assert.equal(r.status,'compatibility_review_required');
});
test('CLI refuses unknown commands, duplicate parameters and accidental mutation flags',()=>{
  for(const args of [[],['doctor'],['doctor','--config=x','--apply'],['doctor','--config=x','--config=y'],['start','--config=x','--target=y'],['migration-plan','--config=x']])assert.throws(()=>parseProductArguments(args));
  assert.equal(parseProductArguments(['doctor','--config=x']).command,'doctor');
});
test('service readiness distinguishes stale locks, denied authentication and correct version without logging tokens',async t=>{
  const {layout}=fixture(t);mkdirSync(layout.paths.host_data,{recursive:true});mkdirSync(layout.host_app,{recursive:true});
  writeFileSync(resolve(layout.host_app,'package.json'),JSON.stringify({version:'0.2.16'}));
  assert.equal((await inspectProductService(layout)).status,'not_running');
  const file=resolve(layout.paths.host_data,'server.lock');writeFileSync(file,JSON.stringify({pid:123,port:12345}));
  assert.equal((await inspectProductService(layout,{processAlive:()=>false})).status,'stale_lock');
  const token='s'.repeat(43);writeFileSync(resolve(layout.paths.host_data,'api-token'),token);
  const denied=await inspectProductService(layout,{processAlive:()=>true,fetcher:async()=>new Response('{}',{status:401})});
  assert.equal(denied.status,'authentication_required');assert.equal(JSON.stringify(denied).includes(token),false);
  assert.equal((await inspectProductService(layout,{processAlive:()=>true,fetcher:async(url,opts)=>{assert.equal(new URL(url).hostname,'localhost');assert.equal(opts.headers.authorization,'Bearer '+token);return new Response('{"version":"0.2.16"}');}})).status,'ready');
  assert.equal((await inspectProductService(layout,{processAlive:()=>true,fetcher:async()=>new Response('{"version":"0.2.17"}')})).status,'version_mismatch');
  assert.equal(JSON.parse(readFileSync(file)).pid,123);
});
test('migration planning refuses source overlap and never copies data or claims readiness',t=>{
  const f=fixture(t),target=structuredClone(f.value);target.root=resolve(f.root,'../separate-target-'+Date.now());
  const plan=planProductMigration(f.layout,resolveProductLayout(target,f.file));assert.equal(plan.ready_to_apply,false);assert.equal(plan.migration_executed,false);assert.equal(existsSync(target.root),false);
  target.root=resolve(f.layout.paths.engine,'nested');assert.throws(()=>planProductMigration(f.layout,resolveProductLayout(target,f.file)),/overlaps/);
});
test('fresh installation provisions agents without model requests and never reinitializes completed credentials',async t=>{
  const {layout}=fixture(t);mkdirSync(resolve(layout.paths.engine,'penguin'),{recursive:true});mkdirSync(layout.paths.host_data,{recursive:true});
  writeFileSync(resolve(layout.paths.host_data,'api-token'),'s'.repeat(43));
  writeFileSync(resolve(layout.paths.engine,'penguin/agents.json'),JSON.stringify({agents:[{id:'test_agent',prompt:'penguin/prompt.md'}]}));
  writeFileSync(resolve(layout.paths.engine,'penguin/prompt.md'),'# 测试角色');
  const calls=[];const options={serviceCheck:async()=>({status:'ready',port:1234}),fetcher:async(url,opts)=>{calls.push({url,method:opts.method,body:opts.body});return new Response(JSON.stringify(opts.method==='GET'?{agents:[]}:{agent:{agentId:'test_agent'}}));},synchronize:()=>({status:'synchronized'}),configureTools:async()=>{}};
  assert.equal((await initializeProductAgents(layout,options)).status,'initialized');assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[1].body),{agentId:'test_agent',name:'测试角色',plugins:[]});
  assert.equal((await initializeProductAgents(layout,options)).status,'already_initialized');assert.equal(calls.length,2);
  assert.equal(existsSync(resolve(layout.paths.qa_data,'agent-initialization.lock')),false);
});
test('first-run setup refuses unmanaged role collisions before writes to agent state',async t=>{
  const {layout}=fixture(t);mkdirSync(resolve(layout.paths.engine,'penguin'),{recursive:true});mkdirSync(layout.paths.host_data,{recursive:true});
  writeFileSync(resolve(layout.paths.host_data,'api-token'),'s'.repeat(43));writeFileSync(resolve(layout.paths.engine,'penguin/agents.json'),JSON.stringify({agents:[{id:'test_agent',prompt:'unused'}]}));
  let writes=0;
  await assert.rejects(initializeProductAgents(layout,{serviceCheck:async()=>({status:'ready',port:1234}),fetcher:async()=>new Response('{"agents":[{"agentId":"test_agent"}]}'),synchronize:()=>{writes++;}}),/unmanaged/);
  assert.equal(writes,0);assert.equal(existsSync(resolve(layout.paths.qa_data,'agent-initialization.json')),false);
});
test('first-run tools require explicit child targets and preserve unrelated schemas',()=>{
  const tools=[{name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'},workdir:{type:'string'}}}},{name:'run_subagent',parameters:{type:'object',properties:{prompt:{type:'string'},agent_id:{type:'string'},description:{type:'string'},unknown:{type:'string'}},required:['prompt']}},{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}];
  const controller=productAgentTools(tools,'test_agent');
  assert.ok(controller[0].parameters.properties.qa_request);assert.ok(controller[1].parameters.required.includes('agent_id'));assert.equal(controller[1].parameters.properties.unknown,undefined);
  assert.deepEqual(controller[2],tools[2]);assert.equal(tools[0].parameters.properties.qa_request,undefined);
  assert.deepEqual(productAgentTools(controller,'test_agent'),controller);
  const child=productAgentTools(tools,'test_case_agent');
  assert.deepEqual(productAgentTools(child,'test_case_agent'),child);
  const sourceDefault=structuredClone(tools);
  sourceDefault[0].parameters.properties.qa_request={type:'object',description:'AITestHarness structured action object. The QA pre-tool hook saves this exact request before project-action.mjs execute. Omit for ordinary shell commands.'};
  assert.deepEqual(productAgentTools(sourceDefault,'android_test_agent')[0].parameters.properties.qa_request,child[0].parameters.properties.qa_request);
  const custom=structuredClone(tools);custom[0].parameters.properties.qa_request={type:'string'};assert.throws(()=>productAgentTools(custom,'test_agent'),/Custom/);
});
test('active first-run agents prevent tool configuration writes',async()=>{
  let writes=0;
  await assert.rejects(configureProductAgentTools({port:1234,project_id:'default_project'},['test_agent'],async(url,body)=>{if(body)writes++;return {activeSessionCount:1,config:{}};}),/active/);
  assert.equal(writes,0);
});
