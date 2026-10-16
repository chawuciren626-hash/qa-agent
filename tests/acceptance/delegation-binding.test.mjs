import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureDelegationBinding, verifyDelegationBinding } from '../../scripts/delegation-binding.mjs';

function fixture(t, { contract = true, evidence = false } = {}) {
  const root=realpathSync(mkdtempSync(resolve(tmpdir(),'qa-binding-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const session='session-2026-10-15-00-00-00-aabbccdd',runId='run-binding',stage=evidence?'report':'test_cases',dispatchId='dispatch-test';
  const args={agent_id:'test_case_agent',description:'Assigned task',prompt:`run_id=${runId} ${session} ${dispatchId} policy ${contract?'INDEPENDENT TASK CONTRACT':'lifecycle'}`};
  const dir=resolve(root,'output/delegations');mkdirSync(dir,{recursive:true});
  const path=resolve(dir,`${dispatchId}.json`), contractPath=resolve(dir,`${dispatchId}.prompt.txt`), evidencePath=resolve(dir,`${dispatchId}.evidence.json`);
  writeFileSync(path,JSON.stringify(args));
  if(contract)writeFileSync(contractPath,'Original scoped assignment\r\nOnly current sources.');
  if(evidence)writeFileSync(evidencePath,'{"files":[]}');
  const binding=captureDelegationBinding(root,dispatchId,args,{contract,evidence});
  const receipt={action:'dispatch',status:'completed',exit_code:0,session_id:session,run_id:runId,stage,dispatch_id:dispatchId,delegation:args,delegation_binding:binding};
  const audit=resolve(root,'output/action-audit',session);mkdirSync(audit,{recursive:true});
  const receiptPath=resolve(audit,'receipt.json'),save=()=>writeFileSync(receiptPath,JSON.stringify(receipt));save();
  const verify=(overrides={})=>verifyDelegationBinding(root,{session,runId,stage,dispatchId,args,...overrides});
  return {root,args,receipt,save,verify,path,contractPath,evidencePath,receiptPath,audit};
}

test('task and lifecycle bindings accept unchanged arguments regardless of JSON key order',t=>{
  for(const contract of [true,false]) {
    const f=fixture(t,{contract});const before=readFileSync(f.receiptPath);
    assert.equal(f.verify({args:{prompt:f.args.prompt,description:f.args.description,agent_id:f.args.agent_id}}).version,1);
    assert.deepEqual(readFileSync(f.receiptPath),before);
  }
});
test('retaining identity tokens does not allow changed goals, role or extra arguments',t=>{
  const f=fixture(t);
  for(const change of [{prompt:f.args.prompt+' Different business goal'},{agent_id:'test_agent'},{model:'other'},{description:''},{description:42}]) {
    assert.throws(()=>f.verify({args:{...f.args,...change}}),/differ|complete registered/);
  }
  f.verify();
});

test('display description may change without changing authority, receipt or bound files',t=>{
  for(const contract of [true,false]) {
    const f=fixture(t,{contract}),before=readFileSync(f.receiptPath),file=readFileSync(f.path);
    assert.equal(f.verify({args:{...f.args,description:'生成本次报告'}}).version,1);
    assert.deepEqual(readFileSync(f.receiptPath),before);assert.deepEqual(readFileSync(f.path),file);
    const missing={...f.args};delete missing.agent_id;
    assert.throws(()=>f.verify({args:missing}),/complete registered/);
    f.receipt.delegation.description='tampered receipt';f.save();
    assert.throws(()=>f.verify({args:{...f.args,description:'展示文字'}}),/receipt changed/);
  }
});
test('changed delegation file, contract bytes and report evidence are rejected',t=>{
  for(const file of ['path','contractPath','evidencePath']) {
    const f=fixture(t,{evidence:true});const original=readFileSync(f[file]);
    writeFileSync(f[file],Buffer.concat([original,Buffer.from('\nchanged')]));
    assert.throws(()=>f.verify(),/resource changed/);
    writeFileSync(f[file],original);f.verify();
  }
});

test('wait duration is transport metadata, not permission to change scope or model',t=>{
  const f=fixture(t);
  for(const yield_time_ms of [250,600000]) assert.equal(f.verify({args:{...f.args,description:'Local display',yield_time_ms}}).version,1);
  for(const yield_time_ms of [0,249,600001,'600000',null,Infinity]) assert.throws(()=>f.verify({args:{...f.args,yield_time_ms}}),/Invalid delegation/);
  for(const change of [{model_id:'different'},{provider:'different'},{run_in_background:true},{prompt:f.args.prompt+' different scope'}]) assert.throws(()=>f.verify({args:{...f.args,yield_time_ms:600000,...change}}));
});
test('missing, duplicate, cross-task, unfinished and unbound legacy receipts do not authorize launch',t=>{
  const f=fixture(t);
  for(const [key,value] of [['session_id','other'],['run_id','run-other'],['stage','execution'],['status','started'],['exit_code',1],['delegation_binding',undefined]]) {
    const old=f.receipt[key];f.receipt[key]=value;f.save();assert.throws(()=>f.verify());f.receipt[key]=old;f.save();
  }
  writeFileSync(resolve(f.audit,'duplicate.json'),readFileSync(f.receiptPath));assert.throws(()=>f.verify(),/one registered/);
  unlinkSync(resolve(f.audit,'duplicate.json'));unlinkSync(f.receiptPath);assert.throws(()=>f.verify(),/one registered/);
});
test('bound resources cannot escape the dispatch directory or redirect through a junction',t=>{
  const f=fixture(t);f.receipt.delegation_binding.files[0].path='../outside';f.save();assert.throws(()=>f.verify(),/Invalid bound/);
  const g=fixture(t);const original=readFileSync(g.path);rmSync(resolve(g.root,'output/delegations'),{recursive:true});
  const other=resolve(g.root,'other');mkdirSync(other);writeFileSync(resolve(other,'dispatch-test.json'),original);
  symlinkSync(other,resolve(g.root,'output/delegations'),'junction');assert.throws(()=>g.verify(),/Linked/);
});
test('unavailable contract or modified receipt parameters fail closed without changing recorded authority',t=>{
  const f=fixture(t);f.receipt.delegation.prompt+=' new goal';f.save();assert.throws(()=>f.verify(),/receipt changed/);
  const g=fixture(t);unlinkSync(g.contractPath);assert.throws(()=>g.verify(),/ENOENT/);
});
