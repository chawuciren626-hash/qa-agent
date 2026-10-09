import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withControllerSession, readControllerSession, reviewControllerSession } from '../../scripts/controller-command-session.mjs';
import { validateCommandArguments, commandHelp } from '../../scripts/command-contracts.mjs';

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
test('failure before run creation persists and blocks later mutation, including from a new CLI process', () => {
  const f = fixture(); const flag = `--controller-session=${f.id}`;
  const bad = f.call(['run','node','scripts/create-run.mjs',flag,'--']);
  assert.equal(bad.status,2);
  const state = readControllerSession(root,f.id); assert.equal(state.status,'stopped');
  const runId = `run-controller-${randomUUID()}`;
  const denied = f.call(['run','node','create-run.mjs',flag,'--',`--run-id=${runId}`]);
  assert.equal(denied.status,2); assert.match(denied.stdout,/session stopped/);
  assert.equal(existsSync(resolve(root,'output/runs',runId)),false);
  assert.equal(readControllerSession(root,f.id).sha256,state.sha256);
  assert.equal(f.call(['help','create-run.mjs',flag]).status,0);
  assert.equal(readControllerSession(root,f.id).sha256,state.sha256);
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
test('nonzero, timeout and unknown completion latch; diagnostics do not clear them', async () => {
  for (const result of [{status:'failed',exit_code:7},{status:'timeout',exit_code:124},{status:'cleanup_required',exit_code:2}]) {
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
