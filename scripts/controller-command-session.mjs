import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJson } from './orchestration-state.mjs';
import { assertParentSession } from './stage-evidence.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class ControllerGateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
function location(root, id) {
  if (!/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(id ?? '')) throw new Error('Valid controller session required');
  return resolve(root, 'output/controller-command-sessions', id, 'state.json');
}
export function readControllerSession(root, id) {
  const path = location(root, id);
  if (!existsSync(path)) return { status: 'not_started', session_id: id, sha256: null };
  const raw = readFileSync(path); const state = JSON.parse(raw);
  if (state.session_id !== id || !['ready', 'running', 'stopped'].includes(state.status) || !Array.isArray(state.events)) throw new Error('Invalid controller session state');
  return { ...state, sha256: digest(raw) };
}
function locked(root, id, operation) {
  const path = location(root, id); mkdirSync(resolve(path, '..'), { recursive: true });
  const lock = `${path}.lock`; writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  try { return operation(path); } finally { unlinkSync(lock); }
}
export async function withControllerSession(root, id, operation, { diagnostic = false, agentRoot } = {}) {
  assertParentSession(root, 'run-command-session', id, agentRoot);
  const token = randomUUID();
  const pausedDiagnostic = locked(root, id, path => {
    const state = readControllerSession(root, id);
    if (state.status === 'running') throw new ControllerGateError('Controller command is running or interrupted; inspect before recovery', 'session_running');
    if (state.status === 'stopped') {
      if (diagnostic) return true;
      throw new ControllerGateError('Controller session stopped; explicit review required before further commands', 'session_stopped');
    }
    delete state.sha256;
    Object.assign(state, { version: 1, status: 'running', token, owner_pid: process.pid, events: state.events ?? [] });
    state.events.push({ type: 'command_started', token, at: new Date().toISOString() }); writeJson(path, state); return false;
  });
  // Diagnostics may observe a stopped session, but never clear its original failure.
  if (pausedDiagnostic) return operation();
  let result; let failure; let caught;
  try {
    result = await operation();
    if ((result.exit_code !== undefined && result.exit_code !== 0) || !['completed', 'ready', 'help'].includes(result.status)) failure = { status: result.status, exit_code: result.exit_code ?? 2, evidence_dir: result.evidence_dir ?? null };
  } catch (error) { caught = error; failure = { status: 'input_or_runner_error', error: error.message }; }
  locked(root, id, path => {
    const state = readControllerSession(root, id);
    if (state.token !== token || state.status !== 'running') throw new Error('Controller session changed during command');
    delete state.sha256;
    state.status = failure ? 'stopped' : 'ready';
    state.events.push({ type: failure ? 'command_failed' : 'command_completed', token, at: new Date().toISOString(), ...(failure ? { failure } : {}) });
    if (failure) state.failure = failure;
    writeJson(path, state);
  });
  if (caught) throw caught;
  return result;
}
export function reviewControllerSession(root, id, options, agentRoot) {
  assertParentSession(root, 'run-command-session', id, agentRoot);
  for (const key of ['expected-sha256','actor','reason','approval-ref','evidence']) if (!options[key]?.trim()) throw new Error(`Review requires ${key}`);
  const base = realpathSync(resolve(root, 'output'));
  const evidence = realpathSync(resolve(root, options.evidence)); const rel = relative(base, evidence);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !statSync(evidence).isFile()) throw new Error('Review evidence must be an existing file inside project output');
  const bytes = readFileSync(evidence); if (!bytes.toString('utf8').trim()) throw new Error('Review evidence is empty');
  return locked(root, id, path => {
    const state = readControllerSession(root, id);
    if (state.status !== 'stopped' || state.sha256 !== options['expected-sha256']) throw new Error('Review requires stopped state and exact reviewed SHA256');
    delete state.sha256; state.status = 'ready';
    state.events.push({ type: 'review_accepted', at: new Date().toISOString(), ...options, evidence_sha256: digest(bytes), previous_failure: state.failure });
    delete state.failure; writeJson(path, state);
    return { status: 'ready', session_id: id, resumed_execution: false, sha256: digest(readFileSync(path)) };
  });
}
