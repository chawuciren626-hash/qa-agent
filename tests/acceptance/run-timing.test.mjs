import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateRunTiming, collectRunTiming } from '../../scripts/run-timing.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
const owner='session-2026-10-19-12-00-00-abcd1234',child='session-2026-10-19-12-00-01-abcd1234',epoch='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const row=(session,ms,type,extra={},timing={})=>({timestamp:new Date(ms).toISOString(),type:'event_msg',payload:{type,...extra},qa_timing:{version:1,owner_session_id:owner,session_id:session,process_id:epoch,offset_ms:ms,...timing}});
test('parent and child request overlap is unioned; command, browser and queue share exact host identity',()=>{
  const parent=[row(owner,0,'request_begin',{}, {request_id:'r1'}),row(owner,100,'request_end',{}, {request_id:'r1',model_request_ms:100})];
  const rows=[row(child,50,'request_begin',{}, {request_id:'r2'}),row(child,120,'request_end',{}, {request_id:'r2',model_request_ms:70}),row(child,130,'tool_call',{tool_call_id:'t1'}),row(child,180,'tool_call_output',{tool_call_id:'t1'},{tool_total_ms:50})];
  const host_binding={session_id:child,tool_call_id:'t1'};
  const result=correlateRunTiming({owner,sessions:[{id:owner,rows:parent},{id:child,rows}],commands:[{command_id:'c1',host_binding},{command_id:'foreign',host_binding:{session_id:owner,tool_call_id:'t1'}}],actions:[{host_binding,timing:{queue_wait_ms:7}}],receipts:[{command_id:'c1',request_id:'op',status:'completed',result:{performance:{version:1,worker_elapsed_ms:20,spans:[]}}}]});
  assert.equal(result.model_request_union_ms,120);assert.equal(result.tool_union_ms,50);assert.equal(result.linked_commands,1);assert.equal(result.unlinked_commands,1);assert.equal(result.queue_wait_sum_ms,7);assert.equal(result.browser.recorded_operation_ms,20);assert.equal(result.pure_inference_ms,null);
});
test('missing or conflicting host measurements never become zero model time or link foreign commands',()=>{
  const result=correlateRunTiming({owner,sessions:[{id:child,rows:[row(child,10,'request_end',{}, {request_id:'missing',model_request_ms:999})]}],commands:[{command_id:'c',host_binding:{session_id:owner,tool_call_id:'guessed'}}]});
  assert.equal(result.model_request_union_ms,null);assert.equal(result.queue_wait_sum_ms,null);assert.equal(result.linked_commands,0);assert.equal(result.invalid_intervals,1);
});

test('report collector follows persisted dispatch-id, native child trace and command identity end to end',t=>{
  const base=mkdtempSync(resolve(tmpdir(),'run-timing-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const agentRoot=resolve(base,'agents'),dir=resolve(base,'workspace/output/runs/run-timing');
  const put=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
  const meta=(id,agent)=>({type:'session_meta',payload:{session_id:id,agent_state:resolve(agentRoot,agent,'agent_state')}});
  const rows=[meta(child,'automation_execution_agent'),row(child,50,'request_begin',{}, {request_id:'r2'}),row(child,120,'request_end',{}, {request_id:'r2',model_request_ms:70}),row(child,130,'tool_call',{tool_call_id:'t1',name:'exec_command'}),row(child,180,'tool_call_output',{tool_call_id:'t1'},{tool_total_ms:50})];
  put(resolve(agentRoot,'test_agent/traces/2026-10-19',owner+'_001.jsonl'),JSON.stringify(meta(owner,'test_agent')));
  put(resolve(agentRoot,'automation_execution_agent/traces/2026-10-19',child+'_001.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',host_binding={session_id:child,tool_call_id:'t1'};
  put(resolve(dir,'audit/commands',id,'command.json'),{run_id:'run-timing',command_id:id,host_binding});
  put(resolve(dir,'../../action-audit',owner,id+'.json'),{run_id:'run-timing',session_id:owner,host_binding,timing:{queue_wait_ms:2}});
  put(resolve(dir,'execution/browser-state.json'),{run_id:'run-timing',invocation_id:'attempt',dispatch_id:'dispatch'});
  put(resolve(dir,'execution/browser-evidence/first.json'),{run_id:'run-timing',invocation_id:'attempt',dispatch_id:'dispatch',request_id:'first',command_id:id,status:'completed',result:{performance:{version:1,worker_elapsed_ms:10,spans:[]}}});
  const manifest={run_id:'run-timing',created_at:new Date(0).toISOString(),orchestration:{events:[{type:'dispatched',dispatch_id:'dispatch','parent-session-id':owner,agent:'automation_execution_agent'},{type:'completed','dispatch-id':'dispatch','parent-session-id':owner,'session-id':child}]}};
  const result=collectRunTiming(dir,manifest,{agentRoot});
  assert.equal(result.model_request_union_ms,70);assert.equal(result.linked_commands,1);assert.equal(result.queue_wait_sum_ms,2);assert.equal(result.linked_browser_receipts,1);assert.equal(result.browser.recorded_operation_ms,10);assert.equal(result.unavailable_sources,0);
});
