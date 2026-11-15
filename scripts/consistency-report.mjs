/**
 * M1 一致性验收报告（§18.2 四条）。
 *
 * M1 的四条验收标准是硬门槛，「这 4 条不达标就不进 M2」：
 *
 * 1. 5 条用例 × 3 次执行 = 15 次，**结果 100% 一致**；
 * 2. 失败时取证包能定位原因（人工抽检 10 个失败，8 个能从取证包直接判断根因）；
 * 3. 单条用例执行耗时与资源占用被记录；
 * 4. 计划改动能产出**可读 diff**，人能在 10 分钟内改完一条用例。
 *
 * 这里能自动算的是 1 和 3，能给「可判依据」的是 2，第 4 条**只能人工**——
 * 「人能不能在 10 分钟内改完」没有程序判据。所以报告里第 4 条永远是 `manual`，
 * 不伪造一个 100%。
 *
 * ## 一致性怎么算才对
 *
 * 只看 `passed / failed`。`inconclusive` 单列：它是「判不了」，不是「不一致」。
 * 把 inconclusive 算进不一致，会把环境问题变成脚本不稳；算进一致，会把不确定性藏起来。
 *
 * 另一条：N=3 是**入库门**（§20.2.1），运行期按 L-6 分层采样。所以报告必须说清
 * 本轮是哪一种口径，否则「一致性 100%」会被误读成「每次回归都跑 3 遍」。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DECIDED = new Set(['passed', 'failed']);

function round(value, digits = 3) {
  return value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}

/**
 * 一致性。
 *
 * 返回每个用例的重复次数、判定一致性与不一致明细。
 * 「只有 1 次执行」的用例不算一致也不算不一致——**单次执行没有一致性可言**，
 * 把它算成一致是本报告最容易骗人的地方。
 */
export function evaluateConsistency({ runs = [], requiredRepeats = 3 } = {}) {
  const byCase = new Map();
  for (const row of runs ?? []) {
    const id = row?.case_id ?? row?.id;
    if (typeof id !== 'string') continue;
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id).push(row);
  }
  if (!byCase.size) {
    return { available: false, reason: 'no_runs', note: '没有执行记录，无法计算一致性。', cases: [], consistency_rate: null };
  }

  const cases = [];
  for (const [caseId, rows] of byCase) {
    const decided = rows.filter(row => DECIDED.has(row.status));
    const inconclusive = rows.filter(row => !DECIDED.has(row.status)).length;
    const statuses = [...new Set(decided.map(row => row.status))];
    const repeats = rows.length;
    const adequate = repeats >= requiredRepeats;
    cases.push({
      case_id: caseId,
      repeats,
      decided: decided.length,
      inconclusive,
      distinct_outcomes: statuses,
      // 只有「重复次数够 + 有可判结果」的用例才进一致率分母
      counted: adequate && decided.length >= 2,
      consistent: adequate && decided.length >= 2 ? statuses.length === 1 : null,
      outcomes: decided.map(row => ({ attempt: row.attempt ?? null, status: row.status, at: row.started_at ?? null })),
    });
  }

  const counted = cases.filter(item => item.counted);
  const consistent = counted.filter(item => item.consistent);
  const insufficient = cases.filter(item => !item.counted);
  const rate = counted.length ? round(consistent.length / counted.length) : null;
  const warnings = [];
  if (insufficient.length) warnings.push(`${insufficient.length} 条用例重复次数不足 ${requiredRepeats} 次或可判结果少于 2 次，未计入一致率——单次执行没有一致性可言。`);
  if (!counted.length) warnings.push('没有任何用例满足重复次数要求，一致率不可计算。不得据此声称「结果一致」。');

  return {
    available: counted.length > 0,
    required_repeats: requiredRepeats,
    scope: 'entry_gate',
    scope_note: `本口径为入库门 N=${requiredRepeats}；运行期按采样分层（L-6）并非每条都跑 ${requiredRepeats} 次。`,
    cases,
    counted: counted.length,
    consistent: consistent.length,
    inconsistency: counted.filter(item => !item.consistent).map(item => ({ case_id: item.case_id, outcomes: item.outcomes })),
    consistency_rate: rate,
    insufficient,
    warnings,
  };
}

/**
 * 取证包可定位性。
 *
 * 判据（全部可程序判）：失败记录是否带证据路径、错误类型、失败步骤。
 * 但「人能不能直接判断根因」仍需人工抽检——所以这里给的是 `locatable` 的**上限**，
 * 报告里要写明「这是可判依据的比例，不是人工抽检结论」。
 */
export function evaluateEvidence({ runs = [] } = {}) {
  const failures = (runs ?? []).filter(row => row?.status === 'failed');
  if (!failures.length) {
    return { available: false, reason: 'no_failures', note: '本轮没有失败记录，取证包可定位性不适用（不适用不等于满分）。', locatable_rate: null };
  }
  const locatable = failures.filter(row => {
    const paths = row.evidence_paths ?? row.evidence?.paths ?? [];
    const hasEvidence = Array.isArray(paths) && paths.length > 0;
    const hasError = Boolean(row.error?.type ?? row.error?.message ?? row.failure_summary);
    return hasEvidence && hasError;
  });
  return {
    available: true,
    failures: failures.length,
    locatable: locatable.length,
    locatable_rate: round(locatable.length / failures.length),
    missing_evidence: failures.filter(row => !locatable.includes(row)).map(row => row.case_id).slice(0, 20),
    note: '这是「失败记录里可判依据齐全」的比例，不等于人工抽检「能从取证包直接判断根因」的结论。后者需人工按 §18.2 抽 10 个失败判定。',
  };
}

/** 耗时。没有耗时记录时明确说没有，不拿 0 充数。 */
export function evaluateTiming({ runs = [] } = {}) {
  const durations = (runs ?? []).map(row => Number(row?.duration_ms)).filter(value => Number.isFinite(value) && value >= 0);
  if (!durations.length) {
    return { available: false, reason: 'no_duration', note: '执行记录没有 duration_ms，单条耗时未记录——M1 第 3 条不达标。' };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    available: true,
    samples: durations.length,
    total_ms: Math.round(durations.reduce((sum, value) => sum + value, 0)),
    p50_ms: Math.round(at(0.5)),
    p95_ms: Math.round(at(0.95)),
    max_ms: Math.round(sorted.at(-1)),
    note: '仅覆盖执行耗时；进程 CPU/内存占用需宿主侧采集，本仓未记录时应视为第 3 条只满足一半。',
  };
}

/**
 * 汇总四条。第 4 条永远 `manual`。
 *
 * `overall` 只在 1、2、3 都有结论时给 `ready`；任一项 `unknown`/不达标就是 `not_ready`。
 * 「不知道」不允许被当成「通过」。
 */
export function inspectM1({ runs = [], requiredRepeats = 3, diffReview = null } = {}) {
  const consistency = evaluateConsistency({ runs, requiredRepeats });
  const evidence = evaluateEvidence({ runs });
  const timing = evaluateTiming({ runs });

  const checks = [
    {
      id: 'consistency',
      label: 'N 次执行结果一致',
      standard: `${requiredRepeats} 次执行结果 100% 一致`,
      status: consistency.available ? (consistency.consistency_rate === 1 ? 'pass' : 'fail') : 'unknown',
      value: consistency.consistency_rate,
      detail: consistency.available
        ? `${consistency.consistent}/${consistency.counted} 条用例重复结果一致`
        : consistency.note ?? consistency.warnings?.[0],
    },
    {
      id: 'evidence',
      label: '失败可从取证包定位',
      standard: '抽检 10 个失败，8 个能直接判断根因（人工）',
      // 零失败 → not_applicable：该条的对象就是失败记录，没有失败就没有抽检对象。
      // 这与「查不了」不同——不适用不阻塞 overall，但也不算满分，报告里明说。
      status: evidence.available ? (evidence.locatable_rate >= 0.8 ? 'pass' : 'fail')
        : evidence.reason === 'no_failures' ? 'not_applicable' : 'unknown',
      value: evidence.locatable_rate,
      detail: evidence.note,
    },
    {
      id: 'timing',
      label: '单条耗时被记录',
      standard: '单条用例执行耗时与资源占用被记录',
      status: timing.available ? 'pass' : 'fail',
      value: timing.available ? timing.samples : null,
      detail: timing.note,
    },
    {
      id: 'diff',
      label: '计划改动可读 diff',
      standard: '人能在 10 分钟内改完一条用例',
      status: 'manual',
      value: null,
      detail: diffReview
        ? `人工结论：${diffReview.verdict}${diffReview.minutes ? `，单条改动耗时 ${diffReview.minutes} 分钟` : ''}。${diffReview.note ?? ''}`
        : '本条只能人工判定：程序无法判断「人改得快不快」。未提供人工结论前，不得声称第 4 条达标。',
    },
  ];

  const autoPass = checks.filter(item => ['pass', 'fail'].includes(item.status));
  const failed = autoPass.filter(item => item.status === 'fail');
  const unknown = checks.filter(item => item.status === 'unknown');
  // not_applicable 是「没有评估对象」，不是「没查出来」：与 manual 一样不阻塞，
  // 但也不能声称 ready——留 ready_pending_manual，等人工补结论。
  const overall = failed.length || unknown.length ? 'not_ready' : (checks.some(item => ['manual', 'not_applicable'].includes(item.status)) ? 'ready_pending_manual' : 'ready');

  const lines = [
    '# M1 一致性验收报告', '',
    `判定：**${overall}**`, '',
    '| # | 验收项 | 标准 | 结果 | 数值 |', '|---|---|---|---|---|',
    ...checks.map((item, index) => `| ${index + 1} | ${item.label} | ${item.standard} | ${item.status} | ${item.value === null ? '—' : item.value} |`),
    '', '## 逐项说明', '',
    ...checks.map((item, index) => `${index + 1}. **${item.label}**：${item.detail}`),
    '',
  ];
  for (const warning of [...(consistency.warnings ?? [])]) lines.push(`> ${warning}`);
  if (consistency.inconsistency?.length) {
    lines.push('', '### 不一致明细', '');
    for (const item of consistency.inconsistency) lines.push(`- ${item.case_id}：${item.outcomes.map(row => row.status).join(' / ')}`);
  }
  lines.push('', '## 口径', '', consistency.scope_note ?? '');

  return { version: 1, overall, checks, consistency, evidence, timing, markdown: lines.join('\n') + '\n' };
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/consistency-report.mjs --run-id=<run> [--repeats=3] */
/* ------------------------------------------------------------------ */

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

function collectRuns(dir) {
  const collected = [];
  for (const path of ['execution/test_results.json', 'execution/api/test_results.json']) {
    const value = readJson(resolve(dir, path));
    const rows = Array.isArray(value) ? value : value?.cases ?? value?.results ?? [];
    for (const row of Array.isArray(rows) ? rows : []) collected.push(row);
  }
  // 多次尝试：attempts 目录下的历史执行（存在则一并纳入）
  const attempts = resolve(dir, 'execution/attempts');
  if (existsSync(attempts)) {
    for (const name of readdirSync(attempts).sort()) {
      const value = readJson(resolve(attempts, name, 'test_results.json'));
      const rows = Array.isArray(value) ? value : value?.cases ?? [];
      for (const row of Array.isArray(rows) ? rows : []) collected.push({ ...row, attempt: name });
    }
  }
  return collected;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) {
    console.error('用法: node scripts/consistency-report.mjs --run-id=<run_id> [--repeats=3]');
    process.exit(2);
  }
  const repeats = Number(process.argv.find(arg => arg.startsWith('--repeats='))?.slice(10)) || 3;
  const dir = resolve(root, 'output/runs', runId);
  const runs = collectRuns(dir);
  const report = inspectM1({ runs, requiredRepeats: repeats });
  const target = resolve(dir, 'report/m1-consistency.md');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, report.markdown);
  console.log(JSON.stringify({ run_id: runId, overall: report.overall, checks: report.checks.map(({ detail, ...rest }) => rest), output: target }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
