import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runManagedProcess } from './managed-process.mjs';
import { writeJson } from './orchestration-state.mjs';
import { runDirectory } from './design-quality.mjs';
import { validateCommandArguments } from './command-contracts.mjs';

function executable(path) {
  return existsSync(path) && statSync(path).isFile() && (process.platform !== 'win32' || /\.exe$/i.test(path));
}

export function pythonCandidates(env = process.env) {
  if (env.QA_PYTHON) {
    if (!isAbsolute(env.QA_PYTHON) || !executable(env.QA_PYTHON)) return [];
    return [realpathSync(env.QA_PYTHON)];
  }
  const paths = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  return [...new Set(paths.split(delimiter).filter(Boolean).flatMap(folder => names.map(name => resolve(folder.replace(/^"|"$/g, ''), name))).filter(executable).map(path => realpathSync(path)))];
}

export function probePython(env = process.env) {
  const attempts = [];
  for (const path of pythonCandidates(env)) {
    if (attempts.length >= 8) break;
    const result = spawnSync(path, ['-c', 'import sys; from docx import Document; import reportlab; print(sys.executable)'], { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 });
    attempts.push({ executable: path, code: result.status, error: result.error?.code ?? (result.status === 0 ? null : 'report_modules_unavailable') });
    if (result.status === 0 && !result.error) return { status: 'ready', executable: path, attempts };
  }
  return { status: 'not_ready', executable: null, attempts, reason: env.QA_PYTHON ? 'Explicit QA_PYTHON is invalid or unusable; no silent fallback' : 'No native Python with python-docx/reportlab found on PATH' };
}

export function inspectRuntime(root, env = process.env) {
  const require = createRequire(resolve(root, 'package.json'));
  const packages = ['@playwright/test', 'xlsx', 'xmind'].map(name => {
    try { return { name, status: 'ready', entry: require.resolve(name) }; }
    catch { return { name, status: 'missing' }; }
  });
  const python = probePython(env);
  return { version: 1, checked_at: new Date().toISOString(), status: packages.every(item => item.status === 'ready') && python.status === 'ready' ? 'ready' : 'not_ready', node: { executable: process.execPath, version: process.version }, python, packages, inherited_shell: env.SHELL ?? null, shell_used_for_children: false, browser_started: false, install_performed: false, scope: 'command_and_report_runtime_only_not_execution_authorization' };
}

export function scriptTarget(root, kind, name) {
  if (!['node', 'python'].includes(kind) || typeof name !== 'string' || basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !name.endsWith(kind === 'node' ? '.mjs' : '.py')) throw new Error('Use a project script basename and matching runtime, not a shell command');
  if (name === 'project-command.mjs') throw new Error('Recursive command runner is not allowed');
  const scripts = realpathSync(resolve(root, 'scripts'));
  const target = realpathSync(resolve(scripts, name));
  if (resolve(target, '..') !== scripts || !statSync(target).isFile()) throw new Error('Script must be a regular file directly inside project scripts');
  return target;
}

export async function runProjectCommand(root, { kind, script, args = [], runId, timeoutMs = 120000, env = process.env, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Timeout must be 100..1800000 milliseconds');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be strings');
  validateCommandArguments(script, args, runId);
  const target = scriptTarget(root, kind, script);
  let runtime = process.execPath;
  if (kind === 'python') {
    const python = probePython(env);
    if (python.status !== 'ready') throw new Error(python.reason);
    runtime = python.executable;
  }
  const base = runId ? resolve(runDirectory(root, runId), 'audit/commands') : resolve(root, 'output/command-runs');
  if (runId && !existsSync(resolve(runDirectory(root, runId), 'manifest.json'))) throw new Error('Run manifest missing');
  const id = randomUUID(); const dir = resolve(base, id); mkdirSync(dir, { recursive: true });
  const recordPath = resolve(dir, 'command.json');
  const record = { version: 1, command_id: id, run_id: runId ?? null, runtime, script, argument_count: args.length, shell: false, timeout_ms: timeoutMs, started_at: new Date().toISOString(), status: 'running', owner_pid: process.pid, child_pid: null };
  writeJson(recordPath, record);
  const result = await runManagedProcess({ command: runtime, args: [target, ...args], cwd: root, env, timeoutMs, logPath: resolve(dir, 'command.log'), signal, onSpawn: pid => { record.child_pid = pid; writeJson(recordPath, record); } });
  record.status = !result.termination_confirmed ? 'cleanup_required' : result.termination ?? (result.error ? 'launch_failed' : result.code === 0 ? 'completed' : 'failed');
  record.finished_at = new Date().toISOString(); Object.assign(record, { result, next_action: record.status === 'completed' ? 'inspect_result' : 'stop_and_request_review', automatic_retries: 0 }); writeJson(recordPath, record);
  const log = readFileSync(resolve(dir, 'command.log'));
  return { ...record, evidence_dir: dir, exit_code: record.status === 'completed' ? 0 : result.termination === 'timeout' ? 124 : result.termination === 'interrupted' ? 130 : Number.isInteger(result.code) && result.code !== 0 ? result.code : 2, output_tail: log.subarray(Math.max(0, log.length - 16000)).toString('utf8') };
}
