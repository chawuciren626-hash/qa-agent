import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createProtectedInputs, isProtectedInput } from '../../scripts/protected-inputs.mjs';
import { createHostBoundary, protectHostToolStream, patchHostObservability, hostPatchAnchors } from '../../scripts/host-observability.mjs';
import { isSensitiveRuntimePath } from '../../scripts/sensitive-file-guard.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';

const owner='session-2026-10-19-12-00-00-abcd1234',other='session-2026-10-19-12-00-00-ffff1234';
function fixture(t) {
  const base=mkdtempSync(resolve(tmpdir(),'protected-inputs-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const key=Buffer.alloc(32,19),backend={wrap:()=>Buffer.from('TEST-WRAPPED-KEY'),unwrap:()=>Buffer.from(key)};
  const store=createProtectedInputs(resolve(base,'vault'),backend),workspace=resolve(base,'workspace');mkdirSync(workspace);
  writeFileSync(resolve(workspace,'.qa-session.json'),JSON.stringify({version:1,engine_root:resolve(import.meta.dirname,'../..'),workspace_root:base,session_root:workspace,session_id:owner}));
  return {base,store,backend,workspace};
}

test('encrypted references are stable across processes, bound to session and never contain values',t=>{
  const f=fixture(t),secret='Synthetic-only-secret-7362',ref=f.store.put(owner,secret);
  assert.ok(isProtectedInput(ref));assert.equal(f.store.get(owner,ref),secret);
  const second=createProtectedInputs(resolve(f.base,'vault'),f.backend);
  assert.equal(second.put(owner,secret),ref);assert.equal(second.get(owner,ref),secret);
  const resumed=createProtectedInputs(resolve(f.base,'vault'),f.backend);
  assert.equal(resumed.protect(owner,ref),ref);
  assert.equal(resumed.protect(owner,`observed ${secret}`),`observed ${ref}`);
  const foreign=createProtectedInputs(resolve(f.base,'vault'),f.backend);
  assert.equal(foreign.protect(other,ref),ref);
  assert.equal(foreign.protect(other,`observed ${secret}`),`observed ${secret}`);
  assert.throws(()=>second.get(other,ref),/not owned/);
  const path=resolve(f.base,'vault',owner,readdirSync(resolve(f.base,'vault',owner))[0]),raw=readFileSync(path,'utf8');
  assert.ok(!raw.includes(secret));assert.ok(!raw.includes(Buffer.from(secret).toString('base64')));
  const record=JSON.parse(raw);record.tag=Buffer.alloc(16).toString('base64');writeFileSync(path,JSON.stringify(record));
  assert.throws(()=>second.get(owner,ref),/unavailable/);
  assert.ok(isSensitiveRuntimePath(path.replace('vault','protected-inputs')));
});

test('first labeled input and JSON file-tool arguments use the same protected value without corrupting JSON',t=>{
  const f=fixture(t),text=f.store.protect(owner,'登录密码："Synthetic-only-secret-7362"，测试登录');
  assert.ok(!text.includes('Synthetic-only-secret-7362'));assert.match(text,/测试登录/);
  const op={action:'browser_task',run_id:'run-example',operation:{type:'fill',request_id:'first',target:{by:'label',value:'Password'},value:'Synthetic-only-secret-7362',secret:true}};
  const args=f.store.protect(owner,{file_path:'output/action-requests/fill.json',content:JSON.stringify(op)});
  const parsed=JSON.parse(args.content);assert.ok(isProtectedInput(parsed.operation.value));assert.equal(parsed.operation.request_id,'first');
  assert.equal(f.store.get(owner,parsed.operation.value),'Synthetic-only-secret-7362');
  assert.deepEqual(f.store.protect(owner,args),args);
  assert.equal(f.store.protect(owner,{authorization:'user allowed login'}).authorization,'user allowed login');
});

test('short credentials do not corrupt action identifiers or nested case drafts',t=>{
  const f=fixture(t),ref=f.store.put(owner,'test');
  const draft={action:'export_test_cases',stage:'test_cases',test_data:{username:'tester',password:'test'},note:'credential test; test_cases and tester remain identifiers'};
  const protectedDraft=JSON.parse(f.store.protect(owner,JSON.stringify(draft)));
  assert.equal(protectedDraft.action,draft.action);
  assert.equal(protectedDraft.stage,draft.stage);
  assert.equal(protectedDraft.test_data.username,'tester');
  assert.equal(protectedDraft.test_data.password,ref);
  assert.equal(protectedDraft.note,`credential ${ref}; test_cases and tester remain identifiers`);
  assert.deepEqual(f.store.protect(owner,protectedDraft),protectedDraft);
  const one=f.store.put(owner,'x');
  assert.equal(f.store.protect(owner,{password:'x',note:'value x, export'}).note,`value ${one}, export`);
  const long=f.store.put(owner,'Synthetic-only-secret-7362');
  assert.equal(f.store.protect(owner,'prefixSynthetic-only-secret-7362suffix'),`prefix${long}suffix`);
});

test('host boundary protects the live message before trace and shares parent ownership in a child',t=>{
  const f=fixture(t);let now=0;
  const boundary=createHostBoundary(f.workspace,other,{store:()=>f.store,clock:()=>now,processIdentity:'a'.repeat(36)});
  const input={type:'model_msg',payload:{type:'text',role:'user',text:'password: Synthetic-only-secret-7362'}};
  boundary.record(input);assert.ok(!JSON.stringify(input).includes('Synthetic-only-secret-7362'));assert.equal(input.qa_timing.owner_session_id,owner);
  const begin={type:'event_msg',payload:{type:'request_begin'}};boundary.record(begin);now=10;
  const end={type:'event_msg',payload:{type:'request_end'}};boundary.record(end);
  assert.equal(end.qa_timing.model_request_ms,10);assert.equal(end.qa_timing.request_id,begin.qa_timing.request_id);
  const call={type:'model_msg',payload:{type:'tool_call',tool_call_id:'a',arguments:'{}'}};boundary.record(call);now=15;
  boundary.record({type:'event_msg',payload:{type:'approval_decision',tool_call_id:'a',decision:'allow'}});now=25;
  const output={type:'model_msg',payload:{type:'tool_call_output',tool_call_id:'a',output:'ok'}};boundary.record(output);
  assert.equal(output.qa_timing.tool_total_ms,15);assert.equal(output.qa_timing.tool_execution_ms,10);
});

test('tool stream masks split credentials before any output archive and retains cancellation cleanup',async t=>{
  const f=fixture(t);let closed=false;
  async function* stream() {try {for(const output of ['password: Synthetic-','only-secret-7362']) yield {type:'model_msg',payload:{type:'partial_tool_call_output',event_type:'delta',output}};return {stopReason:'completed'};} finally {closed=true;}}
  const rows=[];for await(const row of protectHostToolStream(stream(),f.workspace,{store:()=>f.store})) rows.push(row);
  assert.equal(closed,true);assert.ok(!JSON.stringify(rows).includes('Synthetic-only-secret-7362'));assert.match(rows[0].payload.output,/qa-secret:/);
  const limited=[];for await(const row of protectHostToolStream(stream(),f.workspace,{store:()=>f.store,limit:2})) limited.push(row);
  assert.match(limited[0].payload.output,/withheld/);
  assert.ok(!JSON.stringify(limited).includes('Synthetic-'));
});

test('host anchors are exact and cannot silently patch an unsupported server',()=>{
  const source=hostPatchAnchors.join('\n');assert.match(patchHostObservability(source,'file:///safe/module.mjs'),/qaProtectToolStream/);
  assert.throws(()=>patchHostObservability(source+'\n'+hostPatchAnchors[0],'file:///safe/module.mjs'),/anchor/);
});

test('protected references cannot become URLs, selectors, assertions or dialog text',t=>{
  const f=fixture(t),ref=f.store.put(owner,'Synthetic-protected-fill');
  assert.doesNotThrow(()=>validateBrowserOperation({type:'fill',request_id:'a',target:{by:'css',value:'#password'},value:ref,secret:true}));
  assert.throws(()=>validateBrowserOperation({type:'fill',request_id:'a',target:{by:'css',value:'#password'},value:ref,secret:false}),/private fill/);
  assert.throws(()=>validateBrowserOperation({type:'assert',request_id:'a',target:{by:'css',value:'#password'},condition:'value',value:ref,case_id:'a',title:'x',expected:'x'}),/private fill/);
  assert.throws(()=>validateBrowserOperation({type:'goto',request_id:'a',url:ref,source_path:'inputs/request.txt'}),/private fill/);
  const request={type:'fill',request_id:'test-id',target:{by:'css',value:'#test-password'},value:'test',secret:true};
  f.store.put(owner,'test');assert.equal(f.store.protect(owner,request).request_id,'test-id');assert.deepEqual(f.store.protect(owner,request).target,request.target);
});

test('Windows DPAPI persists only a protected key and synthetic ciphertext',t=>{
  if(process.platform!=='win32') return t.skip('Windows DPAPI integration; injected backend contracts remain platform independent');
  const f=fixture(t),store=createProtectedInputs(resolve(f.base,'dpapi')),secret='Synthetic-DPAPI-only-5618';
  const ref=store.put(owner,secret);assert.equal(createProtectedInputs(resolve(f.base,'dpapi')).get(owner,ref),secret);
  assert.ok(!readFileSync(resolve(f.base,'dpapi','key.dpapi'),'utf8').includes(secret));
});
