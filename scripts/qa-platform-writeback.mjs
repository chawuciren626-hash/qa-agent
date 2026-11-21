// 平台任务分析回写（engine → platform server）：把总控预分析的结构化结论 POST 回
// /qa/platform-tasks/<task_id>/analysis-result 端点，由服务端归一后回填 ai_summary_json。
// 通信先例：Bearer 本地 api-token（sync-controller-tool-interface.mjs / product-doctor.mjs）；
// server 地址优先 PENGUIN_API_URL（agent 子进程 controlEnv 注入），缺省回退读
// <PENGUIN_HOME|~/.penguin/data>/server.lock 的端口。本模块不发命令、不改 run 工作区。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SUMMARY_ARRAY_LIMIT = 20;
const SUMMARY_ITEM_LIMIT = 500;
const PRIORITY_VALUES = ['high', 'medium', 'low'];

function hostDataDir(explicit) {
  return resolve(explicit ?? process.env.PENGUIN_HOME ?? resolve(homedir(), '.penguin', 'data'));
}

function serverLockBaseUrl(explicit) {
  const lockPath = resolve(hostDataDir(explicit), 'server.lock');
  if (!existsSync(lockPath)) throw new Error('server.lock not found: set PENGUIN_API_URL, or run inside the product');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!Number.isSafeInteger(lock.port) || lock.port < 1 || lock.port > 65535) throw new Error('invalid server.lock port');
  return `http://localhost:${lock.port}`;
}

function readTokenFile(explicit) {
  const tokenPath = resolve(hostDataDir(explicit), 'api-token');
  if (!existsSync(tokenPath)) throw new Error('api-token not found: set PENGUIN_API_TOKEN or run inside the product');
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error('invalid api-token format');
  return token;
}

/** 解析 server 地址与 Bearer 凭据：显式参数 > env（PENGUIN_API_URL/PENGUIN_API_TOKEN）> host_data 文件。 */
export function resolvePlatformEndpoint({ baseUrl, token, hostData } = {}) {
  const base = baseUrl ?? process.env.PENGUIN_API_URL ?? serverLockBaseUrl(hostData);
  const bearer = token ?? process.env.PENGUIN_API_TOKEN ?? readTokenFile(hostData);
  return { baseUrl: base.replace(/\/+$/, ''), token: bearer };
}

/** 校验 task_ref（简报原样携带）：kind=platform|local、task_id/project_id 非空字符串；非法返回错误文案。 */
export function validatePlatformTaskRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'task_ref must be an object copied verbatim from the task briefing';
  if (value.kind !== 'platform' && value.kind !== 'local') return 'task_ref.kind must be "platform" or "local"';
  for (const key of ['task_id', 'project_id']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) return `task_ref.${key} must be a non-empty string from the task briefing`;
    if (value[key].length > 200) return `task_ref.${key} exceeds 200 characters`;
  }
  return null;
}

/** 校验回写 summary：需求要点与建议范围不能同时为空；非法返回错误文案。 */
export function validatePlatformSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'summary must be an object with the structured pre-analysis result';
  const arr = v => Array.isArray(v) && v.every(x => typeof x === 'string');
  for (const key of ['requirement_points', 'suggested_test_scope', 'risks', 'open_questions']) {
    if (value[key] !== undefined && !arr(value[key])) return `summary.${key} must be an array of strings when present`;
    if (Array.isArray(value[key]) && value[key].length > SUMMARY_ARRAY_LIMIT) return `summary.${key} accepts at most ${SUMMARY_ARRAY_LIMIT} items`;
  }
  if ((!Array.isArray(value.requirement_points) || value.requirement_points.length === 0)
    && (!Array.isArray(value.suggested_test_scope) || value.suggested_test_scope.length === 0)) {
    return 'summary requires non-empty requirement_points or suggested_test_scope';
  }
  if (value.suggested_priority !== undefined && !PRIORITY_VALUES.includes(value.suggested_priority)) {
    return 'summary.suggested_priority must be high, medium or low';
  }
  if (value.priority_reason !== undefined && (typeof value.priority_reason !== 'string' || value.priority_reason.length > 1000)) {
    return 'summary.priority_reason must be a string of at most 1000 characters';
  }
  return null;
}

/**
 * 回写平台任务预分析结果。
 * @param {object} args
 * @param {{kind:'platform'|'local', task_id:string, project_id:string}} args.taskRef 简报原样携带的任务引用
 * @param {object} args.summary 结构化分析结论（validatePlatformSummary 通过的形状）
 * @param {string} [args.runId] 本次预分析 run_id（服务端记录追溯）
 * @param {string} [args.baseUrl] 覆盖 server 地址（缺省 env → server.lock）
 * @param {string} [args.token] 覆盖 Bearer token（缺省 env → api-token 文件）
 * @param {string} [args.hostData] 覆盖 host_data 目录（server.lock/api-token 发现）
 * @param {typeof fetch} [args.fetchImpl] 测试注入
 * @returns {Promise<{ok:boolean, status:number, code?:string, message?:string, updated?:boolean}>}
 */
export async function writebackPlatformTaskAnalysis({ taskRef, summary, runId, baseUrl, token, hostData, fetchImpl = fetch } = {}) {
  const invalidRef = validatePlatformTaskRef(taskRef);
  if (invalidRef) return { ok: false, status: 0, code: 'invalid_task_ref', message: invalidRef };
  const projectId = taskRef.project_id.trim() || process.env.PENGUIN_PROJECT_ID || '';
  if (!projectId) return { ok: false, status: 0, code: 'missing_project', message: 'project_id missing: neither task_ref.project_id nor PENGUIN_PROJECT_ID is set' };
  let endpoint;
  try {
    endpoint = resolvePlatformEndpoint({ baseUrl, token, hostData });
  } catch (error) {
    return { ok: false, status: 0, code: 'endpoint_unavailable', message: error.message };
  }
  const url = `${endpoint.baseUrl}/api/projects/${encodeURIComponent(projectId)}/agents/qa/platform-tasks/${encodeURIComponent(taskRef.task_id.trim())}/analysis-result`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary, ...(runId ? { run_id: runId } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, status: 0, code: 'network_error', message: `回写请求失败：${error?.message ?? error}` };
  }
  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON 响应按状态码处理 */ }
  if (!response.ok) {
    return { ok: false, status: response.status, code: typeof body?.code === 'string' ? body.code : `http_${response.status}`, message: typeof body?.message === 'string' ? body.message : `服务端拒绝回写（HTTP ${response.status}）` };
  }
  return { ok: true, status: response.status, updated: !!body?.updated };
}
