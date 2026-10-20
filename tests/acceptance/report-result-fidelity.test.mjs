import test from 'node:test';
import assert from 'node:assert/strict';
import {preserveReportResults,resultFidelityMarkdown} from '../../scripts/report-result-fidelity.mjs';

function fixture() {
  const original={fixture:true,cases:[{case_id:'A',status:'passed',expected:'Expected',actual_result:'Observed',evidence_mode:'simulated',verification_scope:{layer:'ui'},evidence_paths:['inputs/current-evidence.json']}]};
  const draft={run_id:'current',summary:{total:1,passed:1},cases:[{case_id:'A',status:'passed',evidence_paths:['inputs/current-evidence.json']}]};
  const index={files:[{path:'inputs/current.json',sha256:'hash'}],facts:[{source_path:'inputs/current.json'}]};
  const read=()=>({sha256:'hash',data:JSON.stringify(original)});
  return {original,draft,index,read};
}

test('actual checked condition survives a broader model expectation without inventing field coverage',()=>{
  const f=fixture();
  f.original.cases[0].checked_condition={target:{by:'css',value:'#title'},condition:'visible',value:null};
  f.draft.cases[0].expected='Title, budget and state all correct';
  f.draft.cases[0].checked_condition={condition:'all_fields'};
  const row=preserveReportResults(f.draft,f.index,f.read).results.cases[0];
  assert.deepEqual(row.checked_condition,f.original.cases[0].checked_condition);
  assert.equal(row.status,'passed');
  const md=resultFidelityMarkdown({cases:[row]});
  assert.match(md,/#title/);assert.match(md,/visible/);assert.match(md,/预期（非验证结论）/);
  assert.match(md,/仅检查标题不能证明预算/);
});

test('hash-bound execution partial and untested scope survive report projection',()=>{
  const f=fixture();
  f.index.files[0].path=f.index.facts[0].source_path='execution/test_results.json';
  Object.assign(f.original,{status:'partial',coverage:{status:'partial',untested:['Create success path not tested']}});
  f.draft.status='completed';
  const r=preserveReportResults(f.draft,f.index,f.read).results;
  assert.equal(r.status,'partial');assert.deepEqual(r.coverage,f.original.coverage);
  f.index.files[0].sha256='changed';
  assert.equal(preserveReportResults(f.draft,f.index,f.read).results.status,'completed');
});

test('legacy source without checked condition cannot inherit fabricated model verification scope',()=>{
  const f=fixture();f.draft.cases[0].checked_condition={condition:'all_fields'};
  const row=preserveReportResults(f.draft,f.index,f.read).results.cases[0];
  assert.equal(row.checked_condition,undefined);
  assert.match(resultFidelityMarkdown({cases:[row]}),/未记录，不据预期文字推断/);
  f.original.cases[0].checked_condition={condition:'visible'};
  f.index.files[0].sha256='changed';
  assert.equal(preserveReportResults(f.draft,f.index,f.read).results.cases[0].checked_condition,undefined);
});
test('unique source restores original fields and modes without changing counts or source bytes',()=>{
  const f=fixture(),before=JSON.stringify(f);
  const output=preserveReportResults(f.draft,f.index,f.read);
  assert.equal(output.results.cases[0].expected,'Expected');assert.equal(output.results.cases[0].evidence_mode,'simulated');
  assert.equal(output.results.cases[0].report_source.kind,'imported');assert.equal(output.results.cases[0].report_source.fixture,true);
  assert.deepEqual(output.results.summary,f.draft.summary);assert.equal(JSON.stringify(f),before);
  const md=resultFidelityMarkdown(output.results);assert.match(md,/合成样例/);assert.match(md,/模拟场景/);assert.match(md,/Expected/);assert.match(md,/Observed/);
});
test('ambiguous, changed hash, changed status or evidence never select an arbitrary observation',()=>{
  for(const mutate of [f=>f.original.cases.push({...f.original.cases[0]}),f=>f.index.files[0].sha256='changed',f=>f.original.cases[0].status='failed',f=>f.original.cases[0].evidence_paths=['inputs/old.json']]){
    const f=fixture();mutate(f);const r=preserveReportResults(f.draft,f.index,f.read).results;
    assert.equal(r.cases[0].expected,undefined);assert.equal(r.cases[0].report_source.kind,'unresolved');assert.equal(r.cases[0].status,'passed');
  }
});
test('explicit free-text redactions are preserved while mode is restored and conflicts audited',()=>{
  const f=fixture();f.draft.cases[0].expected='[REDACTED]';f.draft.cases[0].evidence_mode='real';
  const r=preserveReportResults(f.draft,f.index,f.read);
  assert.equal(r.results.cases[0].expected,'[REDACTED]');assert.ok(r.changes[0].retained_text_fields.includes('expected'));
  assert.equal(r.results.cases[0].evidence_mode,'simulated');
  delete f.original.cases[0].actual_result;delete f.draft.cases[0].actual_result;
  assert.equal(preserveReportResults(f.draft,f.index,f.read).results.cases[0].actual_result,undefined);
  assert.doesNotThrow(()=>preserveReportResults(f.draft,f.index,()=>{throw Error('missing');}));
});

test('report preserves expectation provenance, exact comparison and sample versions without promoting observations',()=>{
  const f=fixture();
  Object.assign(f.original.cases[0],{expectation_provenance:{status:'not_recorded',semantic_verified:false},comparison:'exact_text',input_provenance:{samples:[{source_sha256:'original',key:'boundary'}]}});
  Object.assign(f.draft.cases[0],{expectation_provenance:{status:'source_located',semantic_verified:true},comparison:'normalized_text'});
  const row=preserveReportResults(f.draft,f.index,f.read).results.cases[0];
  assert.deepEqual(row.expectation_provenance,f.original.cases[0].expectation_provenance);
  assert.equal(row.comparison,'exact_text');assert.equal(row.input_provenance.samples[0].source_sha256,'original');
  const md=resultFidelityMarkdown({cases:[row]});assert.match(md,/仅条件观察/);assert.match(md,/文本精确比较/);
});
