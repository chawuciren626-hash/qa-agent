/**
 * 可重放的 Web 执行（批次 4）：同一执行计划跑 N 次，对比逐案结论与证据一致性。
 *
 * 为什么要有这一层：单次通过的结论只值一次运行的可信度。Playwright `--retries` 会把
 * "偶尔挂"藏进最终状态里；这里显式跑 N 个独立 attempt（各自有 attempt 目录与封存回执），
 * 然后逐案对比。结论不一致的用例标 `flaky_suspect`——它们不得进入可靠通过率（批次 5 的
 * 隔离名单从这里来）。
 *
 * 三条纪律：
 * 1. **预算超限明确停止**：`replay_deadline_ms` 到点后剩余次数记 not_run，写清 stop_reason，
 *    绝不静默少跑或硬撑着继续；单个 attempt blocked/interrupted 同样停（继续烧只会产出
 *    更多不可比的部分结果）。
 * 2. **未执行不得报通过**：用例结论为 passed 的唯一条件是「N 次全部执行、结论全部一致
 *    且全部通过」。少跑任何一次都是 partial，用例给 inconclusive 而不是 passed。
 * 3. **三层结果如实记录**：`target_tier`（source / isolated / installed）随计划声明、
 *    随对比落盘。源码跑通不等于构建部署后跑通，也不等于已安装实例跑通——tier 不同
 *    的结论不允许混在一张通过率里。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runDirectory } from './design-quality.mjs';
import { atomicJson } from './execution-attempts.mjs';
import { executeAttempt } from './execution-runner.mjs';
import { validateExecutionPlan } from './execution-plan.mjs';

const DEFAULT_REPLAYS = 3;
const MAX_REPLAYS = 5;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function replayComparison(attempts, { requested, tier, deadlineMs, elapsedMs, stopReason }) {
  // 逐案对比：以"出现在全部已执行 attempt"为可比的前提，缺任何一次都是 not_comparable——
  // 拿两次结果说一致、给第三次缺席的用例记通过，是拿缺席冒充证据。
  const byCase = new Map();
  for (const attempt of attempts) {
    for (const row of attempt.result?.cases ?? []) {
      if (!byCase.has(row.case_id)) byCase.set(row.case_id, []);
      byCase.get(row.case_id).push({ invocation_id: attempt.invocation_id, status: row.status, flaky: row.flaky ?? false });
    }
  }
  const complete = attempts.length === requested;
  const perCase = [...byCase.entries()].map(([caseId, verdicts]) => {
    const statuses = [...new Set(verdicts.map(row => row.status))];
    const comparable = verdicts.length === attempts.length && verdicts.length === requested;
    const consistent = comparable && statuses.length === 1;
    const anyFlakyRetry = verdicts.some(row => row.flaky);
    let verdict;
    if (!comparable) verdict = 'inconclusive';
    else if (!consistent) verdict = 'unstable';
    else if (anyFlakyRetry) verdict = 'unstable';            // 结论一致但内部有重试翻盘，同样是稳定性问题
    else verdict = statuses[0];
    return {
      case_id: caseId,
      verdict,
      consistent,
      flaky_suspect: verdict === 'unstable',
      // passed 只在"次数齐 + 全部一致 + 全部通过"时成立，否则 inconclusive 带原因。
      ...(verdict === 'inconclusive' ? { reason: comparable ? null : `缺席 ${requested - verdicts.length} 次执行` } : {}),
      verdicts,
    };
  });
  const executed = attempts.length;
  const sealed = attempts.filter(attempt => ['completed', 'failed'].includes(attempt.status)).length;
  // "完成"的门槛是次数齐**且**每次都跑到封存的终态：blocked/interrupted 的 attempt
  // 只贡献了"这里停了"的事实，不贡献可比结论——不能因为次数凑够就说是完整重放。
  const fullyExecuted = !stopReason && executed === requested && sealed === requested;
  const status = fullyExecuted ? 'completed' : 'partial';
  const consistentCases = perCase.filter(row => row.consistent && row.verdict !== 'unstable');
  return {
    run_id: attempts[0]?.result?.run_id ?? null,
    kind: 'replay-comparison',
    requested_replays: requested,
    executed_replays: executed,
    status,
    ...(stopReason ? { stop_reason: stopReason } : {}),
    ...(status === 'partial' ? { note: '执行次数不足请求值：以下对比只在已执行范围内成立，不构成完整重放结论。' } : {}),
    ...(tier ? { target_tier: tier } : {}),
    budget: {
      deadline_ms: deadlineMs,
      elapsed_ms: elapsedMs,
      remaining_attempts: Math.max(0, requested - executed),
    },
    attempts: attempts.map(attempt => ({
      invocation_id: attempt.invocation_id,
      status: attempt.status,
      attempt_dir: attempt.attempt_dir,
      ...(tier ? { target_tier: tier } : {}),
      summary: attempt.result?.summary ?? null,
      // 证据锚点：原始结果文件的哈希。结论可以吵，哈希对得上就是同一份运行证据。
      results_sha256: attempt.resultsSha256 ?? null,
    })),
    per_case: perCase,
    summary: {
      cases_total: perCase.length,
      consistent: consistentCases.length,
      unstable: perCase.filter(row => row.verdict === 'unstable').length,
      inconclusive: perCase.filter(row => row.verdict === 'inconclusive').length,
      // 只有完整执行且全案一致时才有"可靠通过"；partial 的分母明说只覆盖已执行范围。
      reliable_passed: fullyExecuted && perCase.every(row => row.verdict === 'passed') ? perCase.length : 0,
    },
  };
}

export async function executeReplay(root, runId, {
  replays, headed = false, signal, runProcess = undefined, commandId,
  now = Date.now,
} = {}) {
  const output = resolve(runDirectory(root, runId), 'execution');
  const plan = readJson(resolve(output, 'execution-plan.json'));
  const planErrors = validateExecutionPlan(plan);
  if (planErrors.length) throw new Error(`执行计划无效：${planErrors.join('; ')}`);
  const policy = plan.execution_policy;
  const requested = Math.min(MAX_REPLAYS, replays ?? policy.replays ?? DEFAULT_REPLAYS);
  const tier = policy.target_tier ?? null;
  const perAttemptMs = policy.global_timeout_ms ?? 900000;
  const deadlineMs = policy.replay_deadline_ms ?? requested * (perAttemptMs + 60000);
  const startedAt = now();

  const attempts = [];
  let stopReason = null;
  for (let index = 0; index < requested; index += 1) {
    const elapsed = now() - startedAt;
    if (elapsed > deadlineMs) {
      // 预算到点：剩余次数如实记 not_run，不静默、不硬撑。
      stopReason = 'replay_budget_exhausted';
      break;
    }
    const outcome = await executeAttempt(root, runId, { headed, signal, ...(runProcess ? { runProcess } : {}), ...(commandId ? { commandId } : {}) });
    const attemptDir = outcome.attempt_dir;
    const rawPath = resolve(attemptDir, 'playwright/playwright-results.json');
    let resultsSha256 = null;
    let result = null;
    try {
      // 逐案结果在封存的 test_results.json；attempt.json 只是清单，不含 result。
      resultsSha256 = createHash('sha256').update(readFileSync(rawPath)).digest('hex');
      result = readJson(resolve(attemptDir, 'test_results.json'));
    } catch { /* 封存回执缺失时如实留空，对比会把它判为不可比。 */ }
    attempts.push({ invocation_id: outcome.invocation_id, status: outcome.status, attempt_dir: attemptDir, result, resultsSha256 });
    if (outcome.status !== 'completed' && outcome.status !== 'failed') {
      // blocked / interrupted：继续跑只会产出更多不可比的部分结果，先停下说清楚。
      stopReason = outcome.status === 'interrupted' ? 'attempt_interrupted' : 'attempt_blocked';
      break;
    }
  }

  const comparison = replayComparison(attempts, {
    requested, tier, deadlineMs, elapsedMs: now() - startedAt,
    ...(stopReason ? { stopReason } : {}),
  });
  atomicJson(resolve(output, 'replay-comparison.json'), comparison);
  return comparison;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const runId = process.argv[2];
  if (!runId) throw new Error('用法：node scripts/execution-replay.mjs <run_id> [--replays=N]');
  const flag = process.argv.find(arg => arg.startsWith('--replays='));
  const comparison = await executeReplay(resolve(import.meta.dirname, '..'), runId,
    flag ? { replays: Number(flag.slice(10)) } : {});
  console.log(JSON.stringify({
    run_id: comparison.run_id,
    executed: `${comparison.executed_replays}/${comparison.requested_replays}`,
    status: comparison.status,
    ...(comparison.stop_reason ? { stop_reason: comparison.stop_reason } : {}),
    ...(comparison.target_tier ? { target_tier: comparison.target_tier } : {}),
    consistent: comparison.summary.consistent,
    unstable: comparison.summary.unstable,
    inconclusive: comparison.summary.inconclusive,
    output: 'execution/replay-comparison.json',
  }, null, 2));
}
