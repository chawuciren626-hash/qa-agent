/**
 * 2026-11-21-mcp-server-catalog 迁移回归：三张表建齐、可重跑、外键级联正确。
 *
 * 目录表是这次 MCP 闭环的事实承载；下发台账挂了 ON DELETE CASCADE——删目录条目必须
 * 连带清台账，否则管理页会展示一条指向不存在服务的下发。这里用 SCHEMA_SQL 建全新库
 * （表已存在，验证 schema 形状），再用空库跑迁移（验证 DDL 本身与可重跑性）。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { mcpServerCatalog } from "../src/db/migrations/steps/2026-11-21-mcp-server-catalog.js";

const n = (db: DatabaseSync, sql: string) =>
  Number((db.prepare(sql).get() as { n: number }).n);

describe("2026-11-21-mcp-server-catalog", () => {
  it("全新库的 SCHEMA_SQL 已含三张表；迁移在其上重跑是空操作", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    mcpServerCatalog.up(db);
    mcpServerCatalog.up(db); // 可重跑：再跑一遍不改行数
    expect(n(db, "SELECT COUNT(*) AS n FROM mcp_server_catalog")).toBe(0);
    expect(n(db, "SELECT COUNT(*) AS n FROM mcp_server_assignments")).toBe(0);
    expect(n(db, "SELECT COUNT(*) AS n FROM mcp_server_audit")).toBe(0);
    db.close();
  });

  it("没有 schema 的老库跑迁移：三张表直接建成，台账级联随目录条目删除", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    mcpServerCatalog.up(db);
    db.prepare(
      "INSERT INTO mcp_server_catalog(name,transport,command,args_json,env_json,url,headers_json,description,stage_tags_json,enabled,source,created_at,created_by,updated_at) VALUES ('demo','stdio','node','[]','{}','','{}','','[]',1,'custom','2026-11-21','admin','2026-11-21')",
    ).run();
    db.prepare("INSERT INTO mcp_server_assignments(server_name,project_id,agent_id,assigned_by,assigned_at) VALUES ('demo','p1','a1','admin','2026-11-21')").run();
    db.prepare("INSERT INTO mcp_server_audit(server_name,action,actor,detail,created_at) VALUES ('demo','create','admin','','2026-11-21')").run();
    expect(n(db, "SELECT COUNT(*) AS n FROM mcp_server_assignments")).toBe(1);
    db.prepare("DELETE FROM mcp_server_catalog WHERE name='demo'").run();
    expect(n(db, "SELECT COUNT(*) AS n FROM mcp_server_assignments")).toBe(0);
    mcpServerCatalog.down?.(db);
    expect(n(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_server_%'")).toBe(0);
    db.close();
  });
});
