/** Read-only comparison of the maintained QA definitions and a public central resource export. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sharedInstructionsForRole } from './sync-penguin-agents.mjs';
import { validateSkillResources } from './skill-resources.mjs';

const requireFromServer = createRequire(resolve(import.meta.dirname, '../platform/packages/server/package.json'));
const { unzipSync } = requireFromServer('fflate');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = new Map([
  ['general_agent', 'default_agent'],
  ['默认角色的测试任务入口', 'default_agent'],
  ['软件测试总控智能体', 'test_agent'],
  ['需求分析智能体', 'requirement_analysis_agent'],
  ['测试点智能体', 'test_point_agent'],
  ['测试用例智能体', 'test_case_agent'],
  ['自动化执行智能体', 'automation_execution_agent'],
  ['App 测试智能体', 'android_test_agent'],
  ['小程序测试智能体', 'miniprogram_test_agent'],
  ['缺陷分析智能体', 'defect_analysis_agent'],
  ['测试报告智能体', 'test_report_agent'],
  ['接口自动化测试工程师', 'api_automation_agent'],
]);

export function publicationInventory(root, snapshot) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json'), 'utf8'));
  const shared = readFileSync(resolve(root, manifest.shared_instructions), 'utf8');
  const roles = new Map(manifest.agents.map(item => [item.id, item]));
  const fallback = manifest.fallback_entry;
  const sourceRoles = new Map(roles);
  sourceRoles.set(fallback.id, fallback);
  const resources = snapshot.resources;
  const centralAgents = resources.filter(item => item.kind === 'agents' && item.published);
  const agentRows = centralAgents.map(item => {
    const body = item.body;
    const id = names.get(body?.name);
    if (!id || !sourceRoles.has(id)) throw Error(`Unmapped published role: ${body?.name}`);
    const source = sourceRoles.get(id);
    const text = readFileSync(resolve(root, source.prompt), 'utf8') +
      '\n' + sharedInstructionsForRole(shared, id);
    const payload = body.payload;
    return {
      name: body.name, agentId: id, centralVersion: item.version,
      centralAgentId: payload.agentId ?? null,
      sourceHash: `sha256:${hash(text)}`,
      publishedHash: `sha256:${hash(payload.agentsMd ?? '')}`,
      equal: text === payload.agentsMd,
      promptPresent: Boolean(payload.prompt?.trim()),
      publishedSkillDependencies: payload.skillResources?.length ?? 0,
      sourceSkills: source.skills ?? [],
      publishedPluginDependencies: payload.pluginResources?.length ?? 0,
    };
  });
  if (agentRows.length !== sourceRoles.size || new Set(agentRows.map(row => row.agentId)).size !== sourceRoles.size)
    throw Error('Central role set does not map one-to-one to the maintained source roles');

  const activeSkills = [...new Set(manifest.agents.flatMap(item => item.skills ?? []))].sort();
  const skillRows = activeSkills.map(name => {
    const matches = resources.filter(item => item.kind === 'skills' && item.draft?.payload?.skillName === name);
    if (matches.length !== 1) throw Error(`Expected one central Skill draft for ${name}; found ${matches.length}`);
    const item = matches[0];
    const encoded = item.draft.payload.archiveBase64;
    if (typeof encoded !== 'string') throw Error(`Central Skill is not a full archive: ${name}`);
    const entries = unzipSync(new Uint8Array(Buffer.from(encoded, 'base64')));
    const central = new Map(Object.entries(entries).filter(([file]) => !file.endsWith('/')).map(([file, bytes]) => {
      const relative = file.startsWith(`${name}/`) ? file.slice(name.length + 1) : file;
      return [relative, hash(bytes)];
    }));
    const local = new Map(validateSkillResources(root, name).map(file => [file.relative.replaceAll('\\', '/'), hash(readFileSync(file.source))]));
    const changed = [...local.keys()].filter(file => central.has(file) && central.get(file) !== local.get(file));
    const onlyCentral = [...central.keys()].filter(file => !local.has(file));
    const onlyLocal = [...local.keys()].filter(file => !central.has(file));
    return { name, centralVersion: item.version, centralPublished: item.published,
      centralFileCount: central.size, sourceFileCount: local.size,
      changed, onlyCentral, onlyLocal, equal: changed.length === 0 && onlyCentral.length === 0 && onlyLocal.length === 0 };
  });
  return {
    centralCounts: Object.fromEntries(['agents', 'skills', 'plugins', 'models'].map(kind => [kind, {
      total: resources.filter(item => item.kind === kind).length,
      published: resources.filter(item => item.kind === kind && item.published).length,
    }])),
    agents: agentRows, skills: skillRows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw Error('Usage: node scripts/shared-agent-publication-inventory.mjs <central-public-snapshot.json>');
  const root = resolve(import.meta.dirname, '..');
  const snapshot = JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  console.log(JSON.stringify(publicationInventory(root, snapshot), null, 2));
}
