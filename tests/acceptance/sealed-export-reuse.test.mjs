import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { draftArtifactActions, runDraftArtifactAction } from '../../scripts/draft-artifact-actions.mjs';

const actions=['export_test_points','export_test_cases','export_report'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function fixture(t,action='export_test_cases',decision=null) {
  const root=mkdtempSync(resolve(tmpdir(),'qa-sealed-export-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const runId='run-sealed-export',parent='parent-owner',dispatch='dispatch-current';
  const definition=draftArtifactActions[action],stage=definition.stage;
  const dir=resolve(root,'output/runs',runId);
  const put=(path,value)=>{
    const target=resolve(dir,path);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,typeof value==='string'?value:JSON.stringify(value));
  };
  const paths=[...new Set([...definition.inputs,...definition.outputs,'inputs/original.txt'])];
  // Hash fixtures model already validated receipts, not real Office documents.
  for(const path of paths) put(path,`Sealed fixture bytes: ${path}`);
  const contract={version:1,run_id:runId,stage,status:'passed',files:paths.map(path=>({path,sha256:digest(readFileSync(resolve(dir,path)))}))};
  const completed={type:'completed',stage,'dispatch-id':dispatch,'parent-session-id':parent,evidence:{parent_session_id:parent,artifact_contract:contract}};
  const manifest={run_id:runId,stages:{[stage]:{status:decision==='pending'?'awaiting_confirmation':'completed',dispatch_id:dispatch}},confirmations:[],orchestration:{
    plan:{stages:[{id:stage,selected:true,depends_on:[],confirmation:decision?'after':'none'}]},
    events:[{type:'dispatched',stage,dispatch_id:dispatch,'parent-session-id':parent},completed]
  }};
  if(decision) {
    manifest.confirmations.push({id:'confirm-current',stage,status:decision,artifact_contract:structuredClone(contract),reason:'Preserve this decision'});
    manifest.orchestration.events.push({type:'confirmation_requested',stage,confirmation_id:'confirm-current'});
    if(decision==='approved') manifest.orchestration.events.push({type:'confirmation_resolved',stage,decision});
  }
  const save=()=>put('manifest.json',manifest);save();
  const invoke=(owner=parent)=>runDraftArtifactAction(root,owner,action,runId);
  return {root,dir,runId,parent,dispatch,definition,stage,contract,completed,manifest,put,save,invoke};
}

function snapshot(dir) {
  return readdirSync(dir,{recursive:true}).sort().map(path=>{
    const file=resolve(dir,path),stat=statSync(file);
    return stat.isDirectory()?{path,directory:true}:{path,sha256:digest(readFileSync(file)),mtime:stat.mtimeMs,ctime:stat.ctimeMs};
  });
}

for(const action of actions) for(const decision of [null,'pending','approved']) {
  test(`${action}: reuses sealed ${decision ?? 'completed'} delivery without writing artifacts or state`,async t=>{
    const f=fixture(t,action,decision),before=snapshot(f.dir);
    for(let repeat=0;repeat<2;repeat++) {
      const result=await f.invoke();
      assert.equal(result.status,'completed');assert.equal(result.exit_code,0);
      assert.equal(result.execution_mode,'in_process');assert.equal(result.launches_child,false);
      assert.equal(result.reused,true);assert.equal(result.approval_granted,false);
      assert.equal(result.dispatch_id,f.dispatch);
      assert.deepEqual(result.generated_artifacts,f.definition.outputs);
      assert.deepEqual(snapshot(f.dir),before);
    }
  });
}

test('legacy report returns only sealed Word/PDF, never generates or advertises unsealed formats',async t=>{
  const f=fixture(t,'export_report');
  for(const path of f.definition.outputs.slice(2)) {
    f.contract.files=f.contract.files.filter(file=>file.path!==path);
    unlinkSync(resolve(f.dir,path));
  }
  f.save();const before=snapshot(f.dir);
  assert.deepEqual((await f.invoke()).generated_artifacts,f.definition.outputs.slice(0,2));
  assert.deepEqual(snapshot(f.dir),before);
});

test('audited autonomous continuation reuses the contract without granting approval',async t=>{
  const f=fixture(t,'export_test_cases','pending');
  f.manifest.stages[f.stage].status='completed';
  f.manifest.confirmations[0].status='not_required';
  f.manifest.orchestration.plan.review_mode='auto';
  f.manifest.orchestration.plan.stages[0].confirmation='none';
  const continued={type:'review_mode_continued',stage:f.stage,confirmation_id:'confirm-current',decision:'not_required'};
  f.manifest.orchestration.events.push(continued);f.save();
  const before=snapshot(f.dir),result=await f.invoke();
  assert.equal(result.reused,true);assert.equal(result.approval_granted,false);
  assert.deepEqual(snapshot(f.dir),before);
  continued.confirmation_id='foreign';f.save();
  await assert.rejects(f.invoke(),/confirmation/);
});

test('missing or changed sealed output, source or captured evidence is rejected without regeneration',async t=>{
  for(const action of actions) for(const kind of ['output','source','evidence']) for(const damage of ['changed','missing']) {
    const f=fixture(t,action,'pending');
    const path=kind==='output'?f.definition.outputs.at(-1):kind==='source'?f.definition.inputs[0]:'inputs/original.txt';
    if(damage==='missing') unlinkSync(resolve(f.dir,path));else f.put(path,'Changed after completion');
    const before=snapshot(f.dir);
    await assert.rejects(f.invoke(),error=>{
      assert.match(error.message,/Sealed export reuse refused/);
      assert.match(error.message,/Repair only this presentation version/);
      assert.match(error.message,/do not redispatch professional work/);
      return true;
    });
    assert.deepEqual(snapshot(f.dir),before);
  }
});

test('reuse requires the owning selected current dispatch and its completed contract',async t=>{
  const mutations=[
    f=>f.manifest.orchestration.events[0]['parent-session-id']='foreign',
    f=>f.manifest.stages[f.stage].dispatch_id='old',
    f=>f.completed['dispatch-id']='old',
    f=>f.completed['parent-session-id']='foreign',
    f=>f.completed.evidence.parent_session_id='foreign',
    f=>f.manifest.orchestration.plan.stages[0].selected=false,
    f=>f.manifest.orchestration.events.splice(1,1),
    f=>delete f.completed.evidence.artifact_contract,
    f=>f.contract.run_id='run-other',
    f=>f.contract.stage='report',
    f=>f.contract.status='blocked',
    f=>f.contract.files=[],
    f=>f.contract.files=f.contract.files.filter(file=>file.path!==f.definition.outputs[0]),
    f=>{
      f.manifest.orchestration.events.reverse();
      f.manifest.orchestration.events.push({type:'review_mode_continued',stage:f.stage});
    }
  ];
  for(const mutate of mutations) {
    const f=fixture(t);mutate(f);f.save();const before=snapshot(f.dir);
    await assert.rejects(f.invoke());assert.deepEqual(snapshot(f.dir),before);
  }
  const f=fixture(t);await assert.rejects(f.invoke('foreign'),/owning/);
});

test('pending or approved confirmation remains bound to the exact sealed content',async t=>{
  for(const decision of ['pending','approved']) for(const mutation of ['hash','rejected','revision_requested','missing','foreign-id','duplicate']) {
    const f=fixture(t,'export_test_cases',decision),confirmation=f.manifest.confirmations[0];
    if(mutation==='hash') confirmation.artifact_contract.files[0].sha256='0'.repeat(64);
    else if(mutation==='missing') f.manifest.confirmations=[];
    else if(mutation==='foreign-id') confirmation.id='old-confirmation';
    else if(mutation==='duplicate') f.manifest.confirmations.push(structuredClone(confirmation));
    else confirmation.status=mutation;
    f.save();const before=snapshot(f.dir);
    await assert.rejects(f.invoke(),/confirmation/);assert.deepEqual(snapshot(f.dir),before);
  }
});

test('reuse checks transitive dependency hashes and current completion state',async t=>{
  for(const damage of [null,'changed','missing','blocked']) {
    const f=fixture(t);
    f.manifest.orchestration.plan.stages[0].depends_on=['test_points'];
    for(const [stage,dependency] of [['test_points','analysis'],['analysis',null]]) {
      const path=`inputs/${stage}.txt`;f.put(path,`Sealed dependency ${stage}`);
      f.manifest.stages[stage]={status:'completed'};
      f.manifest.orchestration.plan.stages.push({id:stage,selected:true,depends_on:dependency?[dependency]:[]});
      f.manifest.orchestration.events.push({type:'completed',stage,evidence:{artifact_contract:{version:1,run_id:f.runId,stage,status:'passed',files:[{path,sha256:digest(readFileSync(resolve(f.dir,path)))}]}}});
    }
    if(damage==='changed') f.put('inputs/analysis.txt','Changed dependency');
    if(damage==='missing') unlinkSync(resolve(f.dir,'inputs/analysis.txt'));
    if(damage==='blocked') {
      f.manifest.stages.analysis.status='blocked';
      f.manifest.orchestration.events.push({type:'blocked',stage:'analysis'});
    }
    f.save();const before=snapshot(f.dir);
    if(damage) await assert.rejects(f.invoke(),/Sealed export reuse refused/);
    else assert.equal((await f.invoke()).reused,true);
    assert.deepEqual(snapshot(f.dir),before);
  }
});

test('failed or revision-requested stages cannot reuse old exports',async t=>{
  for(const [status,type] of [['failed','failed'],['blocked','blocked'],['revision_requested','stage_recovered']]) {
    const f=fixture(t);f.manifest.stages[f.stage].status=status;
    f.manifest.orchestration.events.push({type,stage:f.stage});f.save();
    const before=snapshot(f.dir);await assert.rejects(f.invoke(),/active professional dispatch/);
    assert.deepEqual(snapshot(f.dir),before);
  }
});

test('existing exporter lock is preserved without attempting legacy PID recovery',async t=>{
  const f=fixture(t);f.put('manifest.json.lock',{pid:99999999,action:'export_test_cases'});
  const before=snapshot(f.dir);await assert.rejects(f.invoke(),{code:'EEXIST'});
  assert.deepEqual(snapshot(f.dir),before);
});
