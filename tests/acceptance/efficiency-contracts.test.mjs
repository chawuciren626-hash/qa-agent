import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareInlineAction } from '../../scripts/inline-action-request.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';
import { runBrowserSequence } from '../../scripts/browser-sequence.mjs';
import { boundedNetworkLog } from '../../scripts/bounded-network-log.mjs';
import { schemaCache } from '../../scripts/versioned-schema-cache.mjs';
import { childInlineTools, syncChildInterfaces } from '../../scripts/sync-child-tool-interface.mjs';
import { actionCatalog } from '../../scripts/structured-actions.mjs';

test('catalog consistently prefers a single qa_request call and keeps the legacy fallback explicit',()=>{
  const catalog=actionCatalog();
  assert.match(catalog.invocation_steps.join(' '),/不另调write_file/);
  assert.match(catalog.controller_request_transport.preferred,/No separate write_file/);
  assert.match(catalog.invocation_steps.join(' '),/仅旧宿主/);
});

function fixture(t) {
  const dir=mkdtempSync(resolve(tmpdir(),'qa-efficiency-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(resolve(dir,'output/action-requests'),{recursive:true});mkdirSync(resolve(dir,'execution/browser-evidence'),{recursive:true});return dir;
}
test('one-call transport preserves exact body, retries and path/run/parent boundaries',t=>{
  const root=fixture(t),args={cmd:'node scripts/project-action.mjs execute --controller-session=session-parent --request=output/action-requests/request.json',qa_request:{action:'browser_task',run_id:'run-one',operation:{type:'health',request_id:'h'}}};
  const options={runId:'run-one',parentSession:'session-parent'};
  const path=prepareInlineAction(root,args,options);assert.deepEqual(JSON.parse(readFileSync(path)),args.qa_request);
  assert.equal(prepareInlineAction(root,args,options),path);
  assert.throws(()=>prepareInlineAction(root,{...args,qa_request:{...args.qa_request,action:'other'}},options),/conflicts/);
  assert.throws(()=>prepareInlineAction(root,args,{...options,runId:'run-other'}),/run/);
  assert.throws(()=>prepareInlineAction(root,args,{...options,parentSession:'another'}),/parent/);
  assert.throws(()=>prepareInlineAction(root,{...args,cmd:args.cmd.replace('output/action-requests/request.json','../escape.json')},options),/direct|escapes/);
  assert.throws(()=>prepareInlineAction(root,{...args,cmd:args.cmd+' --request=another.json'},options));
});

function sequenceFixture(t) {
  const dir=fixture(t),dispatch={dispatch_id:'dispatch-one'},target={by:'css',value:'#input'};
  writeFileSync(resolve(dir,'execution/browser-evidence/observed.json'),JSON.stringify({status:'completed',dispatch_id:dispatch.dispatch_id,invocation_id:'invocation',result:{snapshot:{page_epoch:1,fields:[{selector:'#input',visible:true}]}}}));
  writeFileSync(resolve(dir,'execution/browser-state.json'),JSON.stringify({status:'ready',invocation_id:'invocation',page_epoch:1}));
  const op={type:'sequence',request_id:'batch',observed_request_id:'observed',steps:[{type:'fill',request_id:'fill',target,value:'synthetic'},{type:'assert',request_id:'assert',target,condition:'value',value:'synthetic',case_id:'C1',title:'Value',expected:'synthetic'}]};
  return {dir,dispatch,op,options:{validate:validateBrowserOperation,binding:()=>dispatch}};
}
test('sequence commits each step, stops on mismatch, and never replays the batch',async t=>{
  const f=sequenceFixture(t);let calls=0;
  const options={...f.options,invoke:async()=>{calls++;return {status:'ready',assertion:{status:'failed'}};}};
  const first=await runBrowserSequence(f.dir,f.op,options);assert.equal(first.status,'sequence_stopped');assert.equal(calls,1);
  const replay=await runBrowserSequence(f.dir,f.op,options);assert.equal(replay.status,'sequence_stopped');assert.equal(calls,1);
  const conflict=await runBrowserSequence(f.dir,{...f.op,steps:[{...f.op.steps[0],value:'changed'},f.op.steps[1]]},options);assert.equal(conflict.status,'invalid_request');assert.equal(calls,1);
});
test('sequence checks cancellation and dispatch each step; unobserved targets and nested batches rejected',async t=>{
  const f=sequenceFixture(t);let calls=0;
  const result=await runBrowserSequence(f.dir,f.op,{...f.options,cancelled:()=>calls>0,invoke:async()=>{calls++;return {status:'ready'};}});
  assert.equal(result.status,'sequence_cancelled');assert.equal(calls,1);
  const another={...f.op,request_id:'other',steps:f.op.steps.map(s=>({...s,target:{by:'css',value:'#unknown'}}))};
  const rejected=await runBrowserSequence(f.dir,another,{...f.options,invoke:async()=>assert.fail()});
  assert.equal(rejected.status,'invalid_operation');assert.equal(rejected.operation_started,false);
  assert.equal(existsSync(resolve(f.dir,'execution/browser-evidence/other.sequence.json')),false);
  assert.throws(()=>validateBrowserOperation({...another,steps:another.steps.map(s=>({...s,target:{by:'role',value:'textbox'}}))}),/CSS targets/);
  assert.throws(()=>validateBrowserOperation({...f.op,steps:[f.op,f.op]}));
  const shifted={...f.op,request_id:'shifted'};let checks=0;
  const changed=await runBrowserSequence(f.dir,shifted,{...f.options,binding:()=>({dispatch_id:++checks<3?'dispatch-one':'dispatch-two'}),invoke:async()=>({status:'ready'})});
  assert.equal(changed.status,'sequence_stopped');assert.equal(changed.steps.length,1);
  writeFileSync(resolve(f.dir,'execution/browser-state.json'),JSON.stringify({status:'ready',invocation_id:'invocation',page_epoch:2}));
  const stale=await runBrowserSequence(f.dir,{...f.op,request_id:'stale'}, {...f.options,invoke:async()=>assert.fail()});
  assert.equal(stale.diagnostic.category,'sequence_observation_stale');assert.equal(stale.operation_started,false);
});
test('interrupted sequence reads saved receipts without issuing any further operation',async t=>{
  const f=sequenceFixture(t);
  await runBrowserSequence(f.dir,f.op,{...f.options,invoke:async()=>({status:'ready'})});
  const path=resolve(f.dir,'execution/browser-evidence/batch.sequence.json'),saved=JSON.parse(readFileSync(path));saved.status='started';writeFileSync(path,JSON.stringify(saved));
  const replay=await runBrowserSequence(f.dir,f.op,{...f.options,invoke:async()=>assert.fail('must not replay')});assert.equal(replay.status,'sequence_interrupted');
});
test('network journal appends numbered bounded entries and flushes compatible summaries',t=>{
  const root=fixture(t),dir=resolve(root,'execution'),log=boundedNetworkLog(dir,{window:3,limit:5,interval:4});
  log.add({method:'GET'});assert.equal(existsSync(resolve(dir,'browser-network.json')),false);
  for(let i=0;i<6;i++) log.add({method:'GET'});log.flush();
  const journal=readFileSync(resolve(dir,'browser-network.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(r=>r.sequence),[1,2,3,4,5]);
  const summary=JSON.parse(readFileSync(resolve(dir,'browser-network.json')));assert.equal(summary.total_events,7);assert.equal(summary.events.length,3);assert.equal(summary.journal_truncated,true);assert.equal(summary.write_errors,0);
});
test('compiled resource cache is content-versioned, immutable-source only and invalidates changes',t=>{
  const dir=fixture(t),path=resolve(dir,'schema.json'),load=schemaCache();
  writeFileSync(path,JSON.stringify({type:'string'}));const a=load(path);assert.equal(load(path),a);assert.equal(a.validate('x'),true);
  writeFileSync(path,JSON.stringify({type:'number'}));const b=load(path);assert.notEqual(b.sha256,a.sha256);assert.equal(b.validate('x'),false);assert.equal(b.validate(1),true);
});

test('child interface sync adds only transport metadata and preserves model/proxy/custom tools',async()=>{
  const configs=new Map(),tools=[{name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}},{name:'custom_read',parameters:{type:'object'}}];
  const api=async(path,method,body)=>{
    if(!configs.has(path)) configs.set(path,{activeSessionCount:0,agentsMd:'unchanged',config:{model:'synthetic-model',proxy:{enabled:true},toolsBuiltin:structuredClone(tools)}});
    if(method==='PUT') configs.get(path).config.toolsBuiltin=body.config.toolsBuiltin;
    return structuredClone(configs.get(path));
  };
  const changed=await syncChildInterfaces(api,{apply:true});assert.equal(changed.roles.length,6);assert.equal((await syncChildInterfaces(api)).status,'in_sync');
  for(const value of configs.values()) {assert.equal(value.config.model,'synthetic-model');assert.equal(value.config.proxy.enabled,true);assert.deepEqual(value.config.toolsBuiltin[1],tools[1]);}
  assert.deepEqual(childInlineTools(childInlineTools(tools)),childInlineTools(tools));
  assert.throws(()=>childInlineTools([{name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'},qa_request:{type:'string'}}}}]),/Custom/);
});
