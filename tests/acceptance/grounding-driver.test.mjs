import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroundingDriver, resolveStructural, reverseLookup } from '../../scripts/grounding-driver.mjs';

const tree = {
  id: 'root', role: 'document', tag: 'body', css_path: 'body', bounds: { x: 0, y: 0, width: 1200, height: 900 },
  children: [
    {
      id: 'form', role: 'form', tag: 'div', css_path: 'body>form', bounds: { x: 20, y: 100, width: 600, height: 400 },
      children: [
        { id: 'username', role: 'textbox', name: '用户名', tag: 'input', testid: 'login-user', css_path: 'body>form>input:nth-child(1)', bounds: { x: 40, y: 140, width: 300, height: 32 }, children: [] },
        { id: 'submit', role: 'button', name: '登录', text: '登录', tag: 'button', css_path: 'body>form>button', bounds: { x: 40, y: 200, width: 100, height: 36 }, children: [] },
      ],
    },
  ],
};

const anchor = { id: 'A-USER', role: 'textbox', testid: 'login-user', name: '用户名' };

test('structural layer resolves with >=2 fingerprints and zero model calls', async () => {
  const driver = createGroundingDriver({ semantic: { resolve: () => { throw new Error('semantic must not be called'); } } });
  const result = await driver.resolve({ tree, anchor });
  assert.equal(result.resolved, true);
  assert.equal(result.backend, 'structural');
  assert.equal(result.model_calls, 0);
  assert.equal(result.node.id, 'username');
  assert.ok(result.matched_fingerprints.length >= 2);
});

test('structural layer refuses a single-fingerprint anchor instead of guessing', () => {
  const result = resolveStructural(tree, { id: 'weak', role: 'button' }, { minFingerprints: 2 });
  assert.equal(result.resolved, false);
  assert.match(result.reason, /insufficient_fingerprints/);
});

test('semantic hit is downgraded to a verified structural anchor', async () => {
  const semantic = { resolve: async () => ({ node_id: 'submit' }) };
  const result = await createGroundingDriver({ semantic }).resolve({ tree, anchor: { id: 'A-SUBMIT', name: '登录' } });
  assert.equal(result.backend, 'semantic');
  assert.equal(result.downgraded, true);
  assert.equal(result.anchor.origin_backend, 'semantic');
  assert.equal(result.anchor.node_id, 'submit');
  assert.ok(result.anchor.fingerprints.includes('name:登录'));
});

test('semantic hit without any structural fingerprint is rejected', async () => {
  const semantic = { resolve: async () => ({ node_id: 'form' }) };
  const result = await createGroundingDriver({ semantic }).resolve({ tree, anchor: { id: 'A-GHOST', name: '登录' } });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts.at(-1).outcome, 'rejected');
  assert.equal(result.attempts.at(-1).reason, 'structural_anchor_unverified');
});

test('visual point must reverse-map to a structural node with a matching fingerprint', async () => {
  const visual = { locate: async () => ({ x: 90, y: 215 }) };
  const result = await createGroundingDriver({ visual }).resolve({ tree, anchor: { id: 'A-BTN', text: '登录' }, screenshot: 'shot.png' });
  assert.equal(result.backend, 'visual');
  assert.equal(result.node.id, 'submit');
  assert.equal(result.anchor.origin_backend, 'visual');
  assert.equal(reverseLookup(tree, { x: 90, y: 215 }, { id: 'A-NONE', text: '不存在的按钮' }), null);
  const rejected = await createGroundingDriver({ visual: { locate: async () => ({ x: 1100, y: 800 }) } }).resolve({ tree, anchor: { id: 'A-BTN', text: '登录' } });
  assert.equal(rejected.resolved, false);
  assert.equal(rejected.attempts.at(-1).reason, 'no_structural_anchor');
});
