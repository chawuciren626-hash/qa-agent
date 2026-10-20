import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { recoverBrowserResults, saveBrowserProgress } from '../../scripts/browser-result-recovery.mjs';
import { writeJson } from '../../scripts/orchestration-state.mjs';
import { publishRecoveredBrowserResults, verifyRecoveredBrowserResults } from '../../scripts/browser-recovery-delivery.mjs';
import { ownProcessIdentity } from '../../scripts/process-identity.mjs';
import { humanHandoffTiming } from '../../scripts/browser-performance.mjs';

function fixture(t) {
  const dir=mkdtempSync(resolve(tmpdir(),'qa-result-recovery-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const put=(path,value)=>{mkdirSync(resolve(dir,path,'..'),{recursive:true});writeJson(resolve(dir,path),value);};
  const state={run_id:'run-synthetic',invocation_id:'attempt-one',dispatch_id:'dispatch-one',status:'ready',started_at:'2026-10-19T00:00:00Z'};
  put('inputs/request.json',{scope:'Synthetic only'});
  state.source_path='inputs/request.json';state.source_sha256=createHash('sha256').update(readFileSync(resolve(dir,state.source_path))).digest('hex');
  put('manifest.json',{run_id:state.run_id,orchestration:{plan:{workflow_mode:'task'},events:[{type:'dispatched',stage:'execution',dispatch_id:state.dispatch_id}]}});
  put('execution/browser-state.json',state);
  mkdirSync(resolve(dir,'execution/browser-evidence'),{recursive:true});
  function receipt(n,status='passed',options={}) {
    const request=`request-${n}`,path=`execution/browser-evidence/${request}.json`,proof=`execution/browser-evidence/${request}.observation.json`;
    const row={case_id:`ASSERT-${n}`,status,evidence_mode:'real',title:'SECRET-SYNTHETIC',expected:'SECRET-SYNTHETIC',actual_result:'SECRET-SYNTHETIC',evidence_paths:[path,proof],...options.row};
    const value={version:2,run_id:state.run_id,invocation_id:state.invocation_id,dispatch_id:state.dispatch_id,
      request_id:request,command_id:`command-${n}`,operation:'assert',status:'completed',at:`2026-10-19T00:00:0${n}Z`,
      request_sha256:createHash('sha256').update(request).digest('hex'),result:{assertion:row},...options.receipt};
    put(proof,{observed:'SECRET-SYNTHETIC'});
    value.assertion_evidence=[{path:proof,sha256:createHash('sha256').update(readFileSync(resolve(dir,proof))).digest('hex')}];
    put(path,value);
    put(`audit/commands/command-${n}/command.json`,{run_id:state.run_id,script:'browser-task.mjs',status:'completed',...options.command});
    return {value,row,path,proof};
  }
  return {dir,put,state,receipt};
}

test('recovery retains failures and unknown actions without closure or secret propagation',t=>{
  const f=fixture(t);f.receipt(1);f.receipt(2,'failed',{command:{status:'failed'}});
  f.receipt(3,'passed',{receipt:{status:'started',result:undefined}});
  const before=readFileSync(resolve(f.dir,'execution/browser-state.json'));
  const result=recoverBrowserResults(f.dir);
  assert.deepEqual(result.summary,{total:2,passed:1,failed:1,blocked:0,skipped:0});
  assert.equal(result.finished_at,null);assert.equal(result.browser_closed,'unknown');assert.equal(result.status,'partial');
  assert.equal(result.result_origin,'recovered');assert.equal(result.unknown_operations.length,1);
  assert.equal(result.cases[1].command_completed,false);
  assert.ok(!JSON.stringify(result).includes('SECRET-SYNTHETIC'));
  assert.deepEqual(readFileSync(resolve(f.dir,'execution/browser-state.json')),before);
  assert.deepEqual(recoverBrowserResults(f.dir),result);
});

test('recovered timing is projected from owned completed receipts and old deliveries remain valid',t=>{
  const f=fixture(t),first=f.receipt(1);
  first.value.result.performance={version:1,worker_elapsed_ms:50,spans:[{phase:'browser_action',start_offset_ms:0,duration_ms:20}],raw:'PRIVATE_SENTINEL'};
  f.put(first.path,first.value);
  f.receipt(2,'passed',{receipt:{status:'started'}});
  f.receipt(3,'passed',{receipt:{invocation_id:'other',result:{performance:first.value.result.performance}}});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.browser_performance_summary.measured_operations,1);
  assert.equal(result.browser_performance_summary.recorded_operation_ms,50);
  assert.equal(result.finished_at,null);assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  verifyRecoveredBrowserResults(f.dir,result);
  result.browser_performance_summary.recorded_operation_ms=99;
  assert.throws(()=>verifyRecoveredBrowserResults(f.dir,result),/differ/);
  delete result.browser_performance_summary;verifyRecoveredBrowserResults(f.dir,result);
  f.put('execution/browser-state.json',{...f.state,status:'expired'});
  const legacy=recoverBrowserResults(f.dir);delete legacy.browser_performance_summary;
  f.put('execution/test_results.json',legacy);
  const before=readFileSync(resolve(f.dir,'execution/test_results.json'));
  assert.equal(publishRecoveredBrowserResults(f.dir,randomUUID()).status,'recovered_partial');
  assert.deepEqual(readFileSync(resolve(f.dir,'execution/test_results.json')),before);
});

test('recovery preserves expectation classification and comparison without copying raw basis or samples',t=>{
  const f=fixture(t);
  f.receipt(1,'passed',{row:{comparison:'exact_text',expectation_provenance:{status:'not_recorded',semantic_verified:true,expected_basis:[{quote:'SECRET-SYNTHETIC'}]},input_provenance:{samples:[{key:'SECRET-SYNTHETIC'}]}}});
  const result=recoverBrowserResults(f.dir),row=result.cases[0];
  assert.equal(row.comparison,'exact_text');assert.equal(row.expectation_provenance.status,'not_recorded');assert.equal(row.expectation_provenance.semantic_verified,false);assert.equal(row.expectation_provenance.redacted,true);
  assert.ok(!JSON.stringify(result).includes('SECRET-SYNTHETIC'));assert.equal(row.input_provenance,undefined);
});

test('recovery projects saved human handoff windows without inventing an end or copying text',t=>{
  const f=fixture(t);f.receipt(1);let now=0;
  const timing=humanHandoffTiming({clock:()=>now,wall:()=> '2026-10-19T00:00:00.000Z'});
  timing.begin('first','captcha');now=10;timing.end('resumed');timing.begin('second','access');now=15;
  f.state.human_handoff_timing={...timing.snapshot(),question:'PRIVATE_SENTINEL'};
  f.put('execution/browser-state.json',f.state);
  const before=readFileSync(resolve(f.dir,'execution/browser-state.json'));
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.human_handoff_summary.closed_window_ms,10);
  assert.equal(result.human_handoff_summary.open_observed_ms,5);
  assert.equal(result.human_handoff_summary.open,true);assert.equal(result.finished_at,null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  assert.deepEqual(readFileSync(resolve(f.dir,'execution/browser-state.json')),before);
  assert.deepEqual(recoverBrowserResults(f.dir),result);
});

test('conflicting request and assertion IDs are excluded, never resolved to passed',t=>{
  const f=fixture(t),first=f.receipt(1,'failed');
  f.put('execution/browser-evidence/conflicting.json',{...first.value,request_sha256:'a'.repeat(64),result:{assertion:{...first.row,status:'passed'}}});
  f.receipt(2);f.receipt(3,'failed',{row:{case_id:'ASSERT-2'}});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);
  assert.deepEqual(result.recovery.problems.map(r=>r.reason).sort(),['conflicting_assertion_id','conflicting_request_receipts']);
});

test('legacy receipts require command/run and dispatch identity; newer attempts must match',t=>{
  const f=fixture(t);f.receipt(1,'passed',{receipt:{version:undefined,run_id:undefined,invocation_id:undefined}});
  f.receipt(2,'passed',{receipt:{invocation_id:'another-attempt'}});
  f.receipt(3,'passed',{command:{run_id:'another-run'}});
  assert.equal(recoverBrowserResults(f.dir).summary.total,1);
});

test('broken JSON, missing evidence and out-of-run references are diagnosed without fabricating rows',t=>{
  const f=fixture(t),r=f.receipt(1);
  rmSync(resolve(f.dir,r.proof));
  f.receipt(2,'passed',{row:{evidence_paths:['execution/browser-evidence/request-2.json','../outside.json']}});
  writeFileSync(resolve(f.dir,'execution/browser-evidence/torn.json'),'{"status":');
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);assert.equal(result.recovery.problems.length,3);
});

test('snapshot is partial, atomically replaced, and independent of final results',t=>{
  const f=fixture(t),r=f.receipt(1);
  f.put('execution/test_results.json',{sentinel:'unchanged'});
  saveBrowserProgress(f.dir,f.state,[r.row],r.value);
  const read=()=>JSON.parse(readFileSync(resolve(f.dir,'execution/browser-progress.json')));
  assert.equal(read().summary.passed,1);assert.equal(read().finished_at,null);
  const other=f.receipt(2,'failed');saveBrowserProgress(f.dir,f.state,[r.row,other.row],other.value);
  assert.equal(read().summary.total,2);assert.equal(read().summary.failed,1);
  assert.deepEqual(JSON.parse(readFileSync(resolve(f.dir,'execution/test_results.json'))),{sentinel:'unchanged'});
});

test('new receipt evidence hashes detect changed observations',t=>{
  const f=fixture(t),r=f.receipt(1);
  f.put(r.proof,{observed:'changed'});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);
  assert.equal(result.recovery.problems[0].reason,'invalid_or_missing_assertion_evidence');
});

test('unacknowledged transport remains unknown even without a worker receipt',t=>{
  const f=fixture(t);
  f.put('execution/browser-pending-operation.json',{request_id:'lost-request',dispatch_id:f.state.dispatch_id,request_sha256:'a'.repeat(64)});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);
  assert.deepEqual(result.unknown_operations,[{request_id:'lost-request',reason:'transport_not_acknowledged'}]);
});

test('a completed diagnostic receipt does not turn an uncertain mutation into a known outcome',t=>{
  const f=fixture(t);
  f.receipt(1,'passed',{receipt:{operation:'click',result:{status:'needs_inspection',action_completed:false}}});
  f.receipt(2,'passed',{receipt:{operation:'click',result:{status:'precondition_not_met',operation_started:false}}});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);assert.equal(result.unknown_operations.length,1);
  assert.equal(result.unknown_operations[0].reason,'completed_receipt_does_not_establish_action_outcome');
});

test('byte-identical receipt copies do not inflate counts',t=>{
  const f=fixture(t),r=f.receipt(1);
  f.put('execution/browser-evidence/aaa-copy.json',r.value);
  assert.equal(recoverBrowserResults(f.dir).summary.total,1);
});

test('unknown receipt versions cannot silently downgrade evidence validation',t=>{
  const f=fixture(t);f.receipt(1,'passed',{receipt:{version:'unsupported'}});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.summary.total,0);assert.equal(result.recovery.problems[0].reason,'invalid_receipt');
});

test('failed checkpoint publication leaves the completed receipt available',t=>{
  const f=fixture(t),r=f.receipt(1),before=readFileSync(resolve(f.dir,r.path));
  mkdirSync(resolve(f.dir,'execution/browser-progress.json'));
  assert.throws(()=>saveBrowserProgress(f.dir,f.state,[r.row],r.value));
  assert.deepEqual(readFileSync(resolve(f.dir,r.path)),before);
  assert.equal(recoverBrowserResults(f.dir).summary.passed,1);
});

test('simulated evidence and later rechecks do not erase an original failure',t=>{
  const f=fixture(t);
  const meta={verification_scope:{layer:'ui'},timing:{mode:'standalone_observation'},check_fingerprint:'f'.repeat(64)};
  f.receipt(1,'failed',{row:meta});f.receipt(2,'passed',{row:{...meta,recheck_of:'ASSERT-1'}});
  f.receipt(3,'failed',{row:{evidence_mode:'simulated'}});
  const result=recoverBrowserResults(f.dir);
  assert.equal(result.statistics.read_only_rechecks,1);assert.equal(result.statistics.rechecks_passed_after_failure,1);
  assert.equal(result.statistics.evidence_modes.simulated,1);assert.equal(result.summary.failed,2);
});

test('controlled recovery publishes partial artifacts without changing browser state and verifies source changes',t=>{
  const f=fixture(t),r=f.receipt(1,'failed');f.put('execution/browser-state.json',{...f.state,status:'expired'});
  const before=readFileSync(resolve(f.dir,'execution/browser-state.json'));
  const delivered=publishRecoveredBrowserResults(f.dir,randomUUID());
  assert.equal(delivered.status,'recovered_partial');assert.equal(delivered.summary.failed,1);
  const result=JSON.parse(readFileSync(resolve(f.dir,'execution/test_results.json')));
  assert.equal(verifyRecoveredBrowserResults(f.dir,result).finished_at,null);
  assert.deepEqual(readFileSync(resolve(f.dir,'execution/browser-state.json')),before);
  assert.equal(publishRecoveredBrowserResults(f.dir,randomUUID()).summary.total,1);
  f.put(r.proof,{observed:'modified'});
  assert.throws(()=>verifyRecoveredBrowserResults(f.dir,result),/differ/);
  assert.throws(()=>publishRecoveredBrowserResults(f.dir,randomUUID()),/Existing results differ/);
});

test('recovery refuses a live or unproven worker and never overwrites a normal finish',t=>{
  const f=fixture(t);f.receipt(1);
  assert.equal(publishRecoveredBrowserResults(f.dir,randomUUID()).status,'recovery_not_ready');
  f.put('execution/browser-private.json',{pid:process.pid,process_identity:ownProcessIdentity()});
  assert.equal(publishRecoveredBrowserResults(f.dir,randomUUID()).status,'recovery_not_ready');
  rmSync(resolve(f.dir,'execution/browser-private.json'));
  f.put('execution/browser-state.json',{...f.state,status:'expired'});
  f.put('execution/test_results.json',{status:'completed',sentinel:'original'});
  assert.throws(()=>publishRecoveredBrowserResults(f.dir,randomUUID()),/preserve original/);
  assert.equal(JSON.parse(readFileSync(resolve(f.dir,'execution/test_results.json'))).sentinel,'original');
});
