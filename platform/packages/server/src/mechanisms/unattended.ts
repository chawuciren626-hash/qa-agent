/**
 * The unattended mechanisms: what a node may require, declared apart from what implements
 * it (the house pattern — Schedules/Scheduling in mechanisms/sessions.ts, Users in
 * mechanisms/identity.ts). The repos in db/repos/unattended-*.ts implement these; the
 * coordinator and the routes require them via @Use.
 *
 * The behavioral contracts (run statuses, ceilings, decisions) live in
 * runtime/unattended/types.ts; these are the store shapes.
 */
import { Interface } from "@prismshadow/penguin-core/kernel";
import type {
  UnattendedBindingRow,
  UnattendedLifecycleRow,
  UnattendedRunPatch,
  UnattendedRunRow,
} from "../runtime/unattended/types.js";

/** UnattendedBindingStore: the mechanism UnattendedBindingsRepo implements. */
@Interface()
export abstract class UnattendedBindingStore {
  abstract bind(args: {
    projectId: string;
    agentId: string;
    name: string;
    ownerUserId: string;
    deviceId: string;
    grantId: string;
    grantExpiresAt: string | null;
    permissionCeiling: UnattendedBindingRow["permissionCeiling"];
    publishSnapshot: Record<string, unknown>;
  }): UnattendedBindingRow;
  abstract find(projectId: string, agentId: string, name: string): UnattendedBindingRow | null;
  abstract listByAgent(projectId: string, agentId: string): UnattendedBindingRow[];
  abstract delete(projectId: string, agentId: string, name: string): boolean;
  abstract deleteByAgent(projectId: string, agentId: string): void;
  abstract deleteByProject(projectId: string): void;
}

/** UnattendedRunLedger: the mechanism UnattendedRunsRepo implements. */
@Interface()
export abstract class UnattendedRunLedger {
  abstract begin(args: {
    projectId: string;
    agentId: string;
    name: string;
    slotMs: number;
    ownerUserId: string;
    deviceId: string;
    grantId: string | null;
    deadlineMs: number | null;
  }): { row: UnattendedRunRow; fresh: boolean };
  abstract find(runId: string): UnattendedRunRow | null;
  abstract byKey(projectId: string, agentId: string, name: string, slotMs: number): UnattendedRunRow | null;
  abstract transition(
    runId: string,
    fromVersion: number,
    fromStatuses: readonly string[],
    patch: UnattendedRunPatch,
  ): UnattendedRunRow | null;
  abstract listUndispatchedBefore(beforeIso: string): UnattendedRunRow[];
  abstract listStaleDispatched(statuses: readonly string[], beforeIso: string): UnattendedRunRow[];
  abstract listPastDeadline(statuses: readonly string[], nowMs: number): UnattendedRunRow[];
  abstract listLapsedApprovals(beforeIso: string): UnattendedRunRow[];
  abstract listRunningWithSession(): UnattendedRunRow[];
  abstract listByTask(projectId: string, agentId: string, name: string, limit?: number): UnattendedRunRow[];
  abstract listByProject(projectId: string, status: string | null, limit?: number): UnattendedRunRow[];
  abstract findRun(runId: string): UnattendedRunRow | null;
}

/** UnattendedLifecycleStore: the mechanism UnattendedLifecycleRepo implements. */
@Interface()
export abstract class UnattendedLifecycleStore {
  abstract insert(kind: string, detail: Record<string, unknown>, at: string): UnattendedLifecycleRow;
  abstract listRecent(limit?: number): UnattendedLifecycleRow[];
}
