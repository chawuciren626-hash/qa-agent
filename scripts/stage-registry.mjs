import { readFileSync } from 'node:fs';

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
const path = value => typeof value === 'string' && value.split('/').length > 1 &&
  !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const unique = values => new Set(values).size === values.length;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function validateStageRegistry(raw) {
  const fail = message => { throw new Error(`Invalid stage registry: ${message}`); };
  if (!raw || typeof raw.workflow_id !== 'string' || !raw.workflow_id.trim() ||
      !Number.isSafeInteger(raw.workflow_version) || raw.workflow_version < 1 ||
      !Array.isArray(raw.stages) || !raw.stages.length) fail('workflow header');
  const ids = raw.stages.map(stage => stage?.id);
  if (!ids.every(identifier) || !unique(ids)) fail('stage identifiers');
  for (const stage of raw.stages) {
    if (typeof stage.label !== 'string' || !stage.label.trim() || !identifier(stage.agent)) fail(`${stage.id}: label/agent`);
    if (!Array.isArray(stage.skills) || !stage.skills.length || !unique(stage.skills) ||
        !stage.skills.every(skill => typeof skill === 'string' && /^[a-z][a-z0-9-]*$/.test(skill))) fail(`${stage.id}: skills`);
    if (!Array.isArray(stage.depends_on) || !unique(stage.depends_on) ||
        stage.depends_on.some(id => !ids.includes(id) || id === stage.id)) fail(`${stage.id}: dependencies`);
    if (!['after', 'before', 'none'].includes(stage.confirmation)) fail(`${stage.id}: confirmation`);
    for (const key of ['lifecycle_artifacts', 'task_artifacts']) {
      if (!Array.isArray(stage[key]) || !stage[key].length || !unique(stage[key]) || !stage[key].every(path)) fail(`${stage.id}: ${key}`);
    }
    if (!path(stage.task_result) || stage.task_artifacts.includes(stage.task_result)) fail(`${stage.id}: task_result`);
    if (stage.optional_artifacts !== undefined && (!Array.isArray(stage.optional_artifacts) ||
        !unique(stage.optional_artifacts) || !stage.optional_artifacts.every(path))) fail(`${stage.id}: optional_artifacts`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    raw.stages.find(stage => stage.id === id).depends_on.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  ids.forEach(visit);
  return freeze(structuredClone(raw));
}

// Engine-owned metadata, never a session input or a rewrite of a saved run plan.
export const stageRegistry = validateStageRegistry(JSON.parse(readFileSync(new URL('../config/orchestration-workflow.json', import.meta.url), 'utf8')));
export const stageDefinitions = stageRegistry.stages;
export const stageNames = freeze(Object.fromEntries(stageDefinitions.map(stage => [stage.id, stage.label])));
export const lifecycleArtifacts = freeze(Object.fromEntries(stageDefinitions.map(stage => [stage.id, stage.lifecycle_artifacts])));
export const independentArtifacts = freeze(Object.fromEntries(stageDefinitions.map(stage => [stage.id, stage.task_artifacts])));
export function stageDefinition(id) {
  const stage = stageDefinitions.find(stage => stage.id === id);
  if (!stage) throw new Error(`Unknown stage: ${id}`);
  return stage;
}

// Shared by the live write guard, historical handoff and draft revision snapshots.
export function stageWriteRules(id) {
  const stage = stageDefinition(id);
  const directories = {analysis:['analysis/'], execution:['execution/'], defects:['defects/'], report:['report/']};
  return {
    exact: [...new Set([...stage.lifecycle_artifacts, ...stage.task_artifacts, stage.task_result,
      ...(stage.optional_artifacts ?? []), ...(id === 'execution' ? ['environment/test-env.json'] : [])])],
    directories: directories[id] ?? []
  };
}

export function isControlledStageEvidence(stage, path) {
  const value = path.toLowerCase();
  return stage === 'execution' && (/^execution\/browser-/.test(value) ||
    ['execution/test_results.json','execution/exploration.json','execution/exploration.lock'].includes(value));
}
export function dispatchTemplate(id, runId = 'run-example') {
  const stage = stageDefinition(id);
  return { action: 'dispatch', run_id: runId, stage: id, agent: stage.agent, skills: [...stage.skills] };
}
// Preserve the existing plan schema and keep lifecycle dependencies out of task contracts.
export function workflowDefinition() {
  return { workflow_id: stageRegistry.workflow_id, workflow_version: stageRegistry.workflow_version,
    stages: stageDefinitions.map(({ id, agent, skills, depends_on, confirmation }) =>
      ({ id, agent, skills: [...skills], depends_on: [...depends_on], confirmation })) };
}
