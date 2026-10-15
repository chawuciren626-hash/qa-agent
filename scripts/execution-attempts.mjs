import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runDirectory } from './design-quality.mjs';
import { dataPath } from './directory-context.mjs';

const now = () => new Date().toISOString();
const hash = data => createHash('sha256').update(data).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const inside = (base, path) => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
export function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}
export function attemptDirectory(root, runId, invocationId) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(invocationId ?? '')) throw new Error('Invalid invocation_id');
  return resolve(runDirectory(root, runId), 'execution/attempts', invocationId);
}
function safeExecution(root, runId) {
  const dir = resolve(runDirectory(root, runId), 'execution');
  mkdirSync(dir, { recursive: true });
  if (!inside(realpathSync(dataPath(root)), realpathSync(dir))) throw new Error('Execution directory outside workspace');
  for (let path = dir; path !== dataPath(root); path = dirname(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symlink in execution directory');
  }
  return dir;
}
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function snapshotTree(source, target) {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Cannot archive a symlink');
  if (stat.isDirectory()) {
    for (const name of readdirSync(source)) snapshotTree(resolve(source, name), resolve(target, name));
  } else if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, 1);
  }
}
function inventory(dir) {
  const files = [];
  function walk(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Symlink in attempt evidence');
      const file = resolve(path, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && file !== resolve(dir, 'attempt.json')) {
        const data = readFileSync(file);
        files.push({ path: relative(dir, file).replaceAll('\\', '/'), size: data.length, sha256: hash(data) });
      }
    }
  }
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function beginAttempt(root, runId) {
  const output = safeExecution(root, runId);
  const invocationId = randomUUID();
  const dir = attemptDirectory(root, runId, invocationId);
  const lockPath = resolve(output, 'execution.lock.json');
  const lock = { version: 1, run_id: runId, invocation_id: invocationId, host: hostname(), owner_pid: process.pid, started_at: now(), children: [] };
  try { writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Execution lock exists; inspect the active attempt or explicitly recover it. No automatic takeover.'); throw error; }
  const context = { root, runId, invocationId, dir, output, lockPath, lock, startedAt: lock.started_at };
  // Capture previous compatibility views before touching the latest-state pointer.
  try {
    const attempts = resolve(output, 'attempts');
    mkdirSync(attempts, { recursive: true });
    if (lstatSync(attempts).isSymbolicLink()) throw new Error('Symlink attempt directory');
    mkdirSync(dir);
    for (const file of ['execution-state.json', 'test_results.json', 'execution-blocked.json']) snapshotTree(resolve(output, file), resolve(dir, 'previous/execution', file));
    for (const folder of ['quality', 'defects', 'report']) snapshotTree(resolve(runDirectory(root, runId), folder), resolve(dir, 'previous', folder));
    const plan = resolve(output, 'execution-plan.json');
    snapshotTree(plan, resolve(dir, 'inputs/execution-plan.json'));
    attemptEvent(context, 'created');
    updateAttempt(context, 'preparing');
    return context;
  } catch (error) {
    // Leave the owned lock and any partial archive for explicit recovery.
    atomicJson(resolve(output, 'execution-state.json'), { version: 2, run_id: runId, invocation_id: invocationId, attempt_dir: `execution/attempts/${invocationId}`, status: 'blocked', phase: 'initialization_failed', updated_at: now(), block_reason: error.message });
    throw new Error(`Attempt initialization failed; preserved lock ${invocationId}: ${error.message}`);
  }
}
export function assertAttemptOwner(context) {
  const lock = read(context.lockPath);
  if (lock.invocation_id !== context.invocationId || lock.owner_pid !== process.pid) throw new Error('Attempt lock ownership lost');
  if (existsSync(resolve(context.dir, 'attempt.json'))) throw new Error('Attempt already sealed');
}
export function attemptEvent(context, type, details = {}) {
  assertAttemptOwner(context);
  appendFileSync(resolve(context.dir, 'events.jsonl'), JSON.stringify({ at: now(), type, ...details }) + '\n');
}
export function updateAttempt(context, phase, details = {}) {
  assertAttemptOwner(context);
  const state = { version: 2, run_id: context.runId, invocation_id: context.invocationId, attempt_dir: `execution/attempts/${context.invocationId}`, status: 'running', phase, started_at: context.startedAt, updated_at: now(), ...details };
  atomicJson(resolve(context.dir, 'state.json'), state);
  atomicJson(resolve(context.output, 'execution-state.json'), state);
  return state;
}
export function trackAttemptProcess(context, pid, phase) {
  assertAttemptOwner(context);
  context.lock.children.push({ pid, phase });
  atomicJson(context.lockPath, context.lock);
  attemptEvent(context, 'process_started', { pid, phase });
}
export function stopTrackingProcess(context, pid) {
  assertAttemptOwner(context);
  context.lock.children = context.lock.children.filter(child => child.pid !== pid);
  atomicJson(context.lockPath, context.lock);
}
export function finishAttempt(context, { status, result, reason = '', details = {}, release = true }) {
  assertAttemptOwner(context);
  if (!['completed', 'failed', 'blocked', 'interrupted'].includes(status)) throw new Error('Invalid terminal attempt status');
  if (result.run_id !== context.runId || result.invocation_id !== context.invocationId) throw new Error('Result does not belong to attempt');
  atomicJson(resolve(context.dir, 'test_results.json'), result);
  attemptEvent(context, 'finished', { status, reason });
  const state = { version: 2, run_id: context.runId, invocation_id: context.invocationId, attempt_dir: `execution/attempts/${context.invocationId}`, status: ['completed', 'failed'].includes(status) ? status : 'blocked', attempt_status: status, phase: 'finished', started_at: context.startedAt, updated_at: now(), block_reason: reason, ...details };
  atomicJson(resolve(context.dir, 'state.json'), state);
  const manifest = { version: 1, run_id: context.runId, invocation_id: context.invocationId, status, reason, started_at: context.startedAt, finished_at: now(), duration_ms: Date.now() - Date.parse(context.startedAt), files: inventory(context.dir), ...details };
  writeFileSync(resolve(context.dir, 'attempt.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  // A crash between these writes leaves the latest pointer non-reportable, never old success.
  if (['completed', 'failed'].includes(status)) atomicJson(resolve(context.output, 'test_results.json'), result);
  else {
    atomicJson(resolve(context.output, 'execution-blocked.json'), result);
    if (!existsSync(resolve(context.output, 'test_results.json'))) atomicJson(resolve(context.output, 'test_results.json'), result);
  }
  atomicJson(resolve(context.output, 'execution-state.json'), state);
  if (release) unlinkSync(context.lockPath);
  return manifest;
}
export function blockedResult(context, reason) {
  return { run_id: context.runId, invocation_id: context.invocationId, status: 'blocked', started_at: context.startedAt, finished_at: now(), block_reason: reason, summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 }, cases: [], asset_refs: [] };
}
export function verifyAttempt(root, runId, invocationId) {
  const dir = attemptDirectory(root, runId, invocationId);
  if (lstatSync(dir).isSymbolicLink() || lstatSync(dirname(dir)).isSymbolicLink() || !inside(realpathSync(runDirectory(root, runId)), realpathSync(dir))) throw new Error('Attempt directory is outside run or a symlink');
  const manifest = read(resolve(dir, 'attempt.json'));
  if (manifest.run_id !== runId || manifest.invocation_id !== invocationId || manifest.version !== 1) throw new Error('Attempt identity mismatch');
  if (!isDeepStrictEqual(manifest.files, inventory(dir))) throw new Error('Attempt archive changed or is incomplete');
  return manifest;
}
export function loadLatestExecution(root, runId) {
  const output = resolve(runDirectory(root, runId), 'execution');
  const statePath = resolve(output, 'execution-state.json');
  const state = existsSync(statePath) ? read(statePath) : null;
  if (state?.version !== 2) return { state, results: read(resolve(output, 'test_results.json')) };
  verifyAttempt(root, runId, state.invocation_id);
  const dir = attemptDirectory(root, runId, state.invocation_id);
  if (!isDeepStrictEqual(state, read(resolve(dir, 'state.json')))) throw new Error('Latest state differs from sealed attempt');
  const results = read(resolve(dir, 'test_results.json'));
  if (state.status !== results.status) throw new Error('Latest result status differs from state');
  if (['completed', 'failed'].includes(state.status) && !isDeepStrictEqual(results, read(resolve(output, 'test_results.json')))) throw new Error('Current results differ from sealed attempt');
  return { state, results };
}
export function verifyCurrentAttempt(root, runId, state, result) {
  if (state?.version !== 2) return null;
  const manifest = verifyAttempt(root, runId, state.invocation_id);
  const dir = attemptDirectory(root, runId, state.invocation_id);
  const archived = read(resolve(dir, 'test_results.json'));
  const storedState = read(resolve(dir, 'state.json'));
  if (!isDeepStrictEqual(result, archived) || !isDeepStrictEqual(state, storedState) || !['completed', 'failed'].includes(manifest.status)) throw new Error('Current results differ from sealed attempt');
  return manifest;
}

export function recoverAttempt(root, runId, reason, confirmedStopped = false) {
  if (!confirmedStopped || !reason?.trim()) throw new Error('Recovery requires --confirm-stopped and a reason after checking descendant processes');
  const output = safeExecution(root, runId);
  const lockPath = resolve(output, 'execution.lock.json');
  const guard = resolve(output, 'recovery.lock');
  writeFileSync(guard, String(process.pid), { flag: 'wx' });
  try {
    const lock = read(lockPath);
    if (lock.run_id !== runId || !Array.isArray(lock.children)) throw new Error('Invalid recovery lock');
    if (lock.host !== hostname() || processAlive(lock.owner_pid) || lock.children.some(child => processAlive(child.pid))) throw new Error('Owner/child still alive or host differs; refuse recovery');
    const dir = attemptDirectory(root, runId, lock.invocation_id);
    if (existsSync(resolve(dir, 'attempt.json'))) {
      const manifest = verifyAttempt(root, runId, lock.invocation_id);
      // Only restore views that were already sealed; never infer success from a raw report.
      const result = read(resolve(dir, 'test_results.json'));
      const state = read(resolve(dir, 'state.json'));
      if (['completed', 'failed'].includes(manifest.status)) atomicJson(resolve(output, 'test_results.json'), result);
      else atomicJson(resolve(output, 'execution-blocked.json'), result);
      atomicJson(resolve(output, 'execution-state.json'), state);
    } else {
      mkdirSync(dir, { recursive: true });
      lock.owner_pid = process.pid;
      atomicJson(lockPath, lock);
      const context = { root, runId, invocationId: lock.invocation_id, dir, output, lockPath, lock, startedAt: lock.started_at };
      const message = `Explicit recovery: ${reason}`;
      finishAttempt(context, { status: 'interrupted', result: blockedResult(context, message), reason: message, release: false });
    }
    appendFileSync(resolve(output, 'recovery-events.jsonl'), JSON.stringify({ at: now(), invocation_id: lock.invocation_id, reason }) + '\n');
    unlinkSync(lockPath);
    return { run_id: runId, invocation_id: lock.invocation_id, status: 'recovered_without_execution' };
  } finally { unlinkSync(guard); }
}
