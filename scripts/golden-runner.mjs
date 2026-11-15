/**
 * golden set 运行器（L-4 落地，对应 §19.5 / 评审 P1-2）。
 *
 * ## 它解决的那个尴尬
 *
 * 确定性代码能写单测，LLM 输出天然不稳定，用「输出完全相等」去断言必然全红，
 * 于是大家干脆不测。结果是：**改一个提示词，输出全变，没人知道变好还是变坏**。
 * 评审问「你怎么证明上周那个 prompt 改动没让测试点质量下降」，答不上来。
 *
 * 所以这里**不断言原文**，只断言六类结构特征——全部可由程序判定，零 LLM：
 *
 * | 断言 | 抓什么 |
 * |---|---|
 * | 结构合法 | 模型跑偏格式 |
 * | 条目数量区间 | 漏抽 / 幻觉膨胀 |
 * | 必含关键词 | 抓错重点 |
 * | **不得含关键词** | **幻觉**（最该拦的一类） |
 * | 引用完整性 | 编造原文位置 |
 * | 越权字段为零 | 权限回归 |
 *
 * ## 两个不肯让步的设计
 *
 * 1. **没有基线时结论是 `no_baseline`，不是 `pass`。**
 *    首次跑当然全绿——但那只是「记录了一次」，不是「质量通过」。把它叫 pass，
 *    等于从第一天就给自己发了一张假的合格证。
 * 2. **退化用「错误率上升幅度」判，不用「某条挂了」。**
 *    LLM 输出本来就会抖；单条失败就拦，会让人习惯性重跑直到绿，门禁随即失效。
 *    所以看的是 `rate_now - rate_baseline > tolerance`，默认 5pp。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GOLDEN_DIR = 'tests/golden';
/** 越权字段：agent 输出里出现这些，说明权限收窄被绕过（§17.8）。 */
export const DEFAULT_FORBIDDEN_FIELDS = ['approved_by', 'confirmed_by', 'verdict', 'engine_version', 'evidence_ref', 'executed_at', 'signature'];

/** 文本归一化：全角半角、空白、标点差异不该让「引用完整」判失败。 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。；：、！？,.;:!?"'“”‘’()（）【】\[\]]/g, '')
    .toLowerCase();
}

function readPath(object, path) {
  if (!path) return object;
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

function walkKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) walkKeys(item, out); return out; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.add(key); walkKeys(item, out); }
  }
  return out;
}

function collectText(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectText(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectText(item, out);
  return out;
}

function collectRefs(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) collectRefs(item, out); return out; }
  if (value && typeof value === 'object') {
    if (value.source && typeof value.source === 'object') {
      for (const key of ['ref', 'quote', 'text', 'locator']) {
        if (typeof value.source[key] === 'string' && value.source[key].trim()) out.push({ kind: key, value: value.source[key] });
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'source') continue;
      if (key === 'citations' && Array.isArray(item)) {
        for (const entry of item) if (typeof entry?.quote === 'string') out.push({ kind: 'quote', value: entry.quote });
      }
      collectRefs(item, out);
    }
  }
  return out;
}

/**
 * 单条样本的六类断言。
 *
 * 返回 `problems[]` 与 `metrics`（每类一个计数），两者都要：
 * 结论靠 problems，趋势靠 metrics。只留 problems 就没法算退化。
 */
export function checkSample(sample, output) {
  const problems = [];
  const metrics = { schema_invalid: 0, count_out_of_range: 0, missing_keyword: 0, hallucination: 0, broken_citation: 0, unauthorized_field: 0 };
  const expect = sample?.expect ?? {};
  const caseId = sample?.id ?? '(unnamed)';

  if (output === null || output === undefined) {
    problems.push({ kind: 'schema_invalid', detail: `${caseId}: 没有任何输出` });
    metrics.schema_invalid += 1;
    return { case_id: caseId, problems, metrics, ok: false };
  }

  // —— 1. 结构合法 ——
  for (const path of expect.required ?? []) {
    const value = readPath(output, path);
    // 空数组不算「缺字段」：空输出是合法结果（如空输入），由条目数量断言去管它
    if (value === undefined || value === null) {
      problems.push({ kind: 'schema_invalid', detail: `${caseId}: 缺必需字段 ${path}` });
      metrics.schema_invalid += 1;
    }
  }
  if (expect.root_type === 'array' && !Array.isArray(output)) {
    problems.push({ kind: 'schema_invalid', detail: `${caseId}: 顶层必须是数组` });
    metrics.schema_invalid += 1;
  }

  // —— 2. 条目数量区间 ——
  if (typeof expect.items_path === 'string' && Number.isFinite(expect.expected_count)) {
    const items = readPath(output, expect.items_path);
    const count = Array.isArray(items) ? items.length : null;
    // 区间固定为 0.7~1.3 倍（§19.5 原话）。不做可配置：区间一宽，漏抽就抓不到了
    const low = expect.expected_count * 0.7;
    const high = expect.expected_count * 1.3;
    if (count === null) {
      problems.push({ kind: 'count_out_of_range', detail: `${caseId}: ${expect.items_path} 不是数组` });
      metrics.count_out_of_range += 1;
    } else if (count < low || count > high) {
      problems.push({ kind: 'count_out_of_range', detail: `${caseId}: 条数 ${count} 超出 [${Math.floor(low)}, ${Math.ceil(high)}]（期望 ${expect.expected_count}）` });
      metrics.count_out_of_range += 1;
    }
  }

  const texts = collectText(output);
  const flat = normalizeText(texts.join('\n'));

  // —— 3. 必含关键词 ——
  for (const keyword of expect.must_include ?? []) {
    if (!flat.includes(normalizeText(keyword))) {
      problems.push({ kind: 'missing_keyword', detail: `${caseId}: 缺核心术语「${keyword}」` });
      metrics.missing_keyword += 1;
    }
  }

  // —— 4. 不得含关键词（幻觉） ——
  for (const keyword of expect.must_not_include ?? []) {
    if (keyword && flat.includes(normalizeText(keyword))) {
      problems.push({ kind: 'hallucination', detail: `${caseId}: 出现输入中不存在的内容「${keyword}」` });
      metrics.hallucination += 1;
    }
  }

  // —— 5. 引用完整性 ——
  if (expect.check_citations !== false) {
    const sourceText = normalizeText(expect.citation_source ?? sample?.input?.text ?? '');
    if (sourceText) {
      for (const ref of collectRefs(output)) {
        if (ref.kind === 'ref' && !normalizeText(ref.value)) continue;
        const probe = normalizeText(ref.value);
        // 短引用（<4 字）不做子串比对：单字命中没有意义，反而制造假阳性
        if (probe.length < 4) continue;
        if (!sourceText.includes(probe)) {
          problems.push({ kind: 'broken_citation', detail: `${caseId}: 引用无法反查原文（${ref.kind}）: ${String(ref.value).slice(0, 40)}` });
          metrics.broken_citation += 1;
        }
      }
    }
  }

  // —— 6. 越权字段为零 ——
  const forbidden = expect.forbidden_fields ?? DEFAULT_FORBIDDEN_FIELDS;
  const keys = walkKeys(output);
  for (const field of forbidden) {
    if (keys.has(field)) {
      problems.push({ kind: 'unauthorized_field', detail: `${caseId}: 出现越权字段 ${field}` });
      metrics.unauthorized_field += 1;
    }
  }

  return { case_id: caseId, problems, metrics, ok: problems.length === 0 };
}

/** 汇总：通过数、六类计数、以及每一类占全部样本的比例（退化判定用比例，不用绝对数）。 */
export function summarize(results) {
  const total = results.length;
  const metrics = { schema_invalid: 0, count_out_of_range: 0, missing_keyword: 0, hallucination: 0, broken_citation: 0, unauthorized_field: 0 };
  for (const result of results) for (const key of Object.keys(metrics)) metrics[key] += result.metrics[key] ?? 0;
  const rates = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, total ? Math.round((value / total) * 1000) / 1000 : 0]));
  return {
    samples: total,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    metrics,
    rates,
  };
}

/**
 * 与基线比较退化。
 *
 * 没有基线 → `no_baseline`。**这不是通过**，是「记录了一次」。
 */
export function compareToBaseline(current, baseline, { tolerance = 0.05 } = {}) {
  if (!baseline?.rates) {
    return { verdict: 'no_baseline', regressions: [], note: '首次记录基线。此结论不代表质量通过，只代表下次有得比。' };
  }
  const regressions = [];
  for (const [key, rate] of Object.entries(current.rates)) {
    const before = baseline.rates[key] ?? 0;
    const delta = Number((rate - before).toFixed(3));
    if (delta > tolerance) regressions.push({ metric: key, baseline: before, current: rate, delta });
  }
  return {
    verdict: regressions.length ? 'regression' : 'pass',
    regressions,
    tolerance,
    note: regressions.length
      ? `错误率上升超过 ${tolerance * 100}pp：${regressions.map(item => `${item.metric} ${item.baseline}→${item.current}`).join('；')}。不允许「先合再修」。`
      : `各项错误率相对基线波动在 ${tolerance * 100}pp 内。`,
  };
}

/** 读 8 个 LLM 点的登记表。没登记的点不能假装覆盖了。 */
export function listPoints(root) {
  const path = resolve(root, GOLDEN_DIR, 'index.json');
  if (!existsSync(path)) return { version: 1, points: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { version: 1, points: [], error: 'index 不可读' }; }
}

export function loadSuite(root, task) {
  const dir = resolve(root, GOLDEN_DIR, task);
  if (!existsSync(dir)) return null;
  const samples = readdirSync(dir)
    .filter(name => name.endsWith('.json') && name !== 'baseline.json')
    .sort()
    .flatMap(name => {
      const value = JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
      return Array.isArray(value) ? value : [value];
    });
  const baselinePath = resolve(dir, 'baseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  return { task, dir, samples, baseline };
}

/**
 * 跑一个点。
 *
 * `produce(sample)` 返回该样本的输出。默认走 `sample.recorded_output`（录制回放），
 * 这样框架本身可以在没有模型密钥的环境里被验证——**框架能不能用，不该取决于今天有没有额度**。
 */
export async function runSuite(root, task, { produce = null } = {}) {
  const suite = loadSuite(root, task);
  if (!suite) return { task, available: false, reason: 'no_suite', note: `没有 ${GOLDEN_DIR}/${task} 样本目录。` };
  if (!suite.samples.length) return { task, available: false, reason: 'empty_suite', note: `${task} 样本目录为空。` };
  const mode = produce ? 'live' : 'replay';
  const results = [];
  for (const sample of suite.samples) {
    const output = produce ? await produce(sample) : (sample.recorded_output ?? null);
    results.push(checkSample(sample, output));
  }
  const current = summarize(results);
  const comparison = compareToBaseline(current, suite.baseline);
  return {
    task,
    available: true,
    mode,
    ...current,
    baseline: suite.baseline?.rates ?? null,
    ...comparison,
    failures: results.filter(item => !item.ok).map(item => ({ case_id: item.case_id, problems: item.problems })),
  };
}

/** 把本次结果写成新基线。只有人明确要求时才写——门禁自动刷新基线等于没有门禁。 */
export function recordBaseline(root, task, runResult) {
  const path = resolve(root, GOLDEN_DIR, task, 'baseline.json');
  mkdirSync(resolve(path, '..'), { recursive: true });
  const value = { version: 1, recorded_at: new Date().toISOString(), samples: runResult.samples, rates: runResult.rates };
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/golden-runner.mjs [--task=<name>|--all] [--record] */
/* ------------------------------------------------------------------ */

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const task = process.argv.find(arg => arg.startsWith('--task='))?.slice(7) ?? null;
  const all = process.argv.includes('--all');
  const record = process.argv.includes('--record');
  const index = listPoints(root);
  if (!task && !all) {
    const ready = index.points.filter(point => point.status === 'ready');
    const pending = index.points.filter(point => point.status !== 'ready');
    console.log(JSON.stringify({
      points: index.points.length,
      ready: ready.map(point => point.task),
      pending: pending.map(point => point.task),
      note: '未登记的点不算已覆盖。用 --task=<name> 跑单个点，--all 跑所有 ready 点。',
    }, null, 2));
    return;
  }
  const tasks = task ? [task] : index.points.filter(point => point.status === 'ready').map(point => point.task);
  const outputs = [];
  let exitCode = 0;
  for (const name of tasks) {
    const result = await runSuite(root, name);
    outputs.push(result);
    if (record && result.available) recordBaseline(root, name, result);
    if (result.verdict === 'regression') exitCode = 1;
  }
  console.log(JSON.stringify(outputs, null, 2));
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
