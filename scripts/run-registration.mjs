/**
 * 运行发起/结束登记（P4 判据 1 收口）：引擎侧经平台 api-token 通道把 startRun/finishRun
 * 写进 qa_runs，让"执行器没起来、起来就退、跑到一半死"在数据库层可见——不再只有
 * dispatch.json 辅助证据与 trace 文件读模型。
 *
 * 通道先例：qa-platform-writeback.mjs（Bearer api-token + server.lock 端口发现）——
 * 鉴权中间件把本机 api-token 认作 admin，引擎子进程因此不需要新的凭据设计。
 *
 * 语义（对齐 P4 第五切片）：
 *   - 发起即 running：startRun 在执行命令被调用的那一刻登记（manifest 已存在的前提下，
 *     与 dispatch.json 同一判据——没有 manifest 的只是拼错参数，不是一次运行）；
 *   - 结束交回 manifest 事实：finishRun 的 facts/sha 全部来自执行器写下的 manifest.json，
 *     不自造结论；counts 缺省不传（统计由既有批次/报告路径回填）；
 *   - 中断不补结论：执行抛错时 finishRun 不会被调用，run 停在 running 由 stalled 判定；
 *   - 幂等：重复发起得 409（run_exists）按已登记处理——重试执行不是新的一次发起。
 *
 * 纪律：登记失败不拦执行。登记是判据 1 的事实通道，不是闸门；失败降级为 stderr 一行，
 * 执行照常，dispatch.json 辅助证据仍会落盘。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolvePlatformEndpoint } from './qa-platform-writeback.mjs';

const RUN_ID = /^run-[A-Za-z0-9-]+$/;

/** manifest.json → 服务端 RunManifestFacts 口径（与 qa-task-run-registry.readRunFacts 对齐）。 */
export function manifestFacts(manifestPath) {
  const root = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = root.orchestration?.plan ?? {};
  const branches = Array.isArray(plan.execution_branches) ? plan.execution_branches.filter(item => typeof item === 'string') : [];
  const platform = typeof plan.execution_platform === 'string' && plan.execution_platform.trim() ? plan.execution_platform.trim() : null;
  const pool = branches.includes('api_execution') ? 'api' : platform;
  const str = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const baseline = root.baseline ?? root.orchestration?.baseline ?? {};
  return {
    runId: String(root.run_id ?? ''),
    manifestVersion: Number.isInteger(root.manifest_version) ? Number(root.manifest_version) : null,
    status: str(root.status) ?? 'unknown',
    resourcePool: pool !== null && ['web', 'api', 'android', 'miniprogram', 'desktop'].includes(pool) ? pool : null,
    sutVersion: str(root.sut_version) ?? str(plan.sut_version),
    baselineHash: str(root.baseline_hash) ?? str(baseline.content_hash),
  };
}

function manifestSha256(manifestPath) {
  return createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
}

async function post(endpoint, path, payload) {
  const { baseUrl, token } = endpoint;
  const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(endpoint.projectId)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (response.status === 409) return { ok: true, conflict: true, status: 409, body: await response.json().catch(() => null) };
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return { ok: false, status: response.status, error: `HTTP ${response.status}: ${detail}` };
  }
  return { ok: true, status: response.status, body: await response.json().catch(() => null) };
}

/**
 * 发起登记。projectId/sessionId 缺省取 QA_DIRECTORY_CONTEXT（会话工作区绑定注入）。
 * 重复发起（409 run_exists）视为已登记——重试执行不是新的一次发起。
 */
export async function startRun({ projectId, sessionId, runId, env, kind, resourcePool, dispatch } = {}, endpoint = {}) {
  try {
    const resolved = resolvePlatformEndpoint(endpoint);
    const targetProject = projectId ?? resolved.projectId;
    const targetSession = sessionId ?? resolved.sessionId;
    if (!targetProject || !targetSession) return { ok: false, error: 'run registration needs projectId/sessionId (QA_DIRECTORY_CONTEXT or explicit)' };
    if (!RUN_ID.test(String(runId ?? ''))) return { ok: false, error: `invalid run_id: ${runId}` };
    const result = await post({ ...resolved, projectId: targetProject },
      `/qa/task-records/${encodeURIComponent(targetSession)}/runs`,
      { runId, ...(env ? { env } : {}), ...(kind ? { kind } : {}), ...(resourcePool ? { resourcePool } : {}), dispatch: dispatch ?? {} });
    return { ok: result.ok, conflict: result.conflict === true, run: result.body?.run ?? null, error: result.error };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 结束登记：facts/sha 读执行器写下的 manifest.json，不自造结论。
 * run 尚未登记（发起登记失败过的）时 finish 得 404——如实返回，不伪造。
 */
export async function finishRun({ projectId, sessionId, runId, manifestPath, counts } = {}, endpoint = {}) {
  try {
    const resolved = resolvePlatformEndpoint(endpoint);
    const targetProject = projectId ?? resolved.projectId;
    if (!targetProject || !sessionId) return { ok: false, error: 'run registration needs projectId/sessionId (QA_DIRECTORY_CONTEXT or explicit)' };
    if (!RUN_ID.test(String(runId ?? ''))) return { ok: false, error: `invalid run_id: ${runId}` };
    const facts = manifestFacts(manifestPath);
    if (facts.runId !== runId) return { ok: false, error: `manifest reports ${facts.runId}, not ${runId}` };
    const result = await post({ ...resolved, projectId: targetProject },
      `/qa/task-records/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/finish`,
      { facts, manifestPath: manifestPath.replaceAll('\\', '/'), manifestSha256: manifestSha256(manifestPath), ...(counts ? { counts } : {}) });
    return { ok: result.ok, conflict: result.conflict === true, run: result.body?.run ?? null, error: result.error };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 会话绑定的登记上下文（projectId/sessionId 来自 QA_DIRECTORY_CONTEXT）。 */
export function registrationContext(directoryContext) {
  return { projectId: directoryContext?.project_id ?? null, sessionId: directoryContext?.session_id ?? null };
}
