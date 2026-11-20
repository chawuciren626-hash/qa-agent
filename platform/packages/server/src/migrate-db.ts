/**
 * Offline schema migration for a data root's Web database — §6.4 红线 3 的落地件
 * （"数据库 schema 迁移要走部署链，不能只在源码目录跑 migration"）。
 *
 * 迁移至今只在服务自己的 open（`openDatabase`）时执行，发布链（scripts/release.mjs）
 * 全程不打开 web.db，于是"源码有表、安装版没表"只能等下一次服务启动才暴露，且失败
 * 发生在 resume 之后无人知晓。本模块把迁移变成发布链里**显式的一步**：pause 之后、
 * resume 之前，用**新部署的代码**对安装目录的 web.db 跑一次迁移并断言成功——失败就
 * 让发布停下来，而不是让服务带着旧 schema 起来。
 *
 * 与 reset-admin-password 同一套纪律：本地文件系统访问即授权；live server 持有 root 时
 * 拒绝（web.db 单写者）；db 不存在时不创建（没跑过服务的 root 迁移它没有意义）。
 * openDatabase 里的迁移是幂等的（账本记账、逐条提交），已经最新的库不写任何东西。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, openDatabaseReadOnly } from "./db/database.js";
import { appliedMigrations, MIGRATIONS } from "./db/migrations/index.js";
import { liveServerLock } from "./lock.js";
import type { ServerLock } from "./lock.js";

export type MigrateDbResult =
  /** Refused: a live server owns this data root (stop it first — web.db is single-writer). */
  | { outcome: "server_running"; lock: ServerLock }
  /** Nothing to migrate: the root has no Web database (the server has never run here). */
  | { outcome: "no_database"; dbPath: string }
  /** Migrations were applied by this run, in order. */
  | { outcome: "migrated"; applied: readonly string[]; ledger: readonly string[] }
  /** The ledger already records every declared migration; nothing was written. */
  | { outcome: "current"; ledger: readonly string[] };

/**
 * 账本对比拿"本次应用了哪些"：openDatabase 内部的 migrate 返回值会被它吞掉，而发布链
 * 需要看见这个名字列表——"迁移跑了"和"迁移跑了什么"是两句话，部署日志要的是后者。
 */
function ledgerOf(dbPath: string, readOnly: boolean): string[] {
  const db = readOnly ? openDatabaseReadOnly(dbPath) : openDatabase(dbPath);
  try {
    return appliedMigrations(db);
  } finally {
    db.close();
  }
}

export async function migrateDatabase(
  root: string,
  dbPath: string = path.join(root, "web.db"),
): Promise<MigrateDbResult> {
  const lock = await liveServerLock(root);
  if (lock !== null) return { outcome: "server_running", lock };
  // Existence check before openDatabase, which would otherwise CREATE an empty database
  // (and the root directory) on a root the server has never used.
  if (!fs.existsSync(dbPath)) return { outcome: "no_database", dbPath };
  const before = ledgerOf(dbPath, true);
  const db = openDatabase(dbPath);
  try {
    const ledger = appliedMigrations(db);
    const applied = ledger.filter(name => !before.includes(name));
    return applied.length > 0 ? { outcome: "migrated", applied, ledger } : { outcome: "current", ledger };
  } finally {
    db.close();
  }
}

const declaredCount = MIGRATIONS.length;

/** Direct CLI: `node dist/migrate-db.js <dataRoot> [dbPath]` — the release chain calls this. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("migrate-db: 用法：node migrate-db.js <dataRoot> [dbPath]");
    process.exit(1);
  }
  const dbPath = process.argv[3] ?? path.join(root, "web.db");
  void migrateDatabase(root, dbPath).then(result => {
    switch (result.outcome) {
      case "server_running":
        console.error(`migrate-db: 有运行中的服务持有数据根（端口 ${result.lock.port}），先暂停服务再迁移。`);
        process.exitCode = 1;
        return;
      case "no_database":
        console.error(`migrate-db: 数据库不存在，跳过迁移：${dbPath}`);
        return;
      case "migrated":
        console.log(`migrate-db: 已应用 ${result.applied.length}/${declaredCount} 条迁移：${result.applied.join(", ")}`);
        return;
      case "current":
        console.log(`migrate-db: schema 已是最新（账本 ${result.ledger.length}/${declaredCount} 条），未做任何改动。`);
    }
  }).catch((cause: unknown) => {
    console.error(`migrate-db: 迁移失败：${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  });
}
