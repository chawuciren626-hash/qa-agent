import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderStageReview, writeStageReviewDocument } from '../../scripts/stage-review-documents.mjs';
import { assertArtifactContract } from '../../scripts/artifact-contracts.mjs';
import { readRunFile } from '../../scripts/design-quality.mjs';
import { provenanceFixture } from './provenance-fixtures.mjs';
import { zipFixture } from './artifact-fixtures.mjs';

test('review Markdown preserves every point and incomplete execution scope',()=>{
  const md=renderStageReview('test_points',()=>({points:[{id:'TP-1',module:'登录',feature:'必填项',description:'空值提示',priority:'P1'},{id:'TP-2',module:'登录',feature:'长度',description:'边界条件'}]}));
  for(const text of ['TP-1','TP-2','空值提示','边界条件','P1']) assert.ok(md.includes(text));
  assert.match(md,/\*\*测试点：\*\* 空值提示/);
  assert.match(md,/\*\*优先级：\*\* P1/);
  const sources={'execution/test_results.json':{run_id:'run-demo',status:'partial',cases:[{case_id:'C1',status:'passed',evidence_mode:'simulated'}],summary:{total:1,passed:1,failed:0,blocked:0,skipped:0}},'execution/execution-task.json':{summary:'部分完成',limitations:['业务提交未测试']},'execution/browser-coverage.json':{untested_cases:[{case_id:'C2',title:'提交'}]}};
  const brief=renderStageReview('execution',file=>sources[file]);
  for(const text of ['部分完成','业务提交未测试','C2','simulated']) assert.ok(brief.includes(text));
  assert.match(brief,/\*\*运行：\*\* run-demo/);
  assert.match(brief,/\*\*执行限制：\*\* 业务提交未测试/);
  assert.throws(()=>renderStageReview('execution',()=>null));
});

test('completion document is included in sealed receipt and rejects changed source',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'qa-review-md-'));
  try {
    mkdirSync(resolve(dir,'design'));writeFileSync(resolve(dir,'design/test_points.json'),JSON.stringify([{id:'TP-1',module:'a',feature:'b',description:'c'}]));
    const file=readRunFile(dir,'design/test_points.json');const receipt={files:[{path:file.path,sha256:file.sha256}]};
    assert.equal(writeStageReviewDocument(dir,'test_points',receipt),'design/test_points.md');
    assert.equal(receipt.files.find(f=>f.path==='design/test_points.md').sha256,readRunFile(dir,'design/test_points.md').sha256);
    writeFileSync(resolve(dir,'design/test_points.json'),'[]');
    assert.throws(()=>writeStageReviewDocument(dir,'test_points',receipt));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('case edits renew review, regenerate Excel, reject stale saves and preserve executed design',()=>{
  const root=resolve(import.meta.dirname,'../..'),temp=mkdtempSync(resolve(tmpdir(),'qa-case-review-'));
  const sessionId=`session-2026-11-02-16-00-00-${randomUUID().replaceAll('-','')}`,runId=`run-${randomUUID()}`,session=resolve(temp,sessionId),dir=resolve(session,'output/runs',runId);
  const context={version:1,engine_root:root,workspace_root:temp,session_root:session,session_id:sessionId};
  const oldContext=process.env.QA_DIRECTORY_CONTEXT;process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(context);
  try {
    for(const part of ['design','inputs'])mkdirSync(resolve(dir,part),{recursive:true});
    writeFileSync(resolve(dir,'inputs/request.txt'),'Original requirement');
    const rows=[1,2,3].map(i=>({case_id:`TC-${i}`,title:`Case ${i}`,priority:'P1',preconditions:[],steps:['Do something'],expected:'Original requirement',expected_basis:[{expected:'Original requirement',kind:'requirement',source_path:'inputs/request.txt',quote:'Original requirement'}]}));
    writeFileSync(resolve(dir,'design/test_cases.json'),JSON.stringify(rows));
    writeFileSync(resolve(dir,'design/test_cases-task.json'),JSON.stringify({run_id:runId,stage:'test_cases',outcome:'completed',summary:'Synthetic test fixture',source_paths:['inputs/request.txt'],questions:[],limitations:[]}));
    const manifest={run_id:runId,directory_context:context,artifacts:['design/test_cases.json','design/test_cases.xlsx','design/test_cases-task.json'],status:'awaiting_confirmation',stages:{test_cases:{status:'awaiting_confirmation'}},confirmations:[],orchestration:{plan:{workflow_mode:'task',review_mode:'staged',stages:[{id:'test_cases',selected:true,confirmation:'after',depends_on:[]}]},events:[]}};
    const put=()=>writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest));put();
    const generated=spawnSync(process.execPath,[resolve(root,'scripts/generate-test-cases-xlsx.mjs'),resolve(dir,'design/test_cases.json'),resolve(dir,'design/test_cases.xlsx')],{encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    const receipt=assertArtifactContract(root,runId,'test_cases',{artifacts:manifest.artifacts});
    manifest.confirmations.push({id:'confirm-test_cases-original',stage:'test_cases',kind:'result',status:'pending',artifact_contract:receipt});
    manifest.orchestration.events.push({type:'completed',stage:'test_cases',evidence:{artifact_contract:receipt}},{type:'confirmation_requested',stage:'test_cases'});put();
    const payload={runId,sessionId,confirmationId:'confirm-test_cases-original',actorId:'owner',caseId:'TC-1',version:readRunFile(dir,'design/test_cases.json').sha256,operation:'edit',values:{title:'Edited title',expected:'Human corrected requirement'}};
    const run=input=>spawnSync(process.execPath,[resolve(root,'scripts/update-case-review.mjs')],{encoding:'utf8',env:{...process.env,QA_CASE_REVIEW:JSON.stringify(input)}});
    const edited=run(payload);assert.equal(edited.status,0,edited.stderr);
    const next=JSON.parse(readFileSync(resolve(dir,'manifest.json'))),data=JSON.parse(readFileSync(resolve(dir,'design/test_cases.json')));
    assert.equal(data[0].title,'Edited title');assert.equal(data[0].expected,'Human corrected requirement');
    assert.equal(next.stages.test_cases.status,'awaiting_confirmation');assert.equal(next.confirmations.at(-1).status,'pending');assert.notEqual(next.confirmations.at(-1).id,'confirm-test_cases-original');
    assertArtifactContract(root,runId,'test_cases',{artifacts:next.artifacts});
    assert.notEqual(run(payload).status,0);
    const deleteInput={...payload,operation:'delete',caseId:'TC-2',version:readRunFile(dir,'design/test_cases.json').sha256,confirmationId:next.confirmations.at(-1).id};
    const deleted=run(deleteInput);assert.equal(deleted.status,0,deleted.stderr);assert.equal(JSON.parse(readFileSync(resolve(dir,'design/test_cases.json'))).length,2);
    const current=JSON.parse(readFileSync(resolve(dir,'manifest.json')));current.orchestration.events.push({type:'dispatched',stage:'execution'});writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(current));
    assert.notEqual(run({...deleteInput,version:readRunFile(dir,'design/test_cases.json').sha256,confirmationId:current.confirmations.at(-1).id}).status,0);
  } finally {if(oldContext===undefined)delete process.env.QA_DIRECTORY_CONTEXT;else process.env.QA_DIRECTORY_CONTEXT=oldContext;rmSync(temp,{recursive:true,force:true});}
});

test('lifecycle deletion preserves explicit excluded coverage and permits approval of the edited version',()=>{
  const root=resolve(import.meta.dirname,'../..'),temp=mkdtempSync(resolve(tmpdir(),'qa-case-lifecycle-'));
  const sessionId=`session-2026-11-02-16-30-00-${randomUUID().replaceAll('-','')}`,runId=`run-${randomUUID()}`,session=resolve(temp,sessionId),dir=resolve(session,'output/runs',runId);
  const context={version:1,engine_root:root,workspace_root:temp,session_root:session,session_id:sessionId};
  const old=process.env.QA_DIRECTORY_CONTEXT;process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(context);
  try {
    for(const part of ['design','inputs'])mkdirSync(resolve(dir,part),{recursive:true});
    writeFileSync(resolve(dir,'inputs/requirements.md'),'Synthetic');provenanceFixture(dir,runId);
    const points=[1,2].map(i=>({id:`TP-${i}`,module:'Synthetic',feature:'Read',description:`Point ${i}`,risk:'低',coverage_type:['normal'],source:'analysis/requirement_analysis.md',rule_ids:['RULE-SYNTHETIC']}));
    writeFileSync(resolve(dir,'design/test_points.json'),JSON.stringify(points));
    zipFixture(resolve(dir,'design/test_points.xmind'),{'content.json':JSON.stringify([{rootTopic:{title:'Synthetic',children:{attached:[{title:'Synthetic',children:{attached:[{title:'Read',children:{attached:points.map(p=>({title:p.description}))}}]}}]}}}])});
    const rows=points.map((p,i)=>({case_id:`TC-${i+1}`,title:'Synthetic',priority:'P2',type:'functional',preconditions:[],related_test_point:p.id,automation_feasible:true,steps:['Synthetic'],expected:'Synthetic',design_contract:{basis:[{source:'inputs/requirements.md',rule:'Synthetic',status:'confirmed',rule_id:'RULE-SYNTHETIC'}],assumptions:[],data_checks:[]}}));
    writeFileSync(resolve(dir,'design/test_cases.json'),JSON.stringify(rows));
    const manifest={run_id:runId,directory_context:context,artifacts:['design/test_cases.json','design/test_cases.xlsx'],status:'awaiting_confirmation',stages:{test_cases:{status:'awaiting_confirmation'}},confirmations:[],orchestration:{plan:{workflow_mode:'lifecycle',review_mode:'staged',stages:[{id:'test_cases',selected:true,confirmation:'after',depends_on:[]}]},events:[]}};
    const put=()=>writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest));put();
    const generated=spawnSync(process.execPath,[resolve(root,'scripts/generate-test-cases-xlsx.mjs'),resolve(dir,'design/test_cases.json'),resolve(dir,'design/test_cases.xlsx')],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
    const receipt=assertArtifactContract(root,runId,'test_cases',{artifacts:manifest.artifacts});
    manifest.confirmations.push({id:'confirm-test_cases-original',stage:'test_cases',kind:'result',status:'pending',artifact_contract:receipt});manifest.orchestration.events.push({type:'completed',stage:'test_cases',evidence:{artifact_contract:receipt}},{type:'confirmation_requested',stage:'test_cases'});put();
    const saved=spawnSync(process.execPath,[resolve(root,'scripts/update-case-review.mjs')],{encoding:'utf8',env:{...process.env,QA_CASE_REVIEW:JSON.stringify({runId,sessionId,actorId:'owner',confirmationId:'confirm-test_cases-original',version:readRunFile(dir,'design/test_cases.json').sha256,operation:'delete',caseId:'TC-1'})}});
    assert.equal(saved.status,0,saved.stderr);
    const current=JSON.parse(readFileSync(resolve(dir,'manifest.json')));
    assertArtifactContract(root,runId,'test_cases',{artifacts:current.artifacts});
    assert.equal(JSON.parse(readFileSync(resolve(dir,'design/test_cases-review.json'))).deletions[0].test_point,'TP-1');
    const approved=spawnSync(process.execPath,[resolve(root,'scripts/approve-design-stage.mjs'),runId,sessionId,'test_cases',current.confirmations.at(-1).id,'owner'],{encoding:'utf8'});
    assert.equal(approved.status,0,approved.stderr);assert.equal(JSON.parse(readFileSync(resolve(dir,'manifest.json'))).stages.test_cases.status,'completed');
  } finally {if(old===undefined)delete process.env.QA_DIRECTORY_CONTEXT;else process.env.QA_DIRECTORY_CONTEXT=old;rmSync(temp,{recursive:true,force:true});}
});
