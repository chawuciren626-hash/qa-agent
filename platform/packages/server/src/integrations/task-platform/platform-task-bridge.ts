/**
 * 任务平台 → AITestHarness 桥接层：PackageActivationHook 的生产实现。
 *
 * 职责（对接方案 §4 P3 激活动作 + 《AITestHarness平台任务列表建设方案》TL-1/TL-2）：
 * 1. 同步项目幂等建立：产品线 → source_type=sync 的 project + project_management 行；
 * 2. 首版包（initial_handoff）：交接包渲染为 Markdown 写入 qa_documents（type=external，
 *    带 task_id/package_version 溯源），upsert platform_task_links（列表真源，
 *    状态 pending_analysis，真实摘要来自包内 ai_structured_result——替换 demo 种子口径）；
 * 3. 后续版本（material_changed / new_pm_round）：追加不可变修订（updateDocument），
 *    状态置 impact_pending，不动 main_session_id 与既有分析（S7：不自动重跑）；
 * 4. 摘要提取：确定性规则从包结构化字段提取 ai_summary_json（source:'requirement_analysis'
 *    的数据前置版；第一阶段分析完成后的回填由 qa-platform-task-service.analyze 负责）。
 *
 * 约束：本模块不直接写 task_platform_* 传输表（store.ts 已负责）；两套表以 external_task_id
 * 为关联键，本桥接层是唯一合法写入方（platform_task_links）。
 */
import { createHash } from "node:crypto";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import {
  QaProjectKnowledgeStore,
  type DocumentSource,
} from "../../services/qa-project-knowledge.js";
import type { HandoffPackage } from "./contracts.js";
import type { PackageActivationHook } from "./ingestion-service.js";
import type { TaskPlatformStore } from "./store.js";

/** platform_task_links 行写入所需的最小 DB 形状（与 qa-platform-task-service 一致）。 */
export interface PlatformTaskLinkDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

export interface BridgeDeps {
  /** web.db（qa_documents / project_management / platform_task_links 都在其中）。 */
  db: PlatformTaskLinkDb & KnowledgeDb;
  /** 项目创建服务句柄：ensureSyncProject 需要真实建项目；由接线层注入。 */
  createProject: (args: { name: string; sourceSystem: string; externalTenantId: string; externalProjectId: string; externalUrl: string | null }) => Promise<{ projectId: string }>;
  /** 系统操作者用户 ID（集成写入的 created_by；取管理员或系统账号）。 */
  systemUserId: string;
  now?: () => Date;
}

/** 从交接包确定性提取 AI 摘要（S3 数据前置版；非模型调用）。 */
export function extractSummaryFromPackage(pkg: HandoffPackage): string {
  const structured = pkg.requirement.ai_structured_result ?? {};
  const strList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const task = pkg.task;
  const priority = ["high", "medium", "low"].includes(String(structured.suggested_priority))
    ? String(structured.suggested_priority)
    : task.priority === "high" || task.priority === "critical" || task.priority === "urgent"
      ? "high"
      : task.priority === "low"
        ? "low"
        : "medium";
  const summary = {
    requirement_points: [
      ...(typeof structured.summary === "string" && structured.summary ? [structured.summary] : []),
      ...strList(structured.acceptance_criteria).slice(0, 5),
    ],
    suggested_test_scope: [
      ...strList(structured.impact_scope),
      ...(pkg.development_self_test.submission_sections
        .filter(s => typeof s.label === "string" && /验证重点|测试|范围/i.test(String(s.label)))
        .map(s => String(s.value ?? "")).filter(Boolean)),
    ].slice(0, 8),
    suggested_priority: priority,
    priority_reason: `平台优先级=${task.priority}${task.complexity_level ? `，复杂度=${task.complexity_level}` : ""}${task.estimated_hours ? `，预估 ${task.estimated_hours} 小时` : ""}`,
    risks: strList(structured.missing_fields).slice(0, 5),
    open_questions: pkg.unresolved_product_line_names.length
      ? [`未解析产品线：${pkg.unresolved_product_line_names.join("、")}`]
      : [],
    analyzed_at: new Date().toISOString(),
    source: "requirement_analysis",
    stage: "package_structured_extract",
  };
  return JSON.stringify(summary);
}

/** 交接包 → 项目资料 Markdown（人读 + Agent 上下文双用途）。 */
export function renderPackageDocument(pkg: HandoffPackage): { title: string; content: string } {
  const title = `${pkg.task_no} ${pkg.task.title}（交接包 v${pkg.package_version}）`.slice(0, 200);
  const lines: string[] = [
    `> 来源：${pkg.source_system} · 包版本 v${pkg.package_version} · 事件 ${pkg.event.event_type} · 生成于 ${pkg.event.generated_at ?? "-"}`,
    `> 平台任务：[${pkg.task_no}](${pkg.source_url}) · 深链直达`,
    "",
    "# 任务概要",
    "",
    `- 标题：${pkg.task.title}`,
    `- 反馈类型：${pkg.task.feedback_type} · 优先级：${pkg.task.priority}${pkg.task.complexity_level ? ` · 复杂度：${pkg.task.complexity_level}` : ""}`,
    `- 提交人：${pkg.task.submitter.display_name ?? "-"} · 处理人：${pkg.task.assignee.display_name ?? "-"}`,
    `- 产品线：${pkg.product_lines.map(l => `${l.line_name}${l.is_primary ? "（主）" : ""}`).join("、")}`,
    pkg.unresolved_product_line_names.length ? `- 未解析产品线：${pkg.unresolved_product_line_names.join("、")}` : "",
    `- 抽测轮次：第 ${pkg.flow.pm_round.round_no} 轮（${pkg.flow.pm_round.entered_at ?? "-"}）`,
    "",
    "# 需求基准（研发处理判断最终确认内容）",
    "",
    pkg.requirement.confirmed_baseline.final_content || "（无）",
    "",
    "# 原始反馈",
    "",
    pkg.requirement.original_content || "（无）",
    "",
    "# AI 整理内容",
    "",
    pkg.requirement.ai_content || "（无）",
  ];
  if (pkg.requirement.original_supplements.length) {
    lines.push("", "# 原始反馈补充记录", "");
    for (const sup of pkg.requirement.original_supplements) {
      lines.push(`## ${sup.created_at ?? "-"} · ${sup.operator.display_name ?? "-"}`, "", sup.content, "");
    }
  }
  lines.push("", "# 研发自测提交资料", "", `- 提交时间：${pkg.development_self_test.submitted_at ?? "-"}`, `- 审核方式：${pkg.development_self_test.review_mode ?? "-"}`, `- 审核通过：${pkg.development_self_test.reviewed_at ?? "-"}`);
  for (const section of pkg.development_self_test.submission_sections) {
    lines.push("", `## ${String(section.label ?? section.key ?? "资料项")}`, "", String(section.value ?? ""));
    const items = Array.isArray(section.material_items) ? section.material_items : [];
    for (const item of items) {
      const record = item as { title?: unknown; result?: unknown };
      if (record && typeof record === "object") {
        lines.push(`- ${String(record.title ?? "")}: ${String(record.result ?? "")}`);
      }
    }
  }
  if (pkg.changes.length) {
    lines.push("", "# 节点变更记录", "");
    for (const change of pkg.changes) {
      lines.push(
        `- [${change.node_label}] 第 ${change.change_batch_no} 批 · 序号 ${change.change_sequence} · ${change.changed_at ?? "-"} · ${change.operator.display_name ?? "-"}`,
      );
      if (change.change_content) lines.push(`  - ${change.change_content}`);
    }
  }
  const regression = pkg.regression_context;
  if (regression) {
    lines.push("", "# 上轮抽测退回问题（回归范围参考）", "");
    for (const issue of regression.previous_failed_issues) {
      lines.push(`- [${issue.severity}] ${issue.issue_no} ${issue.title}：${issue.problem_description}`);
    }
    for (const rect of regression.rectifications) {
      lines.push(`- 整改说明：${rect.solution}（${rect.test_method}）`);
    }
  }
  const attachments = pkg.attachments;
  if (attachments.length) {
    lines.push("", "# 附件清单", "");
    for (const att of attachments) {
      lines.push(`- ${att.file_name}（${att.file_category}，${att.file_size} 字节）`);
    }
  }
  return { title, content: lines.filter(l => l !== "").join("\n") };
}

export class PlatformTaskBridge implements PackageActivationHook {
  private readonly store: TaskPlatformStore;
  private readonly db: PlatformTaskLinkDb;
  private readonly knowledge: () => QaProjectKnowledgeStore;
  private readonly createProject: BridgeDeps["createProject"];
  private readonly systemUserId: string;
  private readonly now: () => Date;

  constructor(deps: BridgeDeps, store: TaskPlatformStore) {
    this.store = store;
    this.db = deps.db;
    this.knowledge = () => new QaProjectKnowledgeStore(deps.db as unknown as KnowledgeDb);
    this.createProject = deps.createProject;
    this.systemUserId = deps.systemUserId;
    this.now = deps.now ?? (() => new Date());
  }

  /** 产品线 → source_type=sync 项目（幂等；同产品线返回既有项目）。 */
  async ensureSyncProject(line: { product_line_id: string; line_code: string; line_name: string }, tenantId: string): Promise<string> {
    const existing = this.store.findProjectLink(tenantId, line.product_line_id);
    if (existing) return existing.project_id;
    const created = await this.createProject({
      name: line.line_name,
      sourceSystem: "sbkj-taskassignment",
      externalTenantId: tenantId,
      externalProjectId: line.product_line_id,
      externalUrl: null,
    });
    return created.projectId;
  }

  /** 首版包：qa_documents 建档 + platform_task_links 建列表条目（pending_analysis + 真实摘要）。 */
  async onInitialHandoff(taskLinkRowId: string, pkg: HandoffPackage): Promise<void> {
    const taskLink = this.requireTaskLink(taskLinkRowId);
    await this.writePackageDocument(taskLink.project_id, pkg);
    this.upsertPlatformTaskLink(taskLink, pkg);
  }

  /** 后续版本：追加修订 + 状态 impact_pending（S7：不动会话与既有分析）。 */
  async onPackageUpdate(taskLinkRowId: string, pkg: HandoffPackage): Promise<void> {
    const taskLink = this.requireTaskLink(taskLinkRowId);
    const current = this.db.prepare(
      "SELECT status FROM platform_task_links WHERE project_id = ? AND source_system = 'sbkj-taskassignment' AND external_tenant_id = ? AND external_task_id = ?",
    ).get(taskLink.project_id, pkg.tenant_id, pkg.task_id) as { status: string } | undefined;
    if (current?.status === "terminated") return;
    await this.writePackageDocument(taskLink.project_id, pkg);
    this.upsertPlatformTaskLink(taskLink, pkg, "impact_pending");
  }

  // ------------------------------------------------------------------ internals

  /**
   * 交接包 → 项目资料文档（幂等，审阅意见"同一包重放不追加重复修订"）：
   * - 文档按任务唯一（source_json.ref 前缀匹配 sbkj-...:{tenant}:{task}:）；
   * - 当前修订的 source_json.ref 已是本包版本且 content_hash 一致 → 跳过（重放安全）；
   * - 已有文档但版本不同 → 追加不可变修订（v2、v3…）；
   * - 无文档 → createDocument。
   */
  private writePackageDocument(projectId: string, pkg: HandoffPackage): void {
    const { title, content } = renderPackageDocument(pkg);
    const refPrefix = `sbkj-taskassignment:${pkg.tenant_id}:${pkg.task_id}:`;
    const docSource: DocumentSource = {
      type: "external",
      ref: `${refPrefix}v${pkg.package_version}`,
      filename: `${pkg.task_no}-v${pkg.package_version}.md`,
      capturedAt: this.now().toISOString(),
    };
    const knowledge = this.knowledge();
    const doc = this.db
      .prepare(
        `SELECT d.document_id, d.revision, d.current_revision_id, d.content_hash
           FROM qa_documents d
          WHERE d.project_id = ? AND d.source_json LIKE ?
          ORDER BY d.created_at ASC LIMIT 1`,
      )
      .get(projectId, `%"ref":"${refPrefix}%`) as
      | { document_id: string; revision: number; current_revision_id: string; content_hash: string }
      | undefined;
    if (!doc) {
      knowledge.createDocument({
        projectId,
        userId: this.systemUserId,
        title,
        format: "markdown",
        content,
        source: docSource,
        changeNote: `任务平台交接包 v${pkg.package_version}（${pkg.event.event_type}）`,
      });
      return;
    }
    // 幂等：当前修订已是该包版本且哈希一致 → 重放/补拉不追加修订
    const current = this.db
      .prepare("SELECT content_hash, source_json FROM qa_document_revisions WHERE revision_id = ?")
      .get(doc.current_revision_id) as { content_hash: string; source_json: string } | undefined;
    if (
      current &&
      current.source_json.includes(`"ref":"${refPrefix}v${pkg.package_version}"`)
    ) {
      // 当前修订即为该版本：内容一致 → 跳过（重放安全）；内容不一致（平台侧同版本号但内容变化）→ 追加修订留痕
      const sha = this.sha256Hex(content);
      if (sha === current.content_hash) return;
      knowledge.updateDocument({
        projectId,
        documentId: doc.document_id,
        userId: this.systemUserId,
        expectedRevision: Number(doc.revision),
        content,
        changeNote: `任务平台交接包 v${pkg.package_version} 内容更新（同版本号，哈希变化）`,
        internalSource: docSource,
      });
      return;
    }
    // 已有任务文档但当前修订是旧版本 → 追加新版本修订
    knowledge.updateDocument({
      projectId,
      documentId: doc.document_id,
      userId: this.systemUserId,
      expectedRevision: Number(doc.revision),
      title,
      content,
      changeNote: `任务平台交接包 v${pkg.package_version}（${pkg.event.event_type}）`,
      internalSource: docSource,
    });
  }

  private sha256Hex(content: string): string {
    // 与 qa-project-knowledge 的 content_hash 口径一致（sha256:<hex>）
    return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  }

  /** 清除项目下演示种子（source_system='demo'），返回删除行数。 */
  clearDemo(projectId: string): number {
    const run = this.db
      .prepare("DELETE FROM platform_task_links WHERE project_id = ? AND source_system = 'demo'")
      .run(projectId) as unknown;
    if (run && typeof run === "object" && "changes" in run) {
      return Number((run as { changes: unknown }).changes ?? 0);
    }
    return 0;
  }

  private requireTaskLink(taskLinkRowId: string): { link_id: string; project_id: string; external_task_id: string } {
    const row = this.db
      .prepare("SELECT link_id, project_id, external_task_id FROM task_platform_task_links WHERE link_id = ?")
      .get(taskLinkRowId) as { link_id: string; project_id: string; external_task_id: string } | undefined;
    if (!row) throw new Error(`task_platform_task_links row missing: ${taskLinkRowId}`);
    return row;
  }

  /** 写/更新列表真源 platform_task_links（qa-platform-task-service 的数据源）。 */
  private upsertPlatformTaskLink(
    taskLink: { link_id: string; project_id: string; external_task_id: string },
    pkg: HandoffPackage,
    nextStatus?: "pending_analysis" | "impact_pending",
  ): void {
    const existing = this.db
      .prepare("SELECT link_id, status, package_version FROM platform_task_links WHERE project_id = ? AND external_tenant_id = ? AND external_task_id = ? AND source_system = 'sbkj-taskassignment'")
      .get(taskLink.project_id, pkg.tenant_id, pkg.task_id) as { link_id: string; status: string; package_version: number } | undefined;
    const now = this.now().toISOString();
    const summary = extractSummaryFromPackage(pkg);
    const suggested = JSON.parse(summary) as { suggested_priority: string };
    if (existing) {
      // T4 本地补充字段不被同步覆盖；终止态不自动复活（对接方案 §8.4）
      if (existing.status === "terminated") return;
      if (pkg.package_version <= existing.package_version) return;
      this.db
        .prepare(
          `UPDATE platform_task_links SET
             title = ?, priority = ?, product_lines_json = ?, feedback_type = ?, estimated_hours = ?,
             package_version = ?, pm_round_no = ?, source_url = ?, ai_summary_json = ?,
             suggested_priority = ?, status = ?, updated_at = ?
           WHERE link_id = ?`,
        )
        .run(
          pkg.task.title,
          pkg.task.priority === "urgent" || pkg.task.priority === "critical" ? "high" : pkg.task.priority,
          JSON.stringify(pkg.product_lines.map(l => ({ name: l.line_name, isPrimary: l.is_primary }))),
          pkg.task.feedback_type,
          pkg.task.estimated_hours,
          pkg.package_version,
          pkg.flow.pm_round.round_no,
          pkg.source_url,
          summary,
          suggested.suggested_priority,
          nextStatus ?? existing.status,
          now,
          existing.link_id,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO platform_task_links (
           link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
           title, priority, product_lines_json, feedback_type, estimated_hours,
           package_version, pm_round_no, source_url, status, ai_summary_json, suggested_priority,
           last_action_json, created_at, updated_at
         ) VALUES (?, ?, 'sbkj-taskassignment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `ptl-${crypto.randomUUID()}`,
        taskLink.project_id,
        pkg.tenant_id,
        pkg.task_id,
        pkg.task_no,
        pkg.task.title,
        pkg.task.priority === "urgent" || pkg.task.priority === "critical" ? "high" : pkg.task.priority,
        JSON.stringify(pkg.product_lines.map(l => ({ name: l.line_name, isPrimary: l.is_primary }))),
        pkg.task.feedback_type,
        pkg.task.estimated_hours,
        pkg.package_version,
        pkg.flow.pm_round.round_no,
        pkg.source_url,
        nextStatus ?? "pending_analysis",
        summary,
        suggested.suggested_priority,
        JSON.stringify({ action: "platform_ingest", event_id: pkg.event.event_id, at: now }),
        now,
        now,
      );
  }
}
