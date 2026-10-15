import test from 'node:test';
import assert from 'node:assert/strict';
import {profileAgentTrace,intervalUnion} from '../../scripts/profile-agent-trace.mjs';
const row=(ms,type,extra={})=>({timestamp:new Date(ms).toISOString(),payload:{type,...extra}});
test('parallel tool intervals are unioned and removed from request envelopes',()=>{
  const p=profileAgentTrace([row(0,'request_begin'),row(10,'tool_call',{tool_call_id:'a',name:'read_file'}),row(20,'tool_call',{tool_call_id:'b',name:'read_file'}),row(60,'tool_call_output',{tool_call_id:'a'}),row(80,'tool_call_output',{tool_call_id:'b'}),row(100,'request_end')]);
  assert.equal(p.tool_wall_ms,70);assert.equal(p.request_without_tools_ms,30);assert.equal(p.by_tool.read_file.calls,2);
});
test('parent delegation waits are not described as model inference',()=>{
  const p=profileAgentTrace([row(0,'request_begin'),row(5,'tool_call',{tool_call_id:'a',name:'run_subagent'}),row(10,'request_end'),row(1000,'tool_call_output',{tool_call_id:'a'})]);
  assert.equal(p.request_without_tools_ms,5);assert.equal(p.tool_wall_ms,995);assert.equal(p.wall_ms,1000);assert.equal(p.outside_recorded_request_and_tools_ms,0);
});
test('reported token usage excludes cumulative session totals and private content',()=>{
  const p=profileAgentTrace([row(0,'token_usage',{request:{output:2,total:20},session:{output:500,total:5000}}),row(1,'token_usage',{request:{output:3,total:30}}),row(2,'thinking',{thinking:'PRIVATE_SENTINEL'})]);
  assert.deepEqual(p.reported_tokens,{output:5,total:50});assert.ok(!JSON.stringify(p).includes('PRIVATE_SENTINEL'));
  assert.equal(profileAgentTrace([]).reported_tokens,null);
});
test('provider and model identity are dynamic and interrupted records remain explicit',()=>{
  const meta={type:'session_meta',timestamp:new Date(0).toISOString(),payload:{provider:'future-provider',model_id:'future-model',model_context_window:12345,system_prompt:'SECRET'}};
  const p=profileAgentTrace([meta,row(1,'request_begin'),row(3,'tool_call',{tool_call_id:'a',name:'exec_command'})]);
  assert.equal(p.models[0].model_id,'future-model');assert.ok(p.warnings.includes('unclosed_request'));assert.ok(p.warnings.includes('unfinished_tools'));assert.ok(!JSON.stringify(p).includes('SECRET'));
});
test('failures and unsorted intervals are measured without exposing outputs',()=>{
  assert.deepEqual(intervalUnion([[20,30],[0,10],[8,25],[40,35]]),[[0,30]]);
  const p=profileAgentTrace([row(10,'tool_call_output',{tool_call_id:'a',stop_reason:'fatal',output:'SECRET'}),row(0,'tool_call',{tool_call_id:'a',name:'x'})]);
  assert.equal(p.failed_tool_stops,1);assert.ok(!JSON.stringify(p).includes('SECRET'));
});
