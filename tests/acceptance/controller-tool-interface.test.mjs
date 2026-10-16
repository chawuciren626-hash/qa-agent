import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerTools, syncControllerInterface } from '../../scripts/sync-controller-tool-interface.mjs';
const tools=()=>[{name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'},workdir:{type:'string'}},required:['cmd']},permission:'rw'},{name:'run_subagent',parameters:{type:'object',properties:{prompt:{type:'string'}}}},{name:'custom',custom:true}];
test('persisted tools gain optional typed transport without changing permissions or unrelated tools',()=>{
  const original=tools(),next=controllerTools(original);
  assert.equal(original[0].parameters.properties.qa_request,undefined);
  assert.equal(next[0].parameters.properties.qa_request.type,'object');
  assert.deepEqual(next[0].parameters.required,['cmd']);assert.equal(next[0].permission,'rw');
  assert.deepEqual(next[1].parameters.required,['agent_id','description','prompt']);
  assert.equal(next[1].parameters.properties.agent_id.type,'string');
  assert.equal(next[1].parameters.additionalProperties,false);
  assert.equal(next[1].parameters.properties.yield_time_ms.maximum,600000);
  const generic=tools();generic[1].parameters.properties.model_id={type:'string'};
  assert.equal(controllerTools(generic)[1].parameters.properties.model_id,undefined);
  assert.deepEqual(next[2],original[2]);assert.deepEqual(controllerTools(next),next);
  next[0].parameters.properties.qa_request={type:'string'};assert.throws(()=>controllerTools(next),/Custom/);
});
test('API update changes tools only, preserves model and instructions, and verifies readback',async()=>{
  let value={activeSessionCount:0,agentsMd:'existing',config:{toolsBuiltin:tools(),model:{maxTokens:123},hooks:{enabled:true},custom:'keep'}},puts=[];
  const api=async(_path,method,body)=>{if(method==='PUT'){puts.push(body);value.config.toolsBuiltin=body.config.toolsBuiltin;}return structuredClone(value);};
  assert.equal((await syncControllerInterface(api)).status,'update_available');assert.equal(puts.length,0);
  assert.equal((await syncControllerInterface(api,{apply:true})).model_unchanged,true);
  assert.deepEqual(Object.keys(puts[0].config),['toolsBuiltin']);assert.equal(value.config.model.maxTokens,123);
  assert.equal((await syncControllerInterface(api,{apply:true})).status,'in_sync');assert.equal(puts.length,1);
  value.activeSessionCount=1;await assert.rejects(syncControllerInterface(api,{apply:true}),/active/);
  value.activeSessionCount=0;value.config.hooks.enabled=false;await assert.rejects(syncControllerInterface(api,{apply:true}),/disabled/);
});
