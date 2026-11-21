import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { localTaskContext } from "../src/db/migrations/steps/2026-11-21-local-task-context.js";
import { SCHEMA_SQL } from "../src/db/schema.js";

const columns = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);

describe("local task context migration", () => {
  it("upgrades old task tables without losing rows and can run twice", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE qa_local_tasks (task_id TEXT PRIMARY KEY, title TEXT); CREATE TABLE platform_task_links (link_id TEXT PRIMARY KEY, title TEXT)");
      db.exec("INSERT INTO qa_local_tasks VALUES ('local-1', 'existing local task'); INSERT INTO platform_task_links VALUES ('platform-1', 'existing platform task')");
      localTaskContext.up(db);
      localTaskContext.up(db);
      expect(columns(db, "qa_local_tasks")).toEqual(expect.arrayContaining(["env_name", "env_base_url", "account", "analysis_session_id", "analysis_state", "analysis_error"]));
      expect(columns(db, "platform_task_links")).toEqual(expect.arrayContaining(["analysis_session_id", "analysis_state", "analysis_error"]));
      expect(db.prepare("SELECT title, env_name, analysis_state FROM qa_local_tasks").get()).toMatchObject({ title: "existing local task", env_name: null, analysis_state: null });
      expect(db.prepare("SELECT title, analysis_session_id FROM platform_task_links").get()).toMatchObject({ title: "existing platform task", analysis_session_id: null });
    } finally { db.close(); }
  });

  it("keeps the current schema unchanged when reapplied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SCHEMA_SQL);
      const before = [columns(db, "qa_local_tasks"), columns(db, "platform_task_links")];
      localTaskContext.up(db);
      expect([columns(db, "qa_local_tasks"), columns(db, "platform_task_links")]).toEqual(before);
    } finally { db.close(); }
  });
});
