/**
 * 把预期结果的可信度接到执行结论上（L-3 的落地部分）。
 *
 * L-1 已经把规则写好了（R1~R5，见 `scripts/expected-source.mjs`），但没有接到真正的执行
 * 结论上——**规则不接在数据路径上，就等于没写**。一份报告里 95% 的通过率如果全部来自
 * 「预期从未被人工确认」的用例，那这个 95% 只是在陈述「机器认为机器是对的」。
 *
 * 这里做三件事，都很小，但缺一件这条链就断：
 *
 * 1. 从用例清单里取出每条的 `expected_source` / `expectation_state`，喂给 R3 求出上限；
 * 2. 把执行器的 `passed` 按上限折算（pass → inconclusive），**fail 不折算**；
 * 3. 汇总时把折算掉的条数单独报出来，并且通过率的分母跟着改。
 *
 * 一条纪律：**降级只降不升**。执行器说 fail，预期再可信也不能变成 pass；执行器说 pass，
 * 预期不可信就降为 inconclusive。这是「不确定时拒绝给结论」在数据层的样子。
 */
import { applyCeiling, smokeEligible, auditExpectations, describeExpectationAudit } from './expected-source.mjs';

/**
 * 用例清单里一条用例的预期字段，可能叫好几种名字。
 *
 * 这不是「兼容历史包袱」，而是因为用例清单由 agent 产出、经 schema 校验，字段名在
 * `expectations`（新）与 `expected_source` + `assertions`（散装）之间都可能出现。
 * 统一收口在这里，好过让每个调用点各写一套 fallback。
 */
export function expectationOf(testCase) {
  if (Array.isArray(testCase?.expectations)) return { expectations: testCase.expectations };
  const assertions = Array.isArray(testCase?.assertions) ? testCase.assertions : [];
  return {
    expectations: assertions.map(item => ({
      ...item,
      // 散装形态里来源挂在用例级；断言级没有就继承用例级——这是最常见的写法。
      ...(item.source === undefined && testCase?.expected_source !== undefined ? { source: testCase.expected_source } : {}),
      ...(item.state === undefined && testCase?.expectation_state !== undefined ? { state: testCase.expectation_state } : {}),
    })),
  };
}

/** 用例清单 → `case_id → { 上限 }` 的索引。报告层按 case_id 查。 */
export function buildCeilingIndex(testCases) {
  const index = new Map();
  for (const testCase of Array.isArray(testCases) ? testCases : []) {
    const id = testCase?.case_id ?? testCase?.id;
    if (typeof id !== 'string' || !id) continue;
    const normalized = expectationOf(testCase);
    const result = applyCeiling('pass', normalized);
    index.set(id, {
      ceiling: result.ceiling,
      reason: result.reason,
      verified: result.verified,
      total: result.total,
      smoke: smokeEligible(normalized),
    });
  }
  return index;
}

const PASSED = new Set(['passed', 'pass']);
const DOWNGRADE_TO = 'inconclusive';

/**
 * 给一批执行结果套上限。
 *
 * 返回 `{ cases, downgraded, unmatched }`：
 *   - `downgraded` 是被拉低的条目（原结论 + 原因），报告要能逐条解释「为什么这条通过不算」；
 *   - `unmatched` 是执行结果里有、用例清单里没有的 case_id。**这一项不能忽略**：
 *     没有清单就没法判预期，而「没清单的结果」不该默认算通过。
 */
export function applyCeilings(rows, ceilingIndex) {
  const cases = [];
  const downgraded = [];
  const unmatched = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = ceilingIndex.get(row.case_id);
    if (!entry) {
      unmatched.push(row.case_id);
      // 没有用例清单依据的执行结果：保留原结论但标出来，降级判断交给报告层——
      // 直接拉低会让「清单缺失」看起来像「用例失败」，那是两个完全不同的问题。
      cases.push({ ...row, expectation: null, ceiling_applied: false, expectation_unknown: true });
      continue;
    }
    if (PASSED.has(row.status) && entry.ceiling !== 'pass') {
      downgraded.push({ case_id: row.case_id, from: row.status, to: DOWNGRADE_TO, reason: entry.reason });
      cases.push({ ...row, status: DOWNGRADE_TO, original_status: row.status, expectation: entry, ceiling_applied: true });
      continue;
    }
    cases.push({ ...row, expectation: entry, ceiling_applied: PASSED.has(row.status) });
  }
  return { cases, downgraded, unmatched };
}

/**
 * 汇总口径。**通过率的分母要跟着改**，否则降级只体现在明细里、看不见。
 *
 * `inflatedPassRate` 是「不套上限时会是的样子」——把两个数并排给出来，是让
 * 「预期收权」这件事在报告上有一个可对比的证据，而不是一句声明。
 */
export function summarizeWithCeilings(rows, ceilingIndex) {
  const applied = applyCeilings(rows, ceilingIndex);
  const counts = status => applied.cases.filter(row => row.status === status).length;
  const executed = applied.cases.filter(row => ['passed', 'failed', 'inconclusive'].includes(row.status)).length;
  const rawPassed = applied.cases.filter(row => PASSED.has(row.original_status ?? row.status)).length;
  const rawExecuted = applied.cases.filter(row => PASSED.has(row.original_status ?? row.status) || ['failed', 'inconclusive'].includes(row.status)).length;
  return {
    ...applied,
    summary: {
      total: applied.cases.length,
      passed: counts('passed'),
      failed: counts('failed'),
      inconclusive: counts('inconclusive'),
      blocked: counts('blocked'),
      skipped: counts('skipped'),
      downgraded: applied.downgraded.length,
      expectation_unknown: applied.unmatched.length,
    },
    /** 套上限后的通过率：分母不含 blocked/skipped/清单缺失。 */
    passRate: executed ? round(applied.cases.filter(row => row.status === 'passed').length / executed) : null,
    /** 不套上限时的通过率：用来对比，不是用来汇报的。 */
    inflatedPassRate: rawExecuted ? round(rawPassed / rawExecuted) : null,
  };
}

function round(value) {
  return Math.round(value * 1000) / 10;
}

/** 报告里那段话。措辞统一放在这里，避免每个调用方各写一套。 */
export function describeCeilings(summary) {
  if (summary.summary.downgraded === 0 && summary.summary.expectation_unknown === 0) {
    return `通过率 ${summary.passRate ?? '—'}%，没有因预期不可信而降级的用例。`;
  }
  const parts = [`通过率 ${summary.passRate ?? '—'}%`];
  if (summary.summary.downgraded > 0) {
    parts.push(`其中 ${summary.summary.downgraded} 条原本通过，因预期未被人工确认而降级为 inconclusive（不套上限时通过率为 ${summary.inflatedPassRate}%）`);
  }
  if (summary.summary.expectation_unknown > 0) {
    parts.push(`${summary.summary.expectation_unknown} 条执行结果在用例清单里找不到对应预期，无法判定其可信度`);
  }
  return `${parts.join('；')}。`;
}

export { auditExpectations, describeExpectationAudit };
