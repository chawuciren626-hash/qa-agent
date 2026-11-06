import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planSharedAgentMigration } from '../../scripts/plan-shared-agent-migration.mjs';
import { applySharedAgentMigration } from '../../scripts/apply-shared-agent-migration.mjs';

test('migration preserves local definition and memory, pins traced history, and enables shared runtime together', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'shared-agent-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'installed'), source = join(root, 'source'), backup = join(root, 'backup');
  mkdirSync(install); mkdirSync(join(source, 'penguin'), { recursive: true });
  writeFileSync(join(source, 'penguin', 'agents.json'), JSON.stringify({ fallback_entry: { id: 'default_agent' }, agents: [] }));
  const config = join(install, 'installation.json');
  writeFileSync(config, JSON.stringify({ version: 1, installation_id: 'fixture', layout: 'unified', root: '.', project_id: 'default_project',
    paths: { engine: 'app/engine', host_executable: 'runtime/penguin/PenguinHarness.exe', host_data: 'data/penguin',
      qa_data: 'data/qa', desktop_profile: 'data/desktop', workspaces: 'workspaces', node: 'runtime/node/node.exe' } }));
  const data = join(install, 'data', 'penguin');
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, 'web.db'));
  db.exec('CREATE TABLE projects(project_id TEXT PRIMARY KEY); CREATE TABLE sessions(session_id TEXT,project_id TEXT,agent_id TEXT)');
  db.prepare('INSERT INTO projects VALUES (?)').run('default_project');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('session-old', 'default_project', 'default_agent');
  db.close();
  const roleRoot = join(data, 'default_project', 'agents', 'default_agent');
  const state = join(roleRoot, 'agent_state');
  mkdirSync(join(state, 'skills', 'custom'), { recursive: true });
  mkdirSync(join(state, 'memory', 'user'), { recursive: true });
  mkdirSync(join(roleRoot, 'traces', '2026-11-04'), { recursive: true });
  writeFileSync(join(state, 'AGENTS.md'), 'local prompt');
  writeFileSync(join(state, 'system_config.yaml'), 'system_prompt: local');
  writeFileSync(join(state, 'skills', 'custom', 'SKILL.md'), '# Custom');
  writeFileSync(join(state, 'memory', 'user', 'MEMORY.md'), 'private memory');
  writeFileSync(join(roleRoot, 'traces', '2026-11-04', 'session-old_001.jsonl'), '{}\n');
  const plan = planSharedAgentMigration({ installation: config, source, projects: ['default_project'] });
  assert.deepEqual(plan.projects[0].roles[0].legacySessionIds, ['session-old']);
  const planFile = join(root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const result = await applySharedAgentMigration({ installation: config, source, planFile, backup });
  assert.equal(result.status, 'enabled');
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'shared-agent.json'))), {
    version: 1, agentId: 'default_agent', legacySessionIds: ['session-old'], localSkillOverrides: ['custom'],
  });
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'shared-agent-runtime.json'))), { version: 1, enabled: true });
  assert.equal(readFileSync(join(state, 'AGENTS.md'), 'utf8'), 'local prompt');
  assert.equal(readFileSync(join(state, 'memory', 'user', 'MEMORY.md'), 'utf8'), 'private memory');
  assert.equal(existsSync(join(backup, 'migration.json')), true);
});
