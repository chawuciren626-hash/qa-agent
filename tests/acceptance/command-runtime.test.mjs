import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateCommandArguments, CommandUsageError } from '../../scripts/command-contracts.mjs';
import { runProjectCommand, scriptTarget, pythonCandidates, probePython } from '../../scripts/command-runtime.mjs';

const project = resolve(import.meta.dirname, '../..');
function fixture() {
  const root = resolve(project, 'output/acceptance', `runtime-${randomUUID()}`);
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  writeFileSync(resolve(root, 'fixture-origin.json'), JSON.stringify({ source: 'synthetic native process test, not business test or Agent E2E' }));
  writeFileSync(resolve(root, 'scripts/echo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  return root;
}

test('native runner preserves spaces, Unicode and shell metacharacters as literal arguments', async () => {
  const root = fixture(); const args = ['two words', '中文', '', 'x;echo injected', '$(whoami)', 'C:\\path with spaces\\file'];
  const result = await runProjectCommand(root, { kind: 'node', script: 'echo.mjs', args });
  assert.equal(result.exit_code, 0); assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.output_tail), args);
  const record = JSON.parse(readFileSync(resolve(result.evidence_dir, 'command.json')));
  assert.equal(record.shell, false); assert.equal(record.runtime, process.execPath);
  assert.equal(record.argument_count, args.length); assert.equal(record.result.termination_confirmed, true);
  assert.equal(record.args, undefined);
  const timing=record.result.timing;
  assert.ok(timing.spawn_ms>=0 && timing.exit_ms>=timing.spawn_ms && timing.close_ms>=timing.exit_ms);
  assert.ok(timing.settled_ms>=timing.close_ms);assert.equal(timing.stop_requested_ms,null);
  const timeline=readFileSync(resolve(result.evidence_dir,'command.log.process.jsonl'),'utf8');
  assert.deepEqual(timeline.trim().split('\n').map(line=>JSON.parse(line).event),['runner_started','child_spawned','child_exited','child_closed','runner_settled']);
  assert.ok(!timeline.includes('two words'));assert.equal(record.result.timeline_write_errors,0);
});

test('runner propagates nonzero status instead of reporting wrapper success', async () => {
  const root = fixture(); writeFileSync(resolve(root, 'scripts/fail.mjs'), 'process.exitCode=7; console.error("Synthetic failure");');
  const result = await runProjectCommand(root, { kind: 'node', script: 'fail.mjs' });
  assert.equal(result.exit_code, 7); assert.equal(result.status, 'failed');
  assert.match(result.output_tail, /Synthetic failure/);
});

test('timeout and cancellation stop owned processes and retain evidence', async () => {
  const root = fixture(); writeFileSync(resolve(root, 'scripts/wait.mjs'), 'console.log(JSON.stringify({status:"synthetic_diagnostic_written"}));setInterval(()=>{},1000);');
  const result = await runProjectCommand(root, { kind: 'node', script: 'wait.mjs', timeoutMs: 1000 });
  assert.equal(result.status, 'timeout'); assert.equal(result.exit_code, 124); assert.equal(result.result.termination_confirmed, true);
  assert.equal(JSON.parse(result.output_tail).status,'synthetic_diagnostic_written');
  assert.ok(result.result.timing.stop_requested_ms>=0);
  assert.ok(result.result.timing.exit_ms>=result.result.timing.stop_requested_ms);
  assert.match(readFileSync(resolve(result.evidence_dir,'command.log.process.jsonl'),'utf8'),/termination_requested/);
  const controller = new AbortController(); controller.abort();
  const interrupted = await runProjectCommand(root, { kind: 'node', script: 'wait.mjs', signal: controller.signal });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.exit_code, 130);
  assert.equal(interrupted.child_pid, null); assert.ok(existsSync(resolve(interrupted.evidence_dir, 'command.log')));
  assert.equal(interrupted.result.timing.spawn_ms,null);
});

test('runner rejects shell commands, path escapes, recursion, missing run and invalid timeouts', async () => {
  const root = fixture();
  for (const [kind, name] of [['node', '../echo.mjs'], ['node', '-e'], ['cmd', 'echo.mjs'], ['node', 'x.cmd'], ['node', 'project-command.mjs']]) assert.throws(() => scriptTarget(root, kind, name));
  for (const timeoutMs of [0, NaN, 1800001]) await assert.rejects(runProjectCommand(root, { kind: 'node', script: 'echo.mjs', timeoutMs }));
  await assert.rejects(runProjectCommand(root, { kind: 'node', script: 'echo.mjs', runId: 'run-missing' }));
});

test('dependency probe retries only timeout, preserves explicit interpreter and distinguishes unavailable from missing',()=>{
  const env={...process.env,QA_PYTHON:process.execPath},calls=[];
  const found=probePython(env,(path,args,options)=>{calls.push({path,timeout:options.timeout});return calls.length===1?{status:null,error:{code:'ETIMEDOUT'}}:{status:0};});
  assert.equal(found.status,'ready');assert.deepEqual(calls.map(c=>c.timeout),[5000,15000]);assert.equal(calls[0].path,calls[1].path);
  const timedOut=probePython(env,()=>({status:null,error:{code:'ETIMEDOUT'}}));
  assert.equal(timedOut.attempts.length,2);assert.match(timedOut.reason,/timed out/);
  let missingCalls=0;
  const missing=probePython(env,()=>{missingCalls++;return {status:1};});
  assert.equal(missingCalls,1);assert.equal(missing.status,'not_ready');assert.match(missing.reason,/no silent fallback/);
});

test('explicit invalid Python never silently falls back to another interpreter', () => {
  const env = { ...process.env, QA_PYTHON: 'python' };
  assert.deepEqual(pythonCandidates(env), []);
  assert.equal(probePython(env).status, 'not_ready');
  assert.equal(probePython({ ...env, QA_PYTHON: resolve(project, 'output/missing-python.exe') }).status, 'not_ready');
});

test('run-bound command audit stays within the selected run', async () => {
  const root = fixture(); const dir = resolve(root, 'output/runs/run-runtime-synthetic'); mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'manifest.json'), '{}');
  const result = await runProjectCommand(root, { kind: 'node', script: 'echo.mjs', runId: 'run-runtime-synthetic' });
  assert.ok(result.evidence_dir.startsWith(resolve(dir, 'audit/commands')));
  assert.equal(readFileSync(resolve(dir, 'manifest.json'), 'utf8'), '{}');
});

test('registered prelaunch contracts reject missing positional run, mixed scope and recovery reason', () => {
  for (const [script, args, runId] of [
    ['validate-artifacts.mjs', ['analysis'], 'run-synthetic'],
    ['validate-artifacts.mjs', ['run-other', 'analysis'], 'run-synthetic'],
    ['validate-artifacts.mjs', ['run-synthetic', 'analysis', '--mode=prepare']],
    ['recover-stage.mjs', ['run-synthetic', 'analysis', '--actor=test']],
    ['generate-analysis-markdown.mjs', ['run-synthetic', '--help']]
  ]) assert.throws(() => validateCommandArguments(script, args, runId), CommandUsageError);
  assert.doesNotThrow(() => validateCommandArguments('validate-artifacts.mjs', ['run-synthetic', 'analysis'], 'run-synthetic'));
});

test('help and usage errors return machine-readable responses without launching a project script', () => {
  const call = args => spawnSync(process.execPath, ['scripts/project-command.mjs', ...args], { cwd: project, encoding: 'utf8' });
  const help = call(['help', 'recover-stage.mjs']);
  assert.equal(help.status, 0); assert.equal(JSON.parse(help.stdout).launches_child, false);
  const bad = call(['run', 'node', 'validate-artifacts.mjs', '--run-id=run-missing', '--', 'analysis']);
  assert.equal(bad.status, 2);
  const data = JSON.parse(bad.stdout); assert.equal(data.status, 'input_rejected');
  assert.equal(data.next_action, 'stop_and_request_review'); assert.equal(data.automatic_retries, 0);
});

test('executed failure retains stop decision in its audit record', async () => {
  const root = fixture(); writeFileSync(resolve(root, 'scripts/fail.mjs'), 'process.exitCode=2;');
  const result = await runProjectCommand(root, { kind: 'node', script: 'fail.mjs' });
  const record = JSON.parse(readFileSync(resolve(result.evidence_dir, 'command.json')));
  assert.equal(record.next_action, 'stop_and_request_review'); assert.equal(record.automatic_retries, 0);
});
