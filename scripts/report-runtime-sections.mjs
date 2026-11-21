/**
 * 报告里的「运行时事实」段（P2-4 + 上一轮遗留的落地）。
 *
 * 上一轮把工具闸门接上了，但软依赖的降级只写进 action 回执——**报告上一个字都没有**。
 * 看报告的人不会去翻回执，于是「本次回归的选集口径未生效」这件事等于没发生。
 * 纪律降级而报告不提，比不降级更糟：它让人以为查过了。
 *
 * 这一段把六件事搬到报告正面上：
 *
 * 1. 工具降级（哪条纪律没生效、发生几次）；
 * 2. 外部依赖桩（声明/降级/保留失败）；
 * 3. 需求完备性（分母修正的依据）；
 * 4. 缺陷根因聚类（40 张单其实是几组）；
 * 5. 覆盖度拆分（已执行 vs 仅分配）；
 * 6. 数据生命周期（data_residue 清理失败不许静默，P1-6）。
 *
 * ## 一条原则：缺的要说「未生成」
 *
 * 产物不存在时**不省略**，写「本轮未生成」。省掉一行，读者会以为那项检查通过了；
 * 写上「未生成」，读者至少知道该去问为什么。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeTrace } from './trace.mjs';
import { renderClusterSummary } from './defect-cluster.mjs';
import { renderCoverageSection, inspectCoverage } from './coverage-split.mjs';
import { inspectCompleteness } from './requirement-completeness.mjs';
import { renderLifecycleSection } from './data-lifecycle.mjs';

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

/**
 * 现场计算兜底。
 *
 * 报告不能要求人「先手动跑一遍 CLI」才肯显示覆盖度与完备性——那样这两段永远空着。
 * 产物文件存在就用文件（它是某次明确的执行留下的），不存在就用当前输入现算，
 * 并标注 `derived: true`，让读者知道这不是某次独立检查的存证。
 */
function deriveCoverage(dir) {
  try {
    const cases = readJson(resolve(dir, 'design/test_cases.json'));
    if (!cases) return null;
    const resultsFile = readJson(resolve(dir, 'execution/test_results.json')) ?? readJson(resolve(dir, 'execution/api/test_results.json'));
    const results = Array.isArray(resultsFile) ? resultsFile : resultsFile?.results ?? resultsFile?.cases ?? [];
    const result = inspectCoverage({ cases: Array.isArray(cases) ? cases : cases?.cases ?? [], results });
    return result.available ? { ...result, derived: true } : null;
  } catch { return null; }
}

function deriveCompleteness(dir) {
  try {
    const ledger = readJson(resolve(dir, 'analysis/requirement-ledger.json'));
    if (!ledger) return null;
    const result = inspectCompleteness(ledger);
    return result.available ? { ...result, derived: true } : null;
  } catch { return null; }
}

function traceDigest(dir) {
  const path = resolve(dir, 'traces/trace.jsonl');
  if (!existsSync(path)) return null;
  const counts = new Map();
  let total = 0;
  let failed = 0;
  const tools = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    total += 1;
    if (row.ok !== true) failed += 1;
    for (const name of Array.isArray(row.degraded) ? row.degraded : []) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of Array.isArray(row.tools) ? row.tools : []) tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return {
    total,
    failed,
    degraded: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
    tools: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * 组装段落。
 *
 * `dir` 是 run 目录。所有产物都是「有就读、没有就说没有」，不抛错——
 * 报告生成不能因为一个可选产物缺失而整体失败。
 */
export function buildRuntimeSections({ dir, root = null } = {}) {
  const data = {};
  const lines = ['## 运行时事实', ''];

  // —— 1. 工具与纪律 ——
  const trace = traceDigest(dir);
  const state = root ? readJson(resolve(root, 'config/tool-runtime-state.json')) : null;
  const disabled = Array.isArray(state?.disabled) ? state.disabled : [];
  if (trace) {
    data.trace = trace;
    lines.push(`本次共 ${trace.total} 次结构化动作调用，失败 ${trace.failed} 次。`);
    if (Object.keys(trace.degraded).length) {
      lines.push(`**纪律降级：${Object.entries(trace.degraded).map(([name, n]) => `${name}×${n}`).join('、')}**。降级意味着该 action 照常执行，但对应校验没有生效——本次结论未包含这层检查。`);
    } else {
      lines.push('本次没有发生纪律降级。');
    }
  } else {
    lines.push('本次未生成调用轨迹（traces/trace.jsonl）。无法核对纪律是否生效。');
  }
  if (disabled.length) {
    lines.push(`报告生成时处于停用状态的工具：${disabled.join('、')}。这些能力在本轮不参与判定。`);
  }
  data.disabled_tools = disabled;

  // —— 1b. 阶段工具降级（admin-tool-console §8 差距①）——
  // run_stage_tool 的降级/停用此前只进流水（tool-usage.jsonl）与健康端点，报告一字未提：
  // 「irval 没跑成」这类事实对看报告的人等于没发生。口径与 qa-run-health.ts 一致：
  // execution 行计调用与降级，本 run 无任何行时如实说明（不编 0、不编降级）。
  const runId = readJson(resolve(dir, 'manifest.json'))?.run_id ?? null;
  const usagePath = root ? resolve(root, 'output/runtime/tool-usage.jsonl') : null;
  if (runId && usagePath && existsSync(usagePath)) {
    const rows = [];
    for (const line of readFileSync(usagePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row?.run_id === runId) rows.push(row); } catch { continue; }
    }
    if (rows.length) {
      const degraded = new Set();
      let invoked = 0;
      for (const row of rows) {
        if (row.kind === 'execution') {
          invoked += 1;
          for (const item of Array.isArray(row.degraded) ? row.degraded : []) if (typeof item === 'string') degraded.add(item);
        }
      }
      data.stage_tools = { rows: rows.length, invoked, degraded: [...degraded].sort() };
      if (degraded.size) {
        lines.push(`**阶段工具降级：${[...degraded].sort().join('、')}**。降级意味着该阶段的确定性检查未按完整契约生效——相关结论缺少这层校验，按 partial 口径理解。`);
      } else {
        lines.push(`本次共 ${invoked} 次阶段工具执行，无降级。`);
      }
    } else {
      lines.push('本轮没有阶段工具调用流水（tool-usage.jsonl 无本 run 条目）——阶段级确定性检查是否执行，以阶段回执为准。');
    }
  }

  // —— 2. 外部依赖桩 ——
  const stubReport = readJson(resolve(dir, 'execution/execution-summary.json'));
  const stubs = stubReport?.stubs ?? null;
  if (stubs?.applied) {
    data.stubs = stubs;
    lines.push(`外部依赖桩：已声明 ${stubs.declared?.length ?? 0} 个${stubs.downgraded?.length ? `；${stubs.downgraded.length} 条因依赖不可用降为 inconclusive` : ''}${stubs.kept_fail?.length ? `；${stubs.kept_fail.length} 条依赖已打桩仍失败，按真问题计入` : ''}。`);
  } else {
    lines.push('本轮未提供外部依赖桩声明。若存在第三方依赖，环境类失败会被计为产品失败。');
  }

  // —— 3. 需求完备性 ——
  // The current ledger wins over an older standalone check without source hashes.
  const completeness = disabled.includes('requirement.completeness') ? null
    : existsSync(resolve(dir, 'analysis/requirement-ledger.json'))
      ? deriveCompleteness(dir) : readJson(resolve(dir, 'analysis/requirement-completeness.json'));
  if (completeness?.available) {
    data.requirement_completeness = completeness;
    const label = completeness.score === null ? '无法判定' : `${(completeness.score * 100).toFixed(0)}%`;
    lines.push(`需求完备性：${label}（覆盖 ${completeness.denominator.covered} 项、缺失 ${completeness.denominator.missing} 项、无法判定 ${completeness.denominator.unknown} 项）。无法判定的项不计入分数，也不等于已覆盖。${completeness.derived ? '（本条为报告生成时现算，非独立检查存证）' : ''}`);
    for (const check of completeness.checks ?? []) {
      if (check.status !== 'missing') continue;
      const detail = Array.isArray(check.missing) && check.missing.length
        ? check.missing.map(item => item.detail ?? item.entity ?? '').filter(Boolean).join('；')
        : '';
      lines.push(`- 缺「${check.label}」${detail ? `：${detail}` : ''}`);
    }
  } else {
    lines.push(disabled.includes('requirement.completeness')
      ? '需求完备性工具已停用，本轮不执行该检查。覆盖率分母未做修正。'
      : '本轮未生成需求完备性检查。覆盖率分母未做修正——此时的分母只含「已写下来的需求」。');
  }

  // —— 4. 缺陷聚类 ——
  const clusters = readJson(resolve(dir, 'defects/root-cause-clusters.json'));
  if (clusters) {
    data.root_cause_clusters = { stats: clusters.stats, merge_safety: clusters.merge_safety };
    lines.push(renderClusterSummary(clusters));
    if (clusters.stats?.tickets_before > clusters.stats?.groups_after) {
      lines.push(`> 聚类只改展示分组，不合并缺陷单：${clusters.stats.tickets_before} 张单仍各自可提单、可流转。`);
    }
  } else {
    lines.push('本轮未生成缺陷根因聚类。缺陷单数量即为逐条数量。');
  }

  // —— 5. 覆盖度 ——
  // Do not let a previous split mask changed case or execution result files.
  const coverage = disabled.includes('coverage.split') ? null
    : existsSync(resolve(dir, 'design/test_cases.json'))
      ? deriveCoverage(dir) : readJson(resolve(dir, 'execution/coverage-split.json'));
  if (coverage) {
    data.coverage = { coverage_rate: coverage.coverage_rate, optimistic_rate: coverage.optimistic_rate, assigned_only: coverage.assigned_only };
    lines.push(renderCoverageSection(coverage));
  } else {
    lines.push(disabled.includes('coverage.split')
      ? '覆盖度拆分工具已停用，本轮不执行该检查。'
      : '本轮未生成覆盖度拆分。若报表给出覆盖率，其口径未区分「已执行」与「仅分配」。');
  }

  // —— 6. 数据生命周期（P1-6）——
  const lifecycle = readJson(resolve(dir, 'execution/data-lifecycle.json'));
  if (lifecycle) {
    data.data_lifecycle = { available: lifecycle.available, residue: lifecycle.data_residue?.length ?? 0, findings: lifecycle.findings?.length ?? 0 };
    lines.push(renderLifecycleSection(lifecycle));
  } else {
    lines.push('本轮未生成数据生命周期检查。若执行写入了数据，这部分不在任何清理机制之内，残留会污染后续轮次。');
  }

  return { markdown: lines.join('\n') + '\n', data };
}

export { summarizeTrace };
