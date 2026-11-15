/**
 * 发版探针（L-5 落地，对应 §25.2 P1-7）。
 *
 * **要防的场景**：发版了，`maps_staleness` 还在按 14 天判「资产新鲜」。
 * 于是平台拿着按旧版本建档的元素库，跑一整轮回归，出一份 300 条的报告——
 * 里面 40% 的失败是「页面改版了」。这份报告一旦发出去，客户对平台的信任就没了，
 * 而且**这件事每次发版都会重演**。
 *
 * 正确顺序是：**先探针，后全量**。
 *
 *     构建号/资源指纹变化 → 20 条冒烟探针（3 分钟）→ 失败率 >20% 就不出全量报告
 *
 * ## 四条口径
 *
 * 1. **首次不发探针**。没有基线时记基线并放行——否则第一次上线就被自己的规则拦住。
 *    `no_baseline` 是一个明确状态，不是「无变化」。
 * 2. **阈值是 `> 20%`，不是 `>=`**。20 条里 4 条失败 = 20%，不拦；5 条才拦。
 *    「刚好卡在阈值上」最容易变成扯皮，所以边界写死并在结果里给出算式。
 * 3. **被拦不是不出结论**，是不出**全量**报告。探针报告照样出，`blocked_reason`
 *    直接指到「重建档」，而不是"建议重试"。
 * 4. **超预算算不可判**（`inconclusive`），不算失败也不算通过。3 分钟没跑完说明
 *    环境本身有问题，此时给任何结论都是猜。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROBE_SIZE = 20;
export const DEFAULT_THRESHOLD = 0.2;
export const DEFAULT_BUDGET_MS = 180_000;

/** 发布指纹：构建号 + 关键资源指纹。资源按路径排序后拼，保证同样内容得到同样结果。 */
export function fingerprintRelease(input = {}) {
  const buildId = typeof input.build_id === 'string' && input.build_id.trim() ? input.build_id.trim() : null;
  const assets = Array.isArray(input.assets)
    ? input.assets
      .filter(item => item && typeof item.path === 'string')
      .map(item => ({ path: item.path, sha256: typeof item.sha256 === 'string' ? item.sha256 : null, size: Number.isFinite(item.size) ? item.size : null }))
      .sort((a, b) => a.path.localeCompare(b.path))
    : [];
  const assetDigest = assets.length
    ? createHash('sha256').update(JSON.stringify(assets.map(item => [item.path, item.sha256 ?? item.size]))).digest('hex').slice(0, 16)
    : null;
  const digest = createHash('sha256').update(JSON.stringify([buildId, assetDigest])).digest('hex').slice(0, 16);
  return { build_id: buildId, assets, asset_digest: assetDigest, digest };
}

/**
 * 比对上一次记录与当前指纹。
 *
 * 没有构建号、也没有资源清单时返回 `changed: false, basis: 'unknown'`——
 * **不能因为「看不出来」就说「变了」**，那会让每次调用都触发一轮探针。
 * 但也不能说「没变」，所以状态单列成 `unknown`，由上层决定要不要按「变了」处理。
 */
export function detectRelease(previous, current) {
  if (!previous?.digest) {
    return { status: 'no_baseline', changed: false, basis: 'first_run', changes: [], note: '首次记录发布基线；本次不触发探针，否则第一次上线会被自己的规则拦住。' };
  }
  if (!current?.digest || (!current.build_id && !current.asset_digest)) {
    return { status: 'unknown', changed: false, basis: 'no_signal', changes: [], note: '既没有构建号也没有资源指纹，无法判断是否发版。此状态不触发探针，也不代表未发版。' };
  }
  const changes = [];
  if (previous.build_id !== current.build_id) changes.push({ field: 'build_id', from: previous.build_id, to: current.build_id });
  if (previous.asset_digest !== current.asset_digest) changes.push({ field: 'asset_digest', from: previous.asset_digest, to: current.asset_digest });
  return {
    status: changes.length ? 'changed' : 'unchanged',
    changed: changes.length > 0,
    basis: 'fingerprint',
    changes,
  };
}

/**
 * 选探针用例。
 *
 * 优先级：S1/P0 → 标签含 smoke → 其余；同优先级内按 `case_id` 排序，**确定性选择**。
 * 随机抽样会让「同一版本两次探针结论不同」，那比不探针更糟。
 *
 * 同时尽量覆盖不同模块：每个 module 先取一条，再按优先级补足——只挑一个模块的
 * 20 条，等于只探了那一个模块。
 */
export function planProbe(cases, { size = DEFAULT_PROBE_SIZE } = {}) {
  const pool = (cases ?? []).filter(item => item && typeof item.case_id === 'string');
  if (!pool.length) return { available: false, reason: 'no_cases', selected: [], note: '没有可用的冒烟用例集，探针无法执行。' };
  const weight = item => {
    const marks = [item.priority, item.severity, item.tag, ...(Array.isArray(item.tags) ? item.tags : [])]
      .filter(Boolean).map(value => String(value).toLowerCase());
    if (marks.some(mark => ['s1', 'p0', 'blocker', 'critical'].includes(mark))) return 0;
    if (marks.some(mark => ['smoke', '冒烟', 's2', 'p1'].includes(mark))) return 1;
    return 2;
  };
  const sorted = [...pool].sort((a, b) => weight(a) - weight(b) || a.case_id.localeCompare(b.case_id));
  const byModule = new Map();
  for (const item of sorted) {
    const module = item.module ?? item.module_name ?? '_';
    if (!byModule.has(module)) byModule.set(module, item);
  }
  const selected = [];
  const take = item => { if (item && !selected.some(row => row.case_id === item.case_id) && selected.length < size) selected.push(item); };
  for (const item of byModule.values()) take(item);
  for (const item of sorted) take(item);
  return {
    available: true,
    requested: size,
    selected: selected.map(item => ({ case_id: item.case_id, module: item.module ?? item.module_name ?? null, weight: weight(item) })),
    note: selected.length < size ? `可用用例不足 ${size} 条，实际使用 ${selected.length} 条。样本越小，失败率的偶然性越大。` : undefined,
  };
}

/**
 * 判定探针结果。
 *
 * `failure_rate` 只用 pass/fail 计算：`inconclusive` 既不算失败也不算通过——
 * 把它算成失败会误拦发版，算成通过会掩盖环境问题。所以它单独计数，
 * 数量超过一半则整体判不可判。
 */
export function evaluateProbe({ results = [], threshold = DEFAULT_THRESHOLD, budget_ms = DEFAULT_BUDGET_MS, elapsed_ms = 0 } = {}) {
  const rows = (results ?? []).filter(item => item && typeof item.status === 'string');
  const passed = rows.filter(item => item.status === 'passed').length;
  const failed = rows.filter(item => item.status === 'failed').length;
  const inconclusive = rows.filter(item => !['passed', 'failed'].includes(item.status)).length;
  const total = rows.length;

  if (!total) {
    return { status: 'inconclusive', blocked: false, total: 0, passed, failed, inconclusive, failure_rate: null, threshold, note: '没有任何探针结果，不能据此放行也不能据此拦截。' };
  }
  if (Number.isFinite(elapsed_ms) && elapsed_ms > budget_ms) {
    return {
      status: 'inconclusive', blocked: false, total, passed, failed, inconclusive,
      failure_rate: Math.round((failed / total) * 1000) / 1000, threshold, elapsed_ms, budget_ms,
      note: `探针超出 ${Math.round(budget_ms / 1000)}s 预算（实际 ${Math.round(elapsed_ms / 1000)}s）。给结论就是猜，先查环境。`,
    };
  }
  if (inconclusive > total / 2) {
    return {
      status: 'inconclusive', blocked: false, total, passed, failed, inconclusive,
      failure_rate: null, threshold,
      note: '过半探针不可判（环境/数据问题），失败率没有意义。先解决环境，再谈发版。',
    };
  }

  const failureRate = Math.round((failed / total) * 1000) / 1000;
  // 用整数比较避免 0.2 的浮点误差把 4/20 判成 >20%
  const exceeded = failed * 100 > threshold * 100 * total;
  return {
    status: exceeded ? 'probe_failed' : 'probe_passed',
    blocked: exceeded,
    total, passed, failed, inconclusive,
    failure_rate: failureRate,
    threshold,
    expression: `${failed}/${total} = ${(failureRate * 100).toFixed(1)}% ${exceeded ? '>' : '≤'} ${(threshold * 100).toFixed(0)}%`,
    blocked_reason: exceeded
      ? `探针失败率 ${(failureRate * 100).toFixed(1)}% 超过 ${(threshold * 100).toFixed(0)}%，不出全量报告。先按失败探针重建档（元素库/登录片段），再重跑全量——此时的「全量失败」大概率是资产过期，不是产品缺陷。`
      : null,
    note: exceeded ? '拦的是全量报告，不是本次结论：探针报告照常可看。' : undefined,
  };
}

/**
 * 串起来的一次判断：指纹 → 是否需要探针 → 探针结论 → 能不能出全量报告。
 *
 * `gate` 是给编排层看的唯一字段：
 *   allow_full_report: boolean     能不能出全量报告
 *   why: string                    一句话原因（要能直接写进报告首页）
 */
export function inspectReleaseProbe({ previous = null, current = null, cases = [], results = null, threshold = DEFAULT_THRESHOLD, budget_ms = DEFAULT_BUDGET_MS, elapsed_ms = 0, size = DEFAULT_PROBE_SIZE } = {}) {
  const release = detectRelease(previous, current);

  // 没变化 / 首次 / 看不出：都不拦
  if (release.status === 'no_baseline') {
    return { version: 1, release, probe: null, gate: { allow_full_report: true, why: '首次记录发布基线，未触发探针。' } };
  }
  if (release.status === 'unchanged') {
    return { version: 1, release, probe: null, gate: { allow_full_report: true, why: '发布指纹未变化，跳过探针。' } };
  }
  if (release.status === 'unknown') {
    return { version: 1, release, probe: null, gate: { allow_full_report: true, why: release.note } };
  }

  const plan = planProbe(cases, { size });
  if (!plan.available) {
    return { version: 1, release, probe: { plan, evaluation: null }, gate: { allow_full_report: true, why: '检测到发版但没有冒烟集，无法探针。此时的全量报告可能基于旧档，须在报告里标注。' } };
  }
  const evaluation = results ? evaluateProbe({ results, threshold, budget_ms, elapsed_ms }) : null;
  if (!evaluation) {
    return { version: 1, release, probe: { plan, evaluation: null }, gate: { allow_full_report: false, why: `检测到发版（${release.changes.map(item => item.field).join('+')} 变化），须先跑 ${plan.selected.length} 条冒烟探针。` } };
  }
  return {
    version: 1,
    release,
    probe: { plan, evaluation },
    gate: {
      allow_full_report: !evaluation.blocked,
      why: evaluation.blocked ? evaluation.blocked_reason : `发版探针通过（${evaluation.expression}），允许出全量报告。`,
    },
  };
}

/** 读/写发布基线，给编排层在每次执行前调用。 */
export function readReleaseBaseline(root, { name = 'default' } = {}) {
  const path = resolve(root, 'output/runtime/release-baseline.json');
  if (!existsSync(path)) return { version: 1, releases: {} };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return { version: 1, releases: value?.releases ?? {}, ...(value?.[name] ? { current: value[name] } : {}) };
  } catch { return { version: 1, releases: {} }; }
}

export function writeReleaseBaseline(root, fingerprint, { name = 'default' } = {}) {
  const path = resolve(root, 'output/runtime/release-baseline.json');
  const store = readReleaseBaseline(root);
  const next = { version: 1, updated_at: new Date().toISOString(), releases: { ...store.releases, [name]: { ...fingerprint, recorded_at: new Date().toISOString() } } };
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/release-probe.mjs --build=<id> [--assets=<json>]   */
/*        [--run-id=<run>] [--results=<json>] [--threshold=0.2]        */
/* ------------------------------------------------------------------ */

function loadArg(name) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const buildId = loadArg('build');
  const assetsRaw = loadArg('assets');
  if (!buildId && !assetsRaw) {
    console.error('用法: node scripts/release-probe.mjs --build=<build_id> [--assets=<path-or-json>] [--run-id=<run>] [--results=<json>] [--threshold=0.2]');
    process.exit(2);
  }
  let assets = [];
  if (assetsRaw) {
    assets = existsSync(resolve(root, assetsRaw)) ? JSON.parse(readFileSync(resolve(root, assetsRaw), 'utf8')) : JSON.parse(assetsRaw);
  }
  const store = readReleaseBaseline(root);
  const previous = store.releases.default ?? null;
  const current = fingerprintRelease({ build_id: buildId, assets });
  const result = inspectReleaseProbe({ previous, current });
  if (result.release.status !== 'unknown') writeReleaseBaseline(root, current);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
