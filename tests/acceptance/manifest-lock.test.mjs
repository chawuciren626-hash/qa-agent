import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { withRunLock } from '../../scripts/orchestration-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const project = { run_root: 'output/runs' };
const moduleUrl = pathToFileURL(resolve(root, 'scripts/orchestration-state.mjs')).href;
function fixture() {
  const id = `run-${randomUUID()}`, dir = resolve(root, project.run_root, id);
  mkdirSync(dir, { recursive: true });
  const manifest = resolve(dir, 'manifest.json'), lock = `${manifest}.lock`;
  writeFileSync(manifest, JSON.stringify({ run_id: id, status: 'in_progress', stages: { execution: { status: 'in_progress' } }, events: [] }));
  return { id, dir, lock, manifest, run: fn => withRunLock(root, project, id, fn),
    code: body => `import fs from 'node:fs';import {withRunLock} from ${JSON.stringify(moduleUrl)};withRunLock(${JSON.stringify(root)},${JSON.stringify(project)},${JSON.stringify(id)},()=>{${body}});` };
}
function orphan(f) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', f.code('process.exit(42);')], { cwd: root, windowsHide: true });
  assert.equal(result.status, 42, result.stderr?.toString());
  return readFileSync(f.lock, 'utf8');
}
function recovery(f) {
  const dir = resolve(f.dir, 'audit/manifest-lock-recovery');
  return existsSync(dir) ? readdirSync(dir).map(name => JSON.parse(readFileSync(resolve(dir, name)))) : [];
}

test('normal and throwing callbacks release only their own lock', () => {
  const f = fixture();
  assert.equal(f.run(() => { const lock = JSON.parse(readFileSync(f.lock)); assert.equal(lock.host, hostname()); return 7; }), 7);
  assert.equal(existsSync(f.lock), false);
  assert.throws(() => f.run(() => { throw Error('callback failed'); }), /callback failed/);
  assert.equal(existsSync(f.lock), false);
  assert.throws(() => f.run(() => writeFileSync(f.lock, 'replacement-owner')), /ownership changed/);
  assert.equal(readFileSync(f.lock, 'utf8'), 'replacement-owner');
});

test('abrupt owner exit recovers once without modifying execution locks or manifest state', () => {
  const f = fixture(), before = readFileSync(f.manifest, 'utf8'), raw = orphan(f);
  mkdirSync(resolve(f.dir, 'execution'));
  const executionLock = resolve(f.dir, 'execution/execution.lock.json');
  writeFileSync(executionLock, 'uncertain product operation');
  let calls = 0;
  f.run(() => calls++);
  assert.equal(calls, 1);
  assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(f.manifest, 'utf8'), before);
  assert.equal(readFileSync(executionLock, 'utf8'), 'uncertain product operation');
  const records = recovery(f);
  assert.equal(records.length, 1);
  assert.equal(records[0].previous_lock, raw);
  assert.equal(records[0].status, 'lock_removed');
  assert.equal(records[0].product_actions_replayed, false);
});

test('live owners are preserved regardless of age; unknown probe results cannot authorize takeover', t => {
  const f = fixture();
  f.run(() => {
    const original = readFileSync(f.lock, 'utf8');
    const owner = JSON.parse(original); owner.at = '2000-01-01T00:00:00Z';
    const raw = JSON.stringify(owner); writeFileSync(f.lock, raw);
    assert.throws(() => f.run(() => assert.fail('must not run')), /still running/);
    const probe = t.mock.method(process, 'kill', () => { throw Object.assign(Error('no permission'), { code: 'EPERM' }); });
    try { assert.throws(() => f.run(() => assert.fail('must not run')), /unknown/); }
    finally { probe.mock.restore(); }
    assert.equal(readFileSync(f.lock, 'utf8'), raw);
    assert.equal(recovery(f).length, 0);
    writeFileSync(f.lock, original);
  });
});

test('crash after commit preserves committed state and a rejected new operation is not retried', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', f.code(`const p=${JSON.stringify(f.manifest)};const m=JSON.parse(fs.readFileSync(p));m.events.push('committed');fs.writeFileSync(p,JSON.stringify(m));process.exit(42);`)], { cwd: root, windowsHide: true });
  assert.equal(result.status, 42);
  const before = readFileSync(f.manifest, 'utf8'); let calls = 0;
  assert.throws(() => f.run(() => { calls++; if (JSON.parse(readFileSync(f.manifest)).events.length) throw Error('already committed'); }), /already committed/);
  assert.equal(calls, 1);
  assert.equal(readFileSync(f.manifest, 'utf8'), before);
  assert.equal(existsSync(f.lock), false);
  assert.equal(recovery(f).length, 1);
});

test('legacy, corrupt, foreign-host and wrong-run locks remain intact', () => {
  const f = fixture(), original = JSON.parse(orphan(f));
  for (const raw of ['broken', '', JSON.stringify({ pid: original.pid, at: original.at }),
    JSON.stringify({ ...original, host: 'other-host' }), JSON.stringify({ ...original, run_id: 'run-other' }),
    JSON.stringify({ ...original, pid: -1 }), JSON.stringify({ ...original, token: '' })]) {
    writeFileSync(f.lock, raw);
    assert.throws(() => f.run(() => assert.fail('must not run')));
    assert.equal(readFileSync(f.lock, 'utf8'), raw);
  }
  assert.equal(recovery(f).length, 0);
});

test('recovery interrupted before removal is not taken over by a second remover', () => {
  const f = fixture(), raw = orphan(f);
  const dir = resolve(f.dir, 'audit/manifest-lock-recovery'); mkdirSync(dir, { recursive: true });
  const claim = resolve(dir, `${createHash('sha256').update(raw).digest('hex')}.json`);
  writeFileSync(claim, JSON.stringify({ status: 'claimed', recovery_pid: JSON.parse(raw).pid }));
  assert.throws(() => f.run(() => assert.fail('must not run')), /already claimed/);
  assert.equal(readFileSync(f.lock, 'utf8'), raw);
});

test('invalid manifest and redirected audit directories cannot delete the orphan lock', () => {
  const f = fixture(), raw = orphan(f), before = readFileSync(f.manifest);
  writeFileSync(f.manifest, JSON.stringify({ run_id: 'run-other' }));
  assert.throws(() => f.run(() => assert.fail('must not run')), /identity mismatch/);
  writeFileSync(f.manifest, before);
  const elsewhere = resolve(root, 'output', `lock-redirect-${randomUUID()}`); mkdirSync(elsewhere);
  symlinkSync(elsewhere, resolve(f.dir, 'audit'), 'junction');
  assert.throws(() => f.run(() => assert.fail('must not run')), /Linked/);
  assert.equal(readFileSync(f.lock, 'utf8'), raw);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('concurrent orphan recovery preserves mutual exclusion and does not duplicate a committed action', async () => {
  const f = fixture(); orphan(f);
  const code = f.code(`const path=${JSON.stringify(f.manifest)};const m=JSON.parse(fs.readFileSync(path));if(m.events.length)throw Error('already committed');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);m.events.push('committed');fs.writeFileSync(path,JSON.stringify(m));`);
  const start = () => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => done(code));
  });
  const results = await Promise.all(Array.from({ length: 6 }, start));
  assert.equal(results.filter(code => code === 0).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.manifest)).events, ['committed']);
  assert.equal(recovery(f).length, 1);
  assert.equal(existsSync(f.lock), false);
});
