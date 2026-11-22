import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { catalogPath } from '../../scripts/test-asset-catalog.mjs';
import { deriveScriptAssets, anchorVersion, scriptAssetStatus, scriptCatalogPath } from '../../scripts/execution-script-assets.mjs';

const engine = resolve(import.meta.dirname, '../..');

const bundle = {
  id: 'ui-demo', kind: 'ui_locator_bundle', name: 'demo locators', version: '1.0.0', status: 'verified',
  scope: { application: 'demo', modules: ['inventory'], environments: ['demo-env'] },
  tags: ['ui', 'demo'],
  source: { type: 'observed_ui', reference: 'test', captured_at: '2026-11-22' },
  validation: { validated_at: '2026-11-22', environment: 'demo-env', evidence: 'test' },
  data: { route: '/inventory.html', controls: [{ control_type: 'button', name: 'add-to-cart-demo', text: 'Add to cart', fingerprints: { testid: null, role: null, css: '#add-to-cart-demo', text: 'Add to cart' } }] },
};

function withIsolatedProject() {
  const temp = mkdtempSync(resolve(tmpdir(), 'qa-script-asset-'));
  const workspace = resolve(temp, 'workspace');
  const session = resolve(workspace, 'session');
  const run = resolve(session, 'output/runs/run-1');
  mkdirSync(resolve(run, 'design'), { recursive: true });
  mkdirSync(resolve(run, 'environment'), { recursive: true });
  const designPath = resolve(run, 'design/test_cases.json');
  writeFileSync(designPath, JSON.stringify([{ case_id: 'TC-CART-1', title: 'add to cart', module: 'inventory', automation_feasible: true, asset_refs: [{ id: 'ui-demo', version: '1.0.0', kind: 'ui_locator_bundle' }] }], null, 2));
  const envPath = resolve(run, 'environment/test-env.json');
  writeFileSync(envPath, JSON.stringify({ environment: 'demo-env', base_url: 'http://127.0.0.1:4317' }, null, 2));
  const saved = { context: process.env.QA_DIRECTORY_CONTEXT, data: process.env.QA_APP_DATA_ROOT };
  process.env.QA_DIRECTORY_CONTEXT = JSON.stringify({ version: 1, engine_root: engine, workspace_root: workspace, session_root: session, session_id: 'session-2026-11-22-00-00-00-abcdef', project_id: 'project-a' });
  process.env.QA_APP_DATA_ROOT = resolve(temp, 'data');
  return {
    plan: { run_id: 'run-1', source: designPath, environment_config: envPath, cases: [{ case_id: 'TC-CART-1', anchors: [{ anchor_id: 'ui-demo:add-to-cart-demo', fingerprints: ['css:#add-to-cart-demo', 'text:Add to cart'] }] }] },
    path: catalogPath(engine),
    restore() {
      if (saved.context === undefined) delete process.env.QA_DIRECTORY_CONTEXT; else process.env.QA_DIRECTORY_CONTEXT = saved.context;
      if (saved.data === undefined) delete process.env.QA_APP_DATA_ROOT; else process.env.QA_APP_DATA_ROOT = saved.data;
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

test('candidate script asset is promoted via CLI then reused with zero regeneration', () => {
  const fixture = withIsolatedProject();
  try {
    assert.equal(scriptCatalogPath(engine), fixture.path, 'script and exploration catalogs must share one resolver');
    mkdirSync(resolve(fixture.path, '..'), { recursive: true });
    writeFileSync(fixture.path, JSON.stringify({ catalog_version: 2, catalog_name: 'QA Test Asset Catalog', assets: [bundle] }, null, 2));
    const [candidate] = deriveScriptAssets(engine, { runId: 'run-1', plan: fixture.plan, bundleId: 'ui-demo', files: [{ path: 'tests/cart.spec.ts' }] });
    assert.equal(candidate.status, 'candidate');
    writeFileSync(fixture.path, JSON.stringify({ catalog_version: 2, catalog_name: 'QA Test Asset Catalog', assets: [bundle, candidate] }, null, 2));

    assert.equal(scriptAssetStatus(engine, fixture.plan).regenerate[0]?.reason, 'asset_candidate');

    const promoted = spawnSync(process.execPath, ['scripts/manage-script-asset.mjs', `--promote=${candidate.id}`, '--evidence=首跑通过，人工复核脚本与断言'], { cwd: engine, env: process.env, encoding: 'utf8' });
    assert.equal(promoted.status, 0, promoted.stderr);
    const saved = JSON.parse(readFileSync(fixture.path, 'utf8')).assets.find(asset => asset.id === candidate.id);
    assert.equal(saved.status, 'verified');
    assert.equal(saved.validation.environment, 'demo-env');
    assert.match(saved.validation.validated_at, /^\d{4}-\d{2}-\d{2}T/);

    const status = scriptAssetStatus(engine, fixture.plan);
    assert.equal(status.reused.length, 1);
    assert.equal(status.reused[0].case_id, 'TC-CART-1');
    assert.equal(status.regenerate.length, 0);
  } finally {
    fixture.restore();
  }
});

test('anchor content changes make a verified script asset stale', () => {
  const fixture = withIsolatedProject();
  try {
    const catalog = { catalog_version: 2, catalog_name: 'QA Test Asset Catalog', assets: [bundle] };
    mkdirSync(resolve(fixture.path, '..'), { recursive: true });
    writeFileSync(fixture.path, JSON.stringify(catalog, null, 2));
    const designCase = { asset_refs: [{ id: 'ui-demo', version: '1.0.0', kind: 'ui_locator_bundle' }] };
    const originalVersion = anchorVersion(designCase, { anchors: fixture.plan.cases[0].anchors, catalog });
    const [candidate] = deriveScriptAssets(engine, { runId: 'run-1', plan: fixture.plan, bundleId: 'ui-demo', files: [] });
    assert.equal(candidate.data.anchor_version, originalVersion);
    catalog.assets.push({ ...candidate, status: 'verified', validation: { validated_at: new Date().toISOString(), environment: 'demo-env', evidence: 'test' } });
    writeFileSync(fixture.path, JSON.stringify(catalog, null, 2));
    assert.equal(scriptAssetStatus(engine, fixture.plan).reused.length, 1);

    catalog.assets[0].data.controls[0].text = 'Add to cart now';
    writeFileSync(fixture.path, JSON.stringify(catalog, null, 2));
    assert.equal(scriptAssetStatus(engine, fixture.plan).regenerate[0]?.reason, 'stale_anchor_version');
  } finally {
    fixture.restore();
  }
});

test('promotion refuses to certify without evidence', () => {
  const fixture = withIsolatedProject();
  try {
    mkdirSync(resolve(fixture.path, '..'), { recursive: true });
    writeFileSync(fixture.path, JSON.stringify({ catalog_version: 2, assets: [bundle] }, null, 2));
    const [candidate] = deriveScriptAssets(engine, { runId: 'run-1', plan: fixture.plan, bundleId: 'ui-demo', files: [] });
    writeFileSync(fixture.path, JSON.stringify({ catalog_version: 2, assets: [bundle, candidate] }, null, 2));
    const result = spawnSync(process.execPath, ['scripts/manage-script-asset.mjs', `--promote=${candidate.id}`], { cwd: engine, env: process.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence/);
    assert.equal(JSON.parse(readFileSync(fixture.path, 'utf8')).assets.find(asset => asset.id === candidate.id).status, 'candidate');
  } finally {
    fixture.restore();
  }
});
