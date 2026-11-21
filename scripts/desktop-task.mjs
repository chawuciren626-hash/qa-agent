/**
 * 桌面任务动作（desktop_task）的执行模块：结构快照 / 视觉兜底 / 锚点重放 的统一入口。
 *
 * 与 browser-task.mjs 的分工：browser-task 起独立 worker 进程（页面状态机复杂），
 * desktop-task 是**无状态单次操作**——每次调用要么快照、要么一个视觉动作、要么一段
 * 重放计划；桌面状态留在操作系统里，不留在进程里。幂等键是 request_id：同名回执已
 * 存在时原样返回（transport uncertainty 必须复用 request_id，与 browser/android 同契约）。
 *
 * 互斥：屏幕是独占资源，`execution/desktop.lock` 记 pid；宿主进程已退出才允许抢占。
 * 跨 run 的串行由 exec/pools.py 的 desktop_pool（容量 1）在计划层约束。
 *
 * 层次不变量（v2 方案 §3.5）：
 *   - snapshot / replay 走 Python 探针（零模型）；
 *   - visual 走 Midscene（视觉层），其产出在 desktop-visual.mjs 内部就降级为 UIA 锚点，
 *     这里只透传 receipt——坐标只存在于 receipt 与截图里，从不进 stage 产物。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonCandidates } from './command-runtime.mjs';
import { ownerHasExited } from './process-identity.mjs';
import { runVisualOperation, resolveVisualModelConfig, desktopVisualError } from './desktop-visual.mjs';

export const desktopOperations = Object.freeze(['doctor', 'snapshot', 'visual', 'replay']);
export const desktopVisualActions = Object.freeze(['locate', 'tap', 'input', 'act', 'assert', 'screenshot']);
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SNAPSHOT_FIELDS = ['window_hint', 'max_nodes', 'max_depth'];

const requireString = (value, label, { min = 0, max = 4000 } = {}) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${label} must be a string of length ${min}..${max}`);
  return value;
};
function fail(message) { throw new Error(message); }

export function validateDesktopOperation(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('operation must be an object');
  const operation = raw;
  requireString(operation.request_id, 'operation.request_id', { min: 1, max: 80 });
  if (!REQUEST_ID.test(operation.request_id)) fail('operation.request_id contains unsupported characters');
  // 坐标不进任何一层：操作顶层与 replay 计划步骤都拒绝（v2 §3.5.5 硬约束）。
  const coordinateKeys = value => value && typeof value === 'object' && !Array.isArray(value) && ['x', 'y', 'coordinates', 'point'].some(key => key in value);
  if (coordinateKeys(operation)) fail('operation carries coordinates: anchors only');
  if (!desktopOperations.includes(operation.type)) fail(`operation.type must be one of ${desktopOperations.join(', ')}`);
  const keys = Object.keys(operation);
  const allowed = ['type', 'request_id', 'run_id', 'action', 'target', 'text', 'instruction', 'expectation', 'plan', 'window_hint', 'max_nodes', 'max_depth'];
  const unknown = keys.filter(key => !allowed.includes(key));
  if (unknown.length) fail(`unknown operation fields: ${unknown.join(', ')}`);
  if (operation.type === 'visual') {
    if (!desktopVisualActions.includes(operation.action)) fail(`operation.action must be one of ${desktopVisualActions.join(', ')}`);
    if (['locate', 'tap', 'input'].includes(operation.action)) {
      requireString(operation.target, 'operation.target', { min: 1, max: 500 });
    }
    if (operation.action === 'input') requireString(operation.text, 'operation.text', { min: 1, max: 4000 });
    if (operation.action === 'act') requireString(operation.instruction, 'operation.instruction', { min: 1, max: 1000 });
    if (operation.action === 'assert') requireString(operation.expectation, 'operation.expectation', { min: 1, max: 1000 });
  }
  if (operation.type === 'replay') {
    const plan = operation.plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('operation.plan must be an object');
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail('operation.plan.steps must be a non-empty array');
    if (plan.steps.some(step => coordinateKeys(step))) fail('plan.steps carry coordinates: anchors only (visual output must degrade to structured anchors)');
  }
  if (operation.type === 'snapshot') {
    for (const key of Object.keys(operation)) if (!['type', 'request_id', 'run_id', ...SNAPSHOT_FIELDS].includes(key)) fail(`unknown snapshot field ${key}`);
    if (operation.window_hint !== undefined && (typeof operation.window_hint !== 'object' || Array.isArray(operation.window_hint))) fail('operation.window_hint must be an object');
  }
}

function receiptDirectory(dir) {
  return resolve(dir, 'execution', 'desktop-receipts');
}

function pythonInvoke(root, env, toolId, payload, timeoutMs = 30000) {
  const candidates = pythonCandidates(env, root);
  if (!candidates.length) throw new Error('No configured Python runtime for desktop probe');
  const packageRoot = resolve(root, 'aitestharness-tools');
  const bootstrap = `import sys,runpy; sys.path.insert(0,${JSON.stringify(packageRoot.replaceAll('\\', '/'))}); sys.argv=['aitestharness_tools.runtime_cli',${JSON.stringify(toolId)}]; runpy.run_module('aitestharness_tools.runtime_cli',run_name='__main__')`;
  const run = spawnSync(candidates[0], ['-c', bootstrap], {
    cwd: root, env: { ...env, PYTHONPATH: [packageRoot, env.PYTHONPATH].filter(Boolean).join(';'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
  });
  let response;
  try { response = JSON.parse(run.stdout); } catch { response = null; }
  if (run.status !== 0 || response?.ok !== true) {
    const message = response?.message ?? (run.error?.message ?? 'desktop python probe failed');
    const error = new Error(message);
    error.code = response?.error_code ?? 'DESKTOP_PROBE_FAILED';
    throw error;
  }
  return response.result;
}

/**
 * 桌面互斥锁。返回 release 函数。锁内容带 pid：宿主已退出才允许抢占——
 * "锁坏了就删"会让两个半死会话同时驱动一台屏幕。
 */
export function acquireDesktopLock(dir, request) {
  const path = resolve(dir, 'execution', 'desktop.lock');
  mkdirSync(resolve(dir, 'execution'), { recursive: true });
  if (existsSync(path)) {
    let held;
    try {
      held = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      // 锁文件损坏 = 状态不可信，如实失败（与"锁坏了就删"相比，宁可不跑）。
      throw new Error(`Desktop lock is unreadable (${error.message}); resolve it manually.`);
    }
    if (typeof held.pid === 'number' && !ownerHasExited(held.pid)) {
      const error = new Error(`Desktop is busy: request ${held.request_id ?? '?'} holds the screen lock (pid ${held.pid}).`);
      error.code = 'DESKTOP_LOCKED';
      throw error;
    }
    // 宿主已退出：旧锁已无主人，删除后接管。
    unlinkSync(path);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, request_id: request.request_id, type: request.type, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return () => {
    try {
      const held = JSON.parse(readFileSync(path, 'utf8'));
      if (held.pid === process.pid) unlinkSync(path);
    } catch { /* 下一个持有者按抢占规则处理 */ }
  };
}

function doctor(root, env) {
  const candidates = pythonCandidates(env, root);
  const pythonOk = candidates.length > 0;
  let uia = { ok: false, error: 'no_python_runtime' };
  if (pythonOk) {
    // 安装包内置 Python 可能是 isolated 模式（忽略 PYTHONPATH），与 stage-tool-runtime
    // 同一解法：受控启动代码显式把工具包加进 sys.path，而不是依赖环境变量。
    // 探测必须真的 import pywinauto——desktop_probe 的顶层 import 不含它，只 import
    // 模块会在"没装 pywinauto"的机器上给出假阳性。
    const packageRoot = resolve(root, 'aitestharness-tools');
    const probe = `import sys; sys.path.insert(0,${JSON.stringify(packageRoot.replaceAll('\\', '/'))}); import pywinauto; from aitestharness_tools.probe.desktop_probe import DesktopProbe; print("ok")`;
    const run = spawnSync(candidates[0], ['-c', probe], {
      cwd: root, env: { ...env, PYTHONUTF8: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    uia = run.status === 0 && run.stdout.trim() === 'ok' ? { ok: true } : { ok: false, error: (run.stderr || '').slice(0, 200) || 'probe import failed' };
  }
  let midscene = { ok: false, error: '' };
  let visualModel = { ok: false };
  // 同步 doctor：Midscene 探测改为检查包是否存在（能解析到 package.json 即视为已安装），
  // 运行期的真实加载失败由 visual 操作的 unavailable 回执如实报告。
  midscene = existsSync(resolve(root, 'node_modules', '@midscene', 'computer', 'package.json'))
    ? { ok: true } : { ok: false, error: '@midscene/computer not installed in engine root' };
  try {
    const config = resolveVisualModelConfig(root, env);
    visualModel = { ok: Boolean(config.modelName && config.baseUrl && (env.MIDSCENE_OPENAI_API_KEY || env.OPENAI_API_KEY)), source: config.source };
  } catch (error) {
    visualModel = { ok: false, error: error.message.slice(0, 200) };
  }
  return { python: { ok: pythonOk }, uia, midscene, visual_model: visualModel };
}

/**
 * 执行一个 desktop_task 操作。返回 {status, result} —— 与 android/miniprogram
 * 操作回执同构；status: ok | failed | unavailable。
 */
export async function runDesktopOperation({ root, dir, operation, env = process.env }) {
  validateDesktopOperation(operation);
  const receipts = receiptDirectory(dir);
  mkdirSync(receipts, { recursive: true });
  const receiptPath = resolve(receipts, `${operation.request_id}.json`);
  if (existsSync(receiptPath)) {
    // 幂等：transport uncertainty 必须复用 request_id；重复请求读回原回执。
    const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return { status: existing.ok ? 'ok' : existing.status ?? 'failed', result: existing, duplicate: true };
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const release = acquireDesktopLock(dir, operation);
  try {
    let result;
    if (operation.type === 'doctor') {
      result = { request_id: operation.request_id, type: 'doctor', ok: true, ...doctor(root, env) };
    } else if (operation.type === 'snapshot') {
      const snapshot = pythonInvoke(root, env, 'desktop.snapshot', {
        ...(operation.window_hint ? { window_hint: operation.window_hint } : {}),
        ...(operation.max_nodes ? { max_nodes: operation.max_nodes } : {}),
        ...(operation.max_depth ? { max_depth: operation.max_depth } : {}),
      }, 45000);
      result = { request_id: operation.request_id, type: 'snapshot', ok: true,
        element_count: snapshot.element_count, truncated: snapshot.truncated, source: snapshot.source,
        windows: snapshot.windows, elements: snapshot.elements };
    } else if (operation.type === 'visual') {
      const outcome = await runVisualOperation({ root, dir, operation: { ...operation, type: 'visual' }, env });
      // visual 的回执（含降级锚点与证据截图）由 desktop-visual.mjs 落盘，这里不再重复写。
      if (outcome.status === 'unavailable') return { status: 'unavailable', result: outcome.result };
      return { status: outcome.status, result: outcome.result };
    } else if (operation.type === 'replay') {
      const receipt = pythonInvoke(root, env, 'desktop.replay', { plan: operation.plan }, 120000);
      result = { request_id: operation.request_id, type: 'replay', ok: receipt.ok, steps: receipt.steps,
        step_count: receipt.step_count, started_at: receipt.started_at, finished_at: receipt.finished_at };
    } else {
      throw new Error(`unhandled desktop operation ${operation.type}`);
    }
    result.started_at = result.started_at ?? startedAt;
    result.duration_ms = result.duration_ms ?? Math.round(performance.now() - started);
    writeFileSync(receiptPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return { status: result.ok ? 'ok' : 'failed', result };
  } catch (error) {
    const locked = error.code === 'DESKTOP_LOCKED';
    const result = { request_id: operation.request_id, type: operation.type, ok: false,
      error: error.message.slice(0, 500), category: locked ? 'desktop_locked' : 'desktop_failed',
      started_at: startedAt, duration_ms: Math.round(performance.now() - started) };
    try { writeFileSync(receiptPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); } catch { /* 尽量落 */ }
    return { status: locked ? 'blocked' : 'failed', result };
  } finally {
    release();
  }
}

export { desktopVisualError };
