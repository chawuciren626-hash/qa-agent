/**
 * 一次运行的**执行痕迹**（P4 判据 1 收口 / 判据 4 可解释）。
 *
 * ## 为什么读文件，而不是让执行器回调登记
 *
 * `qa_runs` 上的 `started_at` 一直填不上：登记走的是"看见 manifest"这条路，而 manifest
 * 在 `create-run` 就写好了——它说明"这次运行存在过"，不说明"执行真的开始过"。区分这两件事
 * 的唯一证据在执行器自己写的文件里（`scripts/execution-runner.mjs` → `execution-attempts.mjs`）：
 *
 *   execution/execution.lock.json    执行开始（含 owner_pid）——跑完就删，剩下就是没跑完
 *   execution/execution-state.json   当前阶段 + 最后一次活动时间
 *   execution/attempts/<id>/attempt.json  每次尝试密封后的起止与结论
 *
 * 让执行器再回调一次平台需要一份平台凭据（执行器是 spawn 出来的子进程，拿不到会话令牌），
 * 而判断"开始/在进行/疑似中断"这三件事根本不需要凭据——执行器本来就在写这两份文件，
 * 缺的是有人读。**所以这一层只读不猜**，也不写库。
 *
 * ## 三条口径
 *
 * 1. **`stalled` 用"最后一次活动"判，不用 `started_at` 判**。一次真机执行跑 40 分钟是正常的；
 *    拿"开始到现在超过 30 分钟"当判据会把长跑全标成中断，人一旦见过一次误报就不再信这个标记。
 * 2. **锁在、进程不在 = 疑似中断的最强证据**（`orphaned`）。执行器正常结束会删锁，所以
 *    残留的锁只有两种含义：还在跑，或者跑到一半死了。同机时可以用 pid 活着否区分；
 *    跨机时 `pid_alive` 不可信，因此只降级成"unknown"，不冒充已死。
 * 3. **缺文件、坏 JSON 都返回 null，不抛**。这些文件是别的进程写的；把它们读崩会让一次
 *    正常的查询变成 500，而"读不到"本身就是要报告的事实。
 */
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_STALE_RUN_MS, readRunFacts } from "./qa-task-run-registry.js";

const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const MAX_JSON_BYTES = 1024 * 1024;

export interface RunExecutionTrace {
  /** 执行器分配的本次尝试 id；与 `attempts` 目录同名。 */
  invocationId: string | null;
  /** 执行真正开始的时刻（执行器写锁的时间），不是 create-run 的时间。 */
  startedAt: string | null;
  /** 最近一次尝试密封的时间；执行没跑完时为 null。 */
  finishedAt: string | null;
  /** 执行器阶段：preparing / preflight / playwright / finished … */
  phase: string | null;
  /** 执行器状态：running / completed / failed / blocked。 */
  state: string | null;
  /** 最后一次活动（状态文件更新时间、锁时间、尝试结束时间里最新的一个）。 */
  lastActivityAt: string | null;
  /** 已密封的尝试数（每重跑一次 +1）。 */
  attempts: number;
  /** 还有锁：说明这次执行没有正常收尾。 */
  locked: boolean;
  /** 锁在、但持锁进程已不在（同机判定）；跨机时恒为 false 且 `pidStatus=unknown`。 */
  orphaned: boolean;
  /** pid 判定的可信度：alive / dead / unknown（未记录 pid 或跨机无法判定）。 */
  pidStatus: "alive" | "dead" | "unknown";
  /** 执行器自己写的阻塞原因（preflight 失败等）；不是平台判定。 */
  blockReason: string | null;
}

export interface RunTraceView {
  runId: string;
  /** run 目录里有没有 manifest——没有就不是一次运行，谈不上发起。 */
  present: boolean;
  manifest: { status: string; manifestVersion: number | null; baselineHash: string | null; sha256: string } | null;
  execution: RunExecutionTrace;
  /** 平台视角的执行开始时间（= `execution.startedAt`）。报告与 `qa_runs.started_at` 都用它。 */
  startedAt: string | null;
  /** 疑似中断：执行尚未收尾，且最后一次活动已经超过阈值。 */
  stalled: boolean;
  /** 给人看的原因；null = 没判中断。 */
  stalledReason: string | null;
  /** 判定用的阈值（毫秒）——把数字一起返回，免得读的人以为是运行时长的绝对值。 */
  staleAfterMs: number;
}

const EMPTY_EXECUTION: RunExecutionTrace = {
  invocationId: null,
  startedAt: null,
  finishedAt: null,
  phase: null,
  state: null,
  lastActivityAt: null,
  attempts: 0,
  locked: false,
  orphaned: false,
  pidStatus: "unknown",
  blockReason: null,
};

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function later(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/** 读一个小 JSON。路径必须已在工作区内（调用方校验），这里只兜住大小与格式。 */
function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fsSync.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(fsSync.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 只有当执行器与平台在同一台机器上，pid 判定才有意义。 */
function pidLiveness(pid: unknown): { status: "alive" | "dead" | "unknown"; orphaned: boolean } {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return { status: "unknown", orphaned: false };
  try {
    process.kill(pid as number, 0);
    return { status: "alive", orphaned: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM = 进程存在但不属于当前用户：活着，只是看不到细节。
    if (code === "EPERM") return { status: "alive", orphaned: false };
    // ESRCH = 没有这个进程。执行器正常结束会删锁，所以"锁在 + 进程不在"就是跑到一半死了。
    if (code === "ESRCH") return { status: "dead", orphaned: true };
    return { status: "unknown", orphaned: false };
  }
}

function sealedAttempts(executionDir: string): { count: number; firstStartedAt: string | null; lastFinishedAt: string | null; lastActivityAt: string | null } {
  const result = { count: 0, firstStartedAt: null as string | null, lastFinishedAt: null as string | null, lastActivityAt: null as string | null };
  try {
    const entries = fsSync.readdirSync(path.join(executionDir, "attempts"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const attempt = readJson(path.join(executionDir, "attempts", entry.name, "attempt.json"));
      if (!attempt) continue;
      result.count++;
      const started = instant(attempt.started_at);
      const finished = instant(attempt.finished_at);
      if (started && (!result.firstStartedAt || Date.parse(started) < Date.parse(result.firstStartedAt))) result.firstStartedAt = started;
      result.lastFinishedAt = later(result.lastFinishedAt, finished);
      result.lastActivityAt = later(later(result.lastActivityAt, finished), started);
    }
  } catch {
    // 没有 attempts 目录 = 还没跑过；不是故障。
  }
  return result;
}

/**
 * 读一次运行的执行痕迹。**不抛错**：读不到就返回空痕迹，让调用方自己决定怎么表述。
 *
 * `staleAfterMs` 默认与 `qa_runs.stalled` 同一个阈值，避免同一个词在两处给出不同答案。
 */
export function readRunTrace(workspace: string, runId: string, options: { now?: number; staleAfterMs?: number } = {}): RunTraceView {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_RUN_MS;
  const empty: RunTraceView = {
    runId,
    present: false,
    manifest: null,
    execution: { ...EMPTY_EXECUTION },
    startedAt: null,
    stalled: false,
    stalledReason: null,
    staleAfterMs,
  };
  if (!workspace || !RUN_ID.test(runId)) return empty;

  let runDir: string;
  try {
    const root = fsSync.realpathSync(path.resolve(workspace));
    runDir = path.join(root, "output", "runs", runId);
    // 不跟随符号链接：run 目录必须是真的目录，否则"读到的痕迹"可能来自工作区之外。
    if (fsSync.realpathSync(runDir) !== runDir || !fsSync.lstatSync(runDir).isDirectory()) return empty;
  } catch {
    return empty;
  }

  const manifestRaw = readJson(path.join(runDir, "manifest.json"));
  if (!manifestRaw) return empty;
  const facts = readRunFacts(manifestRaw);
  let manifestSha256 = "";
  try {
    manifestSha256 = createHash("sha256").update(fsSync.readFileSync(path.join(runDir, "manifest.json"))).digest("hex");
  } catch {
    manifestSha256 = "";
  }

  const executionDir = path.join(runDir, "execution");
  const state = readJson(path.join(executionDir, "execution-state.json"));
  const lock = readJson(path.join(executionDir, "execution.lock.json"));
  const attempts = sealedAttempts(executionDir);

  const lockPid = lock ? pidLiveness(lock.owner_pid) : { status: "unknown" as const, orphaned: false };
  const stateStarted = state ? instant(state.started_at) : null;
  const lockStarted = lock ? instant(lock.started_at) : null;
  const stateUpdated = state ? instant(state.updated_at) : null;

  const execution: RunExecutionTrace = {
    invocationId: (typeof state?.invocation_id === "string" && state.invocation_id) || (typeof lock?.invocation_id === "string" && lock.invocation_id) || null,
    startedAt: stateStarted ?? lockStarted ?? attempts.firstStartedAt,
    finishedAt: attempts.lastFinishedAt,
    phase: typeof state?.phase === "string" ? state.phase : null,
    state: typeof state?.status === "string" ? state.status : null,
    lastActivityAt: later(later(stateUpdated, lockStarted), attempts.lastActivityAt),
    attempts: attempts.count,
    locked: Boolean(lock),
    orphaned: Boolean(lock) && lockPid.orphaned,
    pidStatus: lockPid.status,
    blockReason: typeof state?.block_reason === "string" && state.block_reason ? state.block_reason : null,
  };

  // 只有"还没收尾"才谈得上中断：锁还在，或状态仍是 running。
  const unfinished = execution.locked || execution.state === "running";
  let stalled = false;
  let stalledReason: string | null = null;
  if (unfinished) {
    const lastMs = execution.lastActivityAt ? Date.parse(execution.lastActivityAt) : Number.NaN;
    const idleMs = now - lastMs;
    if (execution.orphaned) {
      // pid 不在了：不用等阈值，这是"跑到一半死了"的直接证据。
      stalled = true;
      stalledReason = "执行锁未释放且持锁进程已退出：疑似执行器崩溃或被强制结束，需人工确认残留后重跑。";
    } else if (Number.isFinite(idleMs) && idleMs > staleAfterMs) {
      stalled = true;
      stalledReason = `执行未收尾，且最后一次活动在 ${Math.round(idleMs / 60000)} 分钟前（阈值 ${Math.round(staleAfterMs / 60000)} 分钟）；进程仍可能是活的，需人工确认。`;
    }
  }

  return {
    runId,
    present: true,
    manifest: {
      status: facts.status,
      manifestVersion: facts.manifestVersion,
      baselineHash: facts.baselineHash,
      sha256: manifestSha256,
    },
    execution,
    startedAt: execution.startedAt,
    stalled,
    stalledReason,
    staleAfterMs,
  };
}
