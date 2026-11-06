/** Read-only migration plan. Trace files are the authority; the database is an index. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProductLayout } from './product-layout.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SHARD = /^(.+)_([0-9]{3})\.jsonl$/;

function plainDirectory(file) {
  if (!existsSync(file)) return false;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw Error(`Linked migration path: ${file}`);
  if (!stat.isDirectory()) throw Error(`Expected directory: ${file}`);
  return true;
}

function traceSessions(root) {
  const sessions = new Set();
  if (!plainDirectory(root)) return sessions;
  for (const day of readdirSync(root, { withFileTypes: true })) {
    const dayPath = join(root, day.name);
    if (day.isSymbolicLink()) throw Error(`Linked Trace directory: ${dayPath}`);
    if (!day.isDirectory()) throw Error(`Unexpected Trace entry: ${dayPath}`);
    for (const shard of readdirSync(dayPath, { withFileTypes: true })) {
      const file = join(dayPath, shard.name);
      if (shard.isSymbolicLink()) throw Error(`Linked Trace file: ${file}`);
      if (!shard.isFile()) throw Error(`Unexpected Trace entry: ${file}`);
      const match = SHARD.exec(shard.name);
      if (!match || !SESSION_ID.test(match[1])) throw Error(`Invalid Trace shard: ${file}`);
      sessions.add(match[1]);
    }
  }
  return sessions;
}

function localSkillNames(state) {
  const root = join(state, 'skills');
  if (!plainDirectory(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(row => {
    if (row.isSymbolicLink()) throw Error(`Linked local Skill: ${join(root, row.name)}`);
    return row.isDirectory();
  }).map(row => row.name).sort();
}

export function planSharedAgentMigration({ installation, source, projects }) {
  const layout = loadProductLayout(installation);
  const manifest = JSON.parse(readFileSync(join(source, 'penguin/agents.json'), 'utf8'));
  const roles = [manifest.fallback_entry, ...manifest.agents];
  const db = new DatabaseSync(join(layout.paths.host_data, 'web.db'), { readOnly: true });
  try {
    const report = { version: 1, installationId: layout.installation_id, projects: [] };
    for (const projectId of projects) {
      if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error(`Invalid project id: ${projectId}`);
      const projectRoot = join(layout.paths.host_data, projectId);
      if (!plainDirectory(projectRoot)) throw Error(`Project directory missing: ${projectId}`);
      const dbProject = db.prepare('SELECT project_id FROM projects WHERE project_id=?').get(projectId);
      if (!dbProject) throw Error(`Project not indexed: ${projectId}`);
      const project = { projectId, roles: [], skippedRoles: [] };
      for (const role of roles) {
        const agentId = role.id;
        const state = join(projectRoot, 'agents', agentId, 'agent_state');
        if (!plainDirectory(state)) { project.skippedRoles.push(agentId); continue; }
        const marker = join(state, 'shared-agent.json');
        if (existsSync(marker)) throw Error(`Shared role already migrated: ${marker}`);
        for (const name of ['AGENTS.md', 'system_config.yaml']) {
          const file = join(state, name);
          if (!existsSync(file) || !lstatSync(file).isFile()) throw Error(`Legacy role definition missing: ${file}`);
        }
        const dbIds = new Set(db.prepare('SELECT session_id FROM sessions WHERE project_id=? AND agent_id=?').all(projectId, agentId).map(row => String(row.session_id)));
        const traceIds = traceSessions(join(projectRoot, 'agents', agentId, 'traces'));
        const unindexedTraceIds = [...traceIds].filter(id => !dbIds.has(id)).sort();
        const missingTraceIds = [...dbIds].filter(id => !traceIds.has(id)).sort();
        const legacySessionIds = [...new Set([...dbIds, ...traceIds])].sort();
        const publishedSkills = new Set(role.skills ?? []);
        const additionalLocalSkills = localSkillNames(state).filter(name => !publishedSkills.has(name));
        project.roles.push({ agentId, state, legacySessionIds, dbSessions: dbIds.size,
          traceSessions: traceIds.size, unindexedTraceIds, missingTraceIds, additionalLocalSkills });
      }
      report.projects.push(project);
    }
    return report;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [installation, source, output, ...projects] = process.argv.slice(2);
  if (!installation || !source || !output || !projects.length)
    throw Error('Usage: plan-shared-agent-migration.mjs <installation.json> <source-root> <output.json> <project-id>...');
  const plan = planSharedAgentMigration({ installation: resolve(installation), source: resolve(source), projects });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ output: resolve(output), projects: plan.projects.map(project => ({
    projectId: project.projectId, roles: project.roles.length,
    legacySessions: project.roles.reduce((n, role) => n + role.legacySessionIds.length, 0),
    unindexedTraces: project.roles.reduce((n, role) => n + role.unindexedTraceIds.length, 0),
    missingTraces: project.roles.reduce((n, role) => n + role.missingTraceIds.length, 0),
    additionalLocalSkills: project.roles.reduce((n, role) => n + role.additionalLocalSkills.length, 0),
  })) }));
}
