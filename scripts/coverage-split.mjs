/**
 * 覆盖度拆分（P2-4 落地，对应 §25.3）。
 *
 * **问题**：矩阵里标了「这一格需要性能验证」，执行层没有压测能力，但覆盖度报表
 * 把它算成了「已覆盖」。于是报告上的 92% 里有 15 个百分点是**分配出来的**，不是**验出来的**。
 * 这种数字经不起追问，一次就够毁掉整份报告。
 *
 * 方案给的两条路：①补最小压测能力（M2）；②**报表显式拆「已执行 / 仅分配未执行」**。
 * 这里走 ②——因为它诚实，而且今天就能做。
 *
 * ## 一条口径
 *
 *     coverage_rate = executed / designed        （诚实的那个）
 *     optimistic_rate = (executed + assigned_only) / designed   （旧口径，只用于对比）
 *
 * 两个数并排给出来，是为了让「差在哪」看得见，而不是让人以为旧数字是错的。
 *
 * ## 什么算「已执行」
 *
 * 有结果记录，且状态属于 `passed / failed / inconclusive`。
 * `blocked` / `skipped` 不算——那是「没跑成」，把它算进覆盖是另一种注水。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXECUTED_STATUSES = new Set(['passed', 'failed', 'inconclusive']);

function layerOf(testCase) {
  // 用例的验证方式：优先显式字段，其次 type，最后按「未分类」处理
  const raw = testCase?.verify_mode ?? testCase?.verification_mode ?? testCase?.type ?? testCase?.execution_layer ?? null;
  if (typeof raw !== 'string' || !raw.trim()) return '未分类';
  const value = raw.trim();
  const upper = value.toUpperCase();
  if (['UI', 'WEB', 'BROWSER'].includes(upper)) return 'UI';
  if (['API', 'INTERFACE', 'HTTP'].includes(upper)) return '接口';
  if (/PERF|LOAD|STRESS|性能|压测/.test(upper)) return '性能';
  if (/SEC|安全|渗透/.test(upper)) return '安全';
  if (/APP|ANDROID|IOS|MINIPROGRAM|小程序/.test(upper)) return '端上';
  return value;
}

/**
 * 主函数。
 *
 * `results` 只用来判断「这条用例跑没跑」，不用来判断成败——
 * 覆盖度问的是「测没测」，不是「过没过」。混在一起会让失败率高的模块覆盖率看起来更低，
 * 那是另一个指标该说的事。
 */
export function inspectCoverage({ cases = [], results = [] } = {}) {
  const byCaseId = new Map();
  for (const result of results ?? []) {
    const id = result?.case_id ?? result?.id;
    if (typeof id !== 'string') continue;
    const previous = byCaseId.get(id);
    // 同一条用例多次执行：任一次真跑过就算已执行
    const executed = EXECUTED_STATUSES.has(result?.status);
    byCaseId.set(id, previous === true ? true : executed);
  }

  const designed = [];
  const seen = new Set();
  for (const testCase of cases ?? []) {
    const id = testCase?.case_id ?? testCase?.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    designed.push({ case_id: id, layer: layerOf(testCase) });
  }

  if (!designed.length) {
    return {
      version: 1,
      available: false,
      reason: 'no_design_cases',
      note: '没有设计用例清单，覆盖度拆分不适用。此结论不代表已覆盖，也不代表未覆盖。',
      coverage_rate: null,
    };
  }

  const executed = [];
  const assignedOnly = [];
  const byLayer = new Map();
  for (const item of designed) {
    const bucket = byLayer.get(item.layer) ?? { designed: 0, executed: 0, assigned_only: 0 };
    bucket.designed += 1;
    if (byCaseId.get(item.case_id) === true) { bucket.executed += 1; executed.push(item); }
    else { bucket.assigned_only += 1; assignedOnly.push(item); }
    byLayer.set(item.layer, bucket);
  }

  const rate = value => (designed.length ? Math.round((value / designed.length) * 1000) / 1000 : null);
  const missing = byCaseId.size ? [...byCaseId].filter(([, ran]) => !ran).length : 0;
  const warnings = [];
  if (assignedOnly.length) warnings.push(`${assignedOnly.length} 条设计用例只有验证方式分配、没有执行结果，不得计入已覆盖。`);
  if (byCaseId.size && designed.every(item => byCaseId.get(item.case_id) !== true)) warnings.push('有执行结果记录，但没有任何一条对应到设计用例——按 case_id 关联，先查 ID 是否一致。');
  if (missing) warnings.push(`${missing} 条结果记录状态为 blocked/skipped 或未执行，不计入覆盖。`);

  return {
    version: 1,
    available: true,
    designed: designed.length,
    executed: executed.length,
    assigned_only: assignedOnly.length,
    coverage_rate: rate(executed.length),
    /** 旧口径：把「仅分配」也算成覆盖。只用于并排对比，不用于汇报。 */
    optimistic_rate: rate(executed.length + assignedOnly.length),
    by_layer: Object.fromEntries([...byLayer].sort((a, b) => b[1].designed - a[1].designed)),
    assigned_only_cases: assignedOnly.slice(0, 50).map(item => ({ case_id: item.case_id, layer: item.layer })),
    warnings,
  };
}

/** 报告段落。两个数并排，说清差在哪。 */
export function renderCoverageSection(result) {
  if (!result?.available) return `覆盖度拆分：${result?.note ?? '无数据'}。`;
  const pct = value => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
  const layers = Object.entries(result.by_layer)
    .map(([layer, bucket]) => `${layer} ${bucket.executed}/${bucket.designed}`)
    .join('、');
  const lines = [
    `覆盖度（按设计用例计）：已执行 ${result.executed}/${result.designed} = ${pct(result.coverage_rate)}。`,
    `其中 ${result.assigned_only} 条仅分配了验证方式、没有执行结果，**不计入覆盖**（若按旧口径会显示为 ${pct(result.optimistic_rate)}）。`,
    layers ? `分层：${layers}。` : '',
  ];
  const gaps = Object.entries(result.by_layer).filter(([, bucket]) => bucket.assigned_only > 0).map(([layer, bucket]) => `${layer} ${bucket.assigned_only} 条`);
  if (gaps.length) {
    const perfOnly = Object.keys(result.by_layer).filter(layer => ['性能', '安全'].includes(layer));
    lines.push(`仅分配未执行的分布：${gaps.join('、')}。${perfOnly.length ? '性能/安全类当前只做到「分配」，未做到「执行」——报表不把它们算作覆盖是刻意的。' : ''}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`- ${warning}`);
  return lines.filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/coverage-split.mjs --run-id=<run_id>               */
/* ------------------------------------------------------------------ */

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) {
    console.error('用法: node scripts/coverage-split.mjs --run-id=<run_id>');
    process.exit(2);
  }
  const dir = resolve(root, 'output/runs', runId);
  const cases = readJson(resolve(dir, 'design/test_cases.json')) ?? [];
  const resultsFile = readJson(resolve(dir, 'execution/test_results.json'))
    ?? readJson(resolve(dir, 'execution/api/test_results.json'));
  const results = Array.isArray(resultsFile) ? resultsFile : resultsFile?.results ?? resultsFile?.cases ?? [];
  const result = inspectCoverage({ cases: Array.isArray(cases) ? cases : cases?.cases ?? [], results });
  const target = resolve(dir, 'execution/coverage-split.json');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ run_id: runId, ...result }, null, 2)}\n`);
  console.log(JSON.stringify({ run_id: runId, ...result, output: target }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
