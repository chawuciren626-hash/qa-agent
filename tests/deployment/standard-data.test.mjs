import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../../platform/packages/server/dist/standard-data.js';
import { initializeStandardData, standardManifest } from '../../scripts/initialize-standard-data.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(user_id TEXT PRIMARY KEY,is_admin INTEGER); INSERT INTO users VALUES(\'admin\',1)');
  t.after(() => db.close());
  return new ControlStore(db);
}
test('fresh deployment publishes complete archives and pinned role dependencies; repeat changes no resource/version/model', async t => {
  const store = fixture(t);
  const manifest = standardManifest();
  assert.equal(manifest.filter(r => r.kind === 'agents').length, 11);
  assert.equal(manifest.filter(r => r.kind === 'skills').length, 15);
  assert.deepEqual(standardManifest(), manifest, 'archives are deterministic');
  const first = await initializeStandardData(store, manifest);
  assert.equal(first.created.length, manifest.length);
  for (const agent of store.list().filter(r => r.kind === 'agents')) {
    const bundle = store.versionBundle(agent.id, agent.version);
    assert.ok(bundle.resources.length >= 2);
  }
  const before = store.db.prepare('SELECT * FROM public_resources ORDER BY id').all();
  const models = store.db.prepare('SELECT * FROM central_model_config').all();
  assert.equal(store.system.menuItems().length, 11);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM public_admin_menus').get().n, 1);
  const second = await initializeStandardData(store, manifest);
  assert.equal(second.created.length, 0);
  assert.deepEqual(store.db.prepare('SELECT * FROM public_resources ORDER BY id').all(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM central_model_config').all(), models);
});
test('administrator edits, draft, model selection, menu visibility and removed tool links survive repeat', async t => {
  const store = fixture(t);
  await initializeStandardData(store);
  const agent = store.list().find(r => r.kind === 'agents');
  store.save('admin', { kind: agent.kind, name: '管理员改名', description: agent.description,
    payload: { ...agent.payload, agentsMd: '管理员维护的指令' }, audience: agent.audience, revision: agent.revision }, agent.id);
  await store.modelConfig.writeRaw('central-model-catalog', { models: [], providers: {} });
  store.system.setMenus('admin', store.system.menuItems().map(r => r.key === 'overview' ? { ...r, visible: false } : r));
  store.db.exec('DELETE FROM central_tool_agents; UPDATE central_tools SET enabled=0');
  await initializeStandardData(store);
  assert.equal(store.get(agent.id, true).name, '管理员改名');
  assert.equal(store.get(agent.id, true).payload.agentsMd, '管理员维护的指令');
  assert.deepEqual((await store.modelConfig.readRaw('central-model-catalog')).models, []);
  assert.equal(store.system.menuItems().find(r => r.key === 'overview').visible, false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM central_tool_agents').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM central_tools WHERE enabled=1').get().n, 0);
});
test('broken dependency rolls back resources, versions and baseline ledger', async t => {
  const store = fixture(t);
  const manifest = standardManifest();
  manifest.at(-1).payload.skillResources.push('skills:missing');
  await assert.rejects(initializeStandardData(store, manifest), /Missing published dependency/);
  for (const table of ['public_resources', 'public_resource_versions', 'standard_data_baselines', 'central_model_config'])
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
});
test('withdrawn or deleted standard resources require review and are never silently re-enabled', async t => {
  const store = fixture(t);
  await initializeStandardData(store);
  const skill = store.list().find(r => r.kind === 'skills');
  store.db.prepare('UPDATE public_resources SET published=0 WHERE id=?').run(skill.id);
  await assert.rejects(initializeStandardData(store), /review required/);
  assert.equal(store.get(skill.id, true).published, false);
});
