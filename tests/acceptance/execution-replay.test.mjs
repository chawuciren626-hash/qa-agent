import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { executionSnapshot } from '../../scripts/execution-authorization.mjs';
import { executeReplay } from '../../scripts/execution-replay.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture() {
  const id = `run-replay-${randomUUID()}`;
  const data = executionInputs(root, id);
  const manifest = { run_id: id, stages: { execution: { status: 'planned' } }, confirmations: [], orchestration: { events: [], plan: { stages: [{ id: 'execution', selected: true, confirmation: 'before', depends_on: [] }] } } };
  manifest.confirmations.push({ id: 'synthetic-approval', stage: 'execution', status: 'approved', execution_snapshot: executionSnapshot(root, id), approval_source: { kind: 'native_user_message', session_id: 'synthetic-parent', timestamp: '2026-10-14T00:00:00Z', sha256: 'a'.repeat(64) } });
  writeJsonFile(resolve(data.dir, 'manifest.json'), manifest);
  return { id, ...data };
}

function raw(status = 'passed', retries = null) {
  const results = retries ?? [{ status, duration: 1, attachments: [] }];
  return { stats: { startTime: new Date().toISOString() }, errors: [], suites: [{ specs: [{ title: 'TC-SYNTHETIC synthetic case', tests: [{ results }] }] }] };
}

function simulatedProcess({ status = 'passed', schedule = null } = {}) {
  // schedule: 按 attempt 次序给出第 N 次执行的 { status, retries, termination, noReport }；
  // 超出schedule 的沿用最后一项。三个 attempt 各自完整跑 preflight + playwright。
  let call = 0;
  return async options => {
    writeFileSync(options.logPath, 'Synthetic process output, not browser execution.');
    const dir = resolve(options.logPath, '..');
    if (options.args[0].endsWith('preflight-test-environment.mjs')) {
      writeJsonFile(resolve(dir, 'environment/preflight.json'), { status: 'ready', environment_id: 'synthetic' });
      return { code: 0, pid: null, termination_confirmed: true };
    }
    const step = schedule?.[Math.min(call, (schedule?.length ?? 1) - 1)] ?? { status };
    call += 1;
    if (step.noReport) return { code: 1, termination: step.termination ?? null, pid: null, termination_confirmed: true };
    const value = raw(step.status ?? 'passed', step.retries);
    writeJsonFile(resolve(dir, 'playwright/playwright-results.json'), value);
    return { code: (step.status ?? 'passed') === 'passed' ? 0 : 1, termination: step.termination ?? null, pid: null, termination_confirmed: true };
  };
}

test('three identical passing attempts produce a consistent, complete comparison', async () => {
  const f = fixture();
  const comparison = await executeReplay(root, f.id, { replays: 3, runProcess: simulatedProcess() });
  assert.equal(comparison.status, 'completed');
  assert.equal(comparison.executed_replays, 3);
  assert.equal(comparison.attempts.length, 3);
  const row = comparison.per_case[0];
  assert.equal(row.verdict, 'passed');
  assert.equal(row.consistent, true);
  assert.equal(row.flaky_suspect, false);
  assert.equal(comparison.summary.reliable_passed, 1);
  // 每次运行的原始证据哈希都记下：结论可以吵，哈希对得上就是同一份运行证据。
  for (const attempt of comparison.attempts) {
    assert.match(attempt.results_sha256 ?? '', /^[0-9a-f]{64}$/);
  }
  // 对比结果要落盘到执行目录，供报告阶段与事后复盘读取。
  const persisted = read(resolve(f.dir, 'execution/replay-comparison.json'));
  assert.equal(persisted.kind, 'replay-comparison');
  assert.equal(persisted.summary.consistent, 1);
});

test('a case that fails in one attempt is flaky_suspect and never counts as reliable passed', async () => {
  const f = fixture();
  const comparison = await executeReplay(root, f.id, {
    replays: 3,
    runProcess: simulatedProcess({ schedule: [{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }] }),
  });
  assert.equal(comparison.status, 'completed');
  const row = comparison.per_case[0];
  assert.equal(row.verdict, 'unstable');
  assert.equal(row.flaky_suspect, true);
  assert.deepEqual(row.verdicts.map(row => row.status), ['passed', 'failed', 'passed']);
  assert.equal(comparison.summary.reliable_passed, 0);
  assert.equal(comparison.summary.unstable, 1);
});

test('a retry that flips to passed inside one attempt is still unstable', async () => {
  const f = fixture();
  const comparison = await executeReplay(root, f.id, {
    replays: 2,
    // 三次结论都是 passed，但第二次内部先挂后过：一致性不能被重试抹平。
    runProcess: simulatedProcess({ schedule: [{ retries: [{ status: 'failed', retry: 0 }, { status: 'passed', retry: 1 }] }, {}] }),
  });
  const row = comparison.per_case[0];
  assert.equal(row.verdict, 'unstable');
  assert.equal(row.flaky_suspect, true);
  assert.equal(comparison.summary.reliable_passed, 0);
});

test('budget exhaustion stops the replay and remaining attempts are honestly missing', async () => {
  const f = fixture();
  let tick = 0;
  const start = 1_000_000;
  const now = () => {
    tick += 1;
    // 调用序：startedAt → 第 1 次预算检查（放行）→ 第 2 次预算检查（超限拦截）。
    return [start, start + 100, start + 10 ** 12][tick - 1] ?? start;
  };
  const comparison = await executeReplay(root, f.id, { replays: 3, runProcess: simulatedProcess(), now });
  assert.equal(comparison.status, 'partial');
  assert.equal(comparison.stop_reason, 'replay_budget_exhausted');
  assert.equal(comparison.executed_replays, 1);
  assert.equal(comparison.budget.remaining_attempts, 2);
  const row = comparison.per_case[0];
  assert.equal(row.verdict, 'inconclusive');
  assert.match(row.reason ?? '', /缺席/);
  assert.equal(comparison.summary.reliable_passed, 0);
  assert.match(comparison.note ?? '', /不构成完整重放结论/);
});

test('a blocked attempt stops the replay instead of producing more incomparable partials', async () => {
  const f = fixture();
  const comparison = await executeReplay(root, f.id, {
    replays: 2,
    runProcess: simulatedProcess({ schedule: [{ status: 'passed' }, { noReport: true, termination: 'timeout' }] }),
  });
  assert.equal(comparison.status, 'partial');
  assert.equal(comparison.stop_reason, 'attempt_blocked');
  assert.equal(comparison.executed_replays, 2);
  // 第二次是 blocked：它没有逐案结果，可比性被如实降级，而不是拿一次通过冒充一致。
  const row = comparison.per_case[0];
  assert.equal(row.verdict, 'inconclusive');
});

test('target_tier is recorded on the comparison and every attempt', async () => {
  const f = fixture();
  const planPath = resolve(f.dir, 'execution/execution-plan.json');
  const plan = read(planPath);
  plan.execution_policy.target_tier = 'installed';
  writeJsonFile(planPath, plan);
  const comparison = await executeReplay(root, f.id, { replays: 2, runProcess: simulatedProcess() });
  assert.equal(comparison.target_tier, 'installed');
  for (const attempt of comparison.attempts) {
    assert.equal(attempt.target_tier, 'installed');
  }
});

test('an invalid replays policy is rejected before any attempt runs', async () => {
  const f = fixture();
  const planPath = resolve(f.dir, 'execution/execution-plan.json');
  const plan = read(planPath);
  plan.execution_policy.replays = 9;
  writeJsonFile(planPath, plan);
  await assert.rejects(
    () => executeReplay(root, f.id, { runProcess: simulatedProcess() }),
    /replays/,
  );
});
