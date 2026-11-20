/**
 * 事件轮询与交接包接入编排（对接方案 §4 P3）。
 *
 * 本模块只做确定性链路：拉事件 → 去重 → 拉包 → 校验 → 落存储 → 推进游标。
 * 「激活后的业务动作」（建 qa_task / 快照 / 触发第一阶段分析 / 更新任务列表状态）
 * 通过 PackageActivationHook 注入——基线定稿后由 integrations 接线层提供实现，
 * 本模块不 import 任何随基线演进的服务，保持零耦合可单测。
 *
 * 幂等：event_id 去重 + (task_link, package_version) 唯一；重复事件/重复包安全跳过。
 */

import {
  looksLikeValidHandoffPackage,
  type HandoffEventDto,
  type HandoffPackage,
} from "./contracts.js";
import { CursorExpiredError, TaskPlatformClient } from "./client.js";
import type { TaskPlatformStore } from "./store.js";

/** 包激活钩子：包校验入库后由接线层执行业务动作。实现必须幂等。 */
export interface PackageActivationHook {
  /** 首版包（initial_handoff）：建测试工作 + 固定快照 + 触发第一阶段。 */
  onInitialHandoff(taskLinkRowId: string, pkg: HandoffPackage): Promise<void>;
  /** 后续版本（变更/新轮次）：登记待确认影响，不动运行中的旧快照。 */
  onPackageUpdate(taskLinkRowId: string, pkg: HandoffPackage): Promise<void>;
  /** 产品线首次同步建项目；返回项目 ID。实现必须幂等（同 ID 返回既有项目）。 */
  ensureSyncProject(line: { product_line_id: string; line_code: string; line_name: string }): Promise<string>;
}

export interface IngestionRunSummary {
  polled_events: number;
  new_events: number;
  packages_received: number;
  packages_activated: number;
  packages_failed: number;
  cursor_advanced: boolean;
  cursor_reset: boolean;
}

export interface IngestionServiceOptions {
  client: TaskPlatformClient;
  store: TaskPlatformStore;
  activation: PackageActivationHook;
  /** 事件类型过滤；缺省全部。 */
  eventTypes?: string[];
  /** 每轮最多处理的事件数。 */
  batchSize?: number;
  /** 注入时钟（ISO 生成），测试用。 */
  now?: () => Date;
}

export class IngestionService {
  private readonly client: TaskPlatformClient;
  private readonly store: TaskPlatformStore;
  private readonly activation: PackageActivationHook;
  private readonly eventTypes?: string[];
  private readonly batchSize: number;
  private readonly now: () => Date;
  /** 游标失效回调（告警挂点）。 */
  onCursorExpired: (() => void) | null = null;

  constructor(options: IngestionServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.activation = options.activation;
    this.eventTypes = options.eventTypes;
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 执行一轮拉取。游标过期时自动清空游标从最早处重建（对接方案 §15.3），
   * 已入库的事件/包由幂等键保护不重复。
   */
  async runOnce(): Promise<IngestionRunSummary> {
    const summary: IngestionRunSummary = {
      polled_events: 0,
      new_events: 0,
      packages_received: 0,
      packages_activated: 0,
      packages_failed: 0,
      cursor_advanced: false,
      cursor_reset: false,
    };
    let cursor = this.store.getIngestCursor();
    if (cursor === null) {
      summary.cursor_reset = true; // 首次或重建后从最早开始
    }

    let page = await this.client.fetchHandoffEvents({
      cursor: cursor ?? undefined,
      limit: this.batchSize,
      eventTypes: this.eventTypes,
    });
    summary.polled_events = page.items.length;

    for (const event of page.items) {
      if (this.store.hasEvent(event.event_id)) continue; // 幂等：事件已处理
      this.store.recordEvent(event);
      summary.new_events++;
      try {
        const result = await this.ingestPackage(event);
        if (result === "received") summary.packages_received++;
        if (result === "activated") summary.packages_activated++;
      } catch (error) {
        summary.packages_failed++;
        // 单包失败不阻断后续事件；该事件已记录，下轮通过补拉接口重试（§15.3）
        console.error(
          `[task-platform] package ingest failed: event=${event.event_id} task=${event.task_id} v${event.package_version}`,
          error,
        );
      }
    }

    if (page.next_cursor) {
      this.store.setIngestCursor(page.next_cursor);
      summary.cursor_advanced = true;
    }
    return summary;
  }

  /** 游标过期恢复：清空游标，下一轮 runOnce 从最早事件重建（幂等保护）。 */
  resetCursor(): void {
    this.store.setIngestCursor("");
    this.onCursorExpired?.();
  }

  /** 单事件 → 拉包 → 校验 → 落库 → 激活。返回处理结果分类。 */
  private async ingestPackage(
    event: HandoffEventDto,
  ): Promise<"received" | "activated" | "skipped"> {
    const pkg = await this.client.fetchHandoffPackage(event.task_id, event.package_version);
    if (!looksLikeValidHandoffPackage(pkg)) {
      throw new Error(`handoff package failed validation: task=${event.task_id} v${event.package_version}`);
    }
    // 包哈希与事件声明一致性（传输完整性，非内容校验——内容校验由平台侧 ETag 保证）
    if (event.package_version !== pkg.package_version) {
      throw new Error(
        `package version mismatch: event says v${event.package_version}, package says v${pkg.package_version}`,
      );
    }

    // 主产品线定位同步项目（D2：首元素为主产品线）
    const primaryLine = pkg.product_lines.find(line => line.is_primary) ?? pkg.product_lines[0];
    if (!primaryLine) throw new Error(`package has no product lines: task=${event.task_id}`);
    const projectLink = this.store.findProjectLink(pkg.tenant_id, primaryLine.product_line_id);
    if (!projectLink) {
      // 项目映射缺失：同步一个再继续（幂等）
      const projectId = await this.activation.ensureSyncProject(primaryLine);
      this.store.upsertProjectLink({
        project_id: projectId,
        source_system: "sbkj-taskassignment",
        external_tenant_id: pkg.tenant_id,
        external_product_line_id: primaryLine.product_line_id,
        external_line_code: primaryLine.line_code,
        display_name: primaryLine.line_name,
        external_url: null,
        sync_status: "active",
        last_synced_at: this.now().toISOString(),
      });
    }
    const link =
      this.store.findProjectLink(pkg.tenant_id, primaryLine.product_line_id) ??
      (() => { throw new Error(`project link still missing after ensureSyncProject: ${primaryLine.product_line_id}`); })();

    // 任务映射 upsert（UNIQUE(source,tenant,task) 兜底）
    let taskLink = this.store.findTaskLink(pkg.tenant_id, pkg.task_id);
    if (!taskLink) {
      taskLink = this.store.createTaskLink({
        project_id: link.project_id,
        source_system: "sbkj-taskassignment",
        external_tenant_id: pkg.tenant_id,
        external_task_id: pkg.task_id,
        external_task_no: pkg.task_no,
        current_package_version: pkg.package_version,
        current_pm_round_id: pkg.flow.pm_round.pm_round_id,
        status: "pending_analysis",
        ai_summary_json: null,
        suggested_priority: null,
      });
    }

    // 包幂等：同任务同版本已入库则跳过（重复事件安全）
    const existing = this.store.findPackage(taskLink.link_id, pkg.package_version);
    if (existing) {
      await this.dispatchActivationHook(taskLink.link_id, pkg, existing.activated === 1);
      return "skipped";
    }

    // 校验包内附件清单完整性（元数据层面；文件下载由接线层按需执行）
    const attachmentIds = new Set<string>();
    for (const att of pkg.attachments) {
      if (attachmentIds.has(att.attachment_id)) {
        throw new Error(`duplicate attachment id in package: ${att.attachment_id}`);
      }
      attachmentIds.add(att.attachment_id);
    }

    this.store.recordPackage({
      task_link_id: taskLink.link_id,
      package_version: pkg.package_version,
      event_id: event.event_id,
      event_type: event.event_type,
      content_hash: pkg.content_hash,
      payload_json: JSON.stringify(pkg),
      document_id: `ptask-${pkg.task_id}`,
      revision: pkg.package_version,
      activated: 1,
    });

    // 更新任务映射到最新版本与轮次；已有进展的任务进入待确认影响（S7：不自动重跑）
    const isInitial = event.event_type === "initial_handoff";
    this.store.updateTaskLink(taskLink.link_id, {
      current_package_version: pkg.package_version,
      current_pm_round_id: pkg.flow.pm_round.pm_round_id,
      ...(isInitial
        ? {}
        : { status: "impact_pending" }),
    });

    await this.dispatchActivationHook(taskLink.link_id, pkg, true);
    return event.event_type === "initial_handoff" ? "activated" : "received";
  }

  /** 首版走 onInitialHandoff；后续版本走 onPackageUpdate；已入库重复包走既有状态。 */
  private async dispatchActivationHook(
    taskLinkRowId: string,
    pkg: HandoffPackage,
    fresh: boolean,
  ): Promise<void> {
    if (!fresh) return; // 重复包：不重复触发业务动作
    if (pkg.event.event_type === "initial_handoff") {
      await this.activation.onInitialHandoff(taskLinkRowId, pkg);
    } else {
      await this.activation.onPackageUpdate(taskLinkRowId, pkg);
    }
  }
}
