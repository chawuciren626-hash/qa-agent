import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildShards, mergePlaywrightReports, planShardWaves, readBatchCheckpoint, runShardedPlaywright } from '../../scripts/execution-shards.mjs';

const contract = (dataIsolation, resourceKeys = []) => ({ data_isolation: dataIsolation, setup: [], assertion_mode: ['dom_state'], cleanup_required: dataIsolation !== 'read_only', resource_keys: resourceKeys });

const plan = {
  run_id: 'run-shards',
  cases: [
    { case_id: 'TC-ORDER-1', module: 'ORDER', priority: 'P1', asset_refs: [], execution_contract: contract('read_only', ['db:orders']) },
    { case_id: 'TC-ORDER-2', module: 'ORDER', priority: 'P0', asset_refs: [], execution_contract: contract('read_only', ['db:orders']) },
    { case_id: 'TC-USER-1', module: 'USER', priority: 'P0', asset_refs: [], execution_contract: contract('isolated') },
    { case_id: 'TC-USER-2', module: 'USER', priority: 'P2', asset_refs: [], execution_contract: contract('isolated') },
    { case_id: 'TC-PAY-1', module: 'PAY', priority: 'P1', asset_refs: [], execution_contract: contract('read_only', ['db:orders']) },
  ],
  execution_policy: { workers: 2, test_dir: 'tests/generated', end: 'web' },
};

test('shards group by module x data profile and order cases by priority', () => {
  const shards = buildShards(plan);
  assert.equal(shards.length, 3);
  const order = shards.find(shard => shard.module === 'ORDER');
  assert.deepEqual(order.case_ids, ['TC-ORDER-2', 'TC-ORDER-1']);
  assert.deepEqual(order.resource_keys, ['db:orders']);
  assert.equal(order.data_profile, 'read_only');
});

test('waves respect pool capacity and serialize shared resource keys', () => {
  const shards = buildShards(plan);
  const waves = planShardWaves(shards, { pools: { web: 2 }, max_shard_workers: 2 });
  const flat = waves.flatMap(wave => wave.shards.map(shard => shard.shard_id));
  assert.equal(flat.length, shards.length);
  for (const wave of waves) assert.ok(wave.shards.length <= 2, `wave exceeded pool capacity: ${wave.shards.length}`);
  for (const wave of waves) {
    const shared = wave.shards.filter(shard => shard.resource_keys.includes('db:orders'));
    assert.ok(shared.length <= 1, 'shards sharing a resource key must not run in the same wave');
  }
  assert.ok(waves.some(wave => wave.shards.length === 2), 'expected at least one wave to run two shards in parallel');
});

test('mergePlaywrightReports keeps every suite and the earliest start time', () => {
  const merged = mergePlaywrightReports([
    { suites: [{ specs: [{ title: 'TC-ORDER-1' }] }], errors: [], stats: { startTime: '2026-11-22T01:00:00.000Z', duration: 10 } },
    { suites: [{ specs: [{ title: 'TC-USER-1' }] }], errors: [], stats: { startTime: '2026-11-22T01:00:05.000Z', duration: 20 } },
  ]);
  assert.equal(merged.suites.length, 2);
  assert.equal(merged.stats.startTime, '2026-11-22T01:00:00.000Z');
  assert.equal(merged.stats.duration, 30);
});

test('runShardedPlaywright executes independent shards concurrently and checkpoints completion', async t => {
  const root = mkdtempSync(resolve(tmpdir(), 'shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'node_modules/@playwright/test'), { recursive: true });
  writeFileSync(resolve(root, 'node_modules/@playwright/test/cli.js'), '');
  const attemptDir = resolve(root, 'attempt');
  let active = 0;
  let maxActive = 0;
  const invokes = [];
  const invoke = async (phase, args, env) => {
    invokes.push(phase);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(done => setTimeout(done, 60));
    active -= 1;
    const ids = args[3].match(/TC-[A-Z0-9-]+/g) ?? [];
    mkdirSync(resolve(env.QA_RUN_DIR, 'playwright'), { recursive: true });
    writeFileSync(resolve(env.QA_RUN_DIR, 'playwright/playwright-results.json'), JSON.stringify({
      suites: [{ specs: ids.map(id => ({ title: id, tests: [{ results: [{ status: 'passed', duration: 1 }] }] })) }],
      errors: [],
      stats: { startTime: new Date().toISOString(), duration: 60 },
    }));
    return { code: 0, termination_confirmed: true };
  };
  const childEnv = (_base, overrides) => ({ ...overrides });
  const result = await runShardedPlaywright({ root, plan, attemptDir, timeoutMs: 1000, capacity: { pools: { web: 2 }, max_shard_workers: 2 }, invoke, childEnv, headed: false, baseUrl: 'http://127.0.0.1' });
  assert.equal(result.shards.length, 3);
  assert.equal(maxActive, 2, `expected two shards to overlap, observed ${maxActive}`);
  assert.equal(invokes.length, 3);
  const raw = JSON.parse(readFileSync(resolve(attemptDir, 'playwright/playwright-results.json'), 'utf8'));
  assert.equal(raw.suites.length, 3);
  const checkpoint = readBatchCheckpoint(resolve(attemptDir, 'shards/checkpoint.json'));
  assert.equal(Object.keys(checkpoint.shards).length, 3);
  assert.ok(Object.values(checkpoint.shards).every(row => row.status === 'completed'));

  // 恢复：同一计划再次执行应直接复用检查点，不重新启动进程。
  const replays = [];
  const resumed = await runShardedPlaywright({ root, plan, attemptDir, timeoutMs: 1000, capacity: { pools: { web: 2 }, max_shard_workers: 2 }, invoke: async (...args) => { replays.push(args[0]); return { code: 0, termination_confirmed: true }; }, childEnv, headed: false, baseUrl: 'http://127.0.0.1' });
  assert.equal(replays.length, 0);
  assert.ok(resumed.shards.every(shard => shard.resumed));
  assert.ok(existsSync(resolve(attemptDir, 'shards/checkpoint.json')));
});
