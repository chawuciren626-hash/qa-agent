import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateSkillResources } from './skill-resources.mjs';
import { stageRegistry as workflow } from './stage-registry.mjs';

const root = resolve(import.meta.dirname, '..');
const names = readdirSync(resolve(root, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const resources = names.flatMap(name => validateSkillResources(root, name));
const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json'), 'utf8'));
const release = JSON.parse(readFileSync(resolve(root, 'config/release-resources.json'), 'utf8'));
for (const agent of manifest.agents) {
  for (const name of agent.skills) if (!names.includes(name)) throw new Error(`Missing installed skill: ${agent.id}/${name}`);
}
for (const stage of workflow.stages) {
  const agent = manifest.agents.find(agent => agent.id === stage.agent);
  if (!agent || stage.skills.some(name => !agent.skills.includes(name))) throw new Error(`Workflow skill mapping mismatch: ${stage.id}`);
}
for (const file of resources) {
  const path = file.source.slice(root.length + 1).replaceAll('\\', '/');
  if (!release.files.includes(path)) throw new Error(`Skill resource missing from release allowlist: ${path}`);
}
console.log(JSON.stringify({ status: 'passed', skills: names.length, resources: resources.length, agents: manifest.agents.length }));
