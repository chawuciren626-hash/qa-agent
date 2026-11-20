/**
 * 一次 run 的健康摘要（§6.5 缺口②）——"跑不通时看哪里"的读取入口。
 *
 * 数据源与口径：
 *  - 工具面：`<engineRoot>/output/runtime/tool-usage.jsonl`（`scripts/tool-gate.mjs` 追加的
 *    O_APPEND 行），按 run_id 过滤。execution 行是"完成了的调用"（带收据才计），check 行是
 *    独立的诊断流（failed/skipped 不挤占成功计数）。engineRoot 未配置或文件不存在时如实
 *    返回 null——"看不到"和"零次"是两个事实，不编 0。
 *  - token 面：`usage_records`（QA 会话的 LLM 调用都记在这，session_id 是任务会话）。
 *    会话全量回答"这个任务花了多少"；run 开始后的增量回答"这一轮执行花了多少"。
 *    started_at 缺失（发而未跑/未登记）时不给窗口数，只有全量。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { readRunTrace } from "./qa-run-trace.js";

export interface RunHealthSummary {
  runId: string;
  sessionId: string;
  /** 工具调用面；engineRoot 未配置或没有任何该 run 的记录时为 null（附 where 指路）。 */
  tools: {
    /** 完成了的实现调用数（带持久收据；策略闸的放行不计）。 */
    executions: number;
    /** 被调用过的工具 id，去重。 */
    invoked: string[];
    /** 降级列表（策略允许的降级，如跳过某工具）。 */
    degraded: string[];
    /** 诊断流按 status 分组（completed/failed/skipped/…），只计该 run 的行。 */
    checks: Record<string, number>;
  } | null;
  toolsSource: string | null;
  /** 该任务会话的 LLM 用量全量（跨 run 累计）。 */
  usage: { requests: number; tokens: number; failedRequests: number } | null;
  /** 本 run 开始（qa_runs.started_at）之后的会话用量增量；startedAt 缺失时为 null。 */
  usageSinceStart: { requests: number; tokens: number; from: string } | null;
  /** trace 事实（present/stalled/startedAt），读模型与 trace 路由同源。 */
  trace: ReturnType<typeof readRunTrace>;
}

function toolUsageForRun(engineRoot: string, runId: string): RunHealthSummary["tools"] {
  if (!engineRoot) return null;
  const path = join(engineRoot, "output", "runtime", "tool-usage.jsonl");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const executions = { count: 0, tools: new Set<string>(), degraded: new Set<string>() };
  const checks: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.run_id !== runId) continue;
    if (row.kind === "execution") {
      executions.count += 1;
      for (const tool of Array.isArray(row.tools) ? row.tools : []) if (typeof tool === "string") executions.tools.add(tool);
      for (const item of Array.isArray(row.degraded) ? row.degraded : []) if (typeof item === "string") executions.degraded.add(item);
    } else if (row.kind === "check") {
      const status = typeof row.status === "string" ? row.status : "unknown";
      checks[status] = (checks[status] ?? 0) + 1;
    }
  }
  return {
    executions: executions.count,
    invoked: [...executions.tools].sort(),
    degraded: [...executions.degraded].sort(),
    checks: Object.fromEntries(Object.entries(checks).sort())
  };
}

interface UsageRow { requests: number; tokens: number; failedRequests: number }

function usageOf(db: DatabaseSync, sessionId: string, sinceTs?: string): UsageRow | null {
  const params: SQLInputValue[] = [sessionId];
  let where = "session_id=?";
  if (sinceTs !== undefined) {
    where += " AND ts>=?";
    params.push(sinceTs);
  }
  const row = db.prepare(
    `SELECT count(*) AS requests, COALESCE(sum(total),0) AS tokens, COALESCE(sum(status<>'completed'),0) AS failed FROM usage_records WHERE ${where}`
  ).get(...params) as { requests: number; tokens: number; failed: number } | undefined;
  if (!row) return null;
  return { requests: row.requests, tokens: row.tokens, failedRequests: row.failed };
}

export function runHealthSummary(deps: { db: DatabaseSync; engineRoot: string; workspace: string }, sessionId: string, runId: string): RunHealthSummary {
  const trace = readRunTrace(deps.workspace, runId);
  const tools = toolUsageForRun(deps.engineRoot, runId);
  const usage = usageOf(deps.db, sessionId);
  const startedAt = trace.startedAt;
  const windowed = startedAt ? usageOf(deps.db, sessionId, startedAt) : null;
  return {
    runId,
    sessionId,
    tools,
    toolsSource: deps.engineRoot ? "output/runtime/tool-usage.jsonl" : null,
    usage,
    usageSinceStart: startedAt && windowed ? { ...windowed, from: startedAt } : null,
    trace
  };
}
