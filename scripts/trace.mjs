/**
 * 全链路 trace（L-10 落地，对应 §25.2 P1-3）。
 *
 * **不记 trace 会怎样**：用户拿着报告说「这条用例不对」，能查到的只有最终产物。
 * 中间 agent 查了哪些资料、调了哪次工具、参数是什么、花了多久，全都没有。
 * 于是每次排查都变成「重跑一遍看看」——而重跑的结果未必复现，最后只能归因为「偶发」。
 *
 * 这里记的是一次 **结构化动作** 的调用轨迹：谁（session）、在哪个阶段（stage）、
 * 干了什么（action）、用了什么工具（tools）、成没成（status）、多久（elapsed）。
 *
 * 三条纪律，写在最前面：
 *
 * 1. **参数脱敏后才落盘**。trace 是给人排查用的，不是凭据仓库。密码/token/cookie
 *    一律替换为 `[redacted]`，长文本截断，大数组只留长度。宁可排查时少看一眼，
 *    也不要让一份 jsonl 变成泄露面。
 * 2. **写失败不影响业务**。trace 是观测，不是业务；磁盘满、权限错都不该让一次
 *    action 失败。
 * 3. **node_id 稳定、attempt 由读取端编号**。写入端不读历史、不抢锁——多个子会话
 *    并发跑 action 时，读写同一份 jsonl 做计数一定会错。`O_APPEND` 追加单行是原子的，
 *    顺序与尝试次数交给读取端按时间排。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** trace 落盘位置：run 内（随 run 归档）；无 run_id 时落到全局目录。 */
export function tracePath(root, runId) {
  return /^run-[A-Za-z0-9-]+$/.test(runId ?? '')
    ? resolve(root, 'output/runs', runId, 'traces/trace.jsonl')
    : resolve(root, 'output/traces/global.jsonl');
}

/** 参数字段的敏感键。命中即整值替换，不做部分保留——`sk-abc` 去掉前缀仍是凭据。 */
const SENSITIVE_KEY = /(pass(word|wd)?|token|secret|authorization|cookie|credential|api[-_]?key|private[-_]?key|session[-_]?key|access[-_]?key)/i;
const MAX_STRING = 200;
const MAX_ARRAY = 10;
const MAX_DEPTH = 6;

/**
 * 脱敏 + 压缩参数。
 *
 * 目标不是「完整复现参数」，而是「知道这次传了什么形态」。所以：
 * 长字符串截断、长数组只留长度、深层嵌套到此为止。真正的内容在 action 回执和
 * 产物文件里，trace 只负责指路。
 */
export function redactArgs(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return '[function]';
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map(item => redactArgs(item, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…(${value.length} items)`] : head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactArgs(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** 稳定节点 ID：同一 run 的同一阶段同一动作共用一个节点，便于与血缘图对齐。 */
export function traceNodeId({ runId, stage, action }) {
  return [runId ?? 'no-run', stage || '-', action || '-'].join(':');
}

function sha256(value) {
  try { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32); }
  catch { return null; }
}

/**
 * 记一次 trace。调用点只该是 `executeAction` 的 finally——别在各 action 内部散着记，
 * 那样漏一个 action 就是一条断链。
 */
export function recordTrace(root, entry = {}) {
  try {
    const path = tracePath(root, entry.run_id);
    mkdirSync(dirname(path), { recursive: true });
    const args = entry.args === undefined ? null : redactArgs(entry.args);
    const row = {
      v: 1,
      at: new Date().toISOString(),
      node_id: traceNodeId({ runId: entry.run_id, stage: entry.stage, action: entry.action }),
      run_id: entry.run_id ?? null,
      stage: entry.stage ?? null,
      action: entry.action ?? null,
      session: entry.session ?? null,
      status: entry.status ?? null,
      exit_code: Number.isInteger(entry.exit_code) ? entry.exit_code : null,
      ok: entry.ok === true,
      elapsed_ms: Number.isFinite(entry.elapsed_ms) ? Math.round(entry.elapsed_ms * 1000) / 1000 : null,
      queue_wait_ms: Number.isFinite(entry.queue_wait_ms) ? Math.round(entry.queue_wait_ms * 1000) / 1000 : null,
      args_sha256: sha256(args),
      args,
      tools: Array.isArray(entry.tools) ? [...new Set(entry.tools)] : [],
      degraded: Array.isArray(entry.degraded) ? [...new Set(entry.degraded)] : [],
      error: typeof entry.error === 'string' ? redactArgs(entry.error) : null,
      receipt: entry.receipt ?? null,
    };
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    return row;
  } catch {
    // 见文件头第 2 条：观测失败不得影响业务。
    return null;
  }
}

function parseLines(path) {
  const rows = [];
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.at === 'string') rows.push(row);
    } catch { /* 半行/坏行跳过：一次进程被杀会留下半行，不该带崩整份 trace */ }
  }
  return rows;
}

/**
 * 读回一个 run 的 trace。
 *
 * `attempt` 在这里编号（同一 node_id 的第几次调用），写入端不做这件事——见文件头第 3 条。
 */
export function readTrace(root, runId, { action = null, stage = null, ok = null, since = null, limit = null } = {}) {
  const rows = parseLines(tracePath(root, runId));
  const seen = new Map();
  const shaped = rows
    .filter(row => !action || row.action === action)
    .filter(row => !stage || row.stage === stage)
    .filter(row => ok === null || row.ok === ok)
    .filter(row => !since || row.at >= since)
    .map(row => {
      const n = (seen.get(row.node_id) ?? 0) + 1;
      seen.set(row.node_id, n);
      return { ...row, attempt: n };
    });
  const sliced = limit && limit > 0 ? shaped.slice(-limit) : shaped;
  return sliced;
}

/**
 * 汇总：给「一眼看出这次 run 卡在哪」用。
 *
 * `failures` 与 `degraded` 单列，因为这两类才是排查入口；把 46 个成功 action 平铺出来没人看。
 */
export function summarizeTrace(root, runId) {
  const rows = readTrace(root, runId);
  if (!rows.length) {
    return {
      version: 1,
      run_id: runId ?? null,
      available: false,
      reason: 'no_trace',
      note: '该 run 没有任何 trace 记录。可能是 trace 上线前跑的历史 run，或 trace 目录未随 run 归档；不据此判断「没有调用」。',
      total: 0,
    };
  }
  const byAction = new Map();
  const byStatus = new Map();
  const degraded = new Map();
  const tools = new Map();
  for (const row of rows) {
    byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
    byStatus.set(row.status ?? 'unknown', (byStatus.get(row.status ?? 'unknown') ?? 0) + 1);
    for (const name of row.degraded) degraded.set(name, (degraded.get(name) ?? 0) + 1);
    for (const name of row.tools) tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  const durations = rows.filter(row => Number.isFinite(row.elapsed_ms)).map(row => ({ action: row.action, at: row.at, elapsed_ms: row.elapsed_ms }));
  return {
    version: 1,
    run_id: runId ?? null,
    available: true,
    total: rows.length,
    first_at: rows[0].at,
    last_at: rows.at(-1).at,
    ok: rows.filter(row => row.ok).length,
    failed: rows.filter(row => !row.ok).length,
    by_action: Object.fromEntries([...byAction].sort((a, b) => b[1] - a[1])),
    by_status: Object.fromEntries([...byStatus].sort((a, b) => b[1] - a[1])),
    tools_used: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
    degraded_tools: Object.fromEntries([...degraded].sort((a, b) => b[1] - a[1])),
    failures: rows.filter(row => !row.ok).map(row => ({
      at: row.at, action: row.action, stage: row.stage, status: row.status,
      error: row.error, receipt: row.receipt,
    })),
    slowest: durations.sort((a, b) => b.elapsed_ms - a.elapsed_ms).slice(0, 5),
  };
}

/** 列出本根目录下所有有 trace 的 run（新→旧）。 */
export function listTracedRuns(root) {
  const base = resolve(root, 'output/runs');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter(name => /^run-[A-Za-z0-9-]+$/.test(name))
    .filter(name => existsSync(tracePath(root, name)))
    .map(name => ({ run_id: name, path: tracePath(root, name) }))
    .sort((a, b) => b.run_id.localeCompare(a.run_id));
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/trace.mjs <run_id|--list> [--action=] [--fail]     */
/* ------------------------------------------------------------------ */

function parseCli(argv) {
  const options = { runId: null, list: false, action: null, stage: null, ok: null, limit: null, json: false };
  for (const arg of argv) {
    if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--fail') options.ok = false;
    else if (arg === '--ok') options.ok = true;
    else if (arg.startsWith('--action=')) options.action = arg.slice(9);
    else if (arg.startsWith('--stage=')) options.stage = arg.slice(8);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8)) || null;
    else if (!arg.startsWith('-') && !options.runId) options.runId = arg;
  }
  return options;
}

function main() {
  const root = process.env.AITEST_ENGINE_ROOT ?? process.cwd();
  const options = parseCli(process.argv.slice(2));
  if (options.list) {
    const runs = listTracedRuns(root);
    if (options.json) { console.log(JSON.stringify(runs, null, 2)); return; }
    console.log(runs.length ? runs.map(r => r.run_id).join('\n') : '（没有找到含 trace 的 run）');
    return;
  }
  if (!options.runId) {
    console.error('用法：node scripts/trace.mjs <run_id> [--action=<name>] [--stage=<stage>] [--fail] [--limit=N] [--json]\n      node scripts/trace.mjs --list');
    process.exit(2);
  }
  const summary = summarizeTrace(root, options.runId);
  if (options.json) {
    console.log(JSON.stringify({ summary, rows: readTrace(root, options.runId, options) }, null, 2));
    return;
  }
  if (!summary.available) {
    console.log(`run ${options.runId}：${summary.reason} — ${summary.note}`);
    return;
  }
  console.log(`run ${options.runId}`);
  console.log(`  调用 ${summary.total} 次 / 成功 ${summary.ok} / 失败 ${summary.failed}`);
  console.log(`  期间 ${summary.first_at} → ${summary.last_at}`);
  const top = Object.entries(summary.by_action).slice(0, 8).map(([name, n]) => `${name}×${n}`).join('  ');
  if (top) console.log(`  动作  ${top}`);
  if (Object.keys(summary.degraded_tools).length) {
    console.log(`  降级  ${Object.entries(summary.degraded_tools).map(([name, n]) => `${name}×${n}`).join('  ')}`);
  }
  for (const row of readTrace(root, options.runId, options)) {
    const mark = row.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${mark} ${row.at}  ${String(row.action).padEnd(24)} ${String(row.elapsed_ms ?? '-').padStart(9)}ms  ${row.error ?? ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
