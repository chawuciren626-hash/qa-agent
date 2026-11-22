import type { Migration } from "../migration.js";

/**
 * origin 枚举扩展（B 清理批）：qa_tasks.origin 从 ('created','backfill') 扩展为
 * ('created','backfill','assistant','environment')。
 * - assistant：测试助手(default_agent)指派的单阶段任务
 * - environment：探索建档作业(env_explorer_agent)
 * SQLite 不能 ALTER CHECK，标准做法：建新表→拷数据→删旧→重命名。
 */
export const originEnum: Migration = {
  name: "2026-11-22-origin-enum",
  swapSafe: true,
  up(db) {
    db.exec(`
      CREATE TABLE qa_tasks_new (
        task_id         TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL,
        env             TEXT NOT NULL DEFAULT '',
        title           TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','done','archived')),
        owner_user_id   TEXT,
        scope_json      TEXT NOT NULL DEFAULT '{}',
        sut_version     TEXT,
        context_snapshot_id TEXT,
        origin          TEXT NOT NULL DEFAULT 'created' CHECK(origin IN ('created','backfill','assistant','environment')),
        created_at      TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      INSERT INTO qa_tasks_new SELECT * FROM qa_tasks;
      DROP TABLE qa_tasks;
      ALTER TABLE qa_tasks_new RENAME TO qa_tasks;
    `);
  },
  down(db) {
    db.exec("ALTER TABLE qa_tasks RENAME TO qa_tasks_old");
    db.exec(`CREATE TABLE qa_tasks (
        task_id         TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL,
        env             TEXT NOT NULL DEFAULT '',
        title           TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','done','archived')),
        owner_user_id   TEXT,
        scope_json      TEXT NOT NULL DEFAULT '{}',
        sut_version     TEXT,
        context_snapshot_id TEXT,
        origin          TEXT NOT NULL DEFAULT 'created' CHECK(origin IN ('created','backfill')),
        created_at      TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );`);
    db.exec("INSERT INTO qa_tasks SELECT * FROM qa_tasks_old WHERE origin IN ('created','backfill');");
    db.exec("DROP TABLE qa_tasks_old;");
  },
};
