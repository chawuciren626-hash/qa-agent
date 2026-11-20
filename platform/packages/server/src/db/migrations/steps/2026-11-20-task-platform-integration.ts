import type { Migration } from "../migration.js";

/**
 * 任务平台（sbkj-taskassignment）对接承载表：项目/任务映射、事件去重、包接收、
 * 结果回传 outbox 与拉取游标。
 *
 * 设计要点：
 * - 全部 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS：RE-RUNNABLE，
 *   重复执行无副作用（迁移规范 EXPAND 规则）。
 * - 幂等防线以唯一键落地（对接方案 §13.2）：
 *   event_id / (source,tenant,product_line) / (source,tenant,task) /
 *   (task_link,package_version) / (result_id,result_version)。
 * - 包正文（payload_json）保存整包 JSON：qa_documents 的任务级修订由激活钩子写入
 *   （保持两套存储职责分离——这里是接收审计真源，qa_documents 是测试上下文真源）。
 * - down 直接删表：表是纯新增承载，删表即回到未对接状态；已接收的事实记录随表消失，
 *   属于破坏性回滚（migration.ts 的 down 语义），不做数据保全。
 */
export const taskPlatformIntegration: Migration = {
  name: "2026-11-20-task-platform-integration",
  swapSafe: true,
  up(db) {
    // 拉取游标（单行，id=1）
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_ingest_cursor (
        id         INTEGER PRIMARY KEY CHECK(id = 1),
        cursor     TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO task_platform_ingest_cursor (id, cursor, updated_at) VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);

    // 事件去重表（游标重建后靠它幂等）
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_events (
        event_id               TEXT PRIMARY KEY,
        event_type             TEXT NOT NULL,
        external_tenant_id     TEXT NOT NULL,
        external_task_id       TEXT NOT NULL,
        task_no                TEXT NOT NULL,
        package_version        INTEGER NOT NULL,
        parent_package_version INTEGER,
        pm_round_id            TEXT,
        occurred_at            TEXT NOT NULL,
        product_line_ids_json  TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_tp_events_task
        ON task_platform_events(external_tenant_id, external_task_id, package_version);
    `);

    // 产品线 → 同步项目映射（D1）
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_project_links (
        link_id                 TEXT PRIMARY KEY,
        project_id              TEXT NOT NULL,
        source_system           TEXT NOT NULL,
        external_tenant_id      TEXT NOT NULL,
        external_product_line_id TEXT NOT NULL,
        external_line_code      TEXT NOT NULL,
        display_name            TEXT NOT NULL,
        external_url            TEXT,
        sync_status             TEXT NOT NULL DEFAULT 'active' CHECK(sync_status IN ('active','inactive')),
        last_synced_at          TEXT,
        UNIQUE(source_system, external_tenant_id, external_product_line_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tp_project_links_project ON task_platform_project_links(project_id);
    `);

    // 平台任务映射 + 任务列表扩展字段（任务列表模块真源）
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_task_links (
        link_id                 TEXT PRIMARY KEY,
        project_id              TEXT NOT NULL,
        source_system           TEXT NOT NULL,
        external_tenant_id      TEXT NOT NULL,
        external_task_id        TEXT NOT NULL,
        external_task_no        TEXT NOT NULL,
        current_package_version INTEGER NOT NULL,
        current_pm_round_id     TEXT,
        status                  TEXT NOT NULL DEFAULT 'pending_analysis'
          CHECK(status IN ('pending_analysis','ready','in_progress','impact_pending','result_returned','terminated')),
        ai_summary_json         TEXT,
        suggested_priority      TEXT CHECK(suggested_priority IN ('high','medium','low')),
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        UNIQUE(source_system, external_tenant_id, external_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tp_task_links_project_status
        ON task_platform_task_links(project_id, status, updated_at DESC);
    `);

    // 包接收审计（整包 JSON；qa_documents 修订由激活钩子另写）
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_packages (
        id              TEXT PRIMARY KEY,
        task_link_id    TEXT NOT NULL REFERENCES task_platform_task_links(link_id) ON DELETE CASCADE,
        package_version INTEGER NOT NULL,
        event_id        TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        document_id     TEXT NOT NULL,
        revision        INTEGER NOT NULL,
        activated       INTEGER NOT NULL DEFAULT 1 CHECK(activated IN (0,1)),
        received_at     TEXT NOT NULL,
        UNIQUE(task_link_id, package_version)
      );
      CREATE INDEX IF NOT EXISTS idx_tp_packages_link ON task_platform_packages(task_link_id, package_version DESC);
    `);

    // 结果回传 outbox
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_platform_result_outbox (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        result_id       TEXT NOT NULL,
        result_version  INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_retry_at   TEXT NOT NULL,
        last_error      TEXT,
        delivered_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(result_id, result_version)
      );
      CREATE INDEX IF NOT EXISTS idx_tp_outbox_due
        ON task_platform_result_outbox(delivered_at, next_retry_at);
    `);
  },
  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS task_platform_result_outbox;
      DROP TABLE IF EXISTS task_platform_packages;
      DROP TABLE IF EXISTS task_platform_task_links;
      DROP TABLE IF EXISTS task_platform_project_links;
      DROP TABLE IF EXISTS task_platform_events;
      DROP TABLE IF EXISTS task_platform_ingest_cursor;
    `);
  },
};
