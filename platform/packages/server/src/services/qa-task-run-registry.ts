/**
 * 任务与运行的登记簿（P2 承载对象）。
 *
 * ## 为什么需要这一层
 *
 * 在此之前，"任务"就是 session，"运行"就是一个 `output/runs/<run_id>/` 目录。两者都没有
 * 数据库行，于是环境、范围、负责人、被测版本无处可落，同一任务下的多次运行也无法列举，
 * 更无法回答"这次比上次多坏了什么"。这个类只做一件事：**把已经发生的事实登记成行**，
 * 让它们可查询、可比较。
 *
 * ## 它不产生事实，只索引事实
 *
 * - run 的身份来自工作区 `manifest.json`：`assertNewRun` / `assertReportRun` 已经核过
 *   run_id、manifest_version 与 directory_context.session_id，本层只把核过的结果落库。
 *   没有任何方法允许调用方绕过 manifest 直接插入一个 run——那会让 qa_runs 变成第二个
 *   真源，与 manifest 不一致时谁也说不清哪个对。
 * - task 的身份是本层产生的（用户建任务时就有），所以它可以被显式创建与修改；但它
 *   绝不覆盖已存在的行，重复 `ensureTask` 是幂等的，避免一处读路径把用户填的 env 冲掉。
 *
 * ## run_index 的语义
 *
 * `0` 专指"回填的历史运行，真实先后顺序未知"。新登记的运行从 `1` 开始递增。不用回填行
 * 参与编号，是因为历史 run 的创建顺序没有记录，编一个序号等于伪造可比性——而"这次比上次"
 * 正是靠这个号，伪造它就等于让对比结论不可信。
 */
import { randomUUID } from "node:crypto";
import type { KnowledgeDb } from "./qa-project-knowledge.js";

export const TASK_STATUSES = ["draft", "active", "blocked", "done", "archived"] as const;
export const RUN_KINDS = ["run", "design", "execution", "regression", "retest", "legacy"] as const;
export const RESOURCE_POOLS = ["web", "api", "android", "miniprogram"] as const;

/**
 * 一台机器上各池的并发上限。这不是可以随便调的参数：浏览器实例、真机、小程序模拟器
 * 的数量是物理的，调高只会让两个 run 抢同一个设备，把"环境问题"伪装成"偶发失败"。
 */
export const DEFAULT_POOL_CAPACITY: Record<ResourcePool, number> = {
  web: 1,
  api: 1,
  android: 2,
  miniprogram: 2,
};

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunKind = (typeof RUN_KINDS)[number];
export type ResourcePool = (typeof RESOURCE_POOLS)[number];

export interface QaTask {
  taskId: string;
  projectId: string;
  sessionId: string;
  env: string;
  title: string;
  status: TaskStatus;
  ownerUserId: string | null;
  scope: Record<string, unknown>;
  sutVersion: string | null;
  contextSnapshotId: string | null;
  origin: "created" | "backfill";
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface QaRun {
  runId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  env: string;
  kind: RunKind;
  status: string;
  runIndex: number;
  manifestPath: string;
  manifestSha256: string;
  manifestVersion: number | null;
  sutVersion: string | null;
  baselineHash: string | null;
  resourcePool: string | null;
  deviceId: string | null;
  batchId: string | null;
  counts: Record<string, number>;
  startedAt: string | null;
  finishedAt: string | null;
  /** 发起时登记的意图（计划/环境/run 目录）。空对象 = 不是经发起登记的行（回填或历史）。 */
  dispatch: Record<string, unknown>;
  /**
   * 疑似中断：`running` 且开始时间超过阈值仍未结束。
   *
   * 这是**读时派生**的结论，不落库：一旦落库就要有人负责把它改回去，而"谁在什么时候
   * 判定它死了"本身就是个会出错的猜测。执行器崩了、机器重启、会话被关掉都会停在这里，
   * 系统不去自动重跑（真机上有写操作，自动续跑等于重复执行），只把状态如实呈现给人。
   */
  stalled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** manifest 里与本层相关的那几个字段，解析后与原文解耦，便于单测。 */
export interface RunManifestFacts {
  runId: string;
  manifestVersion: number | null;
  status: string;
  resourcePool: string | null;
  sutVersion: string | null;
  /** 环境基线指纹（manifest.baseline_hash 或随 run 落盘的 baseline.json）。缺失即"未采集"。 */
  baselineHash: string | null;
}

/** 一次"已校验的 manifest 观察"：三样东西一起传，避免调用方各拼各的路径与指纹。 */
export interface RunObservation {
  facts: RunManifestFacts;
  manifestPath: string;
  manifestSha256: string;
  /**
   * 执行真正开始的时刻（读自执行器的 `execution-state.json` / 锁文件），不是 create-run 的
   * 时间。第一次看见 run 时可能还没有（设计阶段），之后的观察会补上——`started_at` 用
   * COALESCE 写，补一次就固定，不会被后来的观察改掉。
   */
  startedAt?: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 从 manifest 原文派生事实。容错优先：manifest 是别的进程写的文件，字段缺失时返回 null
 * 而不是抛错——把它读崩会让一次正常的运行登记变成 500。
 */
export function readRunFacts(manifest: unknown): RunManifestFacts {
  const root = (manifest ?? {}) as Record<string, unknown>;
  const orchestration = (root.orchestration ?? {}) as Record<string, unknown>;
  const plan = (orchestration.plan ?? {}) as Record<string, unknown>;
  const branches = Array.isArray(plan.execution_branches)
    ? plan.execution_branches.filter((item): item is string => typeof item === "string")
    : [];
  const platform = str(plan.execution_platform);
  // 接口执行走 api 池，其余按执行平台；两者都没有就留空（不猜成 web）。
  const pool = branches.includes("api_execution") ? "api" : platform;
  // 基线指纹是"这次跑在什么环境上"的唯一凭据：manifest 显式声明优先，
  // 其次认随 run 落盘的 baseline 段。两者都没有就留 null——不猜、不补默认值。
  const baseline = (root.baseline ?? orchestration.baseline ?? {}) as Record<string, unknown>;
  return {
    runId: String(root.run_id ?? ""),
    manifestVersion: Number.isInteger(root.manifest_version) ? Number(root.manifest_version) : null,
    status: str(root.status) ?? "unknown",
    resourcePool: pool !== null && (RESOURCE_POOLS as readonly string[]).includes(pool) ? pool : null,
    sutVersion: str(root.sut_version) ?? str(plan.sut_version),
    baselineHash: str(root.baseline_hash) ?? str(baseline.content_hash),
  };
}

function mapTask(r: Record<string, unknown>): QaTask {
  return {
    taskId: r.task_id as string,
    projectId: r.project_id as string,
    sessionId: r.session_id as string,
    env: (r.env as string) ?? "",
    title: (r.title as string) ?? "",
    status: r.status as TaskStatus,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    scope: safeJson(r.scope_json),
    sutVersion: (r.sut_version as string | null) ?? null,
    contextSnapshotId: (r.context_snapshot_id as string | null) ?? null,
    origin: r.origin as "created" | "backfill",
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as string,
  };
}

function mapRun(r: Record<string, unknown>, nowMs: number, staleMs: number): QaRun {
  const counts = safeJson(r.counts_json);
  const startedAt = (r.started_at as string | null) ?? null;
  // `started_at` 只有执行器真的开始过才有值。缺了就退到 `created_at` 判"疑似中断"：
  // 宁可早一点提示"卡住了"，也不要因为少一个字段就让一条跑着的 run 永远看起来正常。
  // 注意这只是判定窗口，`startedAt` 字段本身仍为 null——"不知道什么时候开始的"不能编一个值。
  const windowFrom = startedAt ?? (r.status === "running" ? ((r.created_at as string | null) ?? null) : null);
  const windowMs = windowFrom ? Date.parse(windowFrom) : Number.NaN;
  return {
    runId: r.run_id as string,
    taskId: r.task_id as string,
    projectId: r.project_id as string,
    sessionId: r.session_id as string,
    env: (r.env as string) ?? "",
    kind: r.kind as RunKind,
    status: r.status as string,
    runIndex: Number(r.run_index ?? 0),
    manifestPath: (r.manifest_path as string) ?? "",
    manifestSha256: (r.manifest_sha256 as string) ?? "",
    manifestVersion: r.manifest_version === null || r.manifest_version === undefined ? null : Number(r.manifest_version),
    sutVersion: (r.sut_version as string | null) ?? null,
    baselineHash: (r.baseline_hash as string | null) ?? null,
    resourcePool: (r.resource_pool as string | null) ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    batchId: (r.batch_id as string | null) ?? null,
    counts: Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, Number(value)]).filter(([, value]) => Number.isFinite(value)),
    ),
    startedAt,
    finishedAt: (r.finished_at as string | null) ?? null,
    dispatch: safeJson(r.dispatch_json),
    // 只有"还在跑"才谈得上中断；时间戳解析不出来时宁可不标（unknown 不做成 suspect）。
    stalled: r.status === "running" && Number.isFinite(windowMs) && nowMs - windowMs > staleMs,
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as string,
  };
}

function safeJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface RunComparison {
  from: QaRun;
  to: QaRun;
  /** 上次通过、这次失败——回归结论里唯一真正要人看的那一类。 */
  regressions: string[];
  /** 上次失败、这次通过。 */
  fixed: string[];
  /** 两次都失败。 */
  stillFailing: string[];
  /** 只在这次出现的用例（上次没跑）。 */
  added: string[];
  /** 只在上次出现的用例（这次没跑）——没跑不是通过。 */
  removed: string[];
  /** 两次的 env / sutVersion 是否可比；不可比时上面的差异要打折看。 */
  comparable: boolean;
  /**
   * 两次运行的环境基线关系。三态而不是布尔：
   *   same      → 两侧都采集过且指纹一致，环境没动
   *   different → 两侧都采集过但不同，结果不可直接比（`comparable` 随之为 false）
   *   unknown   → 至少一侧没采集，环境是否动过**无从判断**——不冒充一致，也不武断判不可比
   */
  baselineStatus: "same" | "different" | "unknown";
  /** 同上三态的被测版本关系。`unknown` 表示至少一侧没记录版本——G3 要求此时标 inconclusive。 */
  versionStatus: "same" | "different" | "unknown";
  reasons: string[];
}

/** 疑似中断阈值：一次执行超过这么久还没结束，读时标 `stalled`（不改库、不自动重跑）。 */
export const DEFAULT_STALE_RUN_MS = 30 * 60 * 1000;

export class QaTaskRunRegistry {
  constructor(
    private readonly db: KnowledgeDb,
    private readonly now: () => number = () => Date.now(),
    private readonly id: () => string = () => randomUUID(),
    private readonly staleMs: number = DEFAULT_STALE_RUN_MS,
  ) {}

  private mapRun(row: Record<string, unknown>): QaRun {
    return mapRun(row, this.now(), this.staleMs);
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ------------------------------------------------------------------ tasks

  /**
   * 幂等建档：会话已有任务就原样返回，绝不覆盖 env/title/owner——那些是用户填的，
   * 读路径（报告发布、结果登记）顺手调一次 ensureTask 不该改掉它们。
   */
  ensureTask(input: {
    projectId: string;
    sessionId: string;
    userId: string;
    title?: string;
    env?: string;
  }): QaTask {
    const existing = this.task(input.projectId, input.sessionId);
    if (existing) return existing;
    // 这个会话已经挂在别的项目下：那是数据错，不是并发，不能静默造出第二条。
    const taken = this.db
      .prepare("SELECT project_id FROM qa_tasks WHERE session_id = ?")
      .get(input.sessionId) as { project_id: string } | undefined;
    if (taken) {
      throw new Error(`session ${input.sessionId} already belongs to project ${taken.project_id}`);
    }
    const now = this.at();
    const taskId = `task_${this.id().replace(/-/g, "").slice(0, 20)}`;
    try {
      this.db
        .prepare(
          `INSERT INTO qa_tasks
             (task_id, project_id, session_id, env, title, status, owner_user_id, scope_json,
              sut_version, context_snapshot_id, origin, created_at, created_by, updated_at)
           VALUES (?,?,?,?,?,'active',?,'{}',NULL,NULL,'created',?,?,?)`,
        )
        .run(taskId, input.projectId, input.sessionId, input.env ?? "", input.title ?? "", input.userId, now, input.userId, now);
    } catch (error) {
      // 并发下另一个请求刚建好同一个会话的任务：读回它，不算错误。
      const raced = this.task(input.projectId, input.sessionId);
      if (raced) return raced;
      throw error;
    }
    const created = this.task(input.projectId, input.sessionId);
    if (!created) throw new Error("qa_tasks insert did not read back");
    return created;
  }

  task(projectId: string, sessionId: string): QaTask | null {
    const row = this.db
      .prepare("SELECT * FROM qa_tasks WHERE project_id = ? AND session_id = ?")
      .get(projectId, sessionId);
    return row ? mapTask(row as Record<string, unknown>) : null;
  }

  taskById(taskId: string): QaTask | null {
    const row = this.db.prepare("SELECT * FROM qa_tasks WHERE task_id = ?").get(taskId);
    return row ? mapTask(row as Record<string, unknown>) : null;
  }

  listTasks(projectId: string, filter: { status?: TaskStatus; limit?: number } = {}): QaTask[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = filter.status
      ? this.db
          .prepare("SELECT * FROM qa_tasks WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?")
          .all(projectId, filter.status, limit)
      : this.db
          .prepare("SELECT * FROM qa_tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?")
          .all(projectId, limit);
    return (rows as Record<string, unknown>[]).map(mapTask);
  }

  /**
   * 只改显式传进来的字段。`env` 传空串是有意义的（表示"未指定环境"），与"没传"要区分开，
   * 所以用 `!== undefined` 判断而不是真值判断。
   */
  updateTask(
    projectId: string,
    sessionId: string,
    patch: {
      env?: string;
      title?: string;
      status?: TaskStatus;
      ownerUserId?: string | null;
      scope?: Record<string, unknown>;
      sutVersion?: string | null;
      contextSnapshotId?: string | null;
    },
    userId: string,
  ): QaTask {
    const current = this.task(projectId, sessionId);
    if (!current) throw new Error("task not found");
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.env !== undefined) { sets.push("env = ?"); params.push(patch.env); }
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.ownerUserId !== undefined) { sets.push("owner_user_id = ?"); params.push(patch.ownerUserId); }
    if (patch.scope !== undefined) { sets.push("scope_json = ?"); params.push(JSON.stringify(patch.scope)); }
    // sut_version 允许显式置 NULL（"这一版不知道"），不能退化成空串。
    if (patch.sutVersion !== undefined) { sets.push("sut_version = ?"); params.push(patch.sutVersion); }
    if (patch.contextSnapshotId !== undefined) { sets.push("context_snapshot_id = ?"); params.push(patch.contextSnapshotId); }
    if (!sets.length) return current;
    sets.push("updated_at = ?");
    params.push(this.at(), projectId, sessionId);
    this.db
      .prepare(`UPDATE qa_tasks SET ${sets.join(", ")} WHERE project_id = ? AND session_id = ?`)
      .run(...params);
    const next = this.task(projectId, sessionId);
    if (!next) throw new Error("task vanished after update");
    return next;
  }

  // ------------------------------------------------------------------- runs

  /**
   * 登记一次运行。事实全部来自已校验的 manifest（`facts`）+ 调用现场。
   *
   * 重复登记只刷新派生字段（status / manifest 指纹 / 资源池 / 被测版本），不新增行、
   * 不改 run_index——同一个 run_id 永远是同一次运行。
   */
  observeRun(input: {
    projectId: string;
    sessionId: string;
    userId: string;
    facts: RunManifestFacts;
    manifestPath: string;
    manifestSha256: string;
    kind?: RunKind;
    env?: string;
    batchId?: string | null;
    deviceId?: string | null;
    /** 执行器写的开始时刻；没有就不填（不拿"登记时间"顶替，那是另一个事实）。 */
    startedAt?: string | null;
  }): QaRun {
    if (!input.facts.runId) throw new Error("run manifest carries no run_id");
    return this.tx(() => {
      const task = this.ensureTask({ projectId: input.projectId, sessionId: input.sessionId, userId: input.userId });
      const env = input.env ?? task.env;
      const now = this.at();
      const existing = this.run(input.projectId, input.facts.runId);
      if (existing) {
        this.db
          .prepare(
            `UPDATE qa_runs SET status = ?, manifest_path = ?, manifest_sha256 = ?, manifest_version = ?,
               resource_pool = COALESCE(?, resource_pool), sut_version = COALESCE(?, sut_version),
               baseline_hash = COALESCE(?, baseline_hash), started_at = COALESCE(started_at, ?),
               batch_id = COALESCE(?, batch_id), env = ?, updated_at = ?
             WHERE run_id = ?`,
          )
          .run(
            input.facts.status,
            input.manifestPath,
            input.manifestSha256,
            input.facts.manifestVersion,
            input.facts.resourcePool,
            input.facts.sutVersion,
            input.facts.baselineHash,
            input.startedAt ?? null,
            input.batchId ?? null,
            env,
            now,
            input.facts.runId,
          );
        return this.run(input.projectId, input.facts.runId)!;
      }
      // 回填行占 0，新运行从 1 起；同任务内递增。
      const next = this.db
        .prepare("SELECT COALESCE(MAX(run_index), 0) + 1 AS n FROM qa_runs WHERE task_id = ?")
        .get(task.taskId) as { n: number };
      this.db
        .prepare(
          `INSERT INTO qa_runs
             (run_id, task_id, project_id, session_id, env, kind, status, run_index, manifest_path,
              manifest_sha256, manifest_version, sut_version, baseline_hash, resource_pool, device_id,
              batch_id, counts_json, started_at, finished_at, created_at, created_by, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?,NULL,?,?,?)`,
        )
        .run(
          input.facts.runId,
          task.taskId,
          input.projectId,
          input.sessionId,
          env,
          input.kind ?? "run",
          input.facts.status,
          Number(next.n ?? 1),
          input.manifestPath,
          input.manifestSha256,
          input.facts.manifestVersion,
          input.facts.sutVersion,
          input.facts.baselineHash,
          input.facts.resourcePool,
          input.deviceId ?? null,
          input.batchId ?? null,
          // 只认执行器写下的开始时刻。manifest 自称 in_progress 也不能拿来顶替——
          // "平台第一次看见这次运行"和"执行真的开始了"是两件事，混成一个值会让
          // 报告追溯断言永远通过（它问的正是"到底有没有开始过"）。
          input.startedAt ?? null,
          now,
          input.userId,
          now,
        );
      return this.run(input.projectId, input.facts.runId)!;
    });
  }

  /** 设计批次建好后补上 batch_id：批次在 run 之后才产生，不是 run 的先决条件。 */
  attachBatch(projectId: string, runId: string, batchId: string): void {
    this.db
      .prepare("UPDATE qa_runs SET batch_id = ?, updated_at = ? WHERE project_id = ? AND run_id = ?")
      .run(batchId, this.at(), projectId, runId);
  }

  /** 运行结束后回填统计与结束时间；status 仍以 manifest 为准，由 observeRun 同步。 */
  settleRun(projectId: string, runId: string, counts: Record<string, number>): QaRun | null {
    const current = this.run(projectId, runId);
    if (!current) return null;
    const now = this.at();
    this.db
      .prepare(
        // 不拿 created_at 顶替 started_at：结束时间是知道的，开始时间不知道就是不知道。
        `UPDATE qa_runs SET counts_json = ?, finished_at = ?, updated_at = ?
         WHERE project_id = ? AND run_id = ?`,
      )
      .run(JSON.stringify(counts), now, now, projectId, runId);
    return this.run(projectId, runId);
  }

  run(projectId: string, runId: string): QaRun | null {
    const row = this.db.prepare("SELECT * FROM qa_runs WHERE project_id = ? AND run_id = ?").get(projectId, runId);
    return row ? this.mapRun(row as Record<string, unknown>) : null;
  }

  listRuns(projectId: string, sessionId: string, limit = 50): QaRun[] {
    const rows = this.db
      .prepare("SELECT * FROM qa_runs WHERE project_id = ? AND session_id = ? ORDER BY run_index DESC, created_at DESC LIMIT ?")
      .all(projectId, sessionId, Math.min(Math.max(limit, 1), 200));
    return (rows as Record<string, unknown>[]).map((row) => this.mapRun(row));
  }

  // ------------------------------------------------------- 发起前预登记（B1-5 登记前移）

  /**
   * 开始测试的那一刻先建 run 行（status='planned'），run_id 由平台分配并随开工指令下发；
   * 队长 `create_run` 带 `run_id` 采纳同一 id，manifest 落盘后 `observeRun` 走既有 UPDATE
   * 分支把预约行升级为事实行，`startRun` 把发起升级为 running——"先登记、后派发"由此成立，
   * 工作区出现"有执行痕迹、无登记行"在结构上不可能。
   *
   * 与旧不变量（"不允许绕过 manifest 插入 run"）的关系：planned 行是**预约**，不是事实——
   * dispatch_json 带 registration:'planned' 与发起意图，读侧据此分辨预约与事实；它不冒充
   * 执行（started_at 为空、stalled 判定只看 running），队长没采纳它就永远停在 planned，
   * 由人决定清理或重试，系统不自动补。
   */
  createPlannedRun(input: {
    projectId: string;
    sessionId: string;
    userId: string;
    env?: string;
    kind?: RunKind;
    title?: string;
    briefing?: Record<string, unknown>;
  }): QaRun {
    return this.tx(() => {
      const task = this.ensureTask({
        projectId: input.projectId,
        sessionId: input.sessionId,
        userId: input.userId,
        env: input.env,
        title: input.title,
      });
      const now = this.at();
      // run_id 格式与 RUN_ID 口径一致；时间戳命名与 create-run.mjs 的缺省生成同形，
      // 两边谁先产生都认得出是同一次运行。
      const runId = `run-${now.replace(/[:.]/g, "-")}`;
      const next = this.db
        .prepare("SELECT COALESCE(MAX(run_index), 0) + 1 AS n FROM qa_runs WHERE task_id = ?")
        .get(task.taskId) as { n: number };
      this.db
        .prepare(
          `INSERT INTO qa_runs
             (run_id, task_id, project_id, session_id, env, kind, status, run_index, manifest_path,
              manifest_sha256, manifest_version, sut_version, baseline_hash, resource_pool, device_id,
              batch_id, counts_json, dispatch_json, started_at, finished_at,
              created_at, created_by, updated_at)
           VALUES (?,?,?,?,?,?,'planned',?,'','',NULL,NULL,NULL,NULL,NULL,
                   NULL,'{}',?,NULL,NULL,?,?,?)`,
        )
        .run(
          runId,
          task.taskId,
          input.projectId,
          input.sessionId,
          input.env ?? task.env,
          input.kind ?? "run",
          Number(next.n ?? 1),
          JSON.stringify({ registration: "planned", ...(input.briefing ?? {}) }),
          now,
          input.userId,
          now,
        );
      return this.run(input.projectId, runId)!;
    });
  }

  // ------------------------------------------------------- 发起与结束（判据 1 排查线）

  /**
   * 登记一次**刚开始**的执行。产品里没有队列：用户发起会话、会话里就跑起来，多个会话
   * 天然并行。所以这里不做"待领取"，发起即 `running`。
   *
   * 为什么还是要先写一行：不写的话，"执行器没启动"、"浏览器崩了"、"跑到一半会话被关"
   * 在数据上都是"什么都没有"，排查只能去翻本机目录。这一行的作用是让发起这个动作留下
   * 痕迹，而不是调度。
   *
   * run_id 由调用方给（执行器要用同一个 id 写 manifest），服务端不另生成：两边各生成
   * 一次就会得到两条互不相认的记录。同一 run_id 重复发起直接拒绝——那是调用方拼错了 id。
   */
  startRun(input: {
    projectId: string;
    sessionId: string;
    userId: string;
    runId: string;
    env?: string;
    kind?: RunKind;
    resourcePool?: ResourcePool | null;
    deviceId?: string | null;
    dispatch?: Record<string, unknown>;
    title?: string;
  }): QaRun {
    if (!input.runId) throw new Error("startRun requires a run_id");
    return this.tx(() => {
      const existing = this.run(input.projectId, input.runId);
      if (existing) {
        // B1-5 登记前移：planned 行是本层发出去的预约，发起命令到达即兑现——升级为
        // running（started_at 用发起时刻，与 startRun 既有语义一致），不算重复发起。
        // 其余状态照旧拒绝：那是调用方拼错了 id。
        if (existing.status !== "planned") {
          throw new Error(`run ${input.runId} already exists in project ${input.projectId}`);
        }
        this.db
          .prepare("UPDATE qa_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ?")
          .run(this.at(), this.at(), input.runId);
        return this.run(input.projectId, input.runId)!;
      }
      const task = this.ensureTask({
        projectId: input.projectId,
        sessionId: input.sessionId,
        userId: input.userId,
        title: input.title,
      });
      const next = this.db
        .prepare("SELECT COALESCE(MAX(run_index), 0) + 1 AS n FROM qa_runs WHERE task_id = ?")
        .get(task.taskId) as { n: number };
      const now = this.at();
      this.db
        .prepare(
          `INSERT INTO qa_runs
             (run_id, task_id, project_id, session_id, env, kind, status, run_index, manifest_path,
              manifest_sha256, manifest_version, sut_version, baseline_hash, resource_pool, device_id,
              batch_id, counts_json, dispatch_json, started_at, finished_at,
              created_at, created_by, updated_at)
           VALUES (?,?,?,?,?,?,'running',?,'','',NULL,NULL,NULL,?,?,NULL,'{}',?,?,NULL,?,?,?)`,
        )
        .run(
          input.runId,
          task.taskId,
          input.projectId,
          input.sessionId,
          input.env ?? task.env,
          input.kind ?? "execution",
          Number(next.n ?? 1),
          input.resourcePool ?? null,
          input.deviceId ?? null,
          JSON.stringify(input.dispatch ?? {}),
          now,
          now,
          input.userId,
          now,
        );
      return this.run(input.projectId, input.runId)!;
    });
  }

  /**
   * 交回执行结果。事实仍走 `observeRun`（必须带 manifest 路径与指纹），这一层不承接
   * 任何自报结论；`counts` 覆盖写入，重复交回不会把用例数翻倍。
   *
   * 只接受"还在跑"的 run：已经结束的 run 再交一次结果，说明调用方拿旧结果覆盖新结果，
   * 或者同一次执行被发起了两遍——两者都该报出来，而不是静默写进去。
   *
   * 中断不需要走这里：执行器崩了就永远不会调用它，run 会停在 `running`，读时按阈值标
   * `stalled`（疑似中断），由人决定重跑。**不自动重跑**：真机上有写操作，自动续跑等于
   * 重复执行。
   */
  finishRun(input: {
    projectId: string;
    runId: string;
    facts: RunManifestFacts;
    manifestPath: string;
    manifestSha256: string;
    counts?: Record<string, number>;
  }): QaRun {
    const current = this.run(input.projectId, input.runId);
    if (!current) throw new Error(`run ${input.runId} not found in project ${input.projectId}`);
    // observeRun 以 facts.runId 为键：两者不一致会**插入一条新 run**，而不是报错。
    // 这条线一旦断开，发起的那条永远停在 running，而结果挂在一条没人发起过的 run 下。
    if (input.facts.runId !== input.runId) {
      throw new Error(`run manifest reports ${input.facts.runId}, but this run is ${input.runId}`);
    }
    if (current.status !== "running") {
      throw new Error(`run ${input.runId} is ${current.status}, not running`);
    }
    const observed = this.observeRun({
      projectId: input.projectId,
      sessionId: current.sessionId,
      userId: current.createdBy,
      facts: input.facts,
      manifestPath: input.manifestPath,
      manifestSha256: input.manifestSha256,
      kind: current.kind,
      env: current.env,
    });
    return input.counts ? (this.settleRun(input.projectId, input.runId, input.counts) ?? observed) : observed;
  }

  // ---------------------------------------------------------------- 资源池租约

  /**
   * 申请一个池槽位；没有空位返回 null（调用方排队或拒绝，不要忙等重试）。
   *
   * 过期即视为空闲——执行进程崩了不会留下永久占用的设备，这是租约相对于"加锁标志位"
   * 的唯一好处，也是它必须有 TTL 的原因。同一个 run 重复申请会拿回自己已持有的槽位，
   * 不会把自己锁在门外。
   */
  acquirePoolSlot(input: {
    projectId: string;
    pool: ResourcePool;
    runId: string;
    capacity?: number;
    ttlMs?: number;
  }): { slot: number; leaseUntil: string } | null {
    const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_POOL_CAPACITY[input.pool]));
    const ttl = Math.max(1000, Math.floor(input.ttlMs ?? 30 * 60 * 1000));
    return this.tx(() => {
      const nowMs = this.now();
      // 顺手清一次全表过期租约（G6 资产治理的最小实体）：有效租约的行不可能过期，删的
      // 只是 TTL 兜底之后的残行——包括容量缩到比历史峰值小之后 slot≥capacity 的那些
      // （acquire 的接管循环只扫 [0, capacity)，扫不到它们，不清就永远留着）。
      this.db.prepare("DELETE FROM qa_pool_leases WHERE lease_until <= ?").run(new Date(nowMs).toISOString());
      const leaseUntil = new Date(nowMs + ttl).toISOString();
      const rows = this.db
        .prepare("SELECT slot, project_id, holder_run_id, lease_until FROM qa_pool_leases WHERE pool = ?")
        .all(input.pool) as { slot: number; project_id: string; holder_run_id: string; lease_until: string }[];
      const held = new Map(rows.map((row) => [Number(row.slot), row]));
      for (let slot = 0; slot < capacity; slot += 1) {
        const current = held.get(slot);
        const free = !current || Date.parse(current.lease_until) <= nowMs;
        const own = current && current.project_id === input.projectId && current.holder_run_id === input.runId;
        if (!free && !own) continue;
        const now = this.at();
        this.db
          .prepare(
            `INSERT INTO qa_pool_leases(pool, slot, project_id, holder_run_id, lease_until, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(pool, slot) DO UPDATE SET
               project_id = excluded.project_id, holder_run_id = excluded.holder_run_id,
               lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
          )
          .run(input.pool, slot, input.projectId, input.runId, leaseUntil, now, now);
        return { slot, leaseUntil };
      }
      return null;
    });
  }

  /** 只释放自己持有的槽位；返回 false 说明租约已过期被别人接管，不能误删。 */
  releasePoolSlot(input: { projectId: string; pool: ResourcePool; slot: number; runId: string }): boolean {
    const result = this.db
      .prepare("DELETE FROM qa_pool_leases WHERE pool = ? AND slot = ? AND project_id = ? AND holder_run_id = ?")
      .run(input.pool, input.slot, input.projectId, input.runId) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * 按 run 释放：结束一次执行时调用方不一定记得槽号，而槽号在 TTL 过期后可能已经换人。
   * 条件里带 `holder_run_id`，所以即使槽位被接管也不会误删别人的；返回释放了几行——
   * 0 说明租约早就过期了，这**不是错误**（崩溃过的 run 本来就该由 TTL 兜底）。
   */
  releasePoolSlotOfRun(input: { projectId: string; pool: ResourcePool; runId: string }): number {
    const result = this.db
      .prepare("DELETE FROM qa_pool_leases WHERE pool = ? AND project_id = ? AND holder_run_id = ?")
      .run(input.pool, input.projectId, input.runId) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** 当前池占用情况（排障用：谁在跑、还剩几个槽）。 */
  poolStatus(pool: ResourcePool, capacity?: number): {
    capacity: number;
    free: number;
    holders: { slot: number; projectId: string; runId: string; leaseUntil: string; expired: boolean }[];
  } {
    const limit = Math.max(1, Math.floor(capacity ?? DEFAULT_POOL_CAPACITY[pool]));
    const nowMs = this.now();
    const rows = this.db
      .prepare("SELECT slot, project_id, holder_run_id, lease_until FROM qa_pool_leases WHERE pool = ? ORDER BY slot")
      .all(pool) as { slot: number; project_id: string; holder_run_id: string; lease_until: string }[];
    const holders = rows.map((row) => ({
      slot: Number(row.slot),
      projectId: row.project_id,
      runId: row.holder_run_id,
      leaseUntil: row.lease_until,
      expired: Date.parse(row.lease_until) <= nowMs,
    }));
    const active = holders.filter((item) => !item.expired).length;
    return { capacity: limit, free: Math.max(0, limit - active), holders };
  }

  /**
   * "这次和上次比"。
   *
   * 只读 `qa_case_results`（每 run/case 的最新结果），不猜：没有结果的用例不当作通过，
   * 环境或被测版本不同的两个 run 仍然给出差异，但标 `comparable=false` 并说明原因——
   * 结论打折看，是使用者的决定，不是本方法的隐瞒。
   */
  compareRuns(projectId: string, sessionId: string, fromRunId: string, toRunId: string): RunComparison {
    const from = this.run(projectId, fromRunId);
    const to = this.run(projectId, toRunId);
    if (!from || !to) throw new Error("run not found in this project");
    if (from.sessionId !== sessionId || to.sessionId !== sessionId) throw new Error("run does not belong to this task");
    const statuses = (runId: string): Map<string, string> => {
      const rows = this.db
        .prepare("SELECT case_key, status FROM qa_case_results WHERE project_id = ? AND run_id = ?")
        .all(projectId, runId) as { case_key: string; status: string }[];
      return new Map(rows.map((row) => [row.case_key, row.status]));
    };
    const before = statuses(fromRunId);
    const after = statuses(toRunId);
    const regressions: string[] = [];
    const fixed: string[] = [];
    const stillFailing: string[] = [];
    for (const [key, beforeStatus] of before) {
      const afterStatus = after.get(key);
      if (afterStatus === undefined) continue;
      if (beforeStatus === "passed" && afterStatus === "failed") regressions.push(key);
      else if (beforeStatus === "failed" && afterStatus === "passed") fixed.push(key);
      else if (beforeStatus === "failed" && afterStatus === "failed") stillFailing.push(key);
    }
    const added = [...after.keys()].filter((key) => !before.has(key));
    const removed = [...before.keys()].filter((key) => !after.has(key));
    const reasons: string[] = [];
    if (!from.env || !to.env) reasons.push("环境未记录：无法确认两次是否同一个环境");
    else if (from.env !== to.env) reasons.push(`环境不同：${from.env} → ${to.env}`);
    // 版本三态：两个"未记录"不能算"同一个版本"——那正是 G3 要求标 inconclusive 的场景
    let versionStatus: "same" | "different" | "unknown" = "unknown";
    if (from.sutVersion && to.sutVersion) {
      versionStatus = from.sutVersion === to.sutVersion ? "same" : "different";
      if (versionStatus === "different") reasons.push(`被测版本不同：${from.sutVersion} → ${to.sutVersion}`);
    } else {
      reasons.push("被测版本未记录（G3）：结论标 inconclusive，不当作通过或回归");
    }
    let baselineStatus: "same" | "different" | "unknown" = "unknown";
    if (from.baselineHash && to.baselineHash) {
      baselineStatus = from.baselineHash === to.baselineHash ? "same" : "different";
      if (baselineStatus === "different") {
        // 基线不同意味着数据库/mock/文件至少有一处变了，两次结果不是同一实验条件
        reasons.push(`环境基线不同：${from.baselineHash.slice(0, 12)} → ${to.baselineHash.slice(0, 12)}`);
      }
    } else if (from.baselineHash || to.baselineHash) {
      reasons.push("仅一侧采集了环境基线，环境是否一致无从判断");
    }
    return {
      from,
      to,
      regressions: regressions.sort(),
      fixed: fixed.sort(),
      stillFailing: stillFailing.sort(),
      added: added.sort(),
      removed: removed.sort(),
      comparable: reasons.length === 0,
      baselineStatus,
      versionStatus,
      reasons,
    };
  }
}
