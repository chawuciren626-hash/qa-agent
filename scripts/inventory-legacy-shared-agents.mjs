/** Read-only inventory of project Agent definitions versus published source content. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sharedInstructionsForRole } from './sync-penguin-agents.mjs';

const [sourceRoot, dataRoot] = process.argv.slice(2).map(value => path.resolve(value));
if (!sourceRoot || !dataRoot) throw Error('Usage: inventory-legacy-shared-agents.mjs <source-root> <local-data-root>');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'penguin/agents.json'), 'utf8'));
const common = fs.readFileSync(path.join(sourceRoot, manifest.shared_instructions), 'utf8');
const roles = [manifest.fallback_entry, ...manifest.agents];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const listFiles = root => {
  if (!fs.existsSync(root)) return [];
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error(`Linked legacy resource: ${file}`);
      if (stat.isDirectory()) walk(file);
      else result.push(path.relative(root, file).replaceAll('\\', '/'));
    }
  }
  walk(root);
  return result.sort();
};
const projects = fs.readdirSync(dataRoot, { withFileTypes: true }).filter(row => row.isDirectory() && fs.existsSync(path.join(dataRoot, row.name, 'agents')));
const output = [];
for (const project of projects) {
  for (const role of roles) {
    const state = path.join(dataRoot, project.name, 'agents', role.id, 'agent_state');
    if (!fs.existsSync(state)) continue;
    const promptPath = path.join(state, 'AGENTS.md');
    const expectedPrompt = fs.readFileSync(path.join(sourceRoot, role.prompt), 'utf8') + '\n' + sharedInstructionsForRole(common, role.id);
    const publishedSkills = new Set(role.skills ?? []);
    const skills = path.join(state, 'skills');
    const actualSkills = fs.existsSync(skills) ? fs.readdirSync(skills, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name).sort() : [];
    const skillDifferences = [];
    for (const name of publishedSkills) {
      const from = path.join(sourceRoot, 'skills', name), to = path.join(skills, name);
      const sourceFiles = listFiles(from), targetFiles = listFiles(to);
      const different = sourceFiles.filter(file => !targetFiles.includes(file) || sha(fs.readFileSync(path.join(from, file))) !== sha(fs.readFileSync(path.join(to, file))));
      const extra = targetFiles.filter(file => !sourceFiles.includes(file));
      if (different.length || extra.length) skillDifferences.push({ name, different, extra });
    }
    output.push({ projectId: project.name, agentId: role.id,
      promptPresent: fs.existsSync(promptPath), promptEqual: fs.existsSync(promptPath) && fs.readFileSync(promptPath, 'utf8') === expectedPrompt,
      localConfig: fs.existsSync(path.join(state, 'system_config.yaml')),
      sharedReference: fs.existsSync(path.join(state, 'shared-agent.json')),
      publishedSkills: [...publishedSkills].sort(), additionalLocalSkills: actualSkills.filter(name => !publishedSkills.has(name)), skillDifferences,
      localHooks: listFiles(path.join(state, 'hooks')),
      memoryFiles: listFiles(path.join(state, 'memory')).length });
  }
}
console.log(JSON.stringify({ roles: output }, null, 2));
