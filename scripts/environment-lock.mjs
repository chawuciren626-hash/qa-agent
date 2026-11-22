import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { dataPath, directoryContext } from './directory-context.mjs';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 环境锁目录：锁挂在“环境”而不是“任务”上，因此必须落在任务目录之外。
 * 隔离模式落在项目级 data root，同项目跨任务共享；安装模式落在当前数据根。
 */
export function environmentLockDir(root) {
  const dataRoot = process.env.QA_APP_DATA_ROOT;
  const context = directoryContext(root);
  if (context.mode === 'isolated' && dataRoot && /^[A-Za-z0-9_-]+$/.test(context.project_id ?? '')) {
    return resolve(dataRoot, 'projects', context.project_id, 'locks', 'environments');
  }
  return dataPath(root, 'locks', 'environments');
}

export function environmentLockPath(root, environmentId) {
  const key = String(environmentId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'environment';
  return resolve(environmentLockDir(root), `${key}.lock`);
}

function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function processAlive(pid, host) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (host && host !== hostname()) return true; // 跨主机只能靠 TTL 判定，保守视为存活
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stale(lock, ttlMs) {
  if (!lock) return true;
  if (!processAlive(lock.pid, lock.host)) return true;
  const acquiredAt = Date.parse(lock.acquired_at ?? '');
  return !Number.isFinite(acquiredAt) || Date.now() - acquiredAt > (lock.ttl_ms ?? ttlMs);
}
/**
 * 获取环境互斥锁：O_EXCL 创建，占用方存活则不抢；持有进程已死或超 TTL 才回收。
 * 返回 { acquired, path, meta?, holder? }，调用方在 finally 中释放。
 */
export function acquireEnvironmentLock(root, { environmentId, runId, invocationId, baseUrl, ttlMs = DEFAULT_TTL_MS, pid = process.pid }) {
  const path = environmentLockPath(root, environmentId);
  mkdirSync(resolve(path, '..'), { recursive: true });
  const meta = { environment_id: environmentId, run_id: runId, invocation_id: invocationId ?? null, base_url: baseUrl ?? null, pid, host: hostname(), token: randomUUID(), acquired_at: new Date().toISOString(), ttl_ms: ttlMs };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(path, 'wx');
      try { writeFileSync(handle, `${JSON.stringify(meta, null, 2)}\n`); } finally { closeSync(handle); }
      return { acquired: true, path, meta };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(path);
      // 同一 run 的恢复式重试可以接管：跨 run 的同环境并发仍被严格串行。
      if (holder?.run_id !== runId && !stale(holder, ttlMs)) return { acquired: false, path, holder };
      try { unlinkSync(path); } catch { /* 已被其他进程回收 */ }
    }
  }
  return { acquired: false, path, holder: readLock(path) };
}

/** 只释放自己持有的锁：token 不匹配时绝不删除他人的环境锁。 */
export function releaseEnvironmentLock(lock) {
  if (!lock?.acquired || !existsSync(lock.path)) return false;
  const current = readLock(lock.path);
  if (!current || current.token !== lock.meta.token) return false;
  try { unlinkSync(lock.path); return true; } catch { return false; }
}
