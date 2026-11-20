import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../../scripts/explore-authenticated.mjs');

test('exploration reuses a valid session before looking for login form fields', async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), 'qa-explore-reuse-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    const authenticated = req.headers.cookie?.includes('session=valid');
    if (req.url === '/login' && authenticated) {
      res.writeHead(302, { location: '/home' });
      res.end();
      return;
    }
    if (req.url === '/target' && !authenticated) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/target'
      ? '<!doctype html><title>Target</title><h1>Target</h1><button>Inspect</button>'
      : '<!doctype html><title>Home</title><h1>Home</h1>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = resolve(folder, 'session.json');
  const creds = resolve(folder, 'credentials.json');
  const out = resolve(folder, 'round');
  writeFileSync(session, JSON.stringify({
    cookies: [{ name: 'session', value: 'valid', domain: '127.0.0.1', path: '/', expires: -1,
      httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  writeFileSync(creds, JSON.stringify({ username: 'unused', password: 'unused' }));

  const result = await run(process.execPath, [script, '--login-url', `${origin}/login`,
    '--target-url', `${origin}/target`, '--creds', creds, '--out', out,
    '--session', session, '--discover-login', '--captcha-strategy', 'auto'],
  { timeout: 30000, maxBuffer: 1024 * 1024 });
  const receipt = JSON.parse(readFileSync(resolve(out, 'explore-receipt.json'), 'utf8'));
  assert.equal(receipt.session_reused, true);
  assert.equal(receipt.controls, 1);
  assert.match(result.stderr, /已保存登录态有效/);
});
