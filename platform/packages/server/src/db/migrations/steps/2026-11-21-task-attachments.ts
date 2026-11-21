import type { Migration } from "../migration.js";

/**
 * 任务附件表（B1-3b）：AI 分析的文本型补充输入。
 *
 * 设计口径：
 * - 只收**文本类**附件（md/txt/json/csv/html/yaml 等），内容以内联 TEXT 存储——附件的存在
 *   意义就是进入分析上下文，二进制（图片/压缩包）对同步模型通道没有输入通道，明确拒收；
 * - 大小与数量上限由 service 层执行（单件 60KB、单任务 10 件），表层不做 CHECK；
 * - task_source + task_id 指向 platform_task_links 或 qa_local_tasks 的行；两表无外键互引，
 *   任务删除时附件靠删除动作显式清理（两条删除路径都会先清附件）。
 */
export const taskAttachments: Migration = {
  name: "2026-11-21-task-attachments",
  swapSafe: true,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS qa_task_attachments (
        attachment_id  TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        task_source    TEXT NOT NULL CHECK(task_source IN ('platform','local')),
        task_id        TEXT NOT NULL,
        filename       TEXT NOT NULL,
        mime           TEXT NOT NULL DEFAULT 'text/plain',
        size_bytes     INTEGER NOT NULL,
        content_text   TEXT NOT NULL,
        created_by     TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task
        ON qa_task_attachments(project_id, task_source, task_id, created_at DESC);
    `);
  },
  down(db) {
    db.exec("DROP TABLE IF EXISTS qa_task_attachments");
  },
};
