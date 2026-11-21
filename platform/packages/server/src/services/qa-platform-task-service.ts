/**
 * 平台任务列表服务（TL-1/TL-3 切片）。
 *
 * 口径依据《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5 与 TLQ-1~5：
 * - 列表 = platform_task_links（平台映射）∪ qa_local_tasks（本地新建）的查询视图，不建第二份副本（S2）。
 * - AI 分析 = 同步模型通道：项目默认模型一次性补全（deps.completeOnce）分析用户填写的
 *   内容，产出结构化结论（需求整理/测试环境/测试账号/建议范围/风险/待澄清）直接回填
 *   ai_summary_json，不建会话、不起流程；模型未配置/失败/答非所问时回退演示摘要
 *   （source:'demo'）并在 degraded 带原因——分析是增强不是闸（T5）。
 * - 状态机：pending_analysis → ready → in_progress → result_returned；impact_pending 由
 *   新版本事件触发（ingestion 建设时接线）；terminated 人工终止（封存）。
 * - 开始测试（TLQ-1）：平台任务必须 ai_summary_json 已回填；本地任务不强制（T5）。
 *   开始测试仍建总控会话并注入「平台任务开工」指令（会话模型缺省回退账号级设置）。
 * - 编辑（T4）：平台任务仅 local_title_note / local_test_focus_note；本地任务全量字段。
 * - 全部状态变更写 last_action_json 审计（操作人/时间/动作）。
 *
 * 已知边界（如实标注）：分析产出依赖模型质量，答非所问回退演示摘要；新版本影响确认、
 * 结果回传联动依赖对接阶段 4/5。
 */
import { randomUUID } from "node:crypto";
import type { UtilityCompletion } from "./project-config-service.js";

/** Minimal sqlite shape the service needs (node:sqlite DatabaseSync). */
export interface PlatformTaskDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/**
 * AI 分析的可选模型通道：项目默认模型的一次性补全（ProjectConfigStore.completeOnce）。
 * 分析输出的 JSON 比标识符建议长得多，预算与等待由调用方在 opts 里放大。
 */
export interface AnalyzeModelDeps {
  completeOnce?: ((projectId: string, prompt: string, opts?: { maxTokens?: number; requestTimeoutMs?: number }) => Promise<UtilityCompletion>) | undefined;
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
  /** 需求内容整理（一段话概括要测什么）。 */
  requirement_summary?: string;
  requirement_points: string[];
  suggested_test_scope: string[];
  /** 测试环境（URL 或说明，从填写内容与任务环境字段整理）。 */
  test_environment?: string;
  /** 测试账号（从填写内容提取）。 */
  test_account?: string;
  /** 测试密码（从填写内容提取；来自用户自己录入的任务材料）。 */
  test_password?: string;
  suggested_priority: string;
  priority_reason: string;
  risks: string[];
  open_questions: string[];
  analyzed_at: string;
  /** 'requirement_analysis' = 模型真实分析；'demo' = 演示产出（模型不可用时的回退） */
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
    /** 本地任务：测试环境关联（env 名 + URL 快照）；未填为 null。 */
    envName: string | null;
    envBaseUrl: string | null;
    /** 本地任务：登录账号（选填；密码不落任务表）。 */
    account: string | null;
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
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    requirement_summary: str(s.requirement_summary),
    requirement_points: strArr(s.requirement_points),
    suggested_test_scope: strArr(s.suggested_test_scope),
    test_environment: str(s.test_environment),
    test_account: str(s.test_account),
    test_password: str(s.test_password),
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
         status, local_edited_at, main_session_id, source_url, NULL AS env_name, updated_at
    FROM platform_task_links
    WHERE project_id = ?`;
const LOCAL_SELECT = `
  SELECT task_id AS id, 'local' AS source, task_id AS task_no, title, priority,
         NULL AS package_version, NULL AS pm_round_no, '[]' AS product_lines_json,
         suggested_priority, ai_summary_json, status, NULL AS local_edited_at,
         main_session_id, '' AS source_url, env_name, updated_at
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
  env_name: string | null;
  updated_at: string;
}

/** 任务附件的列表视图（不含正文——正文只进分析上下文，不经 API 明细回传）。 */
export interface TaskAttachment {
  attachmentId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

export class QaPlatformTaskService {
  constructor(
    private readonly db: PlatformTaskDb,
    /** AI 分析的模型通道；缺省或调用失败时回退演示产出（source:'demo'，degraded 带原因）。 */
    private readonly model: AnalyzeModelDeps = {},
  ) {}

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
        .prepare(
          `SELECT description, created_by, env_name, env_base_url, account
             FROM qa_local_tasks WHERE task_id = ? AND project_id = ?`
        )
        .get(id, projectId) as
        | { description: string; created_by: string; env_name: string | null; env_base_url: string | null; account: string | null }
        | undefined;
      extra = {
        description: full?.description ?? "",
        createdBy: full?.created_by ?? null,
        envName: full?.env_name ?? null,
        envBaseUrl: full?.env_base_url ?? null,
        account: full?.account ?? null,
      };
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
        envName: extra.envName ?? null,
        envBaseUrl: extra.envBaseUrl ?? null,
        account: extra.account ?? null,
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

  /**
   * 本地任务创建（T5）：创建即 'ready'（可开始）。测试环境与登录账号由路由层解析后传入
   * （env_name 已按 base_url 匹配/登记），这里只落库；priority 列保留 DB 默认——
   * 表单不再收集，展示层以 AI 建议优先级为准。
   */
  createLocal(input: {
    projectId: string;
    userId: string;
    title: string;
    description: string;
    envName?: string | null;
    envBaseUrl?: string | null;
    account?: string;
  }): TaskListItem {
    const id = `qlt-${randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO qa_local_tasks (task_id, project_id, title, description, status, env_name, env_base_url, account, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.description,
        input.envName || null,
        input.envBaseUrl || null,
        input.account || null,
        input.userId,
        now,
        now
      );
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
    /** 本地任务：测试环境（路由层已解析；undefined=不改，null/空串=清除）。 */
    envName?: string | null;
    envBaseUrl?: string | null;
    account?: string;
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
      // 环境与账号只在调用方显式携带时改写（undefined=保持现状），避免老客户端
      // 漏传把已关联的环境清掉；空串是明确的"清除"。
      const full = this.db
        .prepare(`SELECT env_name, env_base_url, account FROM qa_local_tasks WHERE task_id = ? AND project_id = ?`)
        .get(input.id, input.projectId) as
        | { env_name: string | null; env_base_url: string | null; account: string | null }
        | undefined;
      this.db
        .prepare(
          `UPDATE qa_local_tasks SET title = ?, description = ?, priority = ?,
             env_name = ?, env_base_url = ?, account = ?, updated_at = ?
           WHERE task_id = ? AND project_id = ?`
        )
        .run(
          input.title ?? row.title,
          input.description ?? "",
          // 优先级不再由表单收集：缺省/空串都保持原值（空串落库会撞 CHECK）。
          input.priority || row.priority,
          input.envName !== undefined ? input.envName || null : full?.env_name ?? null,
          input.envBaseUrl !== undefined ? input.envBaseUrl || null : full?.env_base_url ?? null,
          input.account !== undefined ? input.account || null : full?.account ?? null,
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
   * 同步模型通道（completeOnce）直接分析用户填写的内容，产出结构化结论（需求整理、
   * 测试环境、测试账号、建议范围、风险与待澄清）——不建会话、不起流程；模型未配置/
   * 失败/答非所问时回退演示摘要（source:'demo'）并在 degraded 带原因。分析是增强
   * 不是闸（T5），失败不让任务卡死。平台任务 terminated 拒绝；本地随时可分析。
   */
  async analyze(input: { projectId: string; userId: string; id: string }): Promise<{
    updated: TaskListItem | null;
    summary: AiSummary | null;
    degraded?: { reason: string };
  }> {
    const found = this.findAny(input.projectId, input.id);
    if (!found) return { updated: null, summary: null };
    const { row, source } = found;
    if (row.status === "terminated") {
      const err = new Error("task_terminated") as Error & { status?: number; code?: string };
      err.status = 409;
      err.code = "task_terminated";
      throw err;
    }
    const info = this.taskInfo(input.projectId, input.id, source, row);
    const { summary, degraded } = await this.produceSummary(input.projectId, info, row.priority);
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
      source: summary.source,
      ...(degraded ? { degraded: degraded.reason } : {}),
    });
    const updated = this.findAny(input.projectId, input.id)?.row ?? null;
    return { updated: updated ? this.toListItem(updated) : null, summary, ...(degraded ? { degraded } : {}) };
  }

  // ------------------------------------------------------------------ 附件（B1-3b）

  /** 附件进入分析上下文的总预算（字符）：超出截断，防止单文件淹没分析提示词。 */
  private static readonly ATTACHMENT_PROMPT_BUDGET = 20000;

  listAttachments(projectId: string, id: string): TaskAttachment[] {
    const found = this.findAny(projectId, id);
    if (!found) return [];
    const rows = this.db
      .prepare(
        `SELECT attachment_id, filename, mime, size_bytes, created_at FROM qa_task_attachments
         WHERE project_id = ? AND task_source = ? AND task_id = ?
         ORDER BY created_at DESC, attachment_id DESC`,
      )
      .all(projectId, found.source, id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      attachmentId: String(row.attachment_id),
      filename: String(row.filename),
      mime: String(row.mime),
      sizeBytes: Number(row.size_bytes),
      createdAt: String(row.created_at),
    }));
  }

  addAttachment(input: {
    projectId: string;
    userId: string;
    id: string;
    filename: string;
    mime: string;
    contentText: string;
  }): TaskAttachment {
    const found = this.findAny(input.projectId, input.id);
    if (!found) throw this.attachmentError(404, "task_not_found", "任务不存在。");
    if (!input.contentText.trim()) throw this.attachmentError(400, "attachment_empty", "附件内容为空。");
    const bytes = Buffer.byteLength(input.contentText, "utf8");
    if (bytes > 60 * 1024) throw this.attachmentError(400, "attachment_too_large", "单个附件超过 60KB 上限。");
    const count = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM qa_task_attachments WHERE project_id = ? AND task_source = ? AND task_id = ?")
        .get(input.projectId, found.source, input.id) as { n: number }
    ).n;
    if (count >= 10) throw this.attachmentError(400, "attachment_limit", "单任务附件最多 10 件。");
    const attachmentId = `att_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const filename = input.filename.trim().slice(0, 200) || "attachment.txt";
    const mime = input.mime.trim().slice(0, 100) || "text/plain";
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO qa_task_attachments
           (attachment_id, project_id, task_source, task_id, filename, mime, size_bytes, content_text, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(attachmentId, input.projectId, found.source, input.id, filename, mime, bytes, input.contentText, input.userId, now, now);
    this.audit(input.projectId, input.id, found.source, "attachment_add", input.userId, { filename, sizeBytes: bytes });
    return { attachmentId, filename, mime, sizeBytes: bytes, createdAt: now };
  }

  removeAttachment(projectId: string, id: string, attachmentId: string, userId: string): boolean {
    const found = this.findAny(projectId, id);
    if (!found) return false;
    const info = this.db
      .prepare(
        "SELECT filename FROM qa_task_attachments WHERE attachment_id = ? AND project_id = ? AND task_source = ? AND task_id = ?",
      )
      .get(attachmentId, projectId, found.source, id) as { filename: string } | undefined;
    if (!info) return false;
    this.db.prepare("DELETE FROM qa_task_attachments WHERE attachment_id = ?").run(attachmentId);
    this.audit(projectId, id, found.source, "attachment_remove", userId, { filename: info.filename });
    return true;
  }

  private attachmentError(status: number, code: string, message: string) {
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = status;
    err.code = code;
    return err;
  }

  /** 附件 → 分析上下文块（简报/开工指令/analyze 共用）：单件与总预算截断。 */
  private attachmentPromptBlocks(projectId: string, id: string, source: "platform" | "local"): string[] {
    const rows = this.db
      .prepare(
        `SELECT filename, content_text FROM qa_task_attachments
         WHERE project_id = ? AND task_source = ? AND task_id = ?
         ORDER BY created_at ASC, attachment_id ASC`,
      )
      .all(projectId, source, id) as Array<{ filename: string; content_text: string }>;
    if (!rows.length) return [];
    let budget = QaPlatformTaskService.ATTACHMENT_PROMPT_BUDGET;
    const blocks: string[] = [];
    for (const row of rows) {
      if (budget <= 0) {
        blocks.push(`【附件资料 ${row.filename}】（超出分析预算未注入）`);
        continue;
      }
      let text = row.content_text;
      if (text.length > budget) text = `${text.slice(0, budget)}\n…[已截断]`;
      budget -= text.length;
      blocks.push(`【附件资料 ${row.filename}】\n${text}`);
    }
    return blocks;
  }

  /** 任务材料（简报/开工指令共用）：标题、描述、备注、附件、环境与账号。 */
  private taskInfo(projectId: string, id: string, source: "platform" | "local", row: RawRow): TaskInfo {
    // 附件是任务材料的一部分：analyze 提示词、开工简报共用同一份注入（预算内截断）。
    const attachments = this.attachmentPromptBlocks(projectId, id, source);
    if (source === "platform") {
      const full = this.db
        .prepare(`SELECT title, local_title_note, local_test_focus_note FROM platform_task_links WHERE link_id = ? AND project_id = ?`)
        .get(id, projectId) as
        | { title: string; local_title_note: string; local_test_focus_note: string }
        | undefined;
      return {
        title: full?.title ?? row.title,
        description: "",
        notes: [full?.local_title_note, full?.local_test_focus_note, ...attachments].filter(Boolean).join("\n"),
        envUrl: "",
        account: "",
      };
    }
    const full = this.db
      .prepare(`SELECT title, description, env_base_url, account FROM qa_local_tasks WHERE task_id = ? AND project_id = ?`)
      .get(id, projectId) as
      | { title: string; description: string; env_base_url: string | null; account: string | null }
      | undefined;
    return {
      title: full?.title ?? row.title,
      description: full?.description ?? "",
      notes: attachments.join("\n"),
      envUrl: full?.env_base_url ?? "",
      account: full?.account ?? "",
    };
  }

  /** 组装「开工指令」文本（开始测试注入工作会话的消息）；任务不存在返回 null。 */
  workStartBriefing(projectId: string, id: string): string | null {
    const found = this.findAny(projectId, id);
    if (!found) return null;
    const { row, source } = found;
    const info = this.taskInfo(projectId, id, source, row);
    return workStartText(source, row, info, asSummary(parseJson(row.ai_summary_json)));
  }

  /**
   * 产出一份摘要：模型通道可用就先问模型（分析预算 2000 tokens / 90s——结构化结论比
   * 标识符建议长得多），答不上来再落演示摘要，两种路径都返回可入库的 AiSummary。
   */
  private async produceSummary(
    projectId: string,
    info: { title: string; description: string; notes: string; envUrl: string; account: string },
    priority: string,
  ): Promise<{ summary: AiSummary; degraded?: { reason: string } }> {
    const complete = this.model.completeOnce;
    if (complete) {
      const res = await complete(projectId, analysisPrompt(info), {
        maxTokens: ANALYSIS_MAX_TOKENS,
        requestTimeoutMs: ANALYSIS_TIMEOUT_MS,
      });
      if (res.ok) {
        const parsed = parseSummaryJson(res.text);
        if (parsed) return { summary: parsed };
        return { summary: demoSummary(info.title, info.description, info.notes, priority), degraded: { reason: "模型回答不是有效的分析 JSON" } };
      }
      return {
        summary: demoSummary(info.title, info.description, info.notes, priority),
        degraded: { reason: res.cause === "no_model" ? "项目未配置默认模型" : `模型调用失败：${res.error}` },
      };
    }
    return {
      summary: demoSummary(info.title, info.description, info.notes, priority),
      degraded: { reason: "模型通道未接入" },
    };
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


}

function summaryPriorityOf(priority: string): string {
  return priority === "high" ? "high" : priority === "low" ? "low" : "medium";
}

/** 带 HTTP 语义的服务错误（路由 asHttp 转 HttpError）。 */
function httpError(status: number, code: string, message: string): Error & { status: number; code: string } {
  const err = new Error(message) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

/** 任务材料（开工指令用）。 */
interface TaskInfo {
  title: string;
  description: string;
  notes: string;
  envUrl: string;
  account: string;
}

/** 开工指令共用的任务材料段。 */
function taskMaterialLines(source: "platform" | "local", row: RawRow, info: TaskInfo): string[] {
  return [
    `- 任务号：${row.task_no}`,
    `- 任务名称：${info.title}`,
    info.description ? `- 需求描述 / 测试背景：${info.description}` : "",
    info.notes ? `- 本地备注：${info.notes}` : "",
    `- 优先级：${row.priority}`,
    row.package_version != null ? `- 包版本：v${row.package_version}${row.pm_round_no != null ? `（第 ${row.pm_round_no} 轮）` : ""}` : "",
    row.source_url ? `- 平台深链：${row.source_url}` : "",
    info.envUrl ? `- 测试环境：${info.envUrl}` : "",
    info.account ? `- 登录账号：${info.account}` : "",
  ].filter(Boolean);
}

/** 「平台任务开工」：开始测试按钮注入工作会话的正式开工指令。 */
function workStartText(
  source: "platform" | "local",
  row: RawRow,
  info: TaskInfo,
  summary: AiSummary | null,
): string {
  return [
    "[平台任务开工]（测试平台系统注入，非人工输入）",
    "平台任务列表已对本任务点「开始测试」：本消息等价于用户在本会话发起完整测试流程请求，请按 lifecycle + staged（逐阶段人工审阅）正式开工，从需求分析阶段开始。",
    "正式需求分析按现行规则独立产出并交付，完成后等待项目所有者审阅再进入下一阶段；下方 AI 分析结论只是参考输入，不替代正式分析。",
    "任务材料：",
    ...taskMaterialLines(source, row, info),
    ...(summary
      ? [
          "AI 分析结论（仅供参考）：",
          summary.requirement_summary ? `- 需求整理：${summary.requirement_summary}` : "",
          `- 需求要点：${summary.requirement_points.join("；") || "（无）"}`,
          `- 建议测试范围：${summary.suggested_test_scope.join("；") || "（无）"}`,
          summary.test_environment ? `- 测试环境：${summary.test_environment}` : "",
          summary.test_account ? `- 测试账号：${summary.test_account}` : "",
          `- 建议优先级：${summary.suggested_priority}${summary.priority_reason ? `（${summary.priority_reason}）` : ""}`,
          summary.risks.length ? `- 风险点：${summary.risks.join("；")}` : "",
          summary.open_questions.length ? `- 待确认问题：${summary.open_questions.join("；")}` : "",
        ].filter(Boolean)
      : []),
  ].join("\n");
}

/** 分析补全的预算与等待：结构化结论比标识符建议长一个量级，等模型想完。 */
const ANALYSIS_MAX_TOKENS = 2000;
const ANALYSIS_TIMEOUT_MS = 90_000;

/**
 * 分析提问：任务名称、需求描述为主输入，环境 URL 与账号为上下文；要求只回一个 JSON
 * 对象——整理需求内容、提取测试环境与测试账号密码（只从用户填写内容里取，没有就留
 * 空字符串，不得编造），入库走 asSummary 归一。
 */
function analysisPrompt(info: { title: string; description: string; notes: string; envUrl: string; account: string }): string {
  return [
    "你是测试平台的需求分析助手。根据下面的任务信息整理出结构化测试分析数据。",
    "只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏，字段与格式：",
    '{"requirement_summary":"需求内容整理，一段话概括要测什么","requirement_points":["需求要点，3-6条"],"suggested_test_scope":["建议测试范围，3-6条"],"test_environment":"测试环境 URL 或说明，只从任务内容提取，没有就留空字符串","test_account":"测试账号，只从任务内容提取，没有就留空字符串","test_password":"测试密码，只从任务内容提取，没有就留空字符串","suggested_priority":"high|medium|low","priority_reason":"一句话理由","risks":["风险点，可为空数组"],"open_questions":["待确认问题，可为空数组"]}',
    "要求：测试环境/账号/密码只整理用户已填写的内容，不得编造或补全；需求整理与要点基于描述归纳，不确定的列入 open_questions。",
    "",
    `任务名称：${info.title}`,
    info.description ? `需求描述 / 测试背景：${info.description}` : "",
    info.notes ? `补充备注：${info.notes}` : "",
    info.envUrl ? `测试环境 URL（用户已在表单填写）：${info.envUrl}` : "",
    info.account ? `登录账号（用户已在表单填写）：${info.account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 模型回答 → AiSummary。容错截取首个 `{` 到最后一个 `}`（围栏、前言、尾注都剥掉）；
 * 需求要点与建议范围全空、或 suggested_priority 不在三态里才算无效——其余字段缺失
 * 交给 asSummary 的默认值，宁可要一份粗摘要也不因模型少答一个字段就整单作废。
 */
function parseSummaryJson(text: string): AiSummary | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];
  const points = arr(obj.requirement_points);
  const scope = arr(obj.suggested_test_scope);
  const priority = obj.suggested_priority;
  if (points.length === 0 && scope.length === 0) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : undefined);
  return asSummary({
    requirement_summary: str(obj.requirement_summary),
    requirement_points: points,
    suggested_test_scope: scope,
    test_environment: str(obj.test_environment),
    test_account: str(obj.test_account),
    test_password: str(obj.test_password),
    suggested_priority:
      typeof priority === "string" && ["high", "medium", "low"].includes(priority) ? priority : "medium",
    priority_reason: typeof obj.priority_reason === "string" ? obj.priority_reason : "",
    risks: arr(obj.risks),
    open_questions: arr(obj.open_questions),
    analyzed_at: nowIso(),
    source: "requirement_analysis",
    stage: "requirement_analysis",
  });
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
