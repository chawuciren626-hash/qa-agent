import { dataPath, directoryContext } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runManagedProcess } from './managed-process.mjs';
import { writeJson } from './orchestration-state.mjs';
import { runDirectory } from './design-quality.mjs';
import { CommandUsageError, validateCommandArguments } from './command-contracts.mjs';
import { handledExecutionCommand } from './execution-outcome.mjs';
import { applicationDataRoot, assertPlainPath } from './application-data.mjs';
import { resolveWslRuntime } from './wsl-automation.mjs';

function executable(path) {
  return existsSync(path) && statSync(path).isFile() && (process.platform !== 'win32' || /\.exe$/i.test(path));
}

export function pythonCandidates(env = process.env, engineRootOverride = null) {
  if (env.QA_PYTHON) {
    // 子任务可能继承宿主留下的旧 QA_PYTHON（例如已删除的 python311 路径）。
    // 这不应遮蔽安装布局中已验证的内置 Python；有效的显式配置仍保持最高优先级。
    if (!isAbsolute(env.QA_PYTHON) || !executable(env.QA_PYTHON)) return [];
    return [realpathSync(env.QA_PYTHON)];
  }
  // Packaged server code runs from dist/, so its module directory is not the
  // managed engine root. Callers with an explicit root must win over that
  // source-layout heuristic when resolving installation.json and qa runtime.
  const engineRoot = resolve(engineRootOverride || resolve(import.meta.dirname, '..'));
  const configuredFiles = [];
  // PenguinHarness 子任务有时只保留工作区上下文，没有继承 QA_APP_DATA_ROOT。
  // 安装布局本身已经声明了 Python 路径；读取它不会改变用户环境，也不会静默安装依赖。
  for (const installationPath of [resolve(engineRoot, 'installation.json'), resolve(engineRoot, '../../installation.json')]) {
    if (!existsSync(installationPath)) continue;
    try {
      const installation = JSON.parse(readFileSync(installationPath, 'utf8'));
      const candidate = installation?.paths?.python;
      if (typeof candidate === 'string' && candidate) {
        const absolute = isAbsolute(candidate) ? candidate : resolve(installationPath, '..', candidate);
        if (executable(absolute)) configuredFiles.push(absolute);
      }
      const qaData = installation?.paths?.qa_data;
      if (typeof qaData === 'string' && qaData) configuredFiles.push(resolve(dirname(installationPath), qaData, 'runtime', 'python.json'));
    } catch { /* malformed installation metadata falls through to PATH */ }
  }
  // 只有安装布局没有声明可用解释器时，才回退到用户级默认配置或 PATH。
  try { configuredFiles.push(assertPlainPath(resolve(applicationDataRoot(engineRoot,env),'runtime/python.json'))); } catch { /* 子任务环境可能没有继承 QA_APP_DATA_ROOT，继续使用 PATH。 */ }
  for (const local of [...new Set(configuredFiles)]) {
    if (executable(local)) return [realpathSync(local)];
    if (!existsSync(local)) continue;
    try {
      const config=JSON.parse(readFileSync(local,'utf8'));
      if(config.version===1 && isAbsolute(config.executable ?? '') && executable(config.executable)) return [realpathSync(config.executable)];
    } catch { /* invalid config falls through to the next candidate */ }
  }
  const paths = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  return [...new Set(paths.split(delimiter).filter(Boolean).flatMap(folder => names.map(name => resolve(folder.replace(/^"|"$/g, ''), name))).filter(executable).map(path => realpathSync(path)))];
}

export function probePython(env = process.env, run = spawnSync) {
  const attempts = [];
  for (const path of pythonCandidates(env)) {
    if (attempts.length >= 8) break;
    // Only the read-only dependency probe is retried, never an export or product operation.
    for(const timeout of [5000,15000]) {
      if(attempts.length>=8) break;
      const result = run(path, ['-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"; import tomllib; from docx import Document; import reportlab; print(sys.executable)'], { env, encoding: 'utf8', windowsHide: true, shell: false, timeout });
      attempts.push({ executable: path, code: result.status, error: result.error?.code ?? (result.status === 0 ? null : 'report_modules_unavailable') });
      if (result.status === 0 && !result.error) return { status: 'ready', executable: path, attempts };
      if(result.error?.code!=='ETIMEDOUT') break;
    }
  }
  return { status: 'not_ready', executable: null, attempts, reason: attempts.some(a=>a.error==='ETIMEDOUT')?'Python dependency probe timed out; availability unresolved, do not infer missing packages':env.QA_PYTHON ? 'Explicit QA_PYTHON is invalid or unusable; no silent fallback' : 'No configured/PATH Python 3.11+ with tomllib/python-docx/reportlab; use configure-python.mjs with a verified interpreter' };
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
  if (!['node', 'python'].includes(kind) || typeof name !== 'string' || basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !name.endsWith(kind === 'node' ? '.mjs' : '.py')) throw new CommandUsageError('Use a project script basename and matching runtime, not a shell command');
  if (name === 'project-command.mjs') throw new Error('Recursive command runner is not allowed');
  const scripts = realpathSync(resolve(root, 'scripts'));
  let target;
  try { target = realpathSync(resolve(scripts, name)); }
  catch (error) {
    if (error.code === 'ENOENT') throw new CommandUsageError(`Script not found: ${name}; no process started. read_source is a structured action, not a script. Use project-action.mjs catalog and execute --request=<JSON-file>; do not invent script names.`);
    throw error;
  }
  if (resolve(target, '..') !== scripts || !statSync(target).isFile()) throw new Error('Script must be a regular file directly inside project scripts');
  return target;
}

export async function runProjectCommand(root, { kind, script, args = [], runId, timeoutMs = 120000, env = process.env, signal }) {
  const context=directoryContext(root);
  if (env.QA_DIRECTORY_CONTEXT && directoryContext(root,env).session_root!==context.session_root) throw new Error('Child command directory context differs from parent');
  if (context.mode==='isolated') env={...env,QA_DIRECTORY_CONTEXT:JSON.stringify(context)};
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Timeout must be 100..1800000 milliseconds');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be strings');
  validateCommandArguments(script, args, runId);
  let sandboxedDocument = false;
  if (kind === 'python' && script === 'extract-word-input.py' && process.platform === 'win32' && context.mode === 'isolated') {
    try { sandboxedDocument = existsSync(resolve(resolveWslRuntime(root, env).dataDir, 'state.json')); }
    catch { /* Preserve the local parser on hosts without a managed WSL distro. */ }
  }
  const target = sandboxedDocument ? scriptTarget(root, 'node', 'extract-word-sandbox.mjs') : scriptTarget(root, kind, script);
  let runtime = process.execPath;
  if (kind === 'python' && !sandboxedDocument) {
    env = { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const python = probePython(env);
    if (python.status !== 'ready') throw new Error(python.reason);
    runtime = python.executable;
  }
  const base = runId ? resolve(runDirectory(root, runId), 'audit/commands') : dataPath(root, 'output/command-runs');
  if (runId && !existsSync(resolve(runDirectory(root, runId), 'manifest.json'))) throw new Error('Run manifest missing');
  const id = randomUUID(); const dir = resolve(base, id); mkdirSync(dir, { recursive: true });
  env = { ...env }; delete env.QA_EXECUTION_COMMAND_ID;
  delete env.QA_TASK_COMMAND_ID;
  if(kind==='node' && ['explore-task-url.mjs','browser-task.mjs'].includes(script)) env.QA_TASK_COMMAND_ID=id;
  const executionRun = kind === 'node' && script === 'run-ui-tests.mjs' ? args.find(arg => arg.startsWith('--run-id='))?.slice(9) : null;
  if (executionRun) env.QA_EXECUTION_COMMAND_ID = id;
  const recordPath = resolve(dir, 'command.json');
  const record = { version: 1, command_id: id, run_id: runId ?? null, runtime, script, ...(sandboxedDocument ? { sandbox_backend: 'wsl' } : {}), argument_count: args.length, shell: false, timeout_ms: timeoutMs, started_at: new Date().toISOString(), status: 'running', owner_pid: process.pid, child_pid: null };
  if(/^session-[0-9-]+[a-f0-9]+$/.test(env.PENGUIN_SESSION_ID ?? '') && /^[A-Za-z0-9_-]{1,160}$/.test(env.QA_HOST_TOOL_CALL_ID ?? '')) record.host_binding={session_id:env.PENGUIN_SESSION_ID,tool_call_id:env.QA_HOST_TOOL_CALL_ID};
  writeJson(recordPath, record);
  const result = await runManagedProcess({ command: runtime, args: [target, ...args], cwd: root, env, timeoutMs, logPath: resolve(dir, 'command.log'), signal, onSpawn: pid => { record.child_pid = pid; writeJson(recordPath, record); } });
  record.status = !result.termination_confirmed ? 'cleanup_required' : result.termination ?? (result.error ? 'launch_failed' : result.code === 0 ? 'completed' : 'failed');
  const outcome = executionRun ? handledExecutionCommand(root, executionRun, id, result) : null;
  if (outcome) {
    record.status = 'completed';
    record.execution_outcome = outcome;
    record.process_exit_code = result.code;
    record.next_action = outcome.disposition === 'report_only' ? 'report_blocked_execution_without_retry' : 'analyze_execution_results';
  }
  record.finished_at = new Date().toISOString(); Object.assign(record, { result, next_action: record.next_action ?? (record.status === 'completed' ? 'inspect_result' : 'stop_and_request_review'), automatic_retries: 0 }); writeJson(recordPath, record);
  const log = readFileSync(resolve(dir, 'command.log'));
  return { ...record, evidence_dir: dir, exit_code: record.status === 'completed' ? 0 : result.termination === 'timeout' ? 124 : result.termination === 'interrupted' ? 130 : Number.isInteger(result.code) && result.code !== 0 ? result.code : 2, output_tail: log.subarray(Math.max(0, log.length - 16000)).toString('utf8') };
}
