import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withControllerSession, readControllerSession, reviewControllerSession } from '../../scripts/controller-command-session.mjs';
import { validateCommandArguments, commandHelp, CommandUsageError } from '../../scripts/command-contracts.mjs';
import { executeAction } from '../../scripts/structured-actions.mjs';

const root = resolve(import.meta.dirname, '../..');
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
test('execution artifact validation is correctable without stopping the controller',async()=>{
  const f=fixture();
  const result=await withControllerSession(root,f.id,async()=>({status:'failed',exit_code:2,result:{termination_confirmed:true}}),{agentRoot:f.agentRoot,recoveryContext:{action:'validate_artifacts',stage:'execution',key:'run-check:validate_artifacts:execution'}});
  assert.equal(result.recovery.category,'artifact_revision');
  assert.equal(readControllerSession(root,f.id).status,'ready');
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
      await operation();
      const state=readControllerSession(root,f.id);assert.equal(state.status,'ready');
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
  assert.equal(JSON.parse(f.call(invalid).stdout).recovery.retry_allowed,true);
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
  await withControllerSession(root,f.id,async()=>({status:'completed',exit_code:0}),{agentRoot:f.agentRoot});
  assert.equal(readControllerSession(root,f.id).status,'ready');
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
