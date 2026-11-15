/**
 * 缺陷根因聚类（L-9 落地，对应 §25.2 P1-4）。
 *
 * **要解决的具体场景**：后端某个接口 500，40 条用例打穿。缺陷指纹里含 `cases`，
 * 40 条用例就是 40 个不同指纹 → **开 40 张单**。评审看到的是「40 个缺陷」，
 * 实际是 1 个。反过来，如果按标题合并，又会把「同样报 500 但根因不同」的缺陷合掉，
 * 漏真缺陷——两种错都发生过，所以这里只做**展示分组**，不动缺陷单。
 *
 * 聚类键：`error.type + 顶层堆栈帧 + 接口路径`（方案给的三个维度）。
 * 三者都拿不到就不聚——用标题相似度凑一组，是这套东西最容易变味的地方。
 *
 * 两条归一化，缺一条聚类就废：
 *
 * 1. **栈帧去行列号**。同一个 bug 在不同构建里行号会飘，带行号必然分裂。
 * 2. **路径动态段换成 `:id`**。40 条用例各查不同订单，`/orders/123` 与 `/orders/456`
 *    是同一处代码，不归一化就还是 40 组。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, unknown: 4 };

/** 栈顶帧归一化：`at fn (/a/b/c.js:12:34)` → `fn(/a/b/c.js)`。 */
export function normalizeFrame(frame) {
  if (typeof frame !== 'string') return null;
  const line = frame.split('\n').map(item => item.trim()).find(item => item.startsWith('at ')) ?? frame.trim();
  if (!line) return null;
  // 只去行号列号，不动括号——括号是「函数名 (文件)」的结构，去了就分不清谁是谁
  return line
    .replace(/^at\s+/, '')
    .replace(/\(?file:\/\//, '(')
    .replace(/:\d+:\d+(?=\))/g, '')
    .replace(/:\d+:\d+$/, '')
    .trim() || null;
}

/**
 * 接口路径归一化。
 *
 * 数字段与 UUID 一律换成 `:id`：用例换了数据不该分出第二个根因。
 * 版本号（`/v2/`）保留——那是不同路由，不是同一处代码。
 */
export function normalizePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const path = rawPath.split('?')[0].trim();
  if (!path.startsWith('/')) return null;
  return path
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** 从任意文本里捞接口路径与方法。捞不到返回 null，不猜。 */
export function extractEndpoint(text) {
  if (typeof text !== 'string') return null;
  const withMethod = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-.~%/{}\[\]]+)/i);
  const bare = text.match(/(?:path|url|endpoint|接口)\s*[=:：]\s*["']?(\/[\w\-.~%/{}\[\]]+)/i);
  const raw = withMethod?.[2] ?? bare?.[1] ?? null;
  const path = normalizePath(raw);
  if (!path) return null;
  return { method: withMethod?.[1]?.toUpperCase() ?? null, path };
}

/** 错误类型归一化：`TypeError: x is not a function` → `TypeError`；`HTTP 500` → `HTTP500`。 */
export function extractErrorType(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const named = text.match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/);
  if (named) return named[1];
  const status = text.match(/\b(?:HTTP\s*)?([45]\d{2})\b/);
  if (status) return `HTTP${status[1]}`;
  if (/timeout|timed out|超时/i.test(text)) return 'Timeout';
  if (/ECONNREFUSED|connection refused|连接被拒/i.test(text)) return 'ConnectionRefused';
  if (/assert|expected .* to (equal|be|match|contain)/i.test(text)) return 'AssertionFailed';
  return null;
}

function collectErrorText(record, resultsByCase) {
  const texts = [];
  const push = value => { if (typeof value === 'string' && value.trim()) texts.push(value); };
  push(record?.actual_result);
  push(record?.analysis);
  push(record?.title);
  if (record?.error && typeof record.error === 'object') {
    push(record.error.type);
    push(record.error.message);
    push(record.error.stack);
    push(record.error.path);
    push(record.error.url);
  }
  for (const caseId of record?.related_cases ?? []) {
    const result = resultsByCase.get(caseId);
    if (!result) continue;
    push(result.error?.type);
    push(result.error?.message);
    push(result.error?.stack);
    push(result.failure_summary);
    push(result.message);
    push(result.output);
  }
  return texts;
}

/**
 * 抽一条记录的根因签名。
 *
 * 三个维度任一为空就返回 null——**半截签名比没有签名更危险**：
 * 只有 type 的组会把「所有 Timeout」聚成一簇，看起来像发现了一个大根因。
 */
export function extractSignature(record, resultsByCase = new Map()) {
  const texts = collectErrorText(record, resultsByCase);
  const stackText = texts.find(text => /^\s*at\s+/m.test(text) || /\n\s+at\s+/.test(text)) ?? null;
  const errorType = texts.map(extractErrorType).find(Boolean) ?? null;
  const endpoint = texts.map(extractEndpoint).find(Boolean) ?? null;
  const frame = stackText ? normalizeFrame(stackText) : null;

  // type 可以从 status/timeout 推；frame/path 必须有原文证据，不能推。
  if (!errorType) return null;
  if (!frame && !endpoint) return null;
  return {
    key: `${errorType}|${frame ?? '-'}|${endpoint ? `${endpoint.method ?? '-'} ${endpoint.path}` : '-'}`,
    error_type: errorType,
    top_frame: frame,
    endpoint: endpoint?.path ?? null,
    method: endpoint?.method ?? null,
  };
}

function clusterId(key) {
  return `RC-${createHash('sha1').update(key).digest('hex').slice(0, 8).toUpperCase()}`;
}

function rank(record) {
  return SEVERITY_RANK[record?.severity] ?? SEVERITY_RANK.unknown;
}

/**
 * 聚合。
 *
 * `minSize` 默认 2：单条构不成「聚类」。1 条也成组只会让报告多一层噪音，
 * 而人要看的是「这 40 张单其实是 1 个问题」。
 */
export function buildClusters(records, { results = [], minSize = 2 } = {}) {
  const resultsByCase = new Map();
  for (const result of results ?? []) {
    const id = result?.case_id ?? result?.id;
    if (typeof id === 'string') resultsByCase.set(id, result);
  }
  const groups = new Map();
  const unsignatured = [];
  for (const record of records ?? []) {
    const signature = extractSignature(record, resultsByCase);
    if (!signature) { unsignatured.push(record.defect_id ?? record.fingerprint ?? null); continue; }
    if (!groups.has(signature.key)) groups.set(signature.key, { signature, members: [] });
    groups.get(signature.key).members.push(record);
  }

  const clusters = [...groups.values()]
    .filter(group => group.members.length >= minSize)
    .map(group => {
      const members = [...group.members].sort((a, b) => rank(a) - rank(b) || String(a.defect_id).localeCompare(String(b.defect_id)));
      const cases = [...new Set(members.flatMap(item => item.related_cases ?? []))];
      return {
        cluster_id: clusterId(group.signature.key),
        cluster_key: group.signature.key,
        error_type: group.signature.error_type,
        top_frame: group.signature.top_frame,
        endpoint: group.signature.endpoint,
        method: group.signature.method,
        size: members.length,
        defect_ids: members.map(item => item.defect_id),
        related_cases: cases,
        representative: members[0].defect_id,
        severity: members[0].severity ?? 'unknown',
        titles: [...new Set(members.map(item => item.title).filter(Boolean))].slice(0, 5),
        // 一句话给人看，避免读到 cluster_key 还要自己在脑子里拼
        summary: `${members.length} 张单同源：${group.signature.error_type}`
          + (group.signature.endpoint ? ` @ ${group.signature.method ?? ''} ${group.signature.endpoint}`.replace(/\s+/g, ' ') : '')
          + (group.signature.top_frame ? `（${group.signature.top_frame}）` : '')
          + `，影响 ${cases.length} 条用例`,
      };
    })
    .sort((a, b) => b.size - a.size || a.cluster_id.localeCompare(b.cluster_id));

  const clustered = new Set(clusters.flatMap(cluster => cluster.defect_ids));
  const warnings = [];
  if (unsignatured.length) {
    warnings.push(`${unsignatured.length} 张单缺少可判根因的证据（无错误类型或既无堆栈也无接口路径），未参与聚类。这不是「它们没有共同根因」，是「现在判不了」。`);
  }
  if (clusters.length) {
    warnings.push('聚类只改展示分组，不改缺陷单数量与生命周期状态。合并展示后仍可逐张提单——合并过度会漏真缺陷，这个风险不由聚类承担。');
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    merge_safety: 'display_only',
    stats: {
      records: (records ?? []).length,
      clustered_defects: clustered.size,
      clusters: clusters.length,
      unclustered: (records ?? []).length - clustered.size,
      // 最高价值的一个数：不聚类要开多少单，聚类后要人看几组
      tickets_before: clustered.size,
      groups_after: clusters.length,
    },
    clusters,
    unclustered_defect_ids: (records ?? []).map(item => item.defect_id).filter(id => !clustered.has(id)),
    warnings,
  };
}

/** 报告用的一小段话。没有聚类时明确说「没有」，不说「0 个根因」。 */
export function renderClusterSummary(result) {
  if (!result || !result.clusters?.length) {
    return result?.stats?.records
      ? `本轮 ${result.stats.records} 张缺陷单未形成同源分组（缺堆栈与接口路径，或各自独立）。`
      : '本轮无缺陷记录。';
  }
  const lines = result.clusters.map(cluster => `- ${cluster.summary}`);
  return [`本轮 ${result.stats.tickets_before} 张单归并为 ${result.stats.groups_after} 组同源问题：`, ...lines].join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/defect-cluster.mjs --run-id=<run_id>               */
/* ------------------------------------------------------------------ */

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) {
    console.error('用法: node scripts/defect-cluster.mjs --run-id=<run_id>');
    process.exit(2);
  }
  const runDir = resolve(root, 'output/runs', runId);
  const store = readJson(resolve(runDir, 'defects/defect-records.json'));
  if (!store) {
    console.error(`缺少 defects/defect-records.json；先跑 normalize_defects。`);
    process.exit(2);
  }
  const results = readJson(resolve(runDir, 'execution/test_results.json'))?.results
    ?? readJson(resolve(runDir, 'execution/test_results.json'))
    ?? [];
  const result = buildClusters(store.records ?? [], { results: Array.isArray(results) ? results : [] });
  const target = resolve(runDir, 'defects/root-cause-clusters.json');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ run_id: runId, ...result }, null, 2)}\n`);
  console.log(JSON.stringify({ run_id: runId, stats: result.stats, output: target }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
