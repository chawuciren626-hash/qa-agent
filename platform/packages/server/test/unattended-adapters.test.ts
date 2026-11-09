import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { wire } from '@prismshadow/penguin-core/kernel';
import { LocalRunCanceller } from '../src/runtime/unattended/defaults.js';
import { localDeviceId } from '../src/runtime/unattended/device-identity.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it('preserves device identity and refuses to replace a corrupted identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unattended-device-')); roots.push(root);
  expect(localDeviceId(root)).toBe(localDeviceId(root));
  await fs.writeFile(path.join(root, 'device-identity.json'), 'invalid');
  expect(() => localDeviceId(root)).toThrow();
  expect(await fs.readFile(path.join(root, 'device-identity.json'), 'utf8')).toBe('invalid');
});

it('delivers cancellation to the session manager and preserves its acknowledgement', async () => {
  const calls: string[] = [];
  const canceller = wire(LocalRunCanceller, { manager: { abortTask: (id: string) => { calls.push(id); return id === 'active'; } } });
  expect(await canceller.cancel('active')).toBe(true);
  expect(await canceller.cancel('missing')).toBe(false);
  expect(calls).toEqual(['active', 'missing']);
});

it('checks real isolated manifests, task age, missing artifacts and ownership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unattended-outcome-')); roots.push(root);
  const engine = path.resolve('../../..');
  const sessionRoot = path.join(root, 'session');
  const runDir = path.join(sessionRoot, 'output', 'runs', 'run-test');
  await fs.mkdir(runDir, { recursive: true });
  const marker = { version: 1, engine_root: engine, workspace_root: root, session_root: sessionRoot, session_id: 'session-2026-11-09-12-00-00-abcdef' };
  const manifest = { run_id: 'run-test', created_at: '2026-11-09T12:00:00Z', directory_context: marker, status: 'completed',
    orchestration: { plan: { stages: [{ id: 'analysis', selected: true }] } }, stages: { analysis: { status: 'skipped' } } };
  const save = () => fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const observe = async (since = '2026-11-09T11:00:00Z') => {
    const { stdout } = await exec(process.execPath, [path.join(engine, 'scripts/observe-unattended-outcome.mjs'), since], {
      env: { ...process.env, QA_DIRECTORY_CONTEXT: JSON.stringify(marker) }, windowsHide: true,
    });
    return JSON.parse(stdout);
  };
  await save();
  expect(await observe()).toBe('succeeded'); // A workflow with its selected stage explicitly skipped.
  expect(await observe('2026-11-09T13:00:00Z')).toBe(null);
  manifest.stages.analysis.status = 'completed'; await save();
  expect(await observe()).toBe(null); // Missing completed artifacts cannot be reported as success.
  manifest.status = 'failed'; manifest.stages.analysis.status = 'failed'; await save();
  expect(await observe()).toBe('failed');
  manifest.directory_context = { ...marker, session_id: 'session-2026-11-09-12-00-00-aaaaaa' }; await save();
  expect(await observe()).toBe(null);
});
