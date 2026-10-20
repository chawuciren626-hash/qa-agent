import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { ownProcessIdentity } from '../../scripts/process-identity.mjs';
import { withControllerSession, readControllerSession, reviewControllerSession } from '../../scripts/controller-command-session.mjs';
import { validateCommandArguments, commandHelp, CommandUsageError } from '../../scripts/command-contracts.mjs';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { isSafeArtifactAction, safeStoppedOperation, ArtifactSafetyError, classifyRecoverable } from '../../scripts/recovery-policy.mjs';

const root = resolve(import.meta.dirname, '../..');
test('artifact safety rejection is typed and cannot inherit ordinary or wrapped usage recovery',()=>{
  const context={action:'export_report',stage:'report',key:'safe-export'};
  const violation=new ArtifactSafetyError('Artifact boundary rejected');
  for(const error of [violation,new Error('Wrapped exporter error',{cause:violation}),new CommandUsageError('Wrapped usage')]) {
    if(error instanceof CommandUsageError) error.cause=violation;
    assert.equal(classifyRecoverable(error,null,context),null);
  }
  assert.equal(classifyRecoverable(new Error(violation.message),null,context),'artifact_revision');
  assert.equal(classifyRecoverable(Object.assign(new Error('Missing local draft'),{code:'ENOENT'}),null,context),'artifact_revision');
});
const exitedPid = () => {
  const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});
  assert.equal(child.status,0);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  return child.pid;
};

test('reused PID lock and running owner are recovered without stopping the replacement process',async()=>{
  const identity=ownProcessIdentity();assert.ok(identity);
  const stale={...identity,process_start:String(BigInt(identity.process_start)-1n)};
  const f=fixture(),path=resolve(root,'output/controller-command-sessions',f.id,'state.json');
  mkdirSync(resolve(path,'..'),{recursive:true});
  writeFileSync(path,JSON.stringify({session_id:f.id,status:'running',owner_pid:process.pid,owner_identity:stale,events:[],token:randomUUID()}));
  writeFileSync(`${path}.lock`,JSON.stringify({version:2,host:hostname(),session_id:f.id,pid:process.pid,process_identity:stale,token:randomUUID()}));
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot}),/Controller session stopped/);
  assert.equal(readControllerSession(root,f.id).failure.status,'owner_exited');
  assert.equal(existsSync(`${path}.lock`),false);assert.doesNotThrow(()=>process.kill(process.pid,0));
});

test('a dead recovery claimant can be succeeded but a live claimant cannot be displaced',async()=>{
  for(const alive of [false,true]) {
    const f=fixture(),path=resolve(root,'output/controller-command-sessions',f.id,'state.json');
    const audit=resolve(path,'..','lock-recovery');mkdirSync(audit,{recursive:true});
    const raw=JSON.stringify({version:2,host:hostname(),session_id:f.id,pid:exitedPid(),token:randomUUID()});
    const hash=createHash('sha256').update(raw).digest('hex');
    const claimPath=resolve(audit,`${hash}.json`);
    const claim=JSON.stringify({previous_sha256:hash,claimant:{host:hostname(),pid:alive?process.pid:exitedPid(),token:randomUUID()}});
    writeFileSync(`${path}.lock`,raw);writeFileSync(claimPath,claim);
    let executions=0;
    const run=()=>withControllerSession(root,f.id,async()=>{executions++;return {status:'completed',exit_code:0};},{agentRoot:f.agentRoot});
    if(alive) {
      await assert.rejects(run,{code:'EEXIST'});assert.equal(executions,0);
      assert.equal(readFileSync(`${path}.lock`,'utf8'),raw);assert.equal(readdirSync(audit).length,1);
      unlinkSync(`${path}.lock`);
    } else {
      await run();assert.equal(executions,1);assert.equal(readdirSync(audit).length,2);assert.equal(existsSync(`${path}.lock`),false);
    }
    assert.equal(readFileSync(claimPath,'utf8'),claim);
  }
});

test('confirmed browser command failure allows inspection and finish but never replay or cross-run recovery',async()=>{
  const f=fixture(),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId,'audit/commands',randomUUID());
  mkdirSync(dir,{recursive:true});
  writeFileSync(resolve(dir,'command.json'),JSON.stringify({script:'browser-task.mjs',run_id:runId,child_pid:exitedPid(),result:{termination:'timeout'}}));
  await withControllerSession(root,f.id,async()=>({status:'timeout',exit_code:2,evidence_dir:dir}),{agentRoot:f.agentRoot});
  const failure=readControllerSession(root,f.id).failure;
  const call=(op,result={status:'completed',exit_code:0},run=runId)=>withControllerSession(root,f.id,async()=>result,
    {agentRoot:f.agentRoot,recoveryContext:{action:'browser_task',run_id:run,browser_operation:op}});
  await assert.rejects(()=>call('click'),/Controller session stopped/);
  await assert.rejects(()=>call('snapshot',undefined,`run-${randomUUID()}`),/Controller session stopped/);
  for(const op of ['health','snapshot','assert']) {
    await call(op);assert.deepEqual(readControllerSession(root,f.id).failure,failure);
    assert.equal(readControllerSession(root,f.id).status,'stopped');
  }
  await call('finish',{status:'completed',exit_code:0,data:{status:'session_unavailable'}});
  assert.equal(readControllerSession(root,f.id).status,'stopped');
  await call('finish',{status:'completed',exit_code:0,data:{status:'closed'}});
  const state=readControllerSession(root,f.id);assert.equal(state.status,'stopped');assert.deepEqual(state.failure,failure);
  assert.equal(state.events.filter(e=>e.type==='command_failed').length,1);
  await withControllerSession(root,f.id,async()=>({status:'cleanup_required',exit_code:2}),{agentRoot:f.agentRoot,recoveryContext:{action:'export_report'}});
  await assert.rejects(()=>call('finish',{status:'completed',data:{status:'closed'}}),/Controller session stopped/);
  assert.deepEqual(readControllerSession(root,f.id).failure,failure);
});

test('user interruption and live browser command cannot be recovered as a fault',async()=>{
  for(const [pid,termination] of [[process.pid,'timeout'],[exitedPid(),'interrupted']]) {
    const f=fixture(),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId,'audit/commands',randomUUID());
    mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'command.json'),JSON.stringify({script:'browser-task.mjs',run_id:runId,child_pid:pid,result:{termination}}));
    await withControllerSession(root,f.id,async()=>({status:'timeout',exit_code:2,evidence_dir:dir}),{agentRoot:f.agentRoot});
    await assert.rejects(()=>withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,
      recoveryContext:{action:'browser_task',run_id:runId,browser_operation:'finish'}}),/Controller session stopped/);
  }
});

test('verified partial browser recovery preserves the product restriction and failure audit',async()=>{
  const f=fixture(),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId,'audit/commands',randomUUID());
  mkdirSync(dir,{recursive:true});
  writeFileSync(resolve(dir,'command.json'),JSON.stringify({script:'browser-task.mjs',run_id:runId,child_pid:exitedPid(),result:{termination:'timeout'}}));
  await withControllerSession(root,f.id,async()=>({status:'timeout',exit_code:2,evidence_dir:dir}),{agentRoot:f.agentRoot});
  const context={agentRoot:f.agentRoot,recoveryContext:{action:'browser_task',run_id:runId,browser_operation:'recover'}};
  await withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0,data:{status:'recovery_not_ready'}}),context);
  assert.equal(readControllerSession(root,f.id).status,'stopped');
  await withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0,data:{status:'recovered_partial'}}),context);
  const state=readControllerSession(root,f.id);
  assert.equal(state.status,'stopped');assert.equal(state.failure.evidence_dir,dir);
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,recoveryContext:{action:'execute'}}),/Controller session stopped/);
  await withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,recoveryContext:{action:'export_report'}});
  assert.deepEqual(readControllerSession(root,f.id).failure,state.failure);
  assert.ok(state.events.some(e=>e.type==='browser_failure_recovered_partial' && e.previous_failure.evidence_dir===dir));
  assert.equal(state.events.filter(e=>e.type==='command_failed').length,1);
});

test('dead same-host lock is claimed once and an exited running owner becomes stopped, never ready',async()=>{
  const f=fixture(),path=resolve(root,'output/controller-command-sessions',f.id,'state.json'),pid=exitedPid();
  mkdirSync(resolve(path,'..'),{recursive:true});
  writeFileSync(path,JSON.stringify({session_id:f.id,status:'running',owner_pid:pid,events:[],token:randomUUID()}));
  writeFileSync(`${path}.lock`,JSON.stringify({version:2,host:hostname(),session_id:f.id,pid,token:randomUUID()}));
  let executed=false;
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>{executed=true;return {status:'completed'};},{agentRoot:f.agentRoot}),/Controller session stopped/);
  assert.equal(executed,false);assert.equal(existsSync(`${path}.lock`),false);
  const state=readControllerSession(root,f.id);assert.equal(state.status,'stopped');assert.equal(state.failure.status,'owner_exited');
  assert.equal(state.events.filter(e=>e.type==='controller_owner_exited').length,1);
});

test('live, foreign-host and legacy locks are preserved',async()=>{
  for(const lockOwner of [
    {version:2,host:hostname(),pid:process.pid},
    {version:2,host:`other-${hostname()}`,pid:exitedPid()},
    exitedPid()
  ]) {
    const f=fixture(),path=resolve(root,'output/controller-command-sessions',f.id,'state.json.lock');
    mkdirSync(resolve(path,'..'),{recursive:true});
    const raw=JSON.stringify(typeof lockOwner==='object'?{...lockOwner,session_id:f.id,token:randomUUID()}:lockOwner);
    writeFileSync(path,raw);
    try {
      await assert.rejects(()=>withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot}),{code:'EEXIST'});
      assert.equal(readFileSync(path,'utf8'),raw);
    } finally {unlinkSync(path);}
  }
});

test('exited controller can inspect only its matching exited browser command',async()=>{
  const f=fixture(),runId=`run-${randomUUID()}`,pid=exitedPid();
  const path=resolve(root,'output/controller-command-sessions',f.id,'state.json');
  const evidence=resolve(root,'output/runs',runId,'audit/commands',randomUUID());
  mkdirSync(resolve(path,'..'),{recursive:true});mkdirSync(evidence,{recursive:true});
  writeFileSync(path,JSON.stringify({session_id:f.id,status:'running',owner_pid:pid,active_action:'browser_task',
    active_run_id:runId,command_started_at:'2026-10-19T00:00:00Z',events:[],token:randomUUID()}));
  writeFileSync(resolve(evidence,'command.json'),JSON.stringify({owner_pid:pid,child_pid:exitedPid(),script:'browser-task.mjs',run_id:runId,started_at:'2026-10-19T00:00:01Z'}));
  await withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0}),{agentRoot:f.agentRoot,
    recoveryContext:{action:'browser_task',run_id:runId,browser_operation:'health'}});
  const state=readControllerSession(root,f.id);assert.equal(state.status,'stopped');assert.equal(state.failure.evidence_dir,evidence);
});
function fixture() {
  const id = `session-2026-10-09-00-00-00-${randomUUID().replaceAll('-', '')}`;
  const agentRoot = resolve(root, 'output/acceptance', `controller-${randomUUID()}`);
  const dir = resolve(agentRoot, 'test_agent/traces/2026-10-09'); mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}_001.jsonl`), JSON.stringify({ type: 'session_meta', payload: { session_id: id, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } }) + '\n');
  const evidence = resolve(agentRoot, 'review.md'); writeFileSync(evidence, 'Synthetic engineering review. No real workflow authorization.');
  const options = () => ({ 'expected-sha256': readControllerSession(root, id).sha256, actor: 'synthetic-reviewer', reason: 'Synthetic failure reviewed', 'approval-ref': 'synthetic-only', evidence });
  const call = args => spawnSync(process.execPath, ['scripts/project-command.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PENGUIN_AGENT_ROOT: agentRoot } });
  return { id, agentRoot, options, call };
}

test('draft runtime exceptions remain local and identical stalled calls are rejected before execution',async()=>{
  const f=fixture();let calls=0;
  const context={action:'export_test_cases',stage:'test_cases',key:'draft:export',progress_sha256:'artifact-v1'};
  const attempt=()=>withControllerSession(root,f.id,async()=>{calls++;throw new Error('Exporter unavailable');},{agentRoot:f.agentRoot,recoveryContext:context});
  for(let i=0;i<3;i++) await assert.rejects(attempt,error=>error.recovery?.retry_allowed===(i<2));
  assert.equal(readControllerSession(root,f.id).status,'ready');
  await assert.rejects(attempt,error=>error.code==='correction_stalled' && error.recovery.next_action==='inspect_and_repair_artifacts_or_handoff_partial');
  assert.equal(calls,3);
  context.request_sha256='cosmetic-change';
  await assert.rejects(attempt,{code:'correction_stalled'});assert.equal(calls,3);
  context.progress_sha256='artifact-v2';
  await assert.rejects(attempt,error=>error.recovery?.retry_allowed===true);assert.equal(calls,4);
  await withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,recoveryContext:{...context,action:'handoff',key:'draft:handoff'}});
  assert.equal(readControllerSession(root,f.id).events.filter(e=>e.type==='command_failed').length,4);
});

test('stopped product failures permit terminated artifact work but never dispatch, execute or unknown actions',async()=>{
  const f=fixture();
  await withControllerSession(root,f.id,async()=>({status:'failed',exit_code:1,result:{termination_confirmed:true}}),{agentRoot:f.agentRoot,recoveryContext:{action:'execute'}});
  const original=readControllerSession(root,f.id).failure;
  for(const action of ['handoff','complete','validate_artifacts','assess_evidence','normalize_defects','build_report_metrics','export_report']) {
    await withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,recoveryContext:{action,stage:'execution'}});
    assert.equal(readControllerSession(root,f.id).status,'stopped');
    assert.deepEqual(readControllerSession(root,f.id).failure,original);
  }
  for(const action of ['dispatch','execute','prepare_execution','unknown','browser_task']) {
    assert.equal(isSafeArtifactAction({action,stage:'report'}),false);
    await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('must not launch'),{agentRoot:f.agentRoot,recoveryContext:{action,stage:'report'}}),/Controller session stopped/);
  }
  await withControllerSession(root,f.id,async()=>({status:'cleanup_required',exit_code:2}),{agentRoot:f.agentRoot,recoveryContext:{action:'export_report'}});
  assert.deepEqual(readControllerSession(root,f.id).failure,original);
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('unknown continuation process'),{agentRoot:f.agentRoot,recoveryContext:{action:'handoff'}}),/Controller session stopped/);
});

test('unknown legacy processes and live child processes prohibit artifact writes',async()=>{
  for(const childPid of [undefined,process.pid]) {
    const f=fixture(),dir=resolve(root,'output/command-runs',randomUUID());mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'command.json'),JSON.stringify({status:'running',child_pid:childPid}));
    await withControllerSession(root,f.id,async()=>({status:'timeout',exit_code:2,evidence_dir:dir}),{agentRoot:f.agentRoot});
    await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('unsafe artifact write'),{agentRoot:f.agentRoot,recoveryContext:{action:'handoff'}}),/Controller session stopped/);
  }
});

test('stopped draft dispatch requires the matching professional agent and never admits execution',async()=>{
  const f=fixture();
  await withControllerSession(root,f.id,async()=>({status:'failed',result:{termination_confirmed:true}}),{agentRoot:f.agentRoot});
  const original=readControllerSession(root,f.id).failure;
  for(const [stage,agent] of [['analysis','requirement_analysis_agent'],['test_points','test_point_agent'],['test_cases','test_case_agent'],['defects','defect_analysis_agent'],['report','test_report_agent']]) {
    await withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot,recoveryContext:{action:'dispatch',stage,agent}});
    assert.deepEqual(readControllerSession(root,f.id).failure,original);
  }
  for(const context of [{stage:'execution',agent:'automation_execution_agent'},{stage:'report',agent:'automation_execution_agent'},{stage:'report'}]) {
    assert.equal(safeStoppedOperation({action:'dispatch',...context}),false);
    await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('unsafe dispatch'),{agentRoot:f.agentRoot,recoveryContext:{action:'dispatch',...context}}),/Controller session stopped/);
  }
});

test('trusted artifact progress permits repair but request changes alone cannot bypass a stall',async()=>{
  const f=fixture(),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId,'analysis');mkdirSync(dir,{recursive:true});
  const path=resolve(dir,'requirement-ledger.json');writeFileSync(path,'{"version":1}');
  let calls=0;
  const progress=()=>createHash('sha256').update(JSON.stringify(JSON.parse(readFileSync(path)))).digest('hex');
  const context={action:'generate_analysis',run_id:runId,key:'ledger',request_sha256:'first',progress_sha256:progress()};
  const attempt=()=>withControllerSession(root,f.id,async()=>{calls++;throw new Error('Invalid draft');},{agentRoot:f.agentRoot,recoveryContext:context});
  for(let i=0;i<3;i++) await assert.rejects(attempt);
  context.request_sha256='cosmetic';
  writeFileSync(path,'{ "version": 1 }');
  context.progress_sha256=progress();
  await assert.rejects(attempt,{code:'correction_stalled'});assert.equal(calls,3);
  writeFileSync(path,'{"version":2}');
  context.progress_sha256=progress();
  await assert.rejects(attempt,error=>error.recovery?.retry_allowed===true);assert.equal(calls,4);
});

test('draft exception with an outstanding owned child stops conflicting artifact writes',async()=>{
  const f=fixture(),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId,'audit/commands',randomUUID());mkdirSync(dir,{recursive:true});
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>{
    writeFileSync(resolve(dir,'command.json'),JSON.stringify({owner_pid:process.pid,child_pid:process.pid,started_at:new Date().toISOString(),status:'running'}));
    throw new Error('Response lost while exporter is running');
  },{agentRoot:f.agentRoot,recoveryContext:{action:'export_report',run_id:runId,key:'live-export'}}));
  assert.equal(readControllerSession(root,f.id).status,'stopped');
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('must not overlap'),{agentRoot:f.agentRoot,recoveryContext:{action:'export_report',run_id:runId}}),/Controller session stopped/);
});

test('legacy recovery records restore the product restriction and an interrupted continuation preserves the first fault',async()=>{
  const f=fixture(),path=resolve(root,'output/controller-command-sessions',f.id,'state.json');mkdirSync(resolve(path,'..'),{recursive:true});
  const original={status:'failed',termination_confirmed:true};
  writeFileSync(path,JSON.stringify({session_id:f.id,status:'ready',events:[{type:'browser_failure_recovered_partial',previous_failure:original}]}));
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('legacy product replay'),{agentRoot:f.agentRoot,recoveryContext:{action:'execute'}}),/Controller session stopped/);
  assert.deepEqual(readControllerSession(root,f.id).failure,original);
  const state=readControllerSession(root,f.id);delete state.sha256;
  writeFileSync(path,JSON.stringify({...state,status:'running',owner_pid:exitedPid(),token:randomUUID(),active_action:'export_report'}));
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('unknown continuation'),{agentRoot:f.agentRoot,recoveryContext:{action:'handoff'}}),/Controller session stopped/);
  assert.deepEqual(readControllerSession(root,f.id).failure,original);
  assert.equal(readControllerSession(root,f.id).continuation_failures.at(-1).status,'owner_exited');
});
test('execution artifact validation is correctable without stopping the controller',async()=>{
  const f=fixture();
  const result=await withControllerSession(root,f.id,async()=>({status:'failed',exit_code:2,result:{termination_confirmed:true}}),{agentRoot:f.agentRoot,recoveryContext:{action:'validate_artifacts',stage:'execution',key:'run-check:validate_artifacts:execution'}});
  assert.equal(result.recovery.category,'artifact_revision');
  assert.equal(readControllerSession(root,f.id).status,'ready');
});

test('terminated artifact timeout is local but browser timeout, interruption and cleanup remain stopped',async()=>{
  for(const [action,status,confirmed,termination,correctable] of [
    ['export_report','timeout',true,'timeout',true],['handoff','timeout',true,'timeout',true],
    ['browser_task','timeout',true,'timeout',false],['export_report','timeout',false,'timeout',false],
    ['export_report','interrupted',true,'interrupted',false],['export_report','cleanup_required',true,'cleanup_required',false],
    ['export_report','timeout',true,'interrupted',false]
  ]) {
    const f=fixture();
    const result=await withControllerSession(root,f.id,async()=>({status,exit_code:124,result:{termination_confirmed:confirmed,termination}}),
      {agentRoot:f.agentRoot,recoveryContext:{action,key:'timeout'}});
    assert.equal(result.recovery?.category,correctable?'artifact_revision':undefined);
    const state=readControllerSession(root,f.id);
    assert.equal(state.status,correctable?'ready':'stopped');
    assert.equal(state.events.at(-1).failure.status,status);
  }
});

test('failure scope survives artifact work and allows only other runs with all failures terminated',async()=>{
  const f=fixture();
  const call=(run,action,result={status:'completed',exit_code:0})=>withControllerSession(root,f.id,async()=>result,
    {agentRoot:f.agentRoot,recoveryContext:{run_id:run,stage:action==='export_report'?'report':action==='browser_task'?'analysis':'execution',action}});
  await call('run-original','browser_task',{status:'timeout',exit_code:124,result:{termination_confirmed:true}});
  const original=readControllerSession(root,f.id).failure;
  assert.deepEqual([original.run_id,original.stage,original.action],['run-original','execution','browser_task']);
  await call('run-artifact','export_report');
  assert.equal(readControllerSession(root,f.id).active_run_id,'run-artifact');
  assert.deepEqual(readControllerSession(root,f.id).failure,original);
  for(const action of ['execute','browser_task']) {
    await assert.rejects(()=>call('run-original',action),/Controller session stopped/);
    await call('run-other',action);
  }
  await call('run-other','execute',{status:'failed',exit_code:1,result:{termination_confirmed:true}});
  const second=readControllerSession(root,f.id).continuation_failures.at(-1);
  assert.deepEqual([second.run_id,second.stage,second.action],['run-other','execution','execute']);
  await assert.rejects(()=>call('run-other','execute'),/Controller session stopped/);
  await call('run-third','execute');
  await call('run-third','execute',{status:'cleanup_required',exit_code:2});
  await assert.rejects(()=>call('run-fourth','execute'),/Controller session stopped/);
  assert.deepEqual(readControllerSession(root,f.id).failure,original);
});

test('legacy unscoped faults cannot authorize an unrelated run',async()=>{
  const f=fixture();
  await withControllerSession(root,f.id,async()=>({status:'failed',result:{termination_confirmed:true}}),{agentRoot:f.agentRoot});
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>assert.fail('unknown scope'),
    {agentRoot:f.agentRoot,recoveryContext:{run_id:'run-new',action:'execute'}}),/Controller session stopped/);
});

test('historical validation-only stop self-recovers while execution and unknown failures remain stopped',async()=>{
  for(const [script,confirmed,recover] of [['validate-artifacts.mjs',true,true],['run-ui-tests.mjs',true,false],['validate-artifacts.mjs',false,false]]) {
    const f=fixture(),dir=resolve(root,'output/command-runs',randomUUID());mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'command.json'),JSON.stringify({script,status:'failed',result:{code:2,termination_confirmed:confirmed,termination:null,signal:null}}));
    writeFileSync(resolve(dir,'command.log'),JSON.stringify({run_id:'run-synthetic',stage:'execution',status:'blocked',errors:['Missing draft artifact']}));
    await withControllerSession(root,f.id,async()=>({status:'failed',exit_code:2,evidence_dir:dir}),{agentRoot:f.agentRoot});
    assert.equal(readControllerSession(root,f.id).status,'stopped');
    const operation=()=>withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0}),{agentRoot:f.agentRoot});
    if(recover) {
      await assert.rejects(operation,/Controller session stopped/);
      await withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0}),{agentRoot:f.agentRoot,recoveryContext:{action:'validate_artifacts'}});
      const state=readControllerSession(root,f.id);assert.equal(state.status,'stopped');
      assert.ok(state.events.some(e=>e.type==='validation_stop_recovered' && e.previous_failure.evidence_dir===dir));
      assert.ok(state.events.some(e=>e.type==='command_failed'));
    } else await assert.rejects(operation,/Controller session stopped/);
  }
});

test('lifecycle help is complete and rejects unknown, duplicate and misplaced inputs', () => {
  for (const name of ['create-run.mjs','plan-run.mjs','record-orchestration-event.mjs','request-stage-confirmation.mjs','resolve-stage-confirmation.mjs']) assert.ok(commandHelp(name).usages[name]);
  for (const [script,args] of [
    ['create-run.mjs',['create-run','--help']], ['create-run.mjs',['--run-id=run-a','--run-id=run-b']],
    ['plan-run.mjs',['--run-id=run-a','--stages=unknown']], ['plan-run.mjs',[]],
    ['record-orchestration-event.mjs',['run-a','dispatched','--stage=analysis']],
    ['resolve-stage-confirmation.mjs',['run-a','analysis','completed']],
    ['request-stage-confirmation.mjs',['run-a','analysis','../outside']]
  ]) assert.throws(() => validateCommandArguments(script,args));
  assert.doesNotThrow(() => validateCommandArguments('create-run.mjs', []));
  assert.doesNotThrow(() => validateCommandArguments('plan-run.mjs', ['--run-id=run-a','--stages=analysis']));
});

test('legacy artifact command uses structured receipts and does not latch a confirmed draft failure',()=>{
  const f=fixture();const flag=`--controller-session=${f.id}`;const run=`run-controller-${randomUUID()}`;
  assert.equal(f.call(['run','node','create-run.mjs',flag,'--',`--run-id=${run}`]).status,0);
  const result=JSON.parse(f.call(['run','node','generate-analysis-markdown.mjs',flag,'--',run]).stdout);
  assert.equal(result.recovery.category,'artifact_revision');assert.ok(result.action_receipt);
  assert.equal(readControllerSession(root,f.id).status,'ready');
  const execution=JSON.parse(f.call(['run','node','validate-artifacts.mjs',flag,'--',run,'execution']).stdout);
  assert.equal(execution.recovery.category,'artifact_revision');assert.equal(readControllerSession(root,f.id).status,'ready');
});

test('readonly legacy help and doctor do not compete with a running controller mutation',async()=>{
  const f=fixture();const flag=`--controller-session=${f.id}`;
  await withControllerSession(root,f.id,async()=>{
    const before=readControllerSession(root,f.id).sha256;
    assert.equal(f.call(['help',flag]).status,0);
    const doctor=f.call(['doctor',flag]);
    assert.doesNotMatch(doctor.stdout,/Controller command is running/);
    assert.equal(readControllerSession(root,f.id).sha256,before);
    return {status:'completed',exit_code:0};
  },{agentRoot:f.agentRoot});
});

test('legacy misplaced stages can be corrected through structured plan without stopping the session', async () => {
  const f=fixture(); const flag=`--controller-session=${f.id}`;
  const runId=`run-controller-${randomUUID()}`;
  assert.equal(f.call(['run','node','create-run.mjs',flag,'--',`--run-id=${runId}`]).status,0);
  const bad=f.call(['run','node','plan-run.mjs',flag,`--run-id=${runId}`,'--stages=analysis,test_points,test_cases']);
  assert.equal(bad.status,2);
  assert.equal(JSON.parse(bad.stdout).recovery.retry_allowed,true);
  assert.equal(readControllerSession(root,f.id).status,'ready');
  const result=await executeAction(root,f.id,()=>JSON.stringify({action:'plan_run',run_id:runId,stages:['analysis','test_points','test_cases']}),{agentRoot:f.agentRoot});
  assert.equal(result.exit_code,0);
  assert.equal(readControllerSession(root,f.id).events.filter(e=>e.type==='command_failed').length,1);
});

test('legacy input errors keep their budget while unrelated structured actions can continue', async () => {
  const f=fixture(); const flag=`--controller-session=${f.id}`;
  const invalid=['run','node','plan-run.mjs',flag,'--stages=analysis'];
  assert.equal(JSON.parse(f.call(invalid).stdout).recovery.failure_number,1);
  const second=await executeAction(root,f.id,()=>JSON.stringify({action:'plan_run',run_id:'run-invalid-input'}),{agentRoot:f.agentRoot});
  assert.equal(second.recovery.failure_number,1);
  const third=JSON.parse(f.call(invalid).stdout);
  assert.equal(third.recovery.failure_number,2);
  assert.equal(third.recovery.retry_allowed,true);
  assert.equal(JSON.parse(f.call(invalid).stdout).recovery.retry_allowed,false);
  assert.equal(f.call(['help','plan-run.mjs',flag]).status,0);
  assert.equal(JSON.parse(f.call(invalid).stdout).recovery.stalled,true);
  const continued=await executeAction(root,f.id,()=>JSON.stringify({action:'create_run',run_id:`run-controller-${randomUUID()}`}),{agentRoot:f.agentRoot});
  assert.equal(continued.exit_code,0);
});
test('prelaunch script path mistake is recorded and a corrected CLI process can continue', () => {
  const f = fixture(); const flag = `--controller-session=${f.id}`;
  const bad = f.call(['run','node','scripts/create-run.mjs',flag,'--']);
  assert.equal(bad.status,2);
  const state = readControllerSession(root,f.id); assert.equal(state.status,'ready');
  assert.equal(state.events.at(-1).recovery.category,'input_correction');
  assert.equal(state.events.at(-1).recovery.retry_allowed,true);
  const runId = `run-controller-${randomUUID()}`;
  const corrected = f.call(['run','node','create-run.mjs',flag,'--',`--run-id=${runId}`]);
  assert.equal(corrected.status,0,corrected.stdout);
  assert.equal(existsSync(resolve(root,'output/runs',runId)),true);
  assert.equal(f.call(['help','create-run.mjs',flag]).status,0);
  assert.equal(readControllerSession(root,f.id).status,'ready');
});
test('review requires exact snapshot and evidence, preserves failure, does not execute', async () => {
  const f=fixture();
  await assert.rejects(withControllerSession(root,f.id,async()=>{throw new Error('Synthetic error');},{agentRoot:f.agentRoot}));
  const old=readControllerSession(root,f.id);
  assert.throws(()=>reviewControllerSession(root,f.id,{...f.options(),'expected-sha256':'wrong'},f.agentRoot));
  assert.throws(()=>reviewControllerSession(root,f.id,{...f.options(),evidence:resolve(root,'README.md')},f.agentRoot));
  assert.equal(readControllerSession(root,f.id).sha256,old.sha256);
  const options=f.options(); const reviewed=reviewControllerSession(root,f.id,options,f.agentRoot);
  assert.equal(reviewed.resumed_execution,false);
  assert.equal(readControllerSession(root,f.id).events.at(-1).previous_failure.error,'Synthetic error');
  assert.throws(()=>reviewControllerSession(root,f.id,options,f.agentRoot));
  await assert.rejects(()=>withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0}),{agentRoot:f.agentRoot}),/Controller session stopped/);
  assert.deepEqual(readControllerSession(root,f.id).failure,old.failure);
});

test('exhausted input budget requires explicit hash-bound maintenance review and retains history',async()=>{
  const f=fixture();
  for (let i=0;i<3;i++) await assert.rejects(withControllerSession(root,f.id,async()=>{throw new CommandUsageError('Synthetic prelaunch error');},{agentRoot:f.agentRoot,recoveryContext:{key:'input_correction'}}));
  const before=readControllerSession(root,f.id);
  assert.throws(()=>reviewControllerSession(root,f.id,f.options(),f.agentRoot));
  assert.throws(()=>reviewControllerSession(root,f.id,{...f.options(),'correction-key':'other'},f.agentRoot));
  assert.throws(()=>reviewControllerSession(root,f.id,{...f.options(),'correction-key':'input_correction','expected-sha256':'stale'},f.agentRoot));
  const reviewed=reviewControllerSession(root,f.id,{...f.options(),'correction-key':'input_correction'},f.agentRoot);
  assert.equal(reviewed.resumed_execution,false);
  const after=readControllerSession(root,f.id);
  assert.deepEqual(after.events.slice(0,-1),before.events);
  assert.equal(after.events.at(-1).previous_correction_count,3);
  assert.equal(after.corrections.input_correction,undefined);
  assert.throws(()=>reviewControllerSession(root,f.id,{...f.options(),'correction-key':'input_correction'},f.agentRoot));
});
test('nonzero, timeout and unknown completion latch; diagnostics do not clear them', async () => {
  for (const result of [{status:'failed',exit_code:7},{status:'timeout',exit_code:124},{status:'interrupted',exit_code:130},{status:'cleanup_required',exit_code:2}]) {
    const f=fixture(); await withControllerSession(root,f.id,async()=>result,{agentRoot:f.agentRoot});
    const before=readControllerSession(root,f.id);
    await withControllerSession(root,f.id,async()=>({status:'help'}),{agentRoot:f.agentRoot,diagnostic:true});
    assert.equal(readControllerSession(root,f.id).sha256,before.sha256);
    await assert.rejects(withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot}));
  }
});
test('concurrent commands and unresolved running state cannot bypass review', async () => {
  const f=fixture(); let release;
  const waiting=withControllerSession(root,f.id,()=>new Promise(r=>{release=r;}),{agentRoot:f.agentRoot});
  await assert.rejects(withControllerSession(root,f.id,async()=>({status:'completed'}),{agentRoot:f.agentRoot}),/running/);
  assert.throws(()=>reviewControllerSession(root,f.id,f.options(),f.agentRoot),/stopped/);
  release({status:'completed',exit_code:0}); await waiting;
});
test('missing identity, unknown sessions and cross-parent commands are rejected', () => {
  const f=fixture();
  assert.equal(f.call(['run','node','create-run.mjs','--']).status,2);
  const unknown='session-2026-10-09-00-00-00-deadbeef';
  assert.equal(f.call(['run','node','create-run.mjs',`--controller-session=${unknown}`,'--']).status,2);
  const mismatch=f.call(['run','node','record-orchestration-event.mjs',`--controller-session=${f.id}`,'--','run-a','dispatched','--stage=analysis','--agent=requirement_analysis_agent','--skills=requirement-analysis',`--parent-session-id=${unknown}`]);
  assert.equal(mismatch.status,2); assert.match(mismatch.stdout,/differs/);
  assert.equal(readControllerSession(root,f.id).status,'stopped');
});

test('stopped session permits failure closure attempt but rejects completion and keeps first failure', async () => {
  const f=fixture(); const flag=`--controller-session=${f.id}`;
  await withControllerSession(root,f.id,async()=>({status:'failed',exit_code:2}),{agentRoot:f.agentRoot});
  const before=readControllerSession(root,f.id);
  const base=['run','node','record-orchestration-event.mjs',flag,'--','run-nonexistent-controller-fixture'];
  const common=['--stage=analysis',`--parent-session-id=${f.id}`,'--dispatch-id=synthetic'];
  const closed=f.call([...base,'blocked',...common,'--reason=Synthetic closure']);
  // The underlying script reports missing run; the session gate allows only this closure attempt.
  assert.equal(closed.status,1); assert.equal(JSON.parse(closed.stdout).status,'failed');
  assert.doesNotMatch(closed.stdout,/Controller session stopped/);
  const complete=f.call([...base,'completed',...common,`--session-id=${f.id}`,'--artifacts=analysis/requirement_analysis.md']);
  assert.equal(complete.status,2); assert.match(complete.stdout,/Controller session stopped/);
  assert.equal(readControllerSession(root,f.id).sha256,before.sha256);
});
