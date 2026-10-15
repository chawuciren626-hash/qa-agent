import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requiredArtifacts } from '../../scripts/stage-evidence.mjs';
import { executionInputs } from './safety-fixtures.mjs';
import { designArtifacts } from './artifact-fixtures.mjs';
import { childCommandPolicy } from '../../scripts/child-command-policy.mjs';
import { inspectHandoff, handoffReminder } from '../../scripts/controller-handoff.mjs';

const root = resolve(import.meta.dirname, '../..');
test('missing artifact repair preserves history and refuses existing files', () => {
  const id = `run-fixture-${randomUUID()}`;
  const run = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run('create-run', [`--run-id=${id}`]).status, 0);
  const dir = resolve(root, 'output/runs', id);
  writeFileSync(resolve(dir, 'inputs/fixture-origin.json'), JSON.stringify({ source: 'synthetic artifact repair regression' }));
  const path = resolve(dir, 'manifest.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.artifacts = ['inputs/fixture-origin.json', 'quality/missing.json'];
  original.orchestration = { events: [{ type: 'historical_event' }] };
  writeFileSync(path, JSON.stringify(original));
  const before = readFileSync(path, 'utf8');
  for (const artifact of ['inputs/fixture-origin.json', 'unregistered.json']) {
    assert.notEqual(run('remove-missing-artifact', [id, artifact, 'regression']).status, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
  assert.equal(run('remove-missing-artifact', [id, 'quality/missing.json', 'verified absent']).status, 0);
  const repaired = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(repaired.artifacts, ['inputs/fixture-origin.json']);
  assert.deepEqual(repaired.stages, original.stages);
  assert.deepEqual(repaired.orchestration.events[0], original.orchestration.events[0]);
  assert.equal(repaired.orchestration.events[1].type, 'missing_artifact_reference_removed');
  assert.equal(repaired.orchestration.events[1].reason, 'verified absent');
});

test('stage events cannot bypass approval or override state and audit fields', () => {
  const id = `run-fixture-${randomUUID()}`;
  const agentRoot = resolve(root, 'output/runs', id, 'synthetic-agent-store');
  const parentId = `session-2026-10-09-10-00-01-${randomUUID().replaceAll('-', '')}`;
  const parentDir = resolve(agentRoot, 'test_agent/traces/2026-10-09');
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(resolve(parentDir, `${parentId}_001.jsonl`), JSON.stringify({ type: 'session_meta', payload: { session_id: parentId, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } }) + '\n');
  const run = (script, args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PENGUIN_AGENT_ROOT: agentRoot } });
  const ok = (script, args) => {
    if (script === 'record-orchestration-event' && args[1] === 'dispatched') args = [...args, `--parent-session-id=${parentId}`];
    const result = run(script, args);
    assert.equal(result.status, 0, result.stderr);
  };
  ok('create-run', [`--run-id=${id}`]);
  const dir = resolve(root, 'output/runs', id);
  const complete = stage => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
    const agent = manifest.stages[stage].agent;
    const childId = `session-2026-10-09-10-00-00-${randomUUID().replaceAll('-', '')}`;
    const dispatchId = manifest.stages[stage].dispatch_id;
    const timestamp = new Date(Date.now() + 1000).toISOString();
    const saveTrace = (who, session, rows) => {
      const target = resolve(agentRoot, who, 'traces/2026-10-09'); mkdirSync(target, { recursive: true });
      writeFileSync(resolve(target, `${session}_001.jsonl`), rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n'));
    };
    saveTrace(agent, childId, [
      { type: 'session_meta', payload: { session_id: childId, source: 'subagent', agent_state: resolve(agentRoot, agent, 'agent_state'), workspace: root } },
      { type: 'model_msg', payload: { type: 'text', role: 'user', text: `run_id=${id} ${childCommandPolicy(dispatchId)}` } },
      { type: 'model_msg', payload: { type: 'text', role: 'assistant', text: 'Synthetic completion fixture' } },
      { type: 'event_msg', payload: { type: 'request_end', status: 'completed' } }
    ]);
    saveTrace('test_agent', parentId, [
      { type: 'session_meta', payload: { session_id: parentId, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } },
      { type: 'model_msg', payload: { type: 'tool_call', name: 'run_subagent', arguments: JSON.stringify({ agent_id: agent, prompt: `run_id=${id} ${agent} ${dispatchId} ${childCommandPolicy(dispatchId)}` }), tool_call_id: 'synthetic' } },
      { type: 'event_msg', payload: { type: 'subagent', session_id: childId } },
      { type: 'model_msg', payload: { type: 'tool_call_output', tool_call_id: 'synthetic', stop_reason: 'completed', output: 'Synthetic child response without session ID' } }
    ]);
    let artifacts = requiredArtifacts[stage];
    if (stage === 'execution' && manifest.stages.execution.mode === 'prepare') {
      executionInputs(root, id);
      artifacts = ['execution/execution-plan.json', 'execution/scripts/synthetic.spec.ts'];
    } else designArtifacts(root, id);
    const completion = [id, 'completed', `--stage=${stage}`, `--artifacts=${artifacts.join(',')}`, `--session-id=${childId}`, `--dispatch-id=${dispatchId}`];
    const before = readFileSync(resolve(dir, 'manifest.json'), 'utf8');
    if (stage === 'analysis') {
      const parentPath = resolve(parentDir, `${parentId}_001.jsonl`);
      const traceBefore = readFileSync(parentPath, 'utf8');
      const extra = { timestamp, type: 'model_msg', payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'unregistered-retry', arguments: JSON.stringify({ agent_id: agent, prompt: id }) } };
      writeFileSync(parentPath, traceBefore + '\n' + JSON.stringify(extra));
      assert.notEqual(run('record-orchestration-event', [...completion, `--parent-session-id=${parentId}`]).status, 0);
      assert.equal(readFileSync(resolve(dir, 'manifest.json'), 'utf8'), before);
      writeFileSync(parentPath, traceBefore);
      const policy = childCommandPolicy(dispatchId);
      assert.equal(manifest.orchestration.events.filter(e => e.type === 'dispatched' && e.stage === stage).at(-1).child_command_policy, policy);
      const childPath = resolve(agentRoot, agent, 'traces/2026-10-09', `${childId}_001.jsonl`);
      const childBefore = readFileSync(childPath, 'utf8');
      const rejectUnchanged = () => {
        assert.notEqual(run('record-orchestration-event', [...completion, `--parent-session-id=${parentId}`]).status, 0);
        assert.equal(readFileSync(resolve(dir, 'manifest.json'), 'utf8'), before);
      };
      writeFileSync(parentPath, traceBefore.replace(policy, 'omitted policy'));
      rejectUnchanged();
      writeFileSync(parentPath, traceBefore);
      writeFileSync(childPath, childBefore.replace(policy, 'omitted policy'));
      rejectUnchanged();
      const commands = ['input_rejected', 'completed'].flatMap((status, index) => [
        { timestamp, type: 'model_msg', payload: { type: 'tool_call', name: 'exec_command', tool_call_id: `command-${index}`, arguments: JSON.stringify({ cmd: 'node scripts/project-command.mjs run node validate-artifacts.mjs' }) } },
        { timestamp, type: 'model_msg', payload: { type: 'tool_call_output', tool_call_id: `command-${index}`, output: JSON.stringify({ status, exit_code: index === 0 ? 2 : 0, result: { termination_confirmed: true } }) } }
      ]);
      writeFileSync(childPath, childBefore + '\n' + commands.map(row => JSON.stringify(row)).join('\n'));
      rejectUnchanged();
      writeFileSync(childPath, childBefore);
    }
    assert.notEqual(run('record-orchestration-event', [...completion, '--parent-session-id=session-2026-10-09-00-00-00-deadbeef']).status, 0);
    assert.equal(readFileSync(resolve(dir, 'manifest.json'), 'utf8'), before);
    const target = resolve(dir, artifacts[0]);
    const valid = readFileSync(target);
    writeFileSync(target, stage === 'analysis' ? '   ' : '{}');
    assert.notEqual(run('record-orchestration-event', [...completion, `--parent-session-id=${parentId}`]).status, 0);
    assert.equal(readFileSync(resolve(dir, 'manifest.json'), 'utf8'), before);
    writeFileSync(target, valid);
    if(stage==='analysis' && !(manifest.confirmations ?? []).some(c=>c.stage===stage)) {
      const stateDir=resolve(root,'output/controller-command-sessions',parentId);mkdirSync(stateDir,{recursive:true});
      writeFileSync(resolve(stateDir,'state.json'),JSON.stringify({session_id:parentId,status:'ready',events:[]}));
      const request=inspectHandoff(root,parentId,agentRoot);
      assert.equal(request.request.action,'complete');assert.equal(request.request.child_session,undefined);
      assert.equal(handoffReminder(root,parentId,agentRoot).decision,'continue');
      assert.equal(handoffReminder(root,parentId,agentRoot).decision,'continue');
      assert.equal(handoffReminder(root,parentId,agentRoot).decision,'stop');
      assert.equal(readFileSync(resolve(dir,'manifest.json'),'utf8'),before);
      writeFileSync(target,'invalid');assert.equal(handoffReminder(root,parentId,agentRoot).decision,'stop');writeFileSync(target,valid);
    }
    ok('record-orchestration-event', [...completion, `--parent-session-id=${parentId}`]);
    if(stage==='analysis' && !(manifest.confirmations ?? []).some(c=>c.stage===stage)) assert.equal(inspectHandoff(root,parentId,agentRoot).request.action,'request_confirmation');
  };
  writeFileSync(resolve(dir, 'inputs/fixture-origin.json'), JSON.stringify({ source: 'synthetic orchestration regression' }));
  ok('plan-run', [`--run-id=${id}`, '--stages=execution']);
  const manifest = () => readFileSync(resolve(dir, 'manifest.json'), 'utf8');
  const denied = args => {
    const before = manifest();
    assert.notEqual(run('record-orchestration-event', [id, ...args]).status, 0);
    assert.equal(manifest(), before);
  };
  denied(['revision_requested', '--stage=analysis', '--status=completed']);
  denied(['dispatched', '--stage=analysis', '--status=completed']);
  denied(['dispatched', '--stage=analysis', '--type=completed']);
  denied(['completed', '--stage=analysis']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis']);
  denied(['completed', '--stage=analysis', '--artifacts=quality/missing.json']);
  denied(['completed', '--stage=analysis', '--artifacts=../../quality/defect-index.json']);
  denied(['completed', '--stage=analysis']);
  complete('analysis');
  denied(['dispatched', '--stage=test_points', '--agent=test_point_agent', '--skills=test-point-design']);
  ok('request-stage-confirmation', [id, 'analysis']);
  denied(['revision_requested', '--stage=analysis']);
  // Synthetic decisions test transitions; they are not approval of an actual Agent run.
  ok('resolve-stage-confirmation', [id, 'analysis', 'revision_requested', 'synthetic test']);
  assert.notEqual(run('request-stage-confirmation', [id, 'analysis']).status, 0);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis']);
  complete('analysis');
  ok('request-stage-confirmation', [id, 'analysis']);
  ok('resolve-stage-confirmation', [id, 'analysis', 'approved', 'synthetic test only']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=test_points', '--agent=test_point_agent', '--skills=test-point-design']);
  complete('test_points');
  ok('request-stage-confirmation', [id, 'test_points']);
  ok('resolve-stage-confirmation', [id, 'test_points', 'approved', 'synthetic test only']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=test_cases', '--agent=test_case_agent', '--skills=test-case-writing']);
  complete('test_cases');
  ok('request-stage-confirmation', [id, 'test_cases']);
  const casePath = resolve(dir, 'design/test_cases.json');
  const unchangedCases = readFileSync(casePath);
  const unchangedManifest = manifest();
  writeFileSync(casePath, '[]');
  assert.notEqual(run('resolve-stage-confirmation', [id, 'test_cases', 'approved', 'synthetic approval of changed file']).status, 0);
  assert.equal(manifest(), unchangedManifest);
  writeFileSync(casePath, unchangedCases);
  ok('resolve-stage-confirmation', [id, 'test_cases', 'approved', 'synthetic test only']);
  ok('assert-stage-ready', [id, 'execution', '--mode=prepare']);
  ok('record-orchestration-event', [id, 'dispatched', '--stage=execution', '--agent=automation_execution_agent', '--skills=playwright-execution', '--mode=prepare']);
  assert.equal(run('run-ui-tests', [`--run-id=${id}`]).status, 2);
  complete('execution');
  assert.equal(JSON.parse(manifest()).stages.execution.status, 'planned');
  const handoffPath=resolve(dir,'execution/synthetic-handoff-request.json');
  writeFileSync(handoffPath,JSON.stringify({action:'handoff',run_id:id,stage:'execution',artifacts:['execution/execution-plan.json','execution/scripts/synthetic.spec.ts']}));
  const handoffArgs=['execute',`--controller-session=${parentId}`,`--request=${handoffPath}`];
  ok('project-action',handoffArgs);
  assert.equal(JSON.parse(manifest()).stages.execution.status,'awaiting_confirmation');
  const handed=manifest();ok('project-action',handoffArgs);assert.equal(manifest(),handed);
  ok('resolve-stage-confirmation', [id, 'execution', 'revision_requested', 'synthetic plan revision']);
  denied(['dispatched', '--stage=execution', '--agent=automation_execution_agent', '--skills=playwright-execution']);
  ok('request-stage-confirmation', [id, 'execution']);
  const beforeDuplicate = manifest();
  assert.notEqual(run('request-stage-confirmation', [id, 'execution']).status, 0);
  assert.equal(manifest(), beforeDuplicate);
  denied(['dispatched', '--stage=execution', '--agent=automation_execution_agent', '--skills=playwright-execution']);
  const state = JSON.parse(manifest());
  assert.equal(state.stages.execution.status, 'awaiting_confirmation');
  assert.ok(!state.confirmations.some(c => c.stage === 'execution' && c.status === 'approved'));
});
