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
