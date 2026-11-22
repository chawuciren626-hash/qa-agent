import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyAnchorBindings, bindCaseAnchors, bundleAnchors, controlAnchor } from '../../scripts/locator-anchor-adapter.mjs';
import { catalogPath } from '../../scripts/test-asset-catalog.mjs';
import { createExecutionCases } from '../../scripts/execution-plan.mjs';

const bundle = {
  id: 'ui-demo',
  kind: 'ui_locator_bundle',
  version: '1.0.0',
  data: {
    route: '/inventory.html',
    controls: [
      { control_type: 'button', name: 'add-to-cart-demo', text: 'Add to cart', fingerprints: { testid: null, role: null, css: '#add-to-cart-demo', text: 'Add to cart' } },
      { control_type: 'link', name: null, text: 'Facebook', fingerprints: { testid: null, role: null, css: null, text: 'Facebook' } },
      { control_type: 'link', name: 'Cart, empty', text: 'Cart, empty', fingerprints: { testid: null, role: 'button', css: null, text: 'Cart, empty' } },
    ],
  },
};
const catalog = { catalog_version: 2, assets: [bundle] };

test('controls with fewer than two independent fingerprints are not anchors', () => {
  const anchors = bundleAnchors(bundle);
  assert.equal(anchors.length, 2);
  const addToCart = anchors.find(anchor => anchor.control === 'add-to-cart-demo');
  assert.deepEqual(addToCart.fingerprints, ['css:#add-to-cart-demo', 'text:Add to cart', 'name:add-to-cart-demo']);
  assert.equal(anchors.some(anchor => anchor.control === null && anchor.text === 'Facebook'), false);
  assert.equal(controlAnchor({ text: 'Facebook', fingerprints: { text: 'Facebook' } }), null);
});

test('case target_controls resolve to asset_refs and structural anchors', () => {
  const bound = bindCaseAnchors({ case_id: 'TC-CART-1', target_controls: ['add-to-cart-demo'] }, catalog);
  assert.deepEqual(bound.asset_refs, [{ id: 'ui-demo', version: '1.0.0', kind: 'ui_locator_bundle' }]);
  assert.equal(bound.anchors.length, 1);
  assert.equal(bound.anchors[0].css_path, '#add-to-cart-demo');
  assert.equal(bound.anchors[0].route, '/inventory.html');
  const byCss = bindCaseAnchors({ case_id: 'TC-CART-2', target_controls: ['#add-to-cart-demo'] }, catalog);
  assert.equal(byCss.anchors[0].anchor_id, bound.anchors[0].anchor_id);
});

test('unresolved or under-specified targets fail loudly instead of degrading to empty anchors', () => {
  assert.throws(() => bindCaseAnchors({ case_id: 'TC-CART-3', target_controls: ['#missing'] }, catalog), /未在资产目录/);
  assert.throws(() => bindCaseAnchors({ case_id: 'TC-CART-4', target_controls: ['Facebook'] }, catalog), /独立指纹不足/);
});

test('applyAnchorBindings is idempotent and cases without targets are untouched', () => {
  const input = [
    { case_id: 'TC-CART-1', target_controls: ['add-to-cart-demo'] },
    { case_id: 'TC-OTHER-1', automation_feasible: true, title: 'other' },
  ];
  const once = applyAnchorBindings(input, catalog);
  const twice = applyAnchorBindings(once, catalog);
  assert.equal(once[0].anchors.length, 1);
  assert.deepEqual(twice[0].asset_refs, once[0].asset_refs);
  assert.equal(twice[0].anchors.length, 1);
  assert.equal(once[1], input[1]);
  assert.equal(input[0].anchors, undefined, 'input must not be mutated');
});

test('createExecutionCases carries resolved anchors into the execution plan', () => {
  const cases = createExecutionCases([{ case_id: 'TC-CART-1', title: 'cart', automation_feasible: true, target_controls: ['add-to-cart-demo'], anchors: [{ anchor_id: 'ui-demo:add-to-cart-demo', fingerprints: ['css:#add-to-cart-demo'] }] }]);
  assert.equal(cases[0].anchors.length, 1);
  assert.equal(cases[0].anchors[0].anchor_id, 'ui-demo:add-to-cart-demo');
});

test('isolated projects resolve one project-level catalog instead of the engine config', () => {
  const engine = resolve(import.meta.dirname, '../..');
  const temp = mkdtempSync(resolve(tmpdir(), 'qa-catalog-'));
  const saved = { context: process.env.QA_DIRECTORY_CONTEXT, data: process.env.QA_APP_DATA_ROOT };
  try {
    mkdirSync(resolve(temp, 'workspace/session'), { recursive: true });
    process.env.QA_DIRECTORY_CONTEXT = JSON.stringify({ version: 1, engine_root: engine, workspace_root: resolve(temp, 'workspace'), session_root: resolve(temp, 'workspace/session'), session_id: 'session-2026-11-22-00-00-00-abcdef', project_id: 'project-a' });
    process.env.QA_APP_DATA_ROOT = resolve(temp, 'data');
    assert.equal(catalogPath(engine), resolve(temp, 'data/projects/project-a/automation/test-assets.json'));
  } finally {
    if (saved.context === undefined) delete process.env.QA_DIRECTORY_CONTEXT; else process.env.QA_DIRECTORY_CONTEXT = saved.context;
    if (saved.data === undefined) delete process.env.QA_APP_DATA_ROOT; else process.env.QA_APP_DATA_ROOT = saved.data;
    rmSync(temp, { recursive: true, force: true });
  }
});
