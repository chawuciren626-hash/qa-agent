/**
 * Offline schema migration (§6.4 红线 3): the three honest outcomes (no database — none
 * created as a side effect; already current — nothing written; behind — the missing ledger
 * rows reapplied), plus the live-server refusal.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, openDatabaseReadOnly } from "../src/db/database.js";
import { MIGRATIONS } from "../src/db/migrations/index.js";
import { acquireServerLock, releaseServerLock } from "../src/lock.js";
import { migrateDatabase } from "../src/migrate-db.js";
import { makeTempRoot } from "./helpers.js";

describe("migrateDatabase", () => {
  const roots: { root: string; release?: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const entry of roots.splice(0)) {
      await entry.release?.();
      await fs.promises.rm(entry.root, { recursive: true, force: true });
    }
  });

  async function tempRoot(): Promise<string> {
    const root = await makeTempRoot();
    roots.push({ root });
    return root;
  }

  it("refuses to create a database on a root the server has never used", async () => {
    const root = await tempRoot();
    const result = await migrateDatabase(root);
    expect(result.outcome).toBe("no_database");
    expect(fs.existsSync(path.join(root, "web.db"))).toBe(false);
  });

  it("reports current without writing when the ledger already records every migration", async () => {
    const root = await tempRoot();
    const dbPath = path.join(root, "web.db");
    const db = openDatabase(dbPath);
    db.close();
    const beforeDb = openDatabaseReadOnly(dbPath);
    const before = beforeDb.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY rowid").all();
    beforeDb.close();
    const result = await migrateDatabase(root);
    expect(result).toMatchObject({ outcome: "current" });
    if (result.outcome !== "current") return;
    expect(result.ledger).toHaveLength(MIGRATIONS.length);
    // SQLite may checkpoint on close, so assert the logical migration state instead of mtime.
    const verify = openDatabaseReadOnly(dbPath);
    try {
      expect(verify.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(before);
      expect(verify.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    } finally {
      verify.close();
    }
  });

  it("reapplies a ledger row that is missing (an older database) and reports it by name", async () => {
    const root = await tempRoot();
    const dbPath = path.join(root, "web.db");
    const db = openDatabase(dbPath);
    const newest = MIGRATIONS[MIGRATIONS.length - 1]!.name;
    expect(newest).toBeTruthy();
    // Simulate an older database: the newest migration's ledger row is absent, so its
    // contract work has not run here yet.
    db.prepare("DELETE FROM schema_migrations WHERE name=?").run(newest);
    db.close();
    const result = await migrateDatabase(root);
    expect(result).toMatchObject({ outcome: "migrated" });
    if (result.outcome !== "migrated") return;
    expect(result.applied).toEqual([newest]);
    expect(result.ledger).toHaveLength(MIGRATIONS.length);
    // A second run over the same database is a no-op again.
    const again = await migrateDatabase(root);
    expect(again.outcome).toBe("current");
  });

  it("refuses while a live server owns the data root", async () => {
    const root = await tempRoot();
    const dbPath = path.join(root, "web.db");
    openDatabase(dbPath).close();
    const srv = net.createServer();
    await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;
    acquireServerLock(root, { pid: process.pid, port, startedAt: "2026-01-01T00:00:00Z" });
    try {
      const result = await migrateDatabase(root);
      expect(result).toMatchObject({ outcome: "server_running", lock: { port } });
    } finally {
      releaseServerLock(root);
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });
});
