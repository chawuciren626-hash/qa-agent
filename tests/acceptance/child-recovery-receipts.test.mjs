import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertChildCommands } from '../../scripts/child-command-policy.mjs';
import { recordCorrection, stalledCorrection } from '../../scripts/recovery-policy.mjs';
import { verifyActionRecoveryReceipt } from '../../scripts/stage-evidence.mjs';

function fixture(t) {
  const root=mkdtempSync(resolve(tmpdir(),'qa-child-recovery-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const parent='parent',run='run-recovery',at='2026-10-20T00:00:00Z';
  const dir=resolve(root,'output/action-audit',parent);mkdirSync(dir,{recursive:true});
  let serial=0;
  const persist=result=>{
    const action_receipt=resolve(dir,`${++serial}.json`);
    const receipt={session_id:parent,run_id:run,at,task_key:`${run}:export_report:`,...result};
    writeFileSync(action_receipt,JSON.stringify(receipt));
    return {...receipt,action_receipt};
  };
  const verify=result=>verifyActionRecoveryReceipt(root,run,parent,at,result);
  const success=task_key=>persist({status:'completed',exit_code:0,execution_mode:'in_process',launches_child:false,...(task_key?{task_key}:{})});
  return {persist,verify,success,key:`${run}:export_report:`};
}

const rows=results=>results.flatMap((result,index)=>[
  {payload:{type:'tool_call',name:'exec_command',tool_call_id:String(index),arguments:{cmd:'node scripts/project-action.mjs execute'}}},
  {payload:{type:'tool_call_output',tool_call_id:String(index),stop_reason:result.exit_code?'fatal':'completed',output:JSON.stringify(result)}}
]);
const options=f=>({allowRecovery:true,verifyRecovery:f.verify});

function stalled(f,category='artifact_revision',priorFailures=0) {
  const context={key:f.key,progress_sha256:'unchanged'};
  const state={corrections:{[f.key]:priorFailures}};
  let recovery;
  for(let n=0;n<3;n++) recovery=recordCorrection(state,category,context,new Error('unchanged failure'));
  const failed=f.persist({status:'rejected',classification:'input_rejected',exit_code:2,recovery});
  const refused=f.persist({status:'rejected',classification:'correction_stalled',exit_code:2,recovery:stalledCorrection(state,context)});
  return [failed,refused];
}

test('verified third failure and pre-execution stalled rejection remain pending until same-task success',t=>{
  const f=fixture(t);
  for(const category of ['input_correction','artifact_revision','read_correction','request_correction','handoff_correction']) {
    for(const prior of [0,4]) {
      const results=stalled(f,category,prior);
      assert.equal(results[0].recovery.failure_number,prior+3);
      assert.equal(results[0].recovery.retry_allowed,false);
      assert.equal(results[1].recovery.category,category);
      assert.ok(results.every(f.verify));
      assert.throws(()=>assertChildCommands(rows(results),options(f)),/not resolved/);
      assert.doesNotThrow(()=>assertChildCommands(rows(results),{...options(f),allowUnresolvedRecovery:true}));
      assert.doesNotThrow(()=>assertChildCommands(rows([...results,f.success()]),options(f)));
      assert.throws(()=>assertChildCommands(rows([...results,f.success('run-recovery:other:')]),options(f)),/not resolved/);
      assert.throws(()=>assertChildCommands(rows([...results,f.success()]),{...options(f),allowRecovery:false}),/failed/);
    }
  }
});

test('legacy verified exhausted correction can be retained for revision beyond failure three',t=>{
  const f=fixture(t);
  const result=f.persist({status:'failed',exit_code:2,recovery:{category:'artifact_revision',key:f.key,failure_number:6,retry_allowed:false}});
  assert.doesNotThrow(()=>assertChildCommands(rows([result]),{...options(f),allowUnresolvedRecovery:true}));
  assert.throws(()=>assertChildCommands(rows([result,f.success()]),options(f)),/failed/);
});

test('stalled recovery cannot be inferred from unverified, tampered or unrelated receipts',t=>{
  const f=fixture(t),[failed,refused]=stalled(f),success=f.success();
  for(const result of [failed,refused]) {
    assert.throws(()=>assertChildCommands(rows([result,success]),{allowRecovery:true,verifyRecovery:()=>false}),/failed/);
    const changed={...result,recovery:{...result.recovery,failure_number:99}};
    assert.equal(f.verify(changed),false);
    assert.throws(()=>assertChildCommands(rows([changed,success]),{...options(f),allowUnresolvedRecovery:true}),/failed/);
    assert.throws(()=>assertChildCommands(rows([result,{...success,task_key:'run-recovery:foreign:'}]),options(f)),/not resolved/);
  }
  for(const mutate of [
    r=>r.recovery.category='execution_retry',r=>r.recovery.stalled=false,
    r=>r.recovery.policy='unknown',r=>r.recovery.failure_number=2,
    r=>r.recovery.failure_number=3.5,r=>r.recovery.key='foreign',
    r=>r.status='interrupted',r=>r.status='cleanup_required',r=>r.status='timeout',r=>r.exit_code=1
  ]) {
    const candidate=structuredClone(refused);mutate(candidate);
    const verified=f.persist(candidate);
    assert.throws(()=>assertChildCommands(rows([verified,success]),options(f)),/failed/);
  }
});

function timeout(f,recovery={category:'artifact_revision',key:f.key,failure_number:1,retry_allowed:true,policy:'progress_based'}) {
  return f.persist({status:'timeout',exit_code:2,action:'export_report',result:{termination_confirmed:true,termination:'timeout'},recovery});
}

test('verified safe artifact timeout is pending, never completion on its own',t=>{
  const f=fixture(t);
  for(const recovery of [undefined,stalled(f)[0].recovery]) {
    const result=timeout(f,recovery);
    assert.throws(()=>assertChildCommands(rows([result]),options(f)),/not resolved/);
    assert.doesNotThrow(()=>assertChildCommands(rows([result]),{...options(f),allowUnresolvedRecovery:true}));
    assert.doesNotThrow(()=>assertChildCommands(rows([result,f.success()]),options(f)));
    assert.throws(()=>assertChildCommands(rows([result,f.success('run-recovery:other:')]),options(f)),/not resolved/);
  }
});

test('timeouts with unknown termination, unsafe actions or absent recovery are not correctable',t=>{
  const f=fixture(t);
  for(const mutate of [
    r=>delete r.recovery,r=>r.recovery.category='input_correction',
    r=>r.action='browser_task',r=>r.action='execute',r=>delete r.action,
    r=>delete r.result,r=>r.result.termination_confirmed=false,
    r=>r.result.termination='interrupted',r=>r.result.termination='cleanup_required'
  ]) {
    const candidate=timeout(f);mutate(candidate);const result=f.persist(candidate);
    for(const allowUnresolvedRecovery of [false,true]) {
      assert.throws(()=>assertChildCommands(rows([result,f.success()]),{...options(f),allowUnresolvedRecovery}),/failed/);
    }
  }
  assert.throws(()=>assertChildCommands(rows([timeout(f),f.success()]),{allowRecovery:true,verifyRecovery:()=>false}),/failed/);
});

test('browser timeout remains governed by the existing closed partial-delivery verifier',t=>{
  const f=fixture(t),result=f.persist({status:'timeout',exit_code:2,action:'browser_task',recovery:null});
  assert.throws(()=>assertChildCommands(rows([result]),options(f)),/failed/);
  assert.doesNotThrow(()=>assertChildCommands(rows([result]),{...options(f),verifyPartialBrowserFailure:r=>r.action_receipt===result.action_receipt}));
});
