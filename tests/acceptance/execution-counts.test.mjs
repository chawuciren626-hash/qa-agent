import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeExecutionCounts, resolveCaseReference, validateCountMetadata, uiCheckFingerprint } from '../../scripts/execution-counts.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';

const ref={source_path:'inputs/cases.json',case_id:'C1'};
const source=()=>({data:JSON.stringify({cases:[{case_id:'C1',expected:'Ready'}]}),sha256:'verified'});
const row=(id,status)=>({case_id:id,status,expected:'Ready',check_fingerprint:'fingerprint',verification_scope:{layer:'ui'},case_ref:{...ref,source_sha256:'verified'},timing:{mode:'standalone_observation'}});

test('two assertions and a read-only recheck reference one case without losing original failures',()=>{
  const rows=[row('A','failed'),{...row('B','passed'),recheck_of:'A'},{...row('API','passed'),verification_scope:{layer:'api_contract'}}];
  const before=JSON.stringify(rows),counts=summarizeExecutionCounts(rows,{interactive:true,readSource:source});
  assert.equal(counts.records,3);assert.equal(counts.linked_case_count,1);assert.equal(counts.linked_assertions,3);
  assert.equal(counts.counts.failed,1);assert.equal(counts.counts.passed,2);assert.equal(counts.read_only_rechecks,1);assert.equal(counts.rechecks_passed_after_failure,1);
  assert.equal(counts.framework_retries,null);assert.equal(JSON.stringify(rows),before);
});

test('missing or changed design evidence cannot imply case counts or coverage',()=>{
  for(const readSource of [undefined,()=>({...source(),sha256:'changed'}),()=>{throw Error('absent');}]) {
    const counts=summarizeExecutionCounts([row('A','passed')],{interactive:true,readSource});
    assert.equal(counts.linked_case_count,null);assert.equal(counts.unmapped_assertions,1);
  }
  const legacy=summarizeExecutionCounts([{case_id:'TC-1-step-1',status:'passed'},{case_id:'TC-1-step-2',status:'passed'}],{interactive:true});
  assert.equal(legacy.linked_case_count,null);assert.equal(legacy.unmapped_assertions,2);
});

test('framework retries exclude initial runs and retain partial history coverage',()=>{
  const rows=[{case_id:'A',status:'passed',retries:[{retry:0,status:'failed'},{retry:1,status:'passed'},{retry:0,status:'passed'}]},
    {case_id:'B',status:'passed'}, {case_id:'C',status:'passed',retries:[{retry:2,status:'passed'}]}];
  const counts=summarizeExecutionCounts(rows);
  assert.equal(counts.records,3);assert.equal(counts.framework_attempts,3);assert.equal(counts.framework_runs,2);
  assert.equal(counts.framework_retries,1);assert.equal(counts.framework_flaky_records,1);assert.equal(counts.records_without_retry_history,2);
  assert.equal(summarizeExecutionCounts([{case_id:'A',status:'passed'}]).framework_retries,null);
});

test('duplicates and invalid recheck links are reported instead of merged or repaired',()=>{
  const counts=summarizeExecutionCounts([row('A','failed'),row('A','passed'),{...row('B','passed'),recheck_of:'A'}],{interactive:true});
  assert.equal(counts.records,3);assert.equal(counts.duplicate_record_ids,1);assert.equal(counts.invalid_recheck_links,1);assert.equal(counts.read_only_rechecks,0);
  for(const change of [{check_fingerprint:'different'},{expected:'Changed'},{timing:{mode:'same_operation'}}]) {
    assert.equal(summarizeExecutionCounts([row('A','failed'),{...row('B','passed'),recheck_of:'A',...change}],{interactive:true}).invalid_recheck_links,1);
  }
});

test('case links need a real unique source case, no path escape or invented identifiers',()=>{
  assert.deepEqual(resolveCaseReference(ref,source),{...ref,source_sha256:'verified'});
  for(const source_path of ['../cases.json','inputs/../cases.json','design/other.json','inputs/cases.txt']) assert.throws(()=>validateCountMetadata({case_ref:{...ref,source_path}}));
  assert.doesNotThrow(()=>validateCountMetadata({case_ref:{...ref,source_path:'design/test_cases.json'}}));
  assert.throws(()=>resolveCaseReference({...ref,case_id:'invented'},source));
  assert.throws(()=>resolveCaseReference(ref,()=>({data:JSON.stringify([JSON.parse(source().data).cases[0],JSON.parse(source().data).cases[0]])})));
});

test('recheck metadata cannot authorize a repeat click or change the check fingerprint',()=>{
  const check={target:{by:'css',value:'#message'},condition:'text',value:'Ready',case_id:'A',title:'Ready',expected:'Ready',case_ref:ref,recheck_of:'previous'};
  assert.doesNotThrow(()=>validateBrowserOperation({...check,type:'assert',request_id:'read'}));
  assert.throws(()=>validateBrowserOperation({type:'click',request_id:'click',target:{by:'css',value:'#save'},assertion:check}));
  assert.notEqual(uiCheckFingerprint(check),uiCheckFingerprint({...check,value:'Different'}));
});
