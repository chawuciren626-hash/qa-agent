/**
 * 服务端 → 客户端的任务同步下发与状态登记（同步层方案 阶段 A）。
 *
 * 与任务平台对接（integrations/task-platform，拉取方向）互补：这里面向
 * **客户端本地服务**下发业务事实源（服务端库）的任务数据，并接收客户端的
 * 状态登记与测试结果回传——客户端不直连任务平台，一切以服务端库为准（§8.1）。
 *
 * 身份与鉴权：
 * - 客户端本地服务持服务凭据（Bearer API Key，同任务平台对接的凭据模式）；
 * - 请求显式携带中央用户 ID（客户端经 AccountClient 绑定解析出的 userId）；
 * - 下发范围 = recipientUserId 配置指定的用户名下任务（首版单接收人）；
 *   非接收人用户请求返回空集（不越权）。
 *
 * 幂等与一致性：
 * - 增量游标 = 任务 updated_at（ISO 字符串字典序可比）；
 * - 状态登记按 (link_id, expectedRevision) 乐观锁（预留多端；单人员可直接覆盖）。
 */
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { TestResultPayload } from "./contracts.js";
import { looksLikeValidTestResultPayload, testResultPayloadHash } from "./contracts.js";

export interface SyncTaskItem {
  server_link_id: string;
  project_id: string;
  task_no: string;
  title: string;
  priority: string;
  package_version: number | null;
  pm_round_no: number | null;
  product_lines: Array<{ name: string; isPrimary: boolean }>;
  suggested_priority: string | null;
  ai_summary: Record<string, unknown> | null;
  status: string;
  source_url: string;
  requirement_baseline: Record<string, unknown> | null;
  self_test_digest: Record<string, unknown> | null;
  changes_digest: Array<Record<string, unknown>>;
  submitter: string | null;
  assignee: string | null;
  updated_at: string;
}

export interface SyncPage {
  items: SyncTaskItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface StateRegistrationResult {
  applied: boolean;
  status: string;
  revision: number;
  reason: string | null;
}

export function parseJsonSafe(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class PlatformTaskSyncService {
  /** 推送接收人（从 task-platform settings 读取；空 = 不限用户，全部下发）。 */
  private readonly recipientProvider: () => string | null;

  constructor(
    private readonly db: DatabaseSync,
    recipientProvider: () => string | null,
  ) {
    this.recipientProvider = recipientProvider;
  }

  /** 下发身份校验：接收人配置存在时，仅接收人本人（或服务端 admin）可拉取。 */
  canReceive(userId: string): boolean {
    const recipient = this.recipientProvider();
    if (!recipient) return true; // 未配置接收人：单人员场景默认全量可见（登录即本人）
    return userId === recipient || userId === "admin";
  }

  /**
   * A1 增量下发：updated_at > since 的平台任务（按更新时间升序，游标续传）。
   * since 为空 = 全量首拉。
   */
  listIncremental(userId: string, since: string | null, limit: number): SyncPage {
    if (!this.canReceive(userId)) return { items: [], next_cursor: null, has_more: false };
    const bounded = Math.min(Math.max(Math.round(limit) || 50, 1), 500);
    const rows = since
      ? this.db
          .prepare(
            `SELECT link_id, project_id, external_task_no AS task_no, title, priority,
                    package_version, pm_round_no, product_lines_json, suggested_priority,
                    ai_summary_json, status, source_url, requirement_baseline_json,
                    self_test_digest_json, changes_digest_json, submitter_name, assignee_name, updated_at
               FROM platform_task_links
              WHERE source_system = 'sbkj-taskassignment' AND updated_at > ?
              ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(since, bounded + 1)
      : this.db
          .prepare(
            `SELECT link_id, project_id, external_task_no AS task_no, title, priority,
                    package_version, pm_round_no, product_lines_json, suggested_priority,
                    ai_summary_json, status, source_url, requirement_baseline_json,
                    self_test_digest_json, changes_digest_json, submitter_name, assignee_name, updated_at
               FROM platform_task_links
              WHERE source_system = 'sbkj-taskassignment'
              ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(bounded + 1);
    const list = rows as Array<Record<string, unknown>>;
    const hasMore = list.length > bounded;
    const page = hasMore ? list.slice(0, bounded) : list;
    const items: SyncTaskItem[] = page.map(row => ({
      server_link_id: String(row.link_id),
      project_id: String(row.project_id),
      task_no: String(row.task_no),
      title: String(row.title),
      priority: String(row.priority),
      package_version: row.package_version === null ? null : Number(row.package_version),
      pm_round_no: row.pm_round_no === null ? null : Number(row.pm_round_no),
      product_lines: this.parseLines(row.product_lines_json as string | null),
      suggested_priority: (row.suggested_priority as string | null) ?? null,
      ai_summary: parseJsonSafe(row.ai_summary_json as string | null) as Record<string, unknown> | null,
      status: String(row.status),
      source_url: String(row.source_url ?? ""),
      requirement_baseline: parseJsonSafe(row.requirement_baseline_json as string | null) as Record<string, unknown> | null,
      self_test_digest: parseJsonSafe(row.self_test_digest_json as string | null) as Record<string, unknown> | null,
      changes_digest: (Array.isArray(parseJsonSafe(row.changes_digest_json as string | null))
        ? (parseJsonSafe(row.changes_digest_json as string | null) as Array<Record<string, unknown>>)
        : []),
      submitter: (row.submitter_name as string | null) ?? null,
      assignee: (row.assignee_name as string | null) ?? null,
      updated_at: String(row.updated_at),
    }));
    const last = page.at(-1);
    return {
      items,
      next_cursor: hasMore && last ? String(last.updated_at) : null,
      has_more: hasMore,
    };
  }

  private parseLines(json: string | null): Array<{ name: string; isPrimary: boolean }> {
    const parsed = parseJsonSafe(json);
    return Array.isArray(parsed)
      ? parsed
          .filter((x): x is { name: string; isPrimary: boolean } =>
            !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string")
          .map(x => ({ name: x.name, isPrimary: x.isPrimary === true }))
      : [];
  }

  /**
   * A3 状态登记：客户端"开始测试"/完成上报时同步服务端状态。
   * expectedRevision 提供时校验乐观锁（行 revision 变化则拒绝）；缺省直接覆盖（单人员）。
   * 登记写 last_action_json 审计，不改 package_version/pm_round_no（事实由服务端同步层维护）。
   */
  registerState(
    linkId: string,
    status: string,
    userId: string,
    expectedRevision?: number,
  ): StateRegistrationResult {
    const allowed = new Set(["pending_analysis", "ready", "in_progress", "impact_pending", "result_returned", "terminated"]);
    if (!allowed.has(status)) {
      return { applied: false, status, revision: 0, reason: `状态不合法: ${status}` };
    }
    const row = this.db
      .prepare(
        "SELECT link_id, status, updated_at FROM platform_task_links WHERE link_id = ? AND source_system = 'sbkj-taskassignment'",
      )
      .get(linkId) as { link_id: string; status: string; updated_at: string } | undefined;
    if (!row) return { applied: false, status, revision: 0, reason: "任务不存在" };
    const revision = this.revisionOf(row.updated_at);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return { applied: false, status: row.status, revision, reason: "状态已被其他端更新（乐观锁冲突）" };
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE platform_task_links
            SET status = ?,
                last_action_json = ?,
                updated_at = ?
          WHERE link_id = ?`,
      )
      .run(
        status,
        JSON.stringify({ action: "client_state_register", user_id: userId, at: now, from: row.status }),
        now,
        linkId,
      );
    return { applied: true, status, revision: this.revisionOf(now), reason: null };
  }

  /** 乐观锁 revision：updated_at 的稳定哈希前 8 位（避免引入新列；字典序可比性够用）。 */
  private revisionOf(updatedAt: string): number {
    return Number.parseInt(createHash("sha256").update(updatedAt).digest("hex").slice(0, 8), 16) % 1_000_000_007;
  }

  /** A2 服务端包读取：按需提供任务完整包 JSON（客户端详情/开工时拉取）。 */
  getPackagePayload(linkId: string, userId: string): Record<string, unknown> | null {
    if (!this.canReceive(userId)) return null;
    const row = this.db
      .prepare(
        `SELECT p.payload_json
           FROM task_platform_packages p
          WHERE p.task_link_id = ? AND p.activated = 1
          ORDER BY p.package_version DESC LIMIT 1`,
      )
      .get(linkId) as { payload_json: string } | undefined;
    return row ? (parseJsonSafe(row.payload_json) as Record<string, unknown> | null) : null;
  }

  /**
   * C1 测试结果接收（同步层方案 阶段 C）：
   * - 形态校验（looksLikeValidTestResultPayload）→ 结构性缺标识 400；
   * - 幂等三层：result_id+version 唯一（outbox UNIQUE）→ 重收返回 duplicate；
   *   payload 哈希不同（同键不同内容）→ 409 配置错误（应发新 result_version）；
   * - 入 task_platform_result_outbox（结果不丢，任务平台回传由 outbox 心跳负责）；
   * - 展示行状态推进 result_returned（客户端状态机对齐）。
   */
  receiveTestResult(
    payload: TestResultPayload,
    deps: { enqueue: (payload: TestResultPayload) => { created: boolean } },
  ): { accepted: boolean; duplicate: boolean; resultId: string; resultVersion: number; reason: string | null } {
    if (!looksLikeValidTestResultPayload(payload)) {
      return { accepted: false, duplicate: false, resultId: String((payload as Record<string, unknown>)?.result_id ?? ""), resultVersion: 0, reason: "载荷缺少关键标识字段（task_id/result_id/result_version 等）" };
    }
    // 幂等第一层：同 result_id+version 已存在 → duplicate（至少一次语义收敛）。
    const existing = this.db
      .prepare("SELECT payload_json FROM task_platform_result_outbox WHERE result_id = ? AND result_version = ?")
      .get(payload.result_id, payload.result_version) as { payload_json: string } | undefined;
    if (existing) {
      const sameContent = testResultPayloadHash(JSON.parse(existing.payload_json) as TestResultPayload) === testResultPayloadHash(payload);
      if (!sameContent) {
        return { accepted: false, duplicate: false, resultId: payload.result_id, resultVersion: payload.result_version, reason: "幂等冲突：同 result_id/version 载荷不同（应发新 result_version）" };
      }
      return { accepted: true, duplicate: true, resultId: payload.result_id, resultVersion: payload.result_version, reason: null };
    }
    const enqueued = deps.enqueue(payload);
    // 展示行推进：result_returned（仅平台任务；本地任务/未知 link 静默跳过——载荷以任务平台契约为准）
    const taskLink = this.db
      .prepare("SELECT link_id FROM platform_task_links WHERE source_system = 'sbkj-taskassignment' AND external_tenant_id || ':' || external_task_id = ?")
      .get(`${payload.tenant_id || "sbkj-taskassignment"}:${payload.task_id}`) as { link_id: string } | undefined;
    if (taskLink) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE platform_task_links
              SET status = 'result_returned',
                  last_action_json = ?,
                  updated_at = ?
            WHERE link_id = ?`,
        )
        .run(
          JSON.stringify({ action: "test_result_received", result_id: payload.result_id, result_version: payload.result_version, verdict: payload.test_verdict, at: now }),
          now,
          taskLink.link_id,
        );
    }
    return { accepted: true, duplicate: !enqueued.created, resultId: payload.result_id, resultVersion: payload.result_version, reason: null };
  }

  /** 服务凭据派生（管理路由签发；客户端本地服务持久持有）。 */
  static issueServiceKey(): string {
    return randomBytes(24).toString("base64url");
  }

  /** 凭据校验（恒定时间比较防时序侧信道）。 */
  static verifyServiceKey(provided: string, stored: string): boolean {
    if (!stored || !provided || provided.length !== stored.length) return false;
    let diff = 0;
    for (let i = 0; i < stored.length; i++) diff |= provided.charCodeAt(i) ^ stored.charCodeAt(i);
    return diff === 0;
  }
}
