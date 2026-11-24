/**
 * 客户端本地服务的任务同步 worker（同步层方案 阶段 B）。
 *
 * 职责：定时从服务端（单实例 AITestHarness）增量拉取当前中央用户名下的平台任务，
 * upsert 写入本地镜像表 platform_task_links（server_link_id + acct_user_id 标记镜像语义）。
 * UI 列表/详情读本地镜像（离线可看）；"开始测试"先经 registerState 登记服务端。
 *
 * 隔离：本地镜像行带 acct_user_id（AccountClient 绑定的中央 userId），
 * 登录用户切换时各读各的镜像（与 WorkBuddy user-<ID> 隔离同构）。
 *
 * 幂等：按 server_link_id upsert；重复拉取/网络重试不产生重复行。
 * 离线：拉取失败保留上次缓存（本 worker 不删任何行），错误仅记录。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface ClientSyncConfig {
  /** 服务端基地址（单实例部署 = 该实例的访问地址，如 http://localhost:18776）。 */
  serverBaseUrl: string;
  /** 服务凭据（服务端 /api/admin/task-platform 签发的 service key）。 */
  serviceKey: string;
  /** 当前登录中央用户 ID（AccountClient 绑定）。 */
  userId: string;
  /** 本地 web.db（镜像表所在库）。 */
  db: DatabaseSync;
  /** 轮询间隔毫秒；默认 60s。 */
  intervalMs?: number;
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ClientSyncTickSummary {
  pulled: number;
  upserted: number;
  skipped: number;
  failed: boolean;
  error: string | null;
}

const MIRROR_COLUMNS = `
  link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
  title, priority, product_lines_json, feedback_type, estimated_hours,
  package_version, pm_round_no, source_url, status, ai_summary_json, suggested_priority,
  requirement_baseline_json, self_test_digest_json, changes_digest_json,
  submitter_name, assignee_name, complexity_level, estimated_days,
  last_synced_at, server_link_id, acct_user_id, updated_at`;

export class ClientTaskSyncWorker {
  private readonly config: Required<Pick<ClientSyncConfig, "serverBaseUrl" | "serviceKey" | "userId" | "db" | "intervalMs">>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** 最近一轮结果（诊断用）。 */
  lastTick: ClientSyncTickSummary | null = null;

  constructor(config: ClientSyncConfig) {
    if (!config.serverBaseUrl) throw new Error("ClientTaskSyncWorker: serverBaseUrl required");
    if (!config.serviceKey) throw new Error("ClientTaskSyncWorker: serviceKey required");
    if (!config.userId) throw new Error("ClientTaskSyncWorker: userId required");
    this.config = {
      serverBaseUrl: config.serverBaseUrl.replace(/\/+$/, ""),
      serviceKey: config.serviceKey,
      userId: config.userId,
      db: config.db,
      intervalMs: config.intervalMs ?? 60_000,
    };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.now = config.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 单轮拉取 + 镜像 upsert；异常仅记录，不删除本地缓存（离线语义）。 */
  async tickOnce(): Promise<ClientSyncTickSummary> {
    if (this.ticking) return this.lastTick ?? { pulled: 0, upserted: 0, skipped: 0, failed: false, error: null };
    this.ticking = true;
    let summary: ClientSyncTickSummary = { pulled: 0, upserted: 0, skipped: 0, failed: false, error: null };
    try {
      const since = this.localMaxUpdatedAt();
      let cursor: string | null = since;
      let hasMore = true;
      while (hasMore) {
        const page = await this.fetchPage(cursor);
        summary.pulled += page.items.length;
        for (const item of page.items) {
          if (this.upsertMirror(item)) summary.upserted++;
          else summary.skipped++;
        }
        hasMore = page.has_more;
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      summary.error = null;
    } catch (error) {
      summary.failed = true;
      summary.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.ticking = false;
      this.lastTick = summary;
    }
    return summary;
  }

  /** 本地镜像中该用户的最大 updated_at（增量游标）。 */
  private localMaxUpdatedAt(): string | null {
    const row = this.config.db
      .prepare("SELECT MAX(updated_at) AS max FROM platform_task_links WHERE acct_user_id = ? AND source_system = 'sbkj-taskassignment'")
      .get(this.config.userId) as { max: string | null } | undefined;
    return row?.max ?? null;
  }

  private async fetchPage(cursor: string | null): Promise<{ items: SyncItem[]; next_cursor: string | null; has_more: boolean }> {
    const url = new URL(`${this.config.serverBaseUrl}/api/sync/v1/platform-tasks`);
    url.searchParams.set("user", this.config.userId);
    if (cursor) url.searchParams.set("since", cursor);
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.config.serviceKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`服务端下发接口 ${response.status}`);
    return await response.json() as { items: SyncItem[]; next_cursor: string | null; has_more: boolean };
  }

  /**
   * 镜像项目补建（首同步外键防线）：服务端同步项目 ID（sync_<产品线>_<hash>）在本机
   * projects 无行时补建，使 platform_task_links.project_id 外键成立。幂等：
   * 已存在（无论手工还是上次补建）不改动——不覆盖 owner、不动 project_management。
   */
  private ensureMirrorProject(projectId: string): void {
    const exists = this.config.db
      .prepare("SELECT 1 FROM projects WHERE project_id = ?")
      .get(projectId);
    if (exists) return;
    this.config.db
      .prepare("INSERT OR IGNORE INTO projects (project_id, owner_user_id, created_at) VALUES (?, ?, ?)")
      .run(projectId, this.config.userId, this.now().toISOString());
    // project_management 标记 sync 来源：项目列表"来源"展示与手工项目区分（服务端同款语义）。
    this.config.db
      .prepare(
        `INSERT OR IGNORE INTO project_management (project_id, source_type, source_system_name)
         VALUES (?, 'sync', 'sbkj-taskassignment')`,
      )
      .run(projectId);
  }

  /** 镜像 upsert：按 server_link_id 定位（同库唯一），字段全量覆盖（服务端为准）。 */
  private upsertMirror(item: SyncItem): boolean {
    const existing = this.config.db
      .prepare("SELECT link_id FROM platform_task_links WHERE server_link_id = ? AND acct_user_id = ?")
      .get(item.server_link_id, this.config.userId) as { link_id: string } | undefined;
    const now = this.now().toISOString();
    const linesJson = JSON.stringify(item.product_lines ?? []);
    if (existing) {
      this.config.db
        .prepare(
          `UPDATE platform_task_links SET
             external_task_no = ?, title = ?, priority = ?, product_lines_json = ?,
             package_version = ?, pm_round_no = ?, source_url = ?, status = ?,
             ai_summary_json = ?, suggested_priority = ?,
             requirement_baseline_json = ?, self_test_digest_json = ?, changes_digest_json = ?,
             submitter_name = ?, assignee_name = ?,
             last_synced_at = ?, updated_at = ?
           WHERE link_id = ? AND acct_user_id = ?`,
        )
        .run(
          item.task_no, item.title, item.priority, linesJson,
          item.package_version, item.pm_round_no, item.source_url, item.status,
          item.ai_summary ? JSON.stringify(item.ai_summary) : null, item.suggested_priority,
          item.requirement_baseline ? JSON.stringify(item.requirement_baseline) : null,
          item.self_test_digest ? JSON.stringify(item.self_test_digest) : null,
          item.changes_digest ? JSON.stringify(item.changes_digest) : null,
          item.submitter, item.assignee,
          now, item.updated_at,
          existing.link_id, this.config.userId,
        );
      return true;
    }
    const linkId = `ptl-sync-${item.server_link_id}`.slice(0, 64);
    // 项目归属：platform_task_links.project_id 引用本机 projects（PRAGMA foreign_keys=ON），
    // 服务端下发的 project_id 在本机可能不存在——先补建镜像项目行再写任务
    // （INSERT OR IGNORE 幂等；owner=当前登录用户，project_management 记 sync 来源，
    // 与服务端 bridge 建同步项目同款语义；显示名走 project_config，镜像项目只建行）。
    this.ensureMirrorProject(item.project_id);
    this.config.db
      .prepare(
        `INSERT INTO platform_task_links (
           link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
           title, priority, product_lines_json, feedback_type, package_version, pm_round_no,
           source_url, status, ai_summary_json, suggested_priority,
           requirement_baseline_json, self_test_digest_json, changes_digest_json,
           submitter_name, assignee_name, last_synced_at, server_link_id, acct_user_id,
           created_at, updated_at
         ) VALUES (?, ?, 'sbkj-taskassignment', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        linkId, item.project_id, item.task_id ?? item.task_no, item.task_no,
        item.title, item.priority, linesJson, item.feedback_type ?? "",
        item.package_version, item.pm_round_no, item.source_url, item.status,
        item.ai_summary ? JSON.stringify(item.ai_summary) : null, item.suggested_priority,
        item.requirement_baseline ? JSON.stringify(item.requirement_baseline) : null,
        item.self_test_digest ? JSON.stringify(item.self_test_digest) : null,
        item.changes_digest ? JSON.stringify(item.changes_digest) : null,
        item.submitter, item.assignee, now, item.server_link_id, this.config.userId,
        now, item.updated_at,
      );
    return true;
  }
}

interface SyncItem {
  server_link_id: string;
  project_id: string;
  task_no: string;
  task_id?: string;
  title: string;
  priority: string;
  feedback_type?: string;
  estimated_hours?: number | null;
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

/**
 * 服务端凭据的本地持久化（客户端本地服务目录；权限 0600 语义由调用方保证）。
 */
export function saveClientSyncConfig(root: string, config: { serverBaseUrl: string; serviceKey: string }): string {
  const dir = path.join(root, "task-platform-sync");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "client-sync.json");
  fs.writeFileSync(file, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  return file;
}

export function loadClientSyncConfig(root: string): { serverBaseUrl: string; serviceKey: string } | null {
  const file = path.join(root, "task-platform-sync", "client-sync.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { serverBaseUrl?: string; serviceKey?: string };
    if (!parsed.serverBaseUrl || !parsed.serviceKey) return null;
    return { serverBaseUrl: parsed.serverBaseUrl, serviceKey: parsed.serviceKey };
  } catch {
    return null;
  }
}
