/**
 * 回归采样分层（L-6 落地，对应 §20.2.1 / 评审 P1-8）。
 *
 * 问题不在「N=3 对不对」，在「N=3 说的是哪件事」。方案 §1.3 写「N=3 一致性 100%」，
 * 很容易被读成「每轮回归跑 3 次」。按全量理解，1500 条 × 3 = 4500 次执行，一个夜晚跑不完，
 * 客户一算成本就放弃——**指标定义得不清，指标自己会杀死方案**。
 *
 * 这里把三种采样写死，并明确一条不可绕的规则：
 *
 *   **复跑只能确认失败，不能洗成通过。**
 *
 * 首次 fail + 两次 pass 的用例，正确结论是「它是 flaky，进隔离区」，不是「它通过了」。
 * 这是决策 20/33 的同一条纪律：不稳定本身就是被测对象的一个属性，把它抹掉等于不测。
 */

/**
 * 采样分层的三档。`never` 表示这一档不跑复跑；`fail_only` 表示只在失败时复跑。
 * 用枚举而不是布尔，是因为后面一定会有人问「为什么冒烟不跑 3 次」——答案要能直接读出来。
 */
export const samplingModes = Object.freeze({
  /** 入库门：一次性成本，换「这条用例本身稳定」的结论。 */
  admission: Object.freeze({ mode: 'always', runs: 3, why: '计划首次入库、断言变更后重入' }),
  /** 冒烟集：要 ≤5 分钟，不能 ×3；失败才值得多花时间确认。 */
  smoke: Object.freeze({ mode: 'fail_only', runs: 3, why: '每轮回归；失败才复跑到 3 次' }),
  /** 全量回归：4500 次不可接受；失败用例通常 <10%，复跑成本可控。 */
  full: Object.freeze({ mode: 'fail_only', runs: 3, why: '夜间全量；仅失败项复跑' }),
  /** flaky 敏感集：历史 flaky、本版新增、改动跨 ≥3 模块。多采有明确收益。 */
  flaky: Object.freeze({ mode: 'always', runs: 3, why: 'flaky 高发区，首次就要采满' }),
});

/** 判断一条用例属于哪一档。顺序有意义：敏感集优先，其余按调用场景。 */
export function samplingTier(testCase, { suite = 'full' } = {}) {
  const history = testCase?.history;
  const touchedModules = Array.isArray(testCase?.touched_modules) ? testCase.touched_modules.length : 0;
  if (history === 'flaky' || testCase?.new_in_version === true || touchedModules >= 3) return 'flaky';
  if (suite === 'smoke') return 'smoke';
  if (suite === 'admission') return 'admission';
  return 'full';
}

/**
 * 这条用例该跑几次。
 *
 * 返回 `{ runs, mode }`：`runs` 是**上限**，不是承诺——fail_only 的用例首次通过就只跑 1 次。
 * 把它当承诺会得到「为什么实际只跑了 1 次」的疑问，所以字段名用 `max_runs`。
 */
export function plannedRuns(testCase, options) {
  const tier = samplingTier(testCase, options);
  const policy = samplingModes[tier];
  return { tier, mode: policy.mode, max_runs: policy.runs, why: policy.why };
}

/**
 * 一次采样序列的判定。这是本模块的核心，也是「复跑不能洗成通过」的唯一落点。
 *
 * 输入是按执行顺序排列的结果数组（`passed` / `failed` / `blocked` / `skipped`）。
 * 输出四选一：
 *   - passed  —— 首次就通过（fail_only 档到此为止，不再跑）
 *   - failed  —— 采满上限仍有失败
 *   - flaky   —— 首次失败、后续有通过：**不稳定，不是通过**
 *   - unknown —— 首次被 blocked/skipped，或被平台中断：没测到，不能说通过也不能说失败
 */
export function judgeRuns(results, { maxRuns = 3, mode = 'fail_only' } = {}) {
  const fail = message => { throw new Error(`Invalid sampling results: ${message}`); };
  if (!Array.isArray(results) || !results.length) fail('expects a non-empty array');
  const allowed = new Set(['passed', 'failed', 'blocked', 'skipped']);
  for (const status of results) if (!allowed.has(status)) fail(`unknown status "${status}"`);
  if (results.length > maxRuns) fail(`${results.length} runs exceed the ${maxRuns}-run budget`);

  const first = results[0];

  // 未测到的一律 unknown：blocked/skipped 不是「通过」，也不是「失败」。
  // 这里不看后续结果——第一次就没测到，后面的「通过」没有可比的对象。
  if (first === 'blocked' || first === 'skipped') {
    return { verdict: 'unknown', runs: results.length, reason: `first run was ${first}; the case was never exercised` };
  }

  if (first === 'passed') {
    // fail_only 档首次通过就停：再跑是为了确认失败，不是为了多攒几次通过。
    return { verdict: 'passed', runs: results.length, reason: 'passed on the first run' };
  }

  // 首次失败。always 档跑满；fail_only 档跑到出现通过或跑满为止。
  if (results.length < maxRuns) {
    return { verdict: 'incomplete', runs: results.length, reason: `first run failed; ${maxRuns - results.length} of the ${maxRuns} budgeted runs have not happened` };
  }

  const laterPassed = results.slice(1).some(status => status === 'passed');
  if (laterPassed) {
    // 关键分支：有通过，但首次是失败 —— 这是 flaky，不是 passed。
    return { verdict: 'flaky', runs: results.length, reason: 'failed first, passed on a later run: unstable, which is a finding about the case, not a pass' };
  }
  return { verdict: 'failed', runs: results.length, reason: `failed all ${results.length} runs` };
}

/**
 * 逐个用例算出执行预算，并给出成本对照。
 *
 * 成本对照是 §20.2.1 那张表要能被复算——客户问「省了多少」时，答案不能是「大概三分之一」。
 */
export function planSampling(cases, options) {
  const entries = cases.map(testCase => {
    const planned = plannedRuns(testCase, options);
    const worst = planned.max_runs;
    // 期望执行次数的估算：fail_only 档按「首次通过就停」算，所以是 1 + p×(max-1)，
    // 这里用失败率作为 p 的估计——给出的仍是估算，不是承诺，报告要如实写「估算」。
    const failureRate = Number.isFinite(options?.failureRate) ? options.failureRate : 0.08;
    const expected = planned.mode === 'fail_only' ? 1 + failureRate * (planned.max_runs - 1) : planned.max_runs;
    return { case_id: testCase.case_id, ...planned, worst_runs: worst, expected_runs: expected };
  });
  const total = entries.length;
  const worstRuns = entries.reduce((sum, entry) => sum + entry.worst_runs, 0);
  const expectedRuns = entries.reduce((sum, entry) => sum + entry.expected_runs, 0);
  // 「全量 N=3 误读版」的对照：每条都采满 3 次。
  const misreadRuns = total * 3;
  return {
    cases: total,
    byTier: Object.fromEntries(Object.keys(samplingModes).map(tier => [tier, entries.filter(entry => entry.tier === tier).length])),
    worstRuns,
    expectedRuns: Math.round(expectedRuns * 10) / 10,
    misreadRuns,
    /** 只能算作「估算」，写进报告时要带上这个词。 */
    savingVsMisread: misreadRuns === 0 ? 0 : Math.round((1 - expectedRuns / misreadRuns) * 1000) / 10,
    entries,
  };
}

/**
 * 一轮回归跑完之后的一致性口径。
 *
 * 这一层是为了防止上层把 flaky 悄悄算成通过——`flaky` 单独计数，且**不计入** passed。
 * 一条「flaky 也算通过」的汇总，会让 flaky 率这个指标永远显示为 0。
 */
export function summarizeVerdicts(judgements) {
  const counts = { passed: 0, failed: 0, flaky: 0, unknown: 0, incomplete: 0 };
  for (const item of judgements) counts[item.verdict] = (counts[item.verdict] ?? 0) + 1;
  const attempted = counts.passed + counts.failed + counts.flaky;
  return {
    ...counts,
    attempted,
    /** 通过率的分母不含 unknown：没测到的用例不该拉低通过率，也不该被算作通过。 */
    passRate: attempted === 0 ? null : Math.round((counts.passed / attempted) * 1000) / 10,
    flakyRate: attempted === 0 ? null : Math.round((counts.flaky / attempted) * 1000) / 10,
    note: 'flaky is counted on its own and never added to passed; unknown and incomplete neither pass nor fail',
  };
}

/**
 * 从重放对比（批次 4 的 `execution/replay-comparison.json`）提取隔离名单。
 *
 * 这是「不稳定用例不进入可靠通过率」的数据入口：`flaky_suspect` 的用例在这里被标成
 * `history: 'flaky'`，下一轮 `samplingTier` 会把它放进 flaky 敏感集（always ×3）。
 * 怀疑就该隔离——即使重放是 partial（预算到点只跑了 1 次），那次失败依然成立。
 *
 * 只认 `kind: 'replay-comparison'`：别的文档长得再像也不收，防止把任意 JSON
 * 喂进来产出一份看似有据的名单。
 */
export function flakyIsolation(comparison) {
  if (comparison?.kind !== 'replay-comparison') throw new Error('Expected a replay-comparison document (kind: replay-comparison)');
  if (!Array.isArray(comparison.per_case)) throw new Error('replay-comparison missing per_case array');
  const cases = comparison.per_case
    .filter(row => row?.verdict === 'unstable')
    .map(row => ({
      case_id: row.case_id,
      history: 'flaky',
      reason: 'unstable across replay attempts (flaky_suspect from replay-comparison)',
      verdicts: Array.isArray(row.verdicts) ? row.verdicts.map(item => item.status) : null,
    }));
  return {
    kind: 'regression-isolation',
    run_id: comparison.run_id ?? null,
    generated_at: new Date().toISOString(),
    /** 名单只覆盖重放真正执行过的范围；partial 时缺席的次数不构成"稳定"，但也不构成"不稳定"。 */
    coverage: {
      executed_replays: comparison.executed_replays ?? 0,
      requested_replays: comparison.requested_replays ?? 0,
      complete: comparison.status === 'completed',
      ...(comparison.stop_reason ? { stop_reason: comparison.stop_reason } : {}),
    },
    isolated: cases,
    count: cases.length,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const [command, runId] = process.argv.slice(2);
  if (command !== 'isolate' || !runId) {
    console.error('用法：node scripts/regression-sampling.mjs isolate <run_id>  # 从 execution/replay-comparison.json 提取隔离名单');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { runDirectory } = await import('./design-quality.mjs');
  const root = resolve(import.meta.dirname, '..');
  const doc = JSON.parse(readFileSync(resolve(runDirectory(root, runId), 'execution/replay-comparison.json'), 'utf8'));
  console.log(JSON.stringify(flakyIsolation(doc), null, 2));
}
