/**
 * Repo for unattended lifecycle records: service start/stop, clock-gap suspicion
 * (sleep / network-loss approximation), and blocked-fire audit entries. Append-only;
 * nothing reads them back except the routes' recent list and the tests.
 */
import { randomUUID } from "node:crypto";
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Db } from "../../hmr/capabilities.js";
import type { UnattendedLifecycleRow } from "../../runtime/unattended/types.js";

@Component()
export class UnattendedLifecycleRepo {
  @Use() private readonly db!: Db;

  insert(kind: string, detail: Record<string, unknown>, at: string): UnattendedLifecycleRow {
    const row: UnattendedLifecycleRow = { eventId: randomUUID(), at, kind, detail };
    this.db
      .prepare(
        "INSERT INTO unattended_lifecycle (event_id, at, kind, detail_json) VALUES (?, ?, ?, ?)",
      )
      .run(row.eventId, row.at, row.kind, JSON.stringify(row.detail));
    return row;
  }

  listRecent(limit = 100): UnattendedLifecycleRow[] {
    const rows = this.db
      .prepare("SELECT * FROM unattended_lifecycle ORDER BY at DESC, event_id DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => ({
      eventId: r.event_id as string,
      at: r.at as string,
      kind: r.kind as string,
      detail: JSON.parse(r.detail_json as string) as Record<string, unknown>,
    }));
  }

  deleteByProject(projectId: string): void {
    // Lifecycle records are server-level, not per-project; this exists so Project deletion
    // hooks have one call site and so tests can clean selectively. v1 keeps records.
    void projectId;
  }
}
