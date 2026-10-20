import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryPresentation } from '../../scripts/delivery-presentation.mjs';

function fixture(t) {
  const root=mkdtempSync(resolve(tmpdir(),'qa-delivery-version-')),run='run-version';
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const stages={test_points:'design/test_points.json',test_cases:'design/test_cases.json',report:'report/reportable-results.json'};
  const exports={test_points:'design/test_points.xmind',test_cases:'design/test_cases.xlsx',report:'report/test_report.html'};
  const tasks={test_points:'design/test_points-task.json',test_cases:'design/test_cases-task.json',report:'report/report-task.json'};
  const manifest={stages:{},orchestration:{events:[]}};
  for(const [stage,path] of Object.entries(stages)) {
    const files=[];
    for(const [name,value] of [[path,stage==='report'?{summary:{total:2}}:[{},{}]],
      [exports[stage],'export'],[tasks[stage],{run_id:run,stage,summary:`${stage} summary`,questions:[`${stage} question`],limitations:[`${stage} limitation`]}]]) {
      const data=JSON.stringify(value),target=resolve(root,'output/runs',run,name);
      mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);
      files.push({path:name,sha256:createHash('sha256').update(data).digest('hex')});
    }
    manifest.stages[stage]={status:'completed'};
    manifest.orchestration.events.push({type:'completed',stage,evidence:{artifact_contract:{version:1,run_id:run,stage,status:'passed',files}}});
  }
  return {root,run,manifest,present:()=>deliveryPresentation(root,run,manifest)};
}

for(const status of ['revision_requested','failed','in_progress','blocked','planned','skipped']) {
  test(`current ${status} stages cannot publish historical counts, summaries or links`,t=>{
    const f=fixture(t);
    for(const stage of Object.values(f.manifest.stages)) stage.status=status;
    const p=f.present();
    assert.deepEqual(p.facts,{test_points:null,test_cases:null,report_results:null,artifact_count:0});
    assert.equal(p.reply_template,'');assert.equal(p.concise_summary,'');assert.equal(p.markdown,'');
    assert.deepEqual(p.pending_questions,[]);assert.deepEqual(p.limitations,[]);assert.equal(p.question_status,'unknown');
  });
}

test('legacy contracts remain usable with current event bindings and saved confirmations',t=>{
  const f=fixture(t),events=f.manifest.orchestration.events;
  const completion=events.find(e=>e.stage==='report');completion['dispatch-id']='current';
  events.unshift({type:'dispatched',stage:'report',dispatch_id:'current'});
  f.manifest.stages.report={status:'awaiting_confirmation',dispatch_id:'current'};
  const p=f.present();
  assert.equal(p.facts.test_points,2);assert.equal(p.facts.test_cases,2);assert.equal(p.facts.report_results.total,2);
  assert.equal(p.artifacts.length,3);assert.deepEqual(p.confirmation_stages,['report']);
  for(const stage of ['test_points','test_cases','report']) {
    assert.ok(p.pending_questions.includes(`${stage} question`));
    assert.ok(p.limitations.includes(`${stage} limitation`));
    assert.ok(p.reply_template.includes(`${stage} summary`));
  }
});

for(const mismatch of ['old_completion','missing_completion_id','stage_id','contract_id','completion_before_dispatch','latest_invalid_contract']) {
  test(`current delivery rejects ${mismatch} without falling back to older completion`,t=>{
    const f=fixture(t),events=f.manifest.orchestration.events;
    const completion=events.find(e=>e.stage==='report');completion['dispatch-id']='current';
    const dispatch={type:'dispatched',stage:'report',dispatch_id:'current'};
    events.unshift(dispatch);f.manifest.stages.report.dispatch_id='current';
    if(mismatch==='old_completion') completion['dispatch-id']='old';
    if(mismatch==='missing_completion_id') delete completion['dispatch-id'];
    if(mismatch==='stage_id') f.manifest.stages.report.dispatch_id='other';
    if(mismatch==='contract_id') completion.evidence.artifact_contract.dispatch_id='other';
    if(mismatch==='completion_before_dispatch') events.push({...dispatch});
    if(mismatch==='latest_invalid_contract') events.push({type:'completed',stage:'report','dispatch-id':'current'});
    const p=f.present();
    assert.equal(p.facts.report_results,null);assert.equal(p.artifacts.length,2);
    assert.ok(!p.reply_template.includes('report summary'));assert.ok(!p.pending_questions.includes('report question'));
    assert.ok(!p.limitations.includes('report limitation'));assert.equal(p.facts.test_cases,2);
  });
}

test('current version still requires matching file hashes',t=>{
  const f=fixture(t);
  writeFileSync(resolve(f.root,'output/runs',f.run,'design/test_cases.json'),'[]');
  writeFileSync(resolve(f.root,'output/runs',f.run,'design/test_cases.xlsx'),'changed');
  const p=f.present();assert.equal(p.facts.test_cases,null);assert.equal(p.artifacts.length,2);
});
