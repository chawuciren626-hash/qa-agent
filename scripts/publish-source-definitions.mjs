/** Build a publication input from maintained source; output is staged outside Git. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { preparePublication } from './prepare-shared-agent-publication.mjs';
import { validateSkillResources } from './skill-resources.mjs';

const root = resolve(import.meta.dirname, '..');
const fromServer = createRequire(resolve(root, 'platform/packages/server/package.json'));
const { zipSync } = fromServer('fflate');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [snapshotPath, outputPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath) throw Error('Usage: node scripts/publish-source-definitions.mjs <snapshot.json> <output.json>');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8').replace(/^\uFEFF/, ''));
const prepared = preparePublication(snapshot);
const updates = prepared.updates.filter(row => row.kind === 'skills' || row.kind === 'agents');
const included = new Set(updates.filter(row => row.kind === 'skills').map(row => row.payload.skillName));
for (const name of readdirSync(resolve(root, 'skills'), { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name).sort()) {
  if (included.has(name)) continue;
  const matches = snapshot.resources.filter(row => row.kind === 'skills' && row.draft?.payload?.skillName === name);
  if (matches.length !== 1) throw Error(`Expected one central Skill draft for ${name}`);
  const current = matches[0];
  const files = Object.fromEntries(validateSkillResources(root, name).map(file => [
    `${name}/${file.relative}`, new Uint8Array(readFileSync(file.source)),
  ]));
  const archive = Buffer.from(zipSync(files));
  if (archive.length > 1024 * 1024) throw Error(`Skill archive exceeds publication limit: ${name}`);
  updates.push({ kind: 'skills', id: current.id, expectedRevision: current.revision,
    name: current.draft.name, description: current.draft.description, audience: ['*'],
    payload: { skillName: name, archiveBase64: archive.toString('base64'), fileNames: Object.keys(files) },
    previousVersion: current.version, sourceArchiveHash: `sha256:${sha(archive)}` });
}
for (const row of updates.filter(row => row.kind === 'agents')) {
  // Keep the public role identifier, including the general_agent entry alias.
  row.payload.pluginResources = snapshot.resources.find(item => item.id === row.id)?.body?.payload?.pluginResources ?? [];
}
updates.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'skills' ? -1 : 1));
if (updates.filter(row => row.kind === 'skills').length !== 15 || updates.filter(row => row.kind === 'agents').length !== 11)
  throw Error('Source publication set has changed; review before publishing');
const output = { schema: 1, source: 'maintained-qa-definitions', updates };
writeFileSync(outputPath, JSON.stringify(output));
console.log(JSON.stringify({ skills: 15, agents: 11, bytes: readFileSync(outputPath).length, sha256: sha(readFileSync(outputPath)) }));
