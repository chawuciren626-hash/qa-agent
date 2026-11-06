/** Prepare reviewable central publication drafts; never writes to the central service. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sharedInstructionsForRole } from './sync-penguin-agents.mjs';
import { validateSkillResources } from './skill-resources.mjs';
import { publicationInventory } from './shared-agent-publication-inventory.mjs';

const root = resolve(import.meta.dirname, '..');
const fromServer = createRequire(resolve(root, 'platform/packages/server/package.json'));
const { zipSync } = fromServer('fflate');
const { defaultSystemConfig } = await import(pathToFileURL(resolve(root, 'platform/packages/core/dist/index.js')).href);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ADAPTERS = {
  'qa-default-entry': ['hooks.json', 'guard.mjs'],
  'qa-delegation-guard': ['hooks.json', 'guard.mjs', 'finish.mjs'],
  'qa-stage-boundary': ['hooks.json', 'guard.mjs'],
  'goal': ['hooks.json', 'lib.mjs', 'start.mjs', 'stop.mjs'],
};
const requiredAdapters = id => id === 'default_agent' ? ['qa-default-entry', 'goal'] :
  id === 'test_agent' ? ['qa-delegation-guard'] : ['qa-stage-boundary'];

export function preparePublication(snapshot) {
  const inventory = publicationInventory(root, snapshot);
  const resources = snapshot.resources;
  const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json'), 'utf8'));
  const shared = readFileSync(resolve(root, manifest.shared_instructions), 'utf8');
  const sourceRoles = new Map(manifest.agents.map(item => [item.id, item]));
  sourceRoles.set(manifest.fallback_entry.id, manifest.fallback_entry);
  const template = defaultSystemConfig().system_prompt;
  if (!['AGENTS_MD', 'SKILLS', 'MEMORY'].every(name => template.includes(`{{${name}}}`)))
    throw Error('The shared prompt template lacks a required local-memory or resource placeholder');
  const updates = [];
  const skillIds = new Map();
  for (const name of [...new Set(manifest.agents.flatMap(item => item.skills ?? []))].sort()) {
    const matches = resources.filter(item => item.kind === 'skills' && item.draft?.payload?.skillName === name);
    if (matches.length !== 1) throw Error(`Missing or duplicate central Skill draft: ${name}`);
    const item = matches[0];
    const files = Object.fromEntries(validateSkillResources(root, name).map(file => [
      `${name}/${file.relative.replaceAll('\\', '/')}`, new Uint8Array(readFileSync(file.source)),
    ]));
    const archive = Buffer.from(zipSync(files));
    if (archive.length > 1024 * 1024) throw Error(`Skill archive exceeds publication limit: ${name}`);
    const payload = { skillName: name, archiveBase64: archive.toString('base64'), fileNames: Object.keys(files) };
    updates.push({ kind: 'skills', id: item.id, expectedRevision: item.revision,
      name: item.draft.name, description: item.draft.description, audience: ['*'],
      payload, sourceArchiveHash: sha(archive), previousVersion: item.version });
    skillIds.set(name, item.id);
  }
  const adapters = new Map();
  for (const [name, files] of Object.entries(ADAPTERS)) {
    const directory = name === 'goal' ? resolve(root, 'platform/plugins/goal/hooks') : resolve(root, 'penguin/hooks', name);
    const entries = files.map(file => [file, createHash('sha256').update(readFileSync(resolve(directory, file))).digest('hex')]);
    const payload = { source: 'trusted-local-adapter', pluginName: name,
      adapterVersion: '2026.11.04.1', adapterHash: sha(JSON.stringify(entries)) };
    const item = resources.find(item => item.kind === 'plugins' &&
      item.draft?.payload?.pluginName === name && item.draft?.payload?.source === 'trusted-local-adapter');
    updates.push({ kind: 'plugins', id: item?.id ?? null, expectedRevision: item?.revision ?? null,
      name, description: '安装引擎内的受信 QA Hook', audience: ['*'], payload,
      previousVersion: item?.version ?? 0 });
    adapters.set(name, item?.id ?? null);
  }
  for (const row of inventory.agents) {
    const source = sourceRoles.get(row.agentId);
    const current = resources.find(item => item.kind === 'agents' && item.body?.name === row.name);
    if (!source || !current) throw Error(`Missing source or central role: ${row.agentId}`);
    const agentsMd = readFileSync(resolve(root, source.prompt), 'utf8') +
      '\n' + sharedInstructionsForRole(shared, row.agentId);
    const payload = { agentId: row.agentId === 'default_agent' ? 'general_agent' : row.agentId, prompt: template, agentsMd,
      modelResource: current.body.payload.modelResource ?? '',
      skillResources: (source.skills ?? []).map(name => {
        const id = skillIds.get(name);
        if (!id) throw Error(`Missing Skill resource for ${row.agentId}/${name}`);
        return id;
      }),
      // Null IDs are filled after new adapter resources are created.
      pluginResources: requiredAdapters(row.agentId).map(name => adapters.get(name)),
    };
    updates.push({ kind: 'agents', id: current.id, expectedRevision: current.revision,
      name: row.name, description: current.body.description, audience: ['*'],
      payload, sourceAgentsMdHash: sha(agentsMd), previousVersion: current.version });
  }
  return { version: 1, source: 'maintained-qa-definitions', inventory, updates,
    publicationOrder: ['skills', 'plugins', 'agents'],
    note: 'Replace null plugin IDs after creating adapters; review every draft and validate on the new central service before publishing.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw Error('Usage: node scripts/prepare-shared-agent-publication.mjs <central-public-snapshot.json>');
  const snapshot = JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  console.log(JSON.stringify(preparePublication(snapshot), null, 2));
}
