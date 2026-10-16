import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegressionDelivery, regressionMarkdown } from '../../scripts/regression-delivery.mjs';

function fixture() {
  const record = {case_id:'CHECK',status:'failed',expected:'Field rejects invalid value',check_fingerprint:'same-check',
    evidence_mode:'real',verification_scope:{layer:'ui'},evidence_paths:['inputs/evidence.json']};
  const baseline = {run_id:'old',invocation_id:'one',started_at:'2026-10-14T01:00:00Z',finished_at:'2026-10-14T02:00:00Z',cases:[record]};
  const current = {run_id:'new',invocation_id:'two',started_at:'2026-10-15T01:00:00Z',finished_at:'2026-10-15T02:00:00Z',cases:[{...record,status:'passed'}]};
  const mapping = {kind:'regression_comparison',version:1,comparisons:[{id:'ISSUE-1',layer:'original',
    baseline:{source_path:'inputs/before.json',source_sha256:'a',case_id:'CHECK'},current:{source_path:'inputs/after.json',source_sha256:'b',case_id:'CHECK'}}]};
  const parsed = [{path:'inputs/before.json',value:baseline},{path:'inputs/after.json',value:current},{path:'inputs/regression.json',value:mapping}];
  const files = [{path:'inputs/before.json',sha256:'a',kind:'supplied_input'},{path:'inputs/after.json',sha256:'b',kind:'supplied_input'},
    {path:'inputs/evidence.json',sha256:'e',kind:'supplied_input'}];
  return {baseline,current,mapping,parsed,files,run:()=>buildRegressionDelivery(parsed,files)};
}

test('regression delivery compares independent observations without closing issues or rewriting failures',()=>{
  const f=fixture(),before=JSON.stringify(f.parsed),r=f.run();
  assert.equal(r.counts.now_passing,1);assert.equal(r.rows[0].provenance,'imported_or_mixed');
  assert.equal(r.layers.original.compared,1);assert.equal(r.layers.impact.mapped,0);
  assert.equal(JSON.stringify(f.parsed),before);
  const md=regressionMarkdown(r);assert.match(md,/不自动关闭缺陷/);assert.match(md,/含导入材料/);assert.match(md,/原失败保留/);assert.match(md,/关联影响面：关联 0 项.*未评估/);
});

test('comparison outcomes distinguish persistent, new and unchanged observations',()=>{
  for(const [a,b,outcome] of [['failed','failed','still_failing'],['passed','failed','new_failure'],['passed','passed','still_passing']]) {
    const f=fixture();f.baseline.cases[0].status=a;f.current.cases[0].status=b;
    assert.equal(f.run().rows[0].outcome,outcome);
  }
});

test('same attempt, nonlater and malformed dates cannot confirm a regression comparison',()=>{
  for(const change of [f=>{f.current.run_id=f.baseline.run_id;f.current.invocation_id=f.baseline.invocation_id;},
    f=>{f.current.started_at=f.baseline.started_at;},f=>{f.current.finished_at='bad';},f=>{delete f.current.invocation_id;}]) {
    const f=fixture();change(f);assert.equal(f.run().rows[0].reason,'independent_later_execution_not_established');
  }
});

test('changed expectations, missing evidence, simulations and uncertain outcomes remain unresolved',()=>{
  for(const change of [f=>{f.current.cases[0].expected='different';},f=>{delete f.current.cases[0].check_fingerprint;},
    f=>{f.current.cases[0].verification_scope={layer:'api_contract'};},f=>{f.current.cases[0].evidence_mode='simulated';},
    f=>{f.current.cases[0].evidence_mode='simulation_affected';},f=>{delete f.current.cases[0].evidence_mode;},
    f=>{f.current.cases[0].evidence_paths=['../secret'];},f=>{f.current.cases[0].status='blocked';},
    f=>{f.current.cases.push({...f.current.cases[0]});},f=>{f.mapping.comparisons[0].current.source_sha256='changed';}]) {
    const f=fixture();change(f);assert.equal(f.run().rows[0].outcome,'not_verified');assert.equal(f.run().counts.now_passing,0);
  }
});

test('optional mapping absence and malformed entries remain nonblocking without guessing ID associations',()=>{
  assert.equal(buildRegressionDelivery([],[]),null);assert.equal(regressionMarkdown(null),'');
  const f=fixture();f.mapping.comparisons.push(null,{...f.mapping.comparisons[0]});
  const r=f.run();assert.equal(r.rows.length,1);assert.equal(r.warnings.length,2);
  f.mapping.version=99;assert.equal(f.run().rows.length,0);assert.equal(f.run().warnings.length,1);
  f.mapping.version=1;f.parsed[2].path='execution/regression.json';assert.equal(f.run(),null);
});

test('report task pairs bind indexed hashes without imported mapping or ID inference',()=>{
  const f=fixture();f.parsed.pop();
  const draft={version:1,comparisons:[{...f.mapping.comparisons[0],
    baseline:{source_path:'inputs/before.json',case_id:'CHECK'},current:{source_path:'inputs/after.json',case_id:'CHECK'}}]};
  const before=JSON.stringify([f.parsed,draft]);
  assert.equal(buildRegressionDelivery(f.parsed,f.files),null);
  const result=buildRegressionDelivery(f.parsed,f.files,draft);
  assert.equal(result.counts.now_passing,1);
  assert.equal(result.rows[0].baseline.source_sha256,'a');
  assert.equal(result.rows[0].mapping_source,'report/report-task.json#regression_comparison');
  assert.equal(JSON.stringify([f.parsed,draft]),before);
  f.parsed.push({path:'inputs/map.json',value:f.mapping});
  assert.equal(buildRegressionDelivery(f.parsed,f.files,draft).rows.length,1);
  draft.comparisons[0].current.source_sha256='wrong';
  assert.equal(buildRegressionDelivery(f.parsed,f.files,draft).counts.not_verified,1);
  delete draft.comparisons[0].current.source_sha256;
  draft.comparisons[0].current.source_path='../outside.json';
  assert.equal(buildRegressionDelivery(f.parsed,f.files,draft).rows[0].current,null);
});

test('invalid or empty report task mapping stays nonblocking and never falls back silently',()=>{
  const f=fixture();
  for(const draft of [null,{},'invalid',{version:2,comparisons:[]}]) {
    const result=buildRegressionDelivery(f.parsed,f.files,draft);
    assert.equal(result.rows.length,0);assert.equal(result.warnings.length,1);
  }
  const result=buildRegressionDelivery(f.parsed,f.files,{version:1,comparisons:[]});
  assert.equal(result.rows.length,0);assert.match(regressionMarkdown(result),/未评估/);
});

test('unknown scope retains the pair as unverified rather than dropping or approving it',()=>{
  const f=fixture();f.mapping.comparisons[0].layer='simulated';
  const result=f.run();
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].layer,'unclassified');
  assert.equal(result.rows[0].reason,'unclassified_scope');assert.equal(result.counts.not_verified,1);
  assert.equal(result.counts.now_passing,0);assert.equal(result.layers.unclassified.mapped,1);
  assert.equal(result.rows[0].current.case_id,'CHECK');assert.match(regressionMarkdown(result),/范围未确认/);
});
