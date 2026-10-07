import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
function fixture() {
  const id = `run-fixture-${randomUUID()}`;
  const dir = resolve(root,'output/runs',id);
  const write = (path, value) => { const file=resolve(dir,path); mkdirSync(resolve(file,'..'),{recursive:true}); writeFileSync(file,JSON.stringify(value)); };
  const run = script => {
    const result=spawnSync(process.execPath,[`scripts/${script}.mjs`,`--run-id=${id}`],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  };
  const read = path => JSON.parse(readFileSync(resolve(dir,path),'utf8'));
  write('inputs/fixture-origin.json',{source:'synthetic quality regression, never browser execution'});
  return {id,dir,write,run,read};
}
test('missing inputs and zero execution cannot produce informational gate',()=>{
  const f=fixture();f.run('build-quality-metrics');
  const metrics=f.read('report/quality-metrics.json');
  assert.equal(metrics.quality_gate.status,'blocked');
  assert.equal(metrics.trust.missing_inputs.length,3);
});
test('missing assessment and missing defect analysis each block report',()=>{
  for(const missing of ['quality/evidence-assessment.json','defects/defect-records.json']) {
    const f=fixture();
    f.write('execution/test_results.json',{run_id:f.id,status:'completed',cases:[{case_id:'TC-ONE',status:'passed'}],summary:{total:1,passed:1,failed:0}});
    if(missing !== 'quality/evidence-assessment.json') f.write('quality/evidence-assessment.json',{assessments:[],summary:{insufficient:0}});
    if(missing !== 'defects/defect-records.json') f.write('defects/defect-records.json',{records:[]});
    f.run('build-quality-metrics');assert.equal(f.read('report/quality-metrics.json').quality_gate.status,'blocked');
  }
});
test('duplicate or missing evidence cannot inflate confidence; duplicate IDs are distinct',()=>{
  const f=fixture();
  f.write('execution/error.json',{message:'synthetic failure'});
  writeFileSync(resolve(f.dir,'execution/empty.png'),'');
  const evidence=['execution/error.json','execution/../execution/error.json','execution/missing.png','execution/empty.png','execution'];
  f.write('execution/test_results.json',{run_id:f.id,status:'failed',summary:{total:1,failed:1},cases:[{case_id:'TC-ONE',status:'failed',error_message:'synthetic assertion',evidence_paths:evidence}]});
  f.run('assess-execution-evidence');
  assert.equal(f.read('quality/evidence-assessment.json').summary.insufficient,1);
  assert.equal(f.read('quality/evidence-assessment.json').assessments[0].existing_evidence_refs.length,1);
  const bug={bug_id:'BUG-EXISTING',case_id:'TC-ONE',title:'Synthetic issue',classification:'product_defect',evidence_paths:evidence};
  f.write('defects/bugs.json',{bugs:[bug,bug]});f.run('normalize-defects');
  const records=f.read('defects/defect-records.json').records;
  assert.equal(records[0].defect_id,'BUG-EXISTING');
  assert.equal(records[0].confidence,'low');assert.equal(records[0].lifecycle_status,'needs_review');
  assert.notEqual(records[0].defect_id,records[1].defect_id);assert.equal(records[1].duplicate_of,records[0].defect_id);
  f.run('build-quality-metrics');assert.equal(f.read('report/quality-metrics.json').quality_gate.status,'blocked');
});
