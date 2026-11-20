/**
 * G9 迁移：`project_environments.maps_hash`。
 *
 * 两件事必须钉住：
 *   1. **历史行留 NULL，不倒推**。拿现在的文件给历史行补一个值，会把"不知道当时的地图版本"
 *      伪装成"已知且与当前一致"——比留空危险得多。
 *   2. **只加列不动别的**：`swapSafe` 的前提是旧构建按名字取列，多加一列不该让旧构建读坏。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { mapsHash } from "../src/db/migrations/steps/2026-11-19-maps-hash.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  // 模拟"迁移之前"的库：把新列去掉（SCHEMA_SQL 是最新形态，含 maps_hash）
  db.exec("ALTER TABLE project_environments DROP COLUMN maps_hash");
  db.exec("INSERT INTO users(user_id, password_hash, is_admin, created_at) VALUES ('owner1','x',0,'2026-01-01')");
  db.exec("INSERT INTO projects(project_id, owner_user_id, created_at) VALUES ('proj_g9','owner1','2026-01-01')");
  db.prepare(
    `INSERT INTO project_environments(project_id, env, base_url, is_default, status, maps_path, created_at, revision)
     VALUES (?,?,?,1,'registered','maps/staging/maps.json','2026-11-19T00:00:00Z',1)`,
  ).run("proj_g9", "staging", "https://staging.example");
});

afterEach(() => db.close());

const columns = () => (db.prepare("PRAGMA table_info(project_environments)").all() as { name: string }[]).map(item => item.name);

describe("maps_hash migration", () => {
  it("加列，历史行留 NULL（不倒推当前文件）", () => {
    expect(columns()).not.toContain("maps_hash");
    mapsHash.up!(db);
    expect(columns()).toContain("maps_hash");
    const row = db.prepare("SELECT maps_hash, maps_path FROM project_environments WHERE project_id=?").get("proj_g9") as { maps_hash: string | null; maps_path: string | null };
    // 路径在，hash 空：这是"还没登记过版本"，读的一方按 unknown 处理
    expect(row.maps_path).toBe("maps/staging/maps.json");
    expect(row.maps_hash).toBeNull();
  });

  it("可重复执行，不覆盖已登记的版本", () => {
    mapsHash.up!(db);
    db.prepare("UPDATE project_environments SET maps_hash=? WHERE project_id=?").run("a".repeat(64), "proj_g9");
    mapsHash.up!(db);
    const row = db.prepare("SELECT maps_hash FROM project_environments WHERE project_id=?").get("proj_g9") as { maps_hash: string };
    expect(row.maps_hash).toBe("a".repeat(64));
  });

  it("回滚只丢这一列，行还在", () => {
    mapsHash.up!(db);
    mapsHash.down!(db);
    expect(columns()).not.toContain("maps_hash");
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_environments").get()).toEqual({ n: 1 });
  });
});
