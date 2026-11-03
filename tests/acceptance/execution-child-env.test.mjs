import test from 'node:test';
import assert from 'node:assert/strict';
import { executionChildEnv } from '../../scripts/execution-child-env.mjs';

test('generated test process receives run context but no host credentials', () => {
  const env = executionChildEnv({
    PATH: '/bin',
    QA_DIRECTORY_CONTEXT: '{"version":1}',
    PENGUIN_API_TOKEN: 'admin-token',
    OPENAI_API_KEY: 'model-secret',
    QA_BASE_URL: 'https://untrusted.example',
    npm_config_token: 'registry-secret',
  }, { QA_BASE_URL: 'https://target.example' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.QA_DIRECTORY_CONTEXT, '{"version":1}');
  assert.equal(env.QA_BASE_URL, 'https://target.example');
  for (const secret of ['PENGUIN_API_TOKEN', 'OPENAI_API_KEY', 'npm_config_token']) {
    assert.equal(Object.hasOwn(env, secret), false);
  }
});
