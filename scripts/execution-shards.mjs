import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { atomicJson } from './execution-attempts.mjs';

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 };

export const DEFAULT_POOL_CAPACITY = Object.freeze({
  schema_version: 1,
  pools: Object.freeze({ web: 2, api: 2, android: 2, miniprogram: 2 }),
  max_shard_workers: 2,
});

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** 池容量加载：缺失或损坏时回退安全默认值，非法字段显式报错而不是静默降级。 */
export function readPoolCapacity(root) {
  const path = resolve(root, 'config', 'pool-capacity.json');
  if (!existsSync(path)) return { ...DEFAULT_POOL_CAPACITY, pools: { ...DEFAULT_POOL_CAPACITY.pools }, source_path: null };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw?.schema_version !== 1) throw new Error('config/pool-capacity.json schema_version 必须为 1。');
  const pools = { ...DEFAULT_POOL_CAPACITY.pools, ...(raw.pools ?? {}) };
  for (const [name, value] of Object.entries(pools)) {
    if (!positiveInteger(value)) throw new Error(`pool-capacity.pools.${name} 必须是正整数。`);
  }
  const maxShardWorkers = raw.max_shard_workers ?? DEFAULT_POOL_CAPACITY.max_shard_workers;
  if (!positiveInteger(maxShardWorkers)) throw new Error('pool-capacity.max_shard_workers 必须是正整数。');
  return { schema_version: 1, pools, max_shard_workers: Math.min(maxShardWorkers, Math.max(...Object.values(pools))), source_path: path };
}

export function caseModule(testCase) {
  if (testCase?.module) return String(testCase.module);
  const segments = String(testCase?.case_id ?? '').split(/[-_]/);
  return segments.length >= 3 ? segments[1].toUpperCase() : 'default';
}

export function caseResourceKeys(testCase) {
  const keys = testCase?.resource_keys ?? testCase?.execution_contract?.resource_keys ?? [];
  return Array.isArray(keys) ? [...new Set(keys.map(String))].sort() : [];
}

/**
 * 按 模块 × 数据画像 分片；分片内按优先级排序，片间靠资源键串行约束。
 * 数据画像来自 execution_contract.data_isolation（只读/隔离/共享），
 * 共享画像的用例天然需要更严格的资源键约束。
 */
export function buildShards(plan) {
  const groups = new Map();
  for (const testCase of plan.cases ?? []) {
    const module = caseModule(testCase);
    const profile = testCase.execution_contract?.data_isolation ?? 'shared';
    const key = `${module}::${profile}`;
    if (!groups.has(key)) groups.set(key, { module, data_profile: profile, cases: [], resource_keys: new Set() });
    const group = groups.get(key);
    group.cases.push(testCase);
    for (const resource of caseResourceKeys(testCase)) group.resource_keys.add(resource);
  }
  const end = plan.execution_policy?.end ?? plan.execution_policy?.target_end ?? 'web';
  return [...groups.entries()].map(([key, group]) => {
    const ordered = [...group.cases].sort((left, right) => (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9));
    return {
      shard_id: `${group.module}-${group.data_profile}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      module: group.module,
      data_profile: group.data_profile,
      end,
      resource_keys: [...group.resource_keys].sort(),
      case_ids: ordered.map(item => item.case_id),
      priorities: [...new Set(ordered.map(item => item.priority ?? 'P2'))],
      key: key.replace(/[^A-Za-z0-9]+/g, '_'),
    };
  });
}

const intersects = (left, right) => (left.resource_keys ?? []).some(key => (right.resource_keys ?? []).includes(key));

/**
 * 波次编排：同一波内并行度不超过该端池容量；任何共享 resource_key 的分片必须跨波串行。
 * 返回 [{ end, limit, shards: [...] }]，波次之间严格串行，波内可并行。
 */
export function planShardWaves(shards, capacity) {
  const byEnd = new Map();
  for (const shard of shards) {
    if (!byEnd.has(shard.end)) byEnd.set(shard.end, []);
    byEnd.get(shard.end).push(shard);
  }
  const waves = [];
  for (const [end, list] of byEnd) {
    const limit = Math.max(1, Math.min(capacity.pools?.[end] ?? 1, capacity.max_shard_workers ?? Number.MAX_SAFE_INTEGER));
    const endWaves = [];
    for (const shard of list) {
      const slot = endWaves.find(wave => wave.length < limit && !wave.some(other => intersects(other, shard)));
      if (slot) slot.push(shard);
      else endWaves.push([shard]);
    }
    for (const wave of endWaves) waves.push({ end, limit, shards: wave });
  }
  return waves;
}

export function planSha256(plan) {
  return createHash('sha256').update(JSON.stringify({ cases: plan.cases?.map(row => row.case_id), workers: plan.execution_policy?.workers, end: plan.execution_policy?.end ?? 'web' })).digest('hex');
}

export function readBatchCheckpoint(path) {
  if (!existsSync(path)) return { version: 1, plan_sha256: null, shards: {} };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return data?.version === 1 && data.shards ? data : { version: 1, plan_sha256: null, shards: {} };
}

export function writeBatchCheckpoint(path, checkpoint) {
  atomicJson(path, checkpoint);
}

export function mergePlaywrightReports(reports) {
  const suites = reports.flatMap(report => report?.suites ?? []);
  const errors = reports.flatMap(report => report?.errors ?? []);
  const startTime = reports.map(report => report?.stats?.startTime).filter(Boolean).sort()[0] ?? new Date(0).toISOString();
  const duration = reports.reduce((sum, report) => sum + (report?.stats?.duration ?? 0), 0);
  return { config: {}, suites, errors, stats: { startTime, duration } };
}

/**
 * 分片执行：波内并行、跨波串行；每个分片独立 Playwright 进程与 QA_RUN_DIR，
 * 完成后写批次检查点。恢复时同一 plan 指纹下已完成分片直接复用原始报告，不重复跑。
 */
export async function runShardedPlaywright({ root, plan, attemptDir, timeoutMs, capacity, invoke, childEnv, headed, baseUrl }) {
  const shards = buildShards(plan);
  const waves = planShardWaves(shards, capacity);
  const playwright = resolve(root, 'node_modules/@playwright/test/cli.js');
  const testDir = plan.execution_policy?.test_dir ?? 'tests/generated';
  const checkpointPath = resolve(attemptDir, 'shards', 'checkpoint.json');
  const fingerprint = planSha256(plan);
  const prior = readBatchCheckpoint(checkpointPath);
  const checkpoint = prior.plan_sha256 === fingerprint ? prior : { version: 1, plan_sha256: fingerprint, shards: {} };
  mkdirSync(resolve(attemptDir, 'shards'), { recursive: true });
  const reports = [];
  const executed = [];
  let exitCode = 0;
  for (const [waveIndex, wave] of waves.entries()) {
    const outcomes = await Promise.all(wave.shards.map(async (shard, slot) => {
      const shardDir = resolve(attemptDir, 'shards', shard.shard_id);
      const recorded = checkpoint.shards[shard.shard_id];
      if (recorded?.status === 'completed' && existsSync(recorded.raw_path)) {
        return { shard, report: JSON.parse(readFileSync(recorded.raw_path, 'utf8')), code: recorded.code, resumed: true };
      }
      mkdirSync(resolve(shardDir, 'playwright'), { recursive: true });
      const ids = shard.case_ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const args = [playwright, 'test', '--grep', `(?:^|\\s)(${ids.join('|')})(?=\\s|$)`, '--workers=1', '--retries=0', `--global-timeout=${timeoutMs}`];
      const phase = `playwright-shard-${waveIndex + 1}-${slot + 1}`;
      const result = await invoke(phase, args, childEnv(process.env, {
        QA_BASE_URL: baseUrl,
        QA_TEST_DIR: resolve(root, testDir),
        QA_RUN_DIR: shardDir.replaceAll('\\', '/'),
        QA_HEADED: headed ? 'true' : 'false',
        QA_WORKERS: '1',
      }), timeoutMs + 10000);
      if (result.termination || result.error || result.code === null) return { shard, stop: `Shard ${shard.shard_id} stopped: ${result.termination ?? result.error ?? 'unknown'}`, kind: result.termination === 'interrupted' ? 'interrupted' : 'blocked' };
      const rawPath = resolve(shardDir, 'playwright', 'playwright-results.json');
      if (!existsSync(rawPath)) return { shard, stop: `Shard ${shard.shard_id} produced no raw result`, kind: 'blocked' };
      checkpoint.shards[shard.shard_id] = { status: 'completed', raw_path: rawPath, code: result.code, finished_at: new Date().toISOString() };
      writeBatchCheckpoint(checkpointPath, checkpoint);
      return { shard, report: JSON.parse(readFileSync(rawPath, 'utf8')), code: result.code };
    }));
    for (const outcome of outcomes) {
      if (outcome.stop) return { stop: outcome.stop, kind: outcome.kind, shards, waves: waves.length };
      reports.push(outcome.report);
      executed.push({ shard_id: outcome.shard.shard_id, case_ids: outcome.shard.case_ids, code: outcome.code, resumed: Boolean(outcome.resumed) });
      if (outcome.code !== 0) exitCode = outcome.code;
    }
  }
  const rawPath = resolve(attemptDir, 'playwright', 'playwright-results.json');
  mkdirSync(resolve(attemptDir, 'playwright'), { recursive: true });
  atomicJson(rawPath, mergePlaywrightReports(reports));
  writeBatchCheckpoint(checkpointPath, checkpoint);
  return { test: { code: exitCode }, shards: executed, waves: waves.length, checkpoint: checkpointPath };
}
