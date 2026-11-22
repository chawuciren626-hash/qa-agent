import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCases, filterCasesByPhase } from '../../scripts/execution-plan.mjs';
import { DEFAULT_POOL_CAPACITY, buildShards, planShardWaves } from '../../scripts/execution-shards.mjs';

const rows = [
  { case_id: 'TC-LOGIN-1', title: 'smoke login', module: 'login', priority: 'P0', automation_feasible: true, execution_contract: { data_isolation: 'read_only' } },
  { case_id: 'TC-CART-1', title: 'add to cart', module: 'cart', priority: 'P1', automation_feasible: true, execution_contract: { data_isolation: 'read_only' } },
  { case_id: 'TC-ORDER-1', title: 'place order', module: 'checkout', priority: 'P2', automation_feasible: true, execution_contract: { data_isolation: 'read_only' } },
];

test('--phase=smoke only carries P0 cases and --phase=regression excludes them', () => {
  const cases = createExecutionCases(rows);
  assert.deepEqual(filterCasesByPhase(cases, 'smoke').map(row => row.case_id), ['TC-LOGIN-1']);
  assert.deepEqual(filterCasesByPhase(cases, 'regression').map(row => row.case_id), ['TC-CART-1', 'TC-ORDER-1']);
  assert.equal(filterCasesByPhase(cases, null).length, 3);
  assert.throws(() => filterCasesByPhase(cases, 'nightly'), /未知执行阶段/);
});

test('phase filtering keeps design order and only the requested phase partition', () => {
  const cases = filterCasesByPhase(createExecutionCases([
    ...rows,
    { case_id: 'TC-LOGIN-2', title: 'second smoke', module: 'login', priority: 'P0', automation_feasible: true, execution_contract: { data_isolation: 'read_only' } },
  ]), 'smoke');
  assert.deepEqual(cases.map(row => row.case_id), ['TC-LOGIN-1', 'TC-LOGIN-2']);
  assert.ok(cases.every(row => row.priority === 'P0'));
});

test('D3 multi-shard planning parallelises modules up to pool capacity', () => {
  const shards = buildShards({ cases: createExecutionCases(rows), execution_policy: { end: 'web' } });
  assert.deepEqual(shards.map(shard => shard.module).sort(), ['cart', 'checkout', 'login']);
  const waves = planShardWaves(shards, DEFAULT_POOL_CAPACITY);
  assert.equal(waves[0].limit, 2);
  assert.equal(waves[0].shards.length, 2, 'two modules may run in parallel');
  assert.equal(waves[1].shards.length, 1, 'the third module waits for a free slot');
});

test('D3 shards sharing a resource key stay serial across waves', () => {
  const cases = createExecutionCases([
    { ...rows[1], resource_keys: ['account:demo'] },
    { ...rows[2], resource_keys: ['account:demo'] },
  ]);
  const waves = planShardWaves(buildShards({ cases, execution_policy: { end: 'web' } }), DEFAULT_POOL_CAPACITY);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves.map(wave => wave.shards.length), [1, 1]);
});
