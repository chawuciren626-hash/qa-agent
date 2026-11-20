/**
 * 平台任务列表服务（TL-1/TL-3 切片）。
 *
 * 口径依据《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5 与 TLQ-1~5：
 * - 列表 = platform_task_links（平台映射）∪ qa_local_tasks（本地新建）的查询视图，不建第二份副本（S2）。
 * - AI 分析复用第一阶段需求分析（S3）；本切片数据源为演示种子（source_system='demo'），
 *   ai_summary_json 带 source:'demo' 标注，真数据源/真分析管线接通后整体替换，前端不改。
 * - 状态机：pending_analysis → ready → in_progress → result_returned；impact_pending 由
 *   新版本事件触发（ingestion 建设时接线）；terminated 人工终止（封存）。
 * - 开始测试（TLQ-1）：平台任务必须 ai_summary_json 已回填；本地任务不强制（T5）。
 * - 编辑（T4）：平台任务仅 local_title_note / local_test_focus_note；本地任务全量字段。
 * - 全部状态变更写 last_action_json 审计（操作人/时间/动作）。
 *
 * 已知边界（如实标注）：AI 分析产出当前为确定性演示数据；新版本影响确认、结果回传联动
 * 依赖对接阶段 4/5，未在本切片。
 */
import { randomUUID } from "node:crypto";

/** Minimal sqlite shape the service needs (node:sqlite DatabaseSync). */
export interface PlatformTaskDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export type PlatformTaskStatus =
  | "pending_analysis"
  | "ready"
  | "in_progress"
  | "impact_pending"
  | "result_returned"
  | "terminated";

export type LocalTaskStatus = "ready" | "in_progress" | "result_returned" | "terminated";

export interface AiSummary {
  requirement_points: string[];
  suggested_test_scope: string[];
  suggested_priority: string;
  priority_reason: string;
  risks: string[];
  open_questions: string[];
  analyzed_at: string;
  /** 'demo' = 演示产出；'requirement_analysis' = 真实第一阶段管线（接线后） */
  source: string;
  stage?: string;
}

export interface TaskListItem {
  id: string;
  source: "platform" | "local";
  taskNo: string;
  title: string;
  priority: string;
  packageVersion: number | null;
  roundNo: number | null;
  productLines: Array<{ name: string; isPrimary: boolean }>;
  suggestedPriority: string | null;
  analysisSource: string | null;
  status: string;
  edited: boolean;
  mainSessionId: string | null;
  sourceUrl: string;
  updatedAt: string;
}

export interface TaskProgressRun {
  runId: string;
  status: string;
  counts: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskDetail {
  task: TaskListItem & {
    feedbackType: string | null;
    estimatedHours: number | null;
    submitter: string | null;
    assignee: string | null;
    description: string | null;
    localTitleNote: string;
    localTestFocusNote: string;
    localEditedAt: string | null;
    packageVersion: number | null;
    roundNo: number | null;
    createdBy: string | null;
  };
  summary: AiSummary | null;
  progress: { mainSessionId: string | null; runs: TaskProgressRun[] };
}

const STATUS_ORDER: Record<string, number> = {
  pending_analysis: 0,
  ready: 1,
  in_progress: 2,
  impact_pending: 3,
  result_returned: 4,
  terminated: 5,
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asSummary(value: unknown): AiSummary | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    requirement_points: strArr(s.requirement_points),
    suggested_test_scope: strArr(s.suggested_test_scope),
    suggested_priority: typeof s.suggested_priority === "string" ? s.suggested_priority : "medium",
    priority_reason: typeof s.priority_reason === "string" ? s.priority_reason : "",
    risks: strArr(s.risks),
    open_questions: strArr(s.open_questions),
    analyzed_at: typeof s.analyzed_at === "string" ? s.analyzed_at : "",
    source: typeof s.source === "string" ? s.source : "demo",
    stage: typeof s.stage === "string" ? s.stage : undefined,
  };
}

const PLATFORM_SELECT = `
  SELECT link_id AS id, 'platform' AS source, external_task_no AS task_no, title, priority,
         package_version, pm_round_no, product_lines_json, suggested_priority, ai_summary_json,
         status, local_edited_at, main_session_id, source_url, updated_at
    FROM platform_task_links
    WHERE project_id = ?`;
const LOCAL_SELECT = `
  SELECT task_id AS id, 'local' AS source, task_id AS task_no, title, priority,
         NULL AS package_version, NULL AS pm_round_no, '[]' AS product_lines_json,
         suggested_priority, ai_summary_json, status, NULL AS local_edited_at,
         main_session_id, '' AS source_url, updated_at
    FROM qa_local_tasks
    WHERE project_id = ?`;

interface RawRow {
  id: string;
  source: string;
  task_no: string;
  title: string;
  priority: string;
  package_version: number | null;
  pm_round_no: number | null;
  product_lines_json: string;
  suggested_priority: string | null;
  ai_summary_json: string | null;
  status: string;
  local_edited_at: string | null;
  main_session_id: string | null;
  source_url: string;
  updated_at: string;
}

export class QaPlatformTaskService {
  constructor(private readonly db: PlatformTaskDb) {}

  // ------------------------------------------------------------- list / detail

  list(projectId: string, includeTerminated: boolean): {
    items: TaskListItem[];
    counts: Record<string, number>;
  } {
    const rows = [
      ...(this.db.prepare(`${PLATFORM_SELECT} ORDER BY updated_at DESC`).all(projectId) as RawRow[]),
      ...(this.db.prepare(`${LOCAL_SELECT} ORDER BY updated_at DESC`).all(projectId) as RawRow[]),
    ];
    const items = rows.map((r) => this.toListItem(r));
    const counts: Record<string, number> = {
      pending_analysis: 0,
      ready: 0,
      in_progress: 0,
      impact_pending: 0,
      result_returned: 0,
      terminated: 0,
    };
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const visible = items.filter((i) => includeTerminated || i.status !== "terminated");
    visible.sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
    return { items: visible, counts };
  }

  private toListItem(r: RawRow): TaskListItem {
    const lines = parseJson(r.product_lines_json);
    return {
      id: r.id,
      source: r.source === "local" ? "local" : "platform",
      taskNo: r.task_no,
      title: r.title,
      priority: r.priority,
      packageVersion: r.package_version,
      roundNo: r.pm_round_no,
      productLines: Array.isArray(lines)
        ? lines
            .filter((x): x is { name: string; isPrimary: boolean } => !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string")
            .map((x) => ({ name: x.name, isPrimary: x.isPrimary === true }))
        : [],
      suggestedPriority: r.suggested_priority,
      analysisSource: asSummary(parseJson(r.ai_summary_json))?.source ?? null,
      status: r.status,
      edited: !!r.local_edited_at,
      mainSessionId: r.main_session_id,
      sourceUrl: r.source_url,
      updatedAt: r.updated_at,
    };
  }

  private findPlatform(projectId: string, id: string): RawRow | null {
    return (
      (this.db
        .prepare(`${PLATFORM_SELECT} AND link_id = ?`)
        .get(projectId, id) as RawRow | undefined) ?? null
    );
  }

  private findLocal(projectId: string, id: string): RawRow | null {
    return (
      (this.db.prepare(`${LOCAL_SELECT} AND task_id = ?`).get(projectId, id) as RawRow | undefined) ??
      null
    );
  }

  /** 按 id 取条目，先查平台映射再查本地任务；跨项目访问返回 null 由路由转 404。 */
  findAny(projectId: string, id: string): { row: RawRow; source: "platform" | "local" } | null {
    const platform = this.findPlatform(projectId, id);
    if (platform) return { row: platform, source: "platform" };
    const local = this.findLocal(projectId, id);
    if (local) return { row: local, source: "local" };
    return null;
  }

  detail(projectId: string, id: string): TaskDetail | null {
    const found = this.findAny(projectId, id);
    if (!found) return null;
    const { row, source } = found;
    const item = this.toListItem(row);
    let extra: Partial<TaskDetail["task"]> = {};
    if (source === "platform") {
      const full = this.db
        .prepare(
          `SELECT feedback_type, estimated_hours, local_title_note, local_test_focus_note,
                  local_edited_at, source_url
             FROM platform_task_links WHERE link_id = ? AND project_id = ?`
        )
        .get(id, projectId) as
        | {
            feedback_type: string;
            estimated_hours: number | null;
            local_title_note: string;
            local_test_focus_note: string;
            local_edited_at: string | null;
            source_url: string;
          }
        | undefined;
      extra = {
        feedbackType: full?.feedback_type ?? null,
        estimatedHours: full?.estimated_hours ?? null,
        localTitleNote: full?.local_title_note ?? "",
        localTestFocusNote: full?.local_test_focus_note ?? "",
        localEditedAt: full?.local_edited_at ?? null,
        sourceUrl: full?.source_url ?? "",
      };
    } else {
      const full = this.db
        .prepare(`SELECT description, created_by FROM qa_local_tasks WHERE task_id = ? AND project_id = ?`)
        .get(id, projectId) as { description: string; created_by: string } | undefined;
      extra = { description: full?.description ?? "", createdBy: full?.created_by ?? null };
    }
    const runs = row.main_session_id
      ? (
          this.db
            .prepare(
              `SELECT run_id, status, counts_json, started_at, finished_at
                 FROM qa_runs WHERE project_id = ? AND session_id = ?
                 ORDER BY started_at DESC LIMIT 5`
            )
            .all(projectId, row.main_session_id) as Array<{
            run_id: string;
            status: string;
            counts_json: string;
            started_at: string | null;
            finished_at: string | null;
          }>
        ).map((r) => ({
          runId: r.run_id,
          status: r.status,
          counts: (parseJson(r.counts_json) as Record<string, unknown>) ?? {},
          startedAt: r.started_at,
          finishedAt: r.finished_at,
        }))
      : [];
    return {
      task: {
        ...item,
        feedbackType: extra.feedbackType ?? null,
        estimatedHours: extra.estimatedHours ?? null,
        submitter: null,
        assignee: null,
        description: extra.description ?? null,
        localTitleNote: extra.localTitleNote ?? "",
        localTestFocusNote: extra.localTestFocusNote ?? "",
        localEditedAt: extra.localEditedAt ?? null,
        packageVersion: item.packageVersion,
        roundNo: item.roundNo,
        createdBy: extra.createdBy ?? null,
      },
      summary: asSummary(parseJson(row.ai_summary_json)),
      progress: { mainSessionId: row.main_session_id, runs },
    };
  }

  // ------------------------------------------------------------- mutations

  private audit(projectId: string, id: string, source: "platform" | "local", action: string, userId: string, detail?: Record<string, unknown>): void {
    const entry = JSON.stringify({ action, user_id: userId, at: nowIso(), ...(detail ?? {}) });
    if (source === "platform") {
      this.db
        .prepare(`UPDATE platform_task_links SET last_action_json = ?, updated_at = ? WHERE link_id = ? AND project_id = ?`)
        .run(entry, nowIso(), id, projectId);
    } else {
      this.db
        .prepare(`UPDATE qa_local_tasks SET last_action_json = ?, updated_at = ? WHERE task_id = ? AND project_id = ?`)
        .run(entry, nowIso(), id, projectId);
    }
  }

  createLocal(input: {
    projectId: string;
    userId: string;
    title: string;
    description: string;
    priority: string;
  }): TaskListItem {
    const id = `qlt-${randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO qa_local_tasks (task_id, project_id, title, description, priority, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`
      )
      .run(id, input.projectId, input.title, input.description, input.priority, input.userId, now, now);
    const row = this.findLocal(input.projectId, id);
    if (!row) throw new Error("local task insert lost");
    return this.toListItem(row);
  }

  /** 编辑（T4）：平台任务仅补充字段；本地任务全量字段。terminated 拒绝。 */
  edit(input: {
    projectId: string;
    userId: string;
    id: string;
    localTitleNote?: string;
    localTestFocusNote?: string;
    title?: string;
    description?: string;
    priority?: string;
  }): { updated: TaskListItem | null; analysisStale: boolean } {
    const found = this.findAny(input.projectId, input.id);
    if (!found) return { updated: null, analysisStale: false };
    const { row, source } = found;
    if (row.status === "terminated") {
      const err = new Error("task_terminated") as Error & { status?: number; code?: string };
      err.status = 409;
      err.code = "task_terminated";
      throw err;
    }
    if (source === "platform") {
      this.db
        .prepare(
          `UPDATE platform_task_links SET local_title_note = ?, local_test_focus_note = ?, local_edited_at = ?, updated_at = ?
           WHERE link_id = ? AND project_id = ?`
        )
        .run(
          input.localTitleNote ?? "",
          input.localTestFocusNote ?? "",
          nowIso(),
          nowIso(),
          input.id,
          input.projectId
        );
    } else {
      this.db
        .prepare(
          `UPDATE qa_local_tasks SET title = ?, description = ?, priority = ?, updated_at = ?
           WHERE task_id = ? AND project_id = ?`
        )
        .run(
          input.title ?? row.title,
          input.description ?? "",
          input.priority ?? row.priority,
          nowIso(),
          input.id,
          input.projectId
        );
    }
    // 编辑保存后提示重新分析（T4）：已分析且内容来源字段被修改 → 前端提示，人工决定
    const analysisStale = !!row.ai_summary_json;
    this.audit(input.projectId, input.id, source, "edit", input.userId, { analysisStale });
    const updated = this.findAny(input.projectId, input.id)?.row ?? null;
    return { updated: updated ? this.toListItem(updated) : null, analysisStale };
  }

  /**
   * AI 分析触发（T2）：pending_analysis 的重试与已完成态的重新分析共用此入口。
   * 本切片产出演示摘要（source:'demo'）；真管线接通后由第一阶段结果提取替换。
   * 平台任务在 terminated 拒绝；本地任务任何时候可分析（可选增强）。
   */
  analyze(input: { projectId: string; userId: string; id: string }): { updated: TaskListItem | null; summary: AiSummary | null } {
    const found = this.findAny(input.projectId, input.id);
    if (!found) return { updated: null, summary: null };
    const { row, source } = found;
    if (row.status === "terminated") {
      const err = new Error("task_terminated") as Error & { status?: number; code?: string };
      err.status = 409;
      err.code = "task_terminated";
      throw err;
    }
    let info: { title: string; description: string; notes: string };
    if (source === "platform") {
      const full = this.db
        .prepare(`SELECT title, local_title_note, local_test_focus_note FROM platform_task_links WHERE link_id = ? AND project_id = ?`)
        .get(input.id, input.projectId) as
        | { title: string; local_title_note: string; local_test_focus_note: string }
        | undefined;
      info = {
        title: full?.title ?? row.title,
        description: "",
        notes: [full?.local_title_note, full?.local_test_focus_note].filter(Boolean).join("；"),
      };
    } else {
      const full = this.db
        .prepare(`SELECT title, description FROM qa_local_tasks WHERE task_id = ? AND project_id = ?`)
        .get(input.id, input.projectId) as { title: string; description: string } | undefined;
      info = { title: full?.title ?? row.title, description: full?.description ?? "", notes: "" };
    }
    const summary = demoSummary(info.title, info.description, info.notes, row.priority);
    const summaryJson = JSON.stringify(summary);
    if (source === "platform") {
      this.db
        .prepare(
          `UPDATE platform_task_links SET ai_summary_json = ?, suggested_priority = ?,
             status = CASE WHEN status = 'pending_analysis' THEN 'ready' ELSE status END,
             updated_at = ? WHERE link_id = ? AND project_id = ?`
        )
        .run(summaryJson, summary.suggested_priority, nowIso(), input.id, input.projectId);
    } else {
      this.db
        .prepare(
          `UPDATE qa_local_tasks SET ai_summary_json = ?, suggested_priority = ?, updated_at = ?
           WHERE task_id = ? AND project_id = ?`
        )
        .run(summaryJson, summary.suggested_priority, nowIso(), input.id, input.projectId);
    }
    this.audit(input.projectId, input.id, source, row.ai_summary_json ? "reanalyze" : "analyze", input.userId, {
      source: "demo",
    });
    const updated = this.findAny(input.projectId, input.id)?.row ?? null;
    return { updated: updated ? this.toListItem(updated) : null, summary };
  }

  /**
   * 开始测试前置闸（TLQ-1/T5）：在创建会话**之前**调用，未通过不消耗会话资源。
   * 平台任务必须分析完成；本地任务不强制。
   */
  assertStartable(projectId: string, id: string): { row: RawRow; source: "platform" | "local" } {
    const found = this.findAny(projectId, id);
    if (!found) {
      const err = new Error("task_not_found") as Error & { status?: number; code?: string };
      err.status = 404;
      err.code = "task_not_found";
      throw err;
    }
    const { row, source } = found;
    const reject = (code: string, message: string): never => {
      const err = new Error(code) as Error & { status?: number; code?: string };
      err.status = 409;
      err.code = code;
      err.message = message;
      throw err;
    };
    if (row.status === "terminated" || row.status === "result_returned") {
      reject("task_not_startable", "任务已终止或已回传，不能再开始测试。");
    }
    if (source === "platform" && row.status === "pending_analysis") {
      reject("analysis_required", "AI 分析未完成，开始测试不可用（TLQ-1）；可先点重试分析。");
    }
    if (source === "platform" && row.status === "impact_pending") {
      reject("impact_confirm_required", "新版本影响待确认，请先在详情中确认影响。");
    }
    return found;
  }

  /**
   * 开始测试（TLQ-1/T5）：会话已由路由层创建/校验后传入；service 只管绑定与状态。
   */
  start(input: { projectId: string; userId: string; id: string; sessionId: string }): {
    updated: TaskListItem | null;
    previousStatus: string | null;
  } {
    const { row, source } = this.assertStartable(input.projectId, input.id);
    const previousStatus = row.status;
    const run = source === "platform"
      ? this.db
          .prepare(
            `UPDATE platform_task_links SET status = 'in_progress', main_session_id = ?, updated_at = ?
             WHERE link_id = ? AND project_id = ?`
          )
          .run(input.sessionId, nowIso(), input.id, input.projectId)
      : this.db
          .prepare(
            `UPDATE qa_local_tasks SET status = 'in_progress', main_session_id = ?, updated_at = ?
             WHERE task_id = ? AND project_id = ?`
          )
          .run(input.sessionId, nowIso(), input.id, input.projectId);
    void run;
    this.audit(input.projectId, input.id, source, "start", input.userId, { session_id: input.sessionId });
    const updated = this.findAny(input.projectId, input.id)?.row ?? null;
    return { updated: updated ? this.toListItem(updated) : null, previousStatus };
  }

  terminate(input: { projectId: string; userId: string; id: string; reason?: string }): { updated: TaskListItem | null } {
    const found = this.findAny(input.projectId, input.id);
    if (!found) return { updated: null };
    const { row, source } = found;
    const run =
      source === "platform"
        ? this.db
            .prepare(`UPDATE platform_task_links SET status = 'terminated', updated_at = ? WHERE link_id = ? AND project_id = ?`)
            .run(nowIso(), input.id, input.projectId)
        : this.db
            .prepare(`UPDATE qa_local_tasks SET status = 'terminated', updated_at = ? WHERE task_id = ? AND project_id = ?`)
            .run(nowIso(), input.id, input.projectId);
    void run;
    this.audit(input.projectId, input.id, source, "terminate", input.userId, { reason: input.reason ?? "" });
    const updated = this.findAny(input.projectId, input.id)?.row ?? null;
    return { updated: updated ? this.toListItem(updated) : null };
  }

  // ------------------------------------------------------------- demo seed

  /**
   * 演示种子（T1 mock 先行口径）：项目下没有任何条目时，插入一组样例平台任务
   * （source_system='demo'，真数据源接通后 DELETE FROM platform_task_links WHERE source_system='demo' 即清）。
   * 本地任务不种子——留给用户自己建。
   */
  seedDemoIfEmpty(projectId: string): { seeded: boolean; count: number } {
    const existing = this.db
      .prepare(`SELECT COUNT(*) AS n FROM platform_task_links WHERE project_id = ?`)
      .get(projectId) as { n: number };
    if (existing.n > 0) return { seeded: false, count: existing.n };
    const now = nowIso();
    const demo: Array<{
      no: string;
      title: string;
      priority: string;
      status: PlatformTaskStatus;
      version: number;
      round: number;
      lines: Array<{ name: string; isPrimary: boolean }>;
      feedback: string;
      hours: number;
      analyzed: boolean;
    }> = [
      { no: "FB202611090001", title: "gov 用户端登录优化", priority: "high", status: "ready", version: 3, round: 3,
        lines: [{ name: "gov 用户端", isPrimary: true }, { name: "数据平台", isPrimary: false }],
        feedback: "requirement", hours: 24, analyzed: true },
      { no: "FB202611020002", title: "淘宝渠道 API Key 管理页", priority: "medium", status: "pending_analysis", version: 1, round: 1,
        lines: [{ name: "gov 用户端", isPrimary: true }], feedback: "requirement", hours: 12, analyzed: false },
      { no: "FB202611150005", title: "卡密卡池分页查询优化", priority: "high", status: "impact_pending", version: 2, round: 3,
        lines: [{ name: "gov 用户端", isPrimary: true }, { name: "计费网关", isPrimary: false }],
        feedback: "requirement", hours: 16, analyzed: true },
      { no: "FB202611010004", title: "报表中心权限隔离修复", priority: "medium", status: "in_progress", version: 2, round: 2,
        lines: [{ name: "gov 用户端", isPrimary: true }], feedback: "bug", hours: 10, analyzed: true },
      { no: "FB202610280006", title: "网关限流配置页面", priority: "medium", status: "result_returned", version: 1, round: 1,
        lines: [{ name: "计费网关", isPrimary: true }], feedback: "requirement", hours: 8, analyzed: true },
    ];
    for (const d of demo) {
      const summary = d.analyzed ? JSON.stringify(demoSummary(d.title, "", "", d.priority)) : null;
      this.db
        .prepare(
          `INSERT INTO platform_task_links (
             link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
             title, priority, product_lines_json, feedback_type, estimated_hours,
             package_version, pm_round_no, source_url, status, ai_summary_json, suggested_priority,
             last_action_json, created_at, updated_at
           ) VALUES (?, ?, 'demo', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `ptl-${randomUUID()}`, projectId, d.no, d.no, d.title, d.priority,
          JSON.stringify(d.lines), d.feedback, d.hours, d.version, d.round,
          `https://platform.example.com/tasks/active?taskId=${d.no}`, d.status,
          summary, d.analyzed ? summaryPriorityOf(d.priority) : null,
          JSON.stringify({ action: "demo_seed", at: now }), now, now
        );
    }
    return { seeded: true, count: demo.length };
  }

  /** 清除演示数据（真数据源接通时调用，或前端提供手动清理）。 */
  clearDemo(projectId: string): number {
    const run = this.db
      .prepare(`DELETE FROM platform_task_links WHERE project_id = ? AND source_system = 'demo'`)
      .run(projectId) as { changes?: number | bigint };
    return Number(run?.changes ?? 0);
  }
}

function summaryPriorityOf(priority: string): string {
  return priority === "high" ? "high" : priority === "low" ? "low" : "medium";
}

/**
 * 演示摘要构造器：确定性规则（不调模型），按标题/描述/备注做关键词切分。
 * 真实接线后由第一阶段需求分析输出提取替换（S3；见方案 §5.2 摘要提取服务）。
 */
export function demoSummary(title: string, description: string, notes: string, priority: string): AiSummary {
  const basis = [title, description, notes].filter((x) => x && x.trim()).join("；");
  const clauses = basis
    .split(/[；;。;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .slice(0, 4);
  const points = clauses.length > 0 ? clauses : [`围绕「${title}」的功能要点（演示产出，待真实分析替换）`];
  const suggested = summaryPriorityOf(priority);
  return {
    requirement_points: points,
    suggested_test_scope: points.map((p) => `覆盖：${p.slice(0, 24)}`),
    suggested_priority: suggested,
    priority_reason:
      notes
        ? `平台优先级与本地备注已纳入（演示产出）`
        : `平台优先级=${priority === "high" ? "高" : priority === "medium" ? "中" : "低"}（演示产出）`,
    risks: [],
    open_questions: [],
    analyzed_at: nowIso(),
    source: "demo",
    stage: "requirement_analysis_demo",
  };
}
