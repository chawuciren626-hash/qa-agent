import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageRegistry, stageDefinitions, validateStageRegistry, workflowDefinition, dispatchTemplate, stageDefinition, stageWriteRules } from '../../scripts/stage-registry.mjs';
import { requiredArtifacts } from '../../scripts/artifact-contracts.mjs';
import { taskRequiredArtifacts } from '../../scripts/independent-task.mjs';
import { actionCatalog } from '../../scripts/structured-actions.mjs';

const root = resolve(import.meta.dirname, '../..');
const legacy = [
  ['analysis', 'requirement_analysis_agent', 'requirement-analysis', [], 'after'],
  ['test_points', 'test_point_agent', 'test-point-design', ['analysis'], 'after'],
  ['test_cases', 'test_case_agent', 'test-case-writing', ['test_points'], 'after'],
  ['execution', 'automation_execution_agent', 'playwright-execution', ['test_cases'], 'before'],
  ['defects', 'defect_analysis_agent', 'bug-reporting', ['execution'], 'none'],
  ['report', 'test_report_agent', 'test-report-writing', ['defects'], 'none']
];

test('registry preserves the six legacy contracts and returns detached plan projections', () => {
  const workflow = workflowDefinition();
  assert.deepEqual(workflow.stages.filter(s=>s.id!=='api_execution'), legacy.map(([id, agent, skill, depends_on, confirmation]) => ({ id, agent, skills: [skill], depends_on, confirmation })));
  workflow.stages[1].depends_on.push('report');
  assert.deepEqual(stageDefinition('test_points').depends_on, ['analysis']);
  assert.throws(() => stageDefinitions[0].skills.push('other'), TypeError);
  assert.throws(() => stageDefinition('unknown'), /Unknown stage/);
  const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json')));
  for (const stage of stageDefinitions) {
    const role = manifest.agents.find(role => role.id === stage.agent);
    assert.ok(role && stage.skills.every(skill => role.skills.includes(skill)));
  }
});

test('catalog, lifecycle artifacts and independent artifacts share one definition without mixing contracts', () => {
  const catalog = actionCatalog();
  for (const stage of stageDefinitions) {
    assert.deepEqual(requiredArtifacts[stage.id], stage.lifecycle_artifacts);
    assert.deepEqual(taskRequiredArtifacts(stage.id), [stage.task_result, ...stage.task_artifacts]);
    assert.deepEqual(catalog.dispatch_templates.find(item => item.stage === stage.id), dispatchTemplate(stage.id));
    assert.deepEqual(catalog.independent_required_artifacts[stage.id], taskRequiredArtifacts(stage.id));
  }
  assert.deepEqual(requiredArtifacts.execution, ['execution/test_results.json']);
  assert.deepEqual(taskRequiredArtifacts('execution'), ['execution/execution-task.json', 'execution/exploration.json', 'execution/test_results.json']);
  assert.deepEqual(taskRequiredArtifacts('analysis'), ['analysis/analysis-task.json', 'analysis/requirement_analysis.md']);
  assert.equal(taskRequiredArtifacts('test_cases').some(path => path.startsWith('analysis/') || path.includes('test_points')), false);
});

test('registry rejects malformed identities, dependency cycles and unsafe artifact paths', () => {
  const changes = [
    r => { r.stages.push(structuredClone(r.stages[0])); },
    r => { r.stages[0].depends_on = ['missing']; },
    r => { r.stages[0].depends_on = ['report']; },
    r => { r.stages[0].skills = []; },
    r => { r.stages[0].agent = '../outside'; },
    r => { r.stages[0].confirmation = 'force'; },
    r => { r.stages[0].task_result = '../outside.json'; },
    r => { r.stages[0].optional_artifacts = ['../outside.json']; },
    r => { r.stages[0].optional_artifacts = ['analysis/a.md','analysis/a.md']; },
    r => { r.stages[0].task_artifacts = ['C:/outside.json']; },
    r => { r.stages[0].lifecycle_artifacts = ['/absolute.json']; },
    r => { r.stages[0].task_artifacts = ['analysis/../outside.json']; },
    r => { r.stages[0].task_artifacts = [r.stages[0].task_result]; }
  ];
  for (const change of changes) {
    const raw = structuredClone(stageRegistry); change(raw);
    assert.throws(() => validateStageRegistry(raw), /Invalid stage registry/);
  }
});

test('design reading copies are optional and share the registered write contract',()=>{
  for(const stage of ['test_points','test_cases']) {
    const path=`design/${stage}.md`;
    assert.ok(stageWriteRules(stage).exact.includes(path));
    assert.ok(!requiredArtifacts[stage].includes(path));
    assert.ok(!taskRequiredArtifacts(stage).includes(path));
  }
});

test('real planning CLI keeps each role independent, explicit lifecycle dependencies and live-product order', () => {
  function plan(stage, mode, source = 'provided_materials') {
    const id = `run-registry-${randomUUID()}`;
    for (const [script, args] of [
      ['create-run', [`--run-id=${id}`]],
      ['plan-run', [`--run-id=${id}`, `--stages=${stage}`, `--workflow-mode=${mode}`, '--review-mode=auto', `--source-mode=${source}`]]
    ]) {
      const result = spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    return JSON.parse(readFileSync(resolve(root, 'output/runs', id, 'manifest.json'))).orchestration.plan;
  }
  for (const stage of stageDefinitions) {
    const result = plan(stage.id, 'task');
    assert.deepEqual(result.stages.filter(s => s.selected).map(s => s.id), [stage.id]);
    assert.ok(result.stages.every(s => !s.depends_on.length && s.confirmation === 'none'));
    assert.equal(result.stages.some(s => 'task_artifacts' in s), false);
  }
  const lifecycle = plan('report', 'lifecycle');
  assert.deepEqual(lifecycle.stages.filter(s => s.selected).map(s => s.id), legacy.map(s => s[0]));
  assert.equal(lifecycle.stages.find(s => s.id === 'execution').confirmation, 'before');
  const live = plan('report', 'task', 'live_product');
  assert.deepEqual(live.stages.filter(s => s.selected).map(s => s.id), ['execution', 'report']);
  assert.deepEqual(live.stages.find(s => s.id === 'report').depends_on, ['execution']);
});

test('mobile execution plans select dedicated agents without changing the six stage definitions', () => {
  for (const [platform, agent, skill] of [['android','android_test_agent','android-execution'],['miniprogram','miniprogram_test_agent','miniprogram-execution']]) {
    const id=`run-registry-${randomUUID()}`;
    for (const [script,args] of [
      ['create-run',[`--run-id=${id}`]],
      ['plan-run',[`--run-id=${id}`,'--stages=execution','--workflow-mode=task','--review-mode=auto',`--execution-platform=${platform}`]]
    ]) {
      const result=spawnSync(process.execPath,[`scripts/${script}.mjs`,...args],{cwd:root,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    const plan=JSON.parse(readFileSync(resolve(root,'output/runs',id,'manifest.json'))).orchestration.plan;
    assert.equal(plan.execution_platform,platform);
    assert.equal(plan.stages.find(stage=>stage.id==='execution').agent,agent);
    assert.deepEqual(plan.stages.find(stage=>stage.id==='execution').skills,[skill]);
  }
  assert.equal(stageDefinition('execution').agent,'automation_execution_agent');
});
