import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { remoteClientConnection, inspectRemoteService } from '../../scripts/client-connection.mjs';
import { resolveProductLayout } from '../../scripts/product-layout.mjs';
import { ensureLocalService, resumeLocalService, registerLocalService } from '../../scripts/local-service.mjs';
import { inspectProductService } from '../../scripts/product-doctor.mjs';

const remote = { mode: 'remote', origin: 'http://localhost:18777' };
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'aitest-remote-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const file = resolve(root, 'installation.json');
  const value = { version: 1, installation_id: 'remote-client-test', layout: 'unified', root: '.',
    project_id: 'default_project', connection: remote,
    paths: { engine: 'app/engine', host_executable: 'runtime/penguin/PenguinHarness.exe',
      host_data: 'data/penguin', qa_data: 'data/qa', desktop_profile: 'data/profile',
      workspaces: 'workspaces', node: 'runtime/node/node.exe' } };
  writeFileSync(file, JSON.stringify(value));
  return { root, file, value, layout: resolveProductLayout(value, file) };
}

test('remote mode is explicit, validates origins, and leaves existing standalone configurations compatible', t => {
  const f = fixture(t);
  assert.deepEqual(f.layout.connection, remote);
  delete f.value.connection;
  assert.equal(resolveProductLayout(f.value, f.file).connection, undefined);
  assert.deepEqual(remoteClientConnection({ mode: 'remote', origin: 'https://qa.example.com/' }),
    { mode: 'remote', origin: 'https://qa.example.com' });
  for (const origin of ['http://qa.example.com', 'https://user:pass@qa.example.com',
    'https://qa.example.com/user', 'https://qa.example.com/?key=secret', 'https://qa.example.com/#token',
    'file:///c:/app', ' https://qa.example.com', 'https://qa.example.com\n', 'https:\\qa.example.com']) {
    assert.throws(() => remoteClientConnection({ mode: 'remote', origin }));
  }
  assert.throws(() => resolveProductLayout({ ...f.value, connection: { ...remote, token: 'secret' } }, f.file));
});

test('remote client refuses local service startup and resume without creating a database or removing pause protection', async t => {
  const f = fixture(t);
  const pause = resolve(f.root, '.local-service-paused.json');
  writeFileSync(pause, '{"reason":"maintenance"}');
  await assert.rejects(ensureLocalService(f.file), /local business server is disabled/);
  await assert.rejects(resumeLocalService(f.file), /local business server is disabled/);
  assert.equal(existsSync(pause), true);
  assert.equal(existsSync(resolve(f.layout.paths.host_data, 'web.db')), false);
  assert.equal(existsSync(f.layout.paths.qa_data), false);
  if (process.platform === 'win32') assert.throws(() => registerLocalService(f.file), /autostart is disabled/);
});

test('remote health reads only the configured login page and never a local database or credential', async t => {
  const f = fixture(t);
  mkdirSync(f.layout.paths.host_data, { recursive: true });
  writeFileSync(resolve(f.layout.paths.host_data, 'api-token'), 'LOCAL-SECRET-MUST-NOT-BE-SENT');
  writeFileSync(resolve(f.layout.paths.host_data, 'server.lock'), '{"pid":1,"port":59764}');
  const calls = [];
  const health = await inspectProductService(f.layout, { fetcher: async (url, options) => {
    calls.push({ url, options });
    return new Response('<!doctype html><html>Remote sign in</html>', { headers: { 'content-type': 'text/html' } });
  }, processAlive: () => { throw Error('must not inspect a local server'); } });
  assert.equal(health.status, 'ready');
  assert.equal(health.authenticated, false);
  assert.equal(health.mode, 'remote');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:18777/user/login');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { connection: 'close' });
  assert.equal(existsSync(resolve(f.layout.paths.host_data, 'web.db')), false);
});

test('offline, redirect, JSON and malformed responses fail remote health instead of switching to localhost', async () => {
  for (const fetcher of [
    async () => { throw Error('offline'); },
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('', { status: 302, headers: { location: 'http://localhost:59764' } }),
  ]) {
    const result = await inspectRemoteService(remote, { fetcher });
    assert.notEqual(result.status, 'ready');
    assert.equal(result.mode, 'remote');
    assert.equal(result.origin, remote.origin);
  }
});
