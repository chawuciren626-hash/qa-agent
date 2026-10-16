import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApiCheck, validateFault, createOneShotFault } from '../../scripts/browser-api-controls.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';
const check=()=>({url:'https://example.test/data',method:'GET',http_status:200,field:'code',equals:0,source_path:'inputs/contract.txt',quote:'Read data returns 200 and code 0',case_id:'API1',title:'Data',expected:'Contract matched'});
const fault=()=>({url:'https://example.test/data',method:'GET',mode:'http_error',http_status:503,source_path:'inputs/request.txt',quote:'Simulate one read failure'});

test('API checks reject writes, credentials, redirects options and arbitrary payloads',()=>{
  assert.doesNotThrow(()=>validateApiCheck(check()));
  assert.doesNotThrow(()=>validateApiCheck({...check(),method:'HEAD',field:undefined,equals:undefined}));
  for(const update of [{method:'POST'},{url:'https://example.test/data?token=x'},{headers:{authorization:'secret'}},{body:'x'},{redirect:'follow'},{method:'HEAD'}]) assert.throws(()=>validateApiCheck({...check(),...update}));
});

test('fault injection is explicit, limited to GET errors, and cannot mix real data assertions',()=>{
  assert.doesNotThrow(()=>validateFault(fault()));
  for(const update of [{method:'DELETE'},{mode:'rewrite'},{http_status:200},{body:'arbitrary'},{url:'https://name:secret@example.test/data'}]) assert.throws(()=>validateFault({...fault(),...update}));
  const op={type:'click',request_id:'simulate',target:{by:'css',value:'#load'},fault:fault(),assertion:{target:{by:'css',value:'#error'},condition:'visible',case_id:'UI1',title:'Error',expected:'Error shown'}};
  assert.doesNotThrow(()=>validateBrowserOperation(op));
  assert.throws(()=>validateBrowserOperation({...op,response_check:check()}));
  assert.throws(()=>validateBrowserOperation({...op,assertion:undefined}));
});

test('one-shot interception matches the exact main-frame fetch only and disables on every finish',async()=>{
  const frame={},page={mainFrame:()=>frame};let fulfilled=0,aborted=0;
  const route=(overrides={})=>({request:()=>({url:()=>fault().url,method:()=> 'GET',resourceType:()=> 'fetch',frame:()=>frame,...overrides}),fulfill:async options=>{fulfilled++;assert.equal(options.status,503);assert.equal(options.body,'{"qa_simulated_failure":true}');},abort:async()=>{aborted++;}});
  const session=createOneShotFault(fault());
  for(const overrides of [{method:()=> 'POST'},{url:()=> 'https://example.test/other'},{frame:()=>({})},{resourceType:()=> 'document'}]) assert.equal(await session.intercept(route(overrides),page),false);
  assert.equal(await session.intercept(route(),page),true);
  assert.equal(await session.intercept(route(),page),false);
  const proof=await session.finish();assert.equal(proof.applied,true);assert.equal(proof.disabled,true);assert.equal(proof.matched_requests,1);
  assert.equal(await session.intercept(route(),page),false);assert.equal(fulfilled,1);
  const cancelled=createOneShotFault({...fault(),mode:'abort',http_status:undefined});await cancelled.finish(false);
  assert.equal(await cancelled.intercept(route(),page),false);assert.equal(aborted,0);
  const abort=createOneShotFault({...fault(),mode:'abort',http_status:undefined});await abort.intercept(route(),page);assert.equal((await abort.finish()).applied,true);assert.equal(aborted,1);
});

test('failed or unfinished interception cannot remain active after cancellation',async()=>{
  const frame={},page={mainFrame:()=>frame};
  const request=()=>({url:()=>fault().url,method:()=> 'GET',resourceType:()=> 'fetch',frame:()=>frame});
  const failed=createOneShotFault(fault());
  const route={request,fulfill:async()=>{throw Error('closed');}};
  assert.equal(await failed.intercept(route,page),true);
  const proof=await failed.finish();assert.equal(proof.applied,false);assert.equal(proof.in_flight,false);assert.equal(proof.disabled,true);
  assert.equal(await failed.intercept(route,page),false);
  let complete;
  const pending=createOneShotFault(fault());const work=pending.intercept({request,fulfill:()=>new Promise(resolve=>{complete=resolve;})},page);
  const cancelled=await pending.finish(false);assert.equal(cancelled.in_flight,true);assert.equal(cancelled.disabled,true);
  assert.equal(await pending.intercept(route,page),false);complete();await work;
});
