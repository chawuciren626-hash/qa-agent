/** Atomic local cutover for reviewed legacy roles. Only markers and the runtime switch are written. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProductLayout } from './product-layout.mjs';
import { assertSourceTargetStopped } from './sync-source-runtime.mjs';
import { withLocalServicePaused } from './local-service.mjs';
import { within } from './application-data.mjs';
import { planSharedAgentMigration } from './plan-shared-agent-migration.mjs';

export async function applySharedAgentMigration({ installation, source, planFile, backup }) {
  const layout = loadProductLayout(installation);
  const reviewed = JSON.parse(readFileSync(planFile, 'utf8'));
  const projectIds = reviewed.projects?.map(project => project.projectId);
  if (!Array.isArray(projectIds) || projectIds.length === 0 || new Set(projectIds).size !== projectIds.length)
    throw Error('Migration plan has no unique projects');
  if (within(layout.root, backup) || within(backup, layout.root))
    throw Error('Migration backup must be outside the installation');
  return withLocalServicePaused(installation, async () => {
    assertSourceTargetStopped(layout);
    const current = planSharedAgentMigration({ installation, source, projects: projectIds });
    if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw Error('Migration plan is stale; generate and review it again');
    if (current.projects.some(project => project.roles.length === 0 || project.roles.some(role =>
      role.unindexedTraceIds.length || role.missingTraceIds.length)))
      throw Error('Migration plan contains missing roles or inconsistent Trace indexes');
    const switchFile = join(layout.paths.host_data, 'shared-agent-runtime.json');
    if (existsSync(switchFile)) throw Error('Shared Agent runtime switch already exists');
    mkdirSync(backup);
    const journalFile = join(backup, 'migration.json');
    const journal = { version: 1, status: 'preparing', installation, projects: projectIds,
      markers: [], runtimeSwitch: switchFile, startedAt: new Date().toISOString() };
    const save = () => writeFileSync(journalFile, JSON.stringify(journal, null, 2));
    save();
    try {
      for (const project of current.projects) for (const role of project.roles) {
        const marker = join(role.state, 'shared-agent.json');
        writeFileSync(marker, JSON.stringify({ version: 1, agentId: role.agentId,
          legacySessionIds: role.legacySessionIds,
          ...(role.additionalLocalSkills.length ? { localSkillOverrides: role.additionalLocalSkills } : {}),
        }, null, 2), { flag: 'wx' });
        journal.markers.push(marker);
        save();
      }
      writeFileSync(switchFile, JSON.stringify({ version: 1, enabled: true }, null, 2), { flag: 'wx' });
      journal.status = 'enabled';
      journal.finishedAt = new Date().toISOString();
      save();
      return { status: journal.status, backup, projects: projectIds, markers: journal.markers.length };
    } catch (error) {
      if (existsSync(switchFile)) unlinkSync(switchFile);
      for (const marker of journal.markers.reverse()) if (existsSync(marker)) unlinkSync(marker);
      journal.status = 'rolled_back';
      journal.error = error instanceof Error ? error.message : String(error);
      save();
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [installation, source, planFile, backup] = process.argv.slice(2);
  if (!installation || !source || !planFile || !backup)
    throw Error('Usage: apply-shared-agent-migration.mjs <installation.json> <source-root> <reviewed-plan.json> <new-backup-directory>');
  console.log(JSON.stringify(await applySharedAgentMigration({ installation: resolve(installation),
    source: resolve(source), planFile: resolve(planFile), backup: resolve(backup) })));
}
