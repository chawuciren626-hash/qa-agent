/**
 * Repo for unattended per-task authorization bindings: WHO owns the task, on WHICH device
 * it may run, under WHICH grant and permission ceiling, with the content snapshot taken at
 * bind time (CONTRACTS.md 搂1). The binding is the opt-in that puts a schedule task under
 * the unattended boundary; a task without a binding keeps the legacy scheduler semantics.
 */
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Db } from "../../hmr/capabilities.js";
import type { PermissionCeiling, UnattendedBindingRow } from "../../runtime/unattended/types.js";

interface BindingArgs {
  projectId: string;
  agentId: string;
  name: string;
  ownerUserId: string;
  deviceId: string;
  grantId: string;
  grantExpiresAt: string | null;
  permissionCeiling: PermissionCeiling;
  publishSnapshot: Record<string, unknown>;
}

function mapRow(r: Record<string, unknown>): UnattendedBindingRow {
  return {
    projectId: r.project_id as string,
    agentId: r.agent_id as string,
    name: r.name as string,
    ownerUserId: r.owner_user_id as string,
    deviceId: r.device_id as string,
    grantId: r.grant_id as string,
    grantExpiresAt: (r.grant_expires_at as string | null) ?? null,
    permissionCeiling: JSON.parse(r.permission_ceiling_json as string) as PermissionCeiling,
    publishSnapshot: JSON.parse(r.publish_snapshot_json as string) as Record<string, unknown>,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

@Component()
export class UnattendedBindingsRepo {
  @Use() private readonly db!: Db;

  /** Insert or full replacement (the binding is user intent, like the schedule file itself). */
  bind(args: BindingArgs): UnattendedBindingRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO unattended_bindings
           (project_id, agent_id, name, owner_user_id, device_id, grant_id, grant_expires_at,
            permission_ceiling_json, publish_snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, agent_id, name) DO UPDATE SET
           owner_user_id = excluded.owner_user_id,
           device_id = excluded.device_id,
           grant_id = excluded.grant_id,
           grant_expires_at = excluded.grant_expires_at,
           permission_ceiling_json = excluded.permission_ceiling_json,
           publish_snapshot_json = excluded.publish_snapshot_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        args.projectId,
        args.agentId,
        args.name,
        args.ownerUserId,
        args.deviceId,
        args.grantId,
        args.grantExpiresAt,
        JSON.stringify(args.permissionCeiling),
        JSON.stringify(args.publishSnapshot),
        now,
        now,
      );
    const row = this.find(args.projectId, args.agentId, args.name);
    if (!row) throw new Error("Failed to read back unattended_bindings after bind");
    return row;
  }

  find(projectId: string, agentId: string, name: string): UnattendedBindingRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM unattended_bindings WHERE project_id = ? AND agent_id = ? AND name = ?",
      )
      .get(projectId, agentId, name);
    return r ? mapRow(r as Record<string, unknown>) : null;
  }

  listByAgent(projectId: string, agentId: string): UnattendedBindingRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM unattended_bindings WHERE project_id = ? AND agent_id = ? ORDER BY name",
      )
      .all(projectId, agentId);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  delete(projectId: string, agentId: string, name: string): boolean {
    const res = this.db
      .prepare(
        "DELETE FROM unattended_bindings WHERE project_id = ? AND agent_id = ? AND name = ?",
      )
      .run(projectId, agentId, name);
    return res.changes > 0;
  }

  deleteByAgent(projectId: string, agentId: string): void {
    this.db
      .prepare("DELETE FROM unattended_bindings WHERE project_id = ? AND agent_id = ?")
      .run(projectId, agentId);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM unattended_bindings WHERE project_id = ?").run(projectId);
  }
}
