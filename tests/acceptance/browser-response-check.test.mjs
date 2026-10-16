import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { validateResponseCheck, compareBusinessResponse, observeBusinessResponse } from '../../scripts/browser-response-check.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';

const check=()=>({url:'http://example.test/save',method:'POST',http_status:200,field:'data.code',equals:0,source_path:'inputs/contract.txt',quote:'HTTP 200 and data.code 0 mean accepted',case_id:'API1',title:'Accepted',expected:'Contract matched'});
test('response contract rejects defaults, unsafe destinations, sensitive fields and arbitrary code',()=>{
  assert.doesNotThrow(()=>validateResponseCheck(check()));
  for(const change of [c=>delete c.http_status,c=>delete c.equals,c=>c.field='token',c=>c.field='constructor.code',c=>c.url='http://user:pass@example.test/save',c=>c.url+='?token=x',c=>c.source_path='inputs/../secret',c=>c.evaluate='arbitrary']) {
    const value=check();change(value);assert.throws(()=>validateResponseCheck(value));
  }
  const op={type:'click',request_id:'submit',target:{by:'css',value:'#save'},preconditions:[{target:{by:'css',value:'#title'},condition:'value',value:''}],response_check:check()};
  assert.doesNotThrow(()=>validateBrowserOperation(op));
  assert.throws(()=>validateBrowserOperation({...op,preconditions:[{...op.preconditions[0],force:true}]}));
  assert.throws(()=>validateBrowserOperation({...op,type:'fill',value:'x'}));
});
test('HTTP and business matches are independent and missing data is not success',()=>{
  assert.equal(compareBusinessResponse(check(),200,{data:{code:400}}).status,'failed');
  assert.equal(compareBusinessResponse(check(),500,{data:{code:0}}).status,'failed');
  assert.equal(compareBusinessResponse(check(),200,{data:{code:'0'}}).status,'failed');
  assert.equal(compareBusinessResponse(check(),200,{data:{code:0}}).status,'passed');
  assert.equal(compareBusinessResponse(check(),200,{}).status,'blocked');
  assert.ok(!JSON.stringify(compareBusinessResponse(check(),200,{data:{code:'secret'}})).includes('secret'));
});
test('passive observer ignores old/unrelated requests, rejects ambiguity and cleans up listeners',async()=>{
  const page=new EventEmitter(),frame={};page.mainFrame=()=>frame;
  const request=()=>({url:()=>check().url,method:()=>check().method,frame:()=>frame});
  const response=req=>({request:()=>req,headers:()=>({'content-type':'application/json','content-length':'19'}),status:()=>200,body:async()=>Buffer.from('{"data":{"code":0}}')});
  let observer=observeBusinessResponse(page,check(),20);
  page.emit('response',response(request()));
  assert.equal((await observer.finish()).status,'blocked');
  observer=observeBusinessResponse(page,check(),100);
  const req=request();page.emit('request',req);page.emit('response',response(req));
  assert.equal((await observer.finish()).status,'passed');
  observer=observeBusinessResponse(page,check(),100);
  const first=request(),second=request();page.emit('request',first);page.emit('request',second);page.emit('response',response(first));
  assert.equal((await observer.finish()).reason,'ambiguous_matching_requests');
  observer=observeBusinessResponse(page,check(),100);observer.cancel();
  assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);
});

test('unknown size, malformed JSON and stalled bodies remain inconclusive without leaking content',async()=>{
  for(const mode of ['unknown_size','malformed','stalled']) {
    const page=new EventEmitter(),frame={};page.mainFrame=()=>frame;
    const req={url:()=>check().url,method:()=>check().method,frame:()=>frame};
    let reads=0;
    const observer=observeBusinessResponse(page,check(),25);
    page.emit('request',req);
    page.emit('response',{request:()=>req,headers:()=>({'content-type':'application/json',...(mode==='unknown_size'?{}:{'content-length':'20'})}),status:()=>200,body:async()=>{reads++;return mode==='stalled'?new Promise(()=>{}):Buffer.from('SECRET_INVALID_JSON');}});
    const result=await observer.finish();
    assert.equal(result.status,'blocked');assert.ok(!JSON.stringify(result).includes('SECRET'));
    if(mode==='unknown_size') assert.equal(reads,0);
    assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);
  }
});
