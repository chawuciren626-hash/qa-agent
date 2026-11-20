/** Deployment-owned baseline. Run offline to seed, then online to provision/check the assistant.
 * Existing resources belong to administrators: never overwrite, republish or re-enable them.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sharedInstructionsForRole } from './sync-penguin-agents.mjs';
import { validateSkillResources } from './skill-resources.mjs';

const root = resolve(import.meta.dirname, '..');
const server = file => import(pathToFileURL(resolve(root, 'platform/packages/server/dist', file)).href);
const require = createRequire(resolve(root, 'platform/packages/server/package.json'));
const { zipSync } = require('fflate');
const { defaultSystemConfig, parseSkillFrontmatter } = await import(pathToFileURL(resolve(root, 'platform/packages/core/dist/index.js')).href);
export const STANDARD_VERSION = '2026.11.16.1';
const names = {
  default_agent: '通用智能体', test_agent: '软件测试总控智能体', requirement_analysis_agent: '需求分析智能体',
  test_point_agent: '测试点智能体', test_case_agent: '测试用例智能体', automation_execution_agent: '自动化执行智能体',
  android_test_agent: 'App 测试智能体', miniprogram_test_agent: '小程序测试智能体', defect_analysis_agent: '缺陷分析智能体',
  test_report_agent: '测试报告智能体', api_automation_agent: '接口自动化测试工程师',
};
const adapters = {
  'qa-default-entry': ['hooks.json', 'guard.mjs'],
  'qa-delegation-guard': ['hooks.json', 'guard.mjs', 'finish.mjs'],
  'qa-stage-boundary': ['hooks.json', 'guard.mjs'],
  goal: ['hooks.json', 'lib.mjs', 'start.mjs', 'stop.mjs'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = r => `${r.kind}:${r.payload.agentId ?? r.payload.skillName ?? `${r.payload.source}:${r.payload.pluginName}`}`;
const body = r => ({ kind: r.kind, name: r.name, description: r.description, payload: r.payload, audience: r.audience });

/** Only maintained public files enter the manifest, never a host config, memory or credential file. */
export function standardManifest() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json'), 'utf8'));
  const shared = readFileSync(resolve(root, manifest.shared_instructions), 'utf8');
  const resources = [];
  for (const name of readdirSync(resolve(root, 'skills'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    const files = Object.fromEntries(validateSkillResources(root, name).map(file => [
      `${name}/${file.relative.replaceAll('\\', '/')}`, new Uint8Array(readFileSync(file.source)),
    ]).sort(([a], [b]) => a.localeCompare(b)));
    const archive = Buffer.from(zipSync(files, { mtime: new Date('2000-01-01T00:00:00Z') }));
    if (archive.length > 1024 * 1024) throw Error(`Skill archive exceeds limit: ${name}`);
    const meta = parseSkillFrontmatter(readFileSync(resolve(root, 'skills', name, 'SKILL.md'), 'utf8'));
    resources.push({ kind: 'skills', name, description: meta?.description ?? name, audience: ['*'],
      payload: { skillName: name, archiveBase64: archive.toString('base64'), fileNames: Object.keys(files) } });
  }
  for (const [name, files] of Object.entries(adapters)) {
    const directory = name === 'goal' ? resolve(root, 'platform/plugins/goal/hooks') : resolve(root, 'penguin/hooks', name);
    resources.push({ kind: 'plugins', name, description: '随应用交付的受信运行适配器', audience: ['*'],
      payload: { source: 'trusted-local-adapter', pluginName: name, adapterVersion: '2026.11.04.1',
        adapterHash: `sha256:${sha(JSON.stringify(files.map(file => [file, sha(readFileSync(resolve(directory, file)))])))}` } });
  }
  for (const directory of readdirSync(resolve(root, 'platform/plugins'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = resolve(root, 'platform/plugins', directory.name, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (!pkg.keywords?.includes('penguin-plugin') || !pkg.penguin) continue;
    resources.push({ kind: 'plugins', name: pkg.penguin.title_zh ?? pkg.penguin.title ?? directory.name,
      description: pkg.penguin.description_zh ?? pkg.description, audience: ['*'],
      payload: { source: 'upstream-library', pluginName: directory.name, pluginVersion: pkg.version } });
  }
  for (const role of [manifest.fallback_entry, ...manifest.agents]) {
    resources.push({ kind: 'agents', name: names[role.id] ?? role.id, description: '项目标准智能体定义', audience: ['*'],
      payload: { agentId: role.id === 'default_agent' ? 'general_agent' : role.id,
        prompt: defaultSystemConfig().system_prompt,
        agentsMd: readFileSync(resolve(root, role.prompt), 'utf8') + '\n' + sharedInstructionsForRole(shared, role.id),
        modelResource: '', skillResources: (role.skills ?? []).map(name => `skills:${name}`),
        pluginResources: (role.id === 'default_agent' ? ['qa-default-entry', 'goal'] :
          role.id === 'test_agent' ? ['qa-delegation-guard'] : ['qa-stage-boundary']).map(name => `plugins:trusted-local-adapter:${name}`) } });
  }
  return resources;
}

/** One synchronous SQLite transaction, including dependency pins, models and menu defaults. */
export async function initializeStandardData(store, resources = standardManifest()) {
  const { controlRoutes, seedControlGroups, seedPluginCategories } = await server('standard-data.js');
  // Create service-owned auxiliary tables before the transaction, using the normal route setup.
  controlRoutes(store);
  const { centralSkillRoutes, defaultSkillCategory } = await server('standard-data.js');
  const db = store.db;
  db.exec('CREATE TABLE IF NOT EXISTS standard_data_baselines(resource_key TEXT PRIMARY KEY,resource_id TEXT NOT NULL,source_hash TEXT NOT NULL,version TEXT NOT NULL,created_at TEXT NOT NULL)');
  const created = [], preserved = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = new Map();
    for (const item of store.list(true)) {
      const key = identity(item);
      if (existing.has(key) && resources.some(r => identity(r) === key)) throw Error(`Duplicate standard resource: ${key}`);
      existing.set(key, item);
    }
    const keys = new Set();
    for (const definition of resources) {
      const key = identity(definition);
      if (keys.has(key)) throw Error(`Duplicate manifest key: ${key}`);
      keys.add(key);
      const previous = existing.get(key);
      const ledger = db.prepare('SELECT resource_id FROM standard_data_baselines WHERE resource_key=?').get(key);
      if (previous) {
        if (!previous.published || db.prepare('SELECT 1 FROM central_skill_deleted WHERE resource_id=?').get(previous.id))
          throw Error(`Standard resource is withdrawn/deleted/unpublished; administrator review required: ${key}`);
        if (!ledger) db.prepare('INSERT INTO standard_data_baselines VALUES(?,?,?,?,?)').run(key, previous.id, sha(JSON.stringify(body(previous))), STANDARD_VERSION, new Date().toISOString());
        preserved.push(key);
        continue;
      }
      if (ledger) throw Error(`Previously initialized resource was removed; administrator review required: ${key}`);
      const payload = structuredClone(definition.payload);
      if (definition.kind === 'agents') for (const field of ['skillResources', 'pluginResources']) {
        payload[field] = payload[field].map(ref => {
          const dependency = existing.get(ref);
          if (!dependency?.published) throw Error(`Missing published dependency: ${ref}`);
          return dependency.id;
        });
      }
      const saved = store.save('deployment-initializer', { ...definition, payload });
      const published = store.publish('deployment-initializer', saved.id, saved.revision);
      existing.set(key, published);
      db.prepare('INSERT INTO standard_data_baselines VALUES(?,?,?,?,?)').run(key, published.id, sha(JSON.stringify(body(published))), STANDARD_VERSION, new Date().toISOString());
      created.push(key);
    }
    store.modelConfig.initializeDefaults();
    store.system.initializeDefaults();
    seedControlGroups(store);
    seedPluginCategories(store);
    for (const item of existing.values()) {
      if (item.kind === 'skills') db.prepare('INSERT OR IGNORE INTO central_skill_assignments VALUES(?,?)').run(String(item.payload.skillName), defaultSkillCategory(String(item.payload.skillName)));
      if (item.kind === 'plugins') db.prepare('INSERT OR IGNORE INTO public_plugin_category_assignments VALUES(?,?)').run(item.id, 'other');
    }
    // Register Skill version labels through the same migration used on normal service startup.
    centralSkillRoutes(store);
    for (const resource of existing.values()) if (resource.kind === 'agents' && resource.published) store.versionBundle(resource.id, resource.version);
    db.exec('COMMIT');
    return { version: STANDARD_VERSION, created, preserved, resources: resources.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Online phase uses normal project lifecycle. Never fabricates assistant directories or sessions. */
export async function completeInitialization(home, origin, checkOnly = false) {
  const url = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/')
    throw Error('Run on the central host with a loopback origin');
  const token = readFileSync(resolve(home, 'api-token'), 'utf8').trim();
  const request = async (path, method = 'GET', data) => {
    let res = await fetch(new URL(path, url), { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    if ([307, 308].includes(res.status)) {
      const target = new URL(res.headers.get('location'), url);
      if (target.origin !== url.origin) throw Error('Cross-origin redirect refused');
      res = await fetch(target, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    }
    if (!res.ok) throw Error(`${method} ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const config = await request('/api/account-client/config');
  if (config.central !== true) throw Error('Target is not the central administration service');
  const resources = (await request('/api/control/admin/resources')).resources;
  const manifest = standardManifest();
  for (const definition of manifest) {
    const matches = resources.filter(item => identity(item) === identity(definition));
    if (matches.length !== 1 || !matches[0].published) throw Error(`Standard resource missing or unpublished: ${identity(definition)}`);
  }
  const projects = (await request('/api/projects')).projects;
  if (!projects.some(item => item.projectId === 'admin_agent_catalog')) {
    if (checkOnly) throw Error('Administrator assistant project missing');
    await request('/api/projects', 'POST', { projectId: 'admin_agent_catalog', name: '管理员助手' });
  }
  const agents = await request('/api/projects/admin_agent_catalog/agents');
  if (!agents.agents?.some(item => item.agentId === 'default_agent')) throw Error('Administrator assistant agent missing');
  const models = await request('/api/projects/admin_agent_catalog/models');
  if (!models.models?.length) throw Error('Model catalogue missing');
  const tools = await request('/api/control/tools/admin');
  if (!tools.tools?.length) throw Error('Tool catalogue missing');
  const catalog = await request('/api/control/catalog');
  const counts = Object.fromEntries(['agents', 'skills', 'plugins'].map(kind => [kind, catalog.resources.filter(item => item.kind === kind).length]));
  return { version: STANDARD_VERSION, counts, models: models.models.length, tools: tools.tools.length,
    assistant: 'admin_agent_catalog/default_agent', credentials: 'not validated; configure and test in model settings' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, homeArg, origin] = process.argv.slice(2);
  if (!['seed', 'complete', 'check'].includes(mode) || !homeArg) throw Error('Usage: node scripts/initialize-standard-data.mjs seed|complete|check <central-home> [http://localhost:port]');
  const home = resolve(homeArg);
  if (mode !== 'seed') {
    if (!origin) throw Error('Central loopback origin required');
    console.log(JSON.stringify(await completeInitialization(home, origin, mode === 'check'), null, 2));
  } else {
    if (!existsSync(resolve(home, 'web.db'))) throw Error('Start central service once to provision database/admin, then stop it before seeding');
    const { readServerLock } = await server('lock.js');
    const lock = readServerLock(home);
    if (lock) {
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw Error('Central process is running. Stop it before offline initialization');
    }
    const { ControlStore } = await server('standard-data.js');
    const db = new DatabaseSync(resolve(home, 'web.db'));
    try { console.log(JSON.stringify(await initializeStandardData(new ControlStore(db, home)), null, 2)); }
    finally { db.close(); }
  }
}
