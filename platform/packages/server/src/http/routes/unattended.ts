/**
 * Unattended routes (batch 4), relative to `/api/projects/:projectId/unattended`:
 *
 * PUT    /bind/:agentId/:name   — bind the schedule task to the unattended boundary
 *                                 {deviceId?, grantExpiresAt?, permissionCeiling, publishSnapshot}.
 *                                 Owner-only. The device defaults to THIS machine's identity
 *                                 (an unattended task runs on the local executor; remote
 *                                 devices are the task exchange's server-side concern).
 * DELETE /bind/:agentId/:name   — remove the binding (the task returns to legacy semantics).
 * GET    /bind/:agentId         — the agent's bindings.
 * GET    /runs?agentId=&name=&status=&limit= — the run ledger (member read; audit).
 * POST   /runs/:runId/cancel    — cancel an open run {by?} (member of the project).
 *
 * Bind-time validation: the schedule file must exist and parse; a grant already past its
 * expiry is refused (创建时已过期的授权没有意义，与调度写入拒绝过去时刻同原则).
 */
import { Hono } from "hono";
import { isValidId } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { ServerConfig } from "../../config.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { readScheduleFile } from "../../runtime/schedule-store.js";
import { localDeviceId } from "../../runtime/unattended/device-identity.js";
import type {
  PermissionCeiling,
  UnattendedBindingRow,
  UnattendedCoordinator,
  UnattendedRunRow,
} from "../../runtime/unattended/types.js";
import type {
  UnattendedBindingStore,
  UnattendedLifecycleStore,
  UnattendedRunLedger,
} from "../../mechanisms/unattended.js";
import type { Access } from "../../mechanisms/projects.js";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Config } from "../../hmr/capabilities.js";

export interface UnattendedRouteDeps {
  config: ServerConfig;
  access: Access;
  bindings: UnattendedBindingStore;
  runs: UnattendedRunLedger;
  lifecycle: UnattendedLifecycleStore;
  coordinator: UnattendedCoordinator;
}

const RUN_STATUSES = new Set([
  "queued",
  "claimed",
  "running",
  "needs_approval",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "unknown",
]);

function requireTaskId(raw: string | undefined, what: string): string {
  if (!raw || !isValidId(raw)) throw new HttpError(400, "bad_request", `Invalid ${what}.`);
  return raw;
}

function parseCeiling(body: Record<string, unknown>): PermissionCeiling {
  const ceiling = body.permissionCeiling;
  if (ceiling === null || ceiling === undefined || typeof ceiling !== "object") {
    throw new HttpError(400, "bad_request", "permissionCeiling must be an object.");
  }
  const ops = (ceiling as Record<string, unknown>).allowedOperations;
  if (
    !Array.isArray(ops) ||
    ops.length === 0 ||
    ops.some((o) => typeof o !== "string" || o === "")
  ) {
    throw new HttpError(
      400,
      "bad_request",
      "permissionCeiling.allowedOperations must be a non-empty string array.",
    );
  }
  const escalation = (ceiling as Record<string, unknown>).unattendedApproval;
  if (escalation !== undefined && escalation !== "default" && escalation !== "allow-all") {
    throw new HttpError(
      400,
      "bad_request",
      'permissionCeiling.unattendedApproval must be "default" or "allow-all".',
    );
  }
  const deadline = (ceiling as Record<string, unknown>).defaultRunDeadlineMs;
  if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)) {
    throw new HttpError(400, "bad_request", "permissionCeiling.defaultRunDeadlineMs must be a positive number.");
  }
  return {
    allowedOperations: ops as string[],
    ...(escalation !== undefined ? { unattendedApproval: escalation as "default" | "allow-all" } : {}),
    ...(deadline !== undefined ? { defaultRunDeadlineMs: deadline as number } : {}),
  };
}

function bindingView(row: UnattendedBindingRow) {
  return {
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    ownerUserId: row.ownerUserId,
    deviceId: row.deviceId,
    grantId: row.grantId,
    grantExpiresAt: row.grantExpiresAt,
    permissionCeiling: row.permissionCeiling,
    publishSnapshot: row.publishSnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runView(row: UnattendedRunRow) {
  return {
    runId: row.runId,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    slotMs: row.slotMs,
    ownerUserId: row.ownerUserId,
    deviceId: row.deviceId,
    status: row.status,
    statusVersion: row.statusVersion,
    sessionId: row.sessionId,
    reasonCode: row.reasonCode,
    decisionId: row.decisionId,
    policyRevision: row.policyRevision,
    deadlineMs: row.deadlineMs,
    cancelRequested: row.cancelRequested,
    cancelSignalDelivered: row.cancelSignalDelivered,
    dispatchedAt: row.dispatchedAt,
    settledAt: row.settledAt,
    evidence: row.evidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function unattendedRoutes(deps: UnattendedRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put("/bind/:agentId/:name", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const agentId = requireTaskId(c.req.param("agentId"), "agent id");
    const name = requireTaskId(c.req.param("name"), "schedule name");
    deps.access.requireProjectOwner(c.var.user.userId, projectId);
    const file = await readScheduleFile(deps.config.root, projectId, agentId, name);
    if (!file || !file.parsed.ok) {
      throw new HttpError(404, "schedule_not_found", `No valid schedule file: ${name}`);
    }
    const body = await readJson(c);
    const ceiling = parseCeiling(body);
    const grantExpiresAt = body.grantExpiresAt;
    if (grantExpiresAt !== undefined && grantExpiresAt !== null && typeof grantExpiresAt !== "string") {
      throw new HttpError(400, "bad_request", "grantExpiresAt must be an ISO instant or null.");
    }
    if (typeof grantExpiresAt === "string" && (!Number.isFinite(Date.parse(grantExpiresAt)) || Date.parse(grantExpiresAt) <= Date.now())) {
      throw new HttpError(
        400,
        "grant_already_expired",
        "grantExpiresAt is already past: bind a grant that still has time.",
      );
    }
    const publishSnapshot =
      body.publishSnapshot !== undefined && body.publishSnapshot !== null
        ? body.publishSnapshot
        : {};
    if (typeof publishSnapshot !== "object") {
      throw new HttpError(400, "bad_request", "publishSnapshot must be an object.");
    }
    const deviceId = body.deviceId === undefined ? localDeviceId(deps.config.root) : body.deviceId;
    if (typeof deviceId !== "string" || deviceId === "") {
      throw new HttpError(400, "bad_request", "deviceId must be a non-empty string.");
    }
    const grantId =
      body.grantId === undefined || body.grantId === null
        ? `grant-${crypto.randomUUID()}`
        : body.grantId;
    if (typeof grantId !== "string" || grantId === "") {
      throw new HttpError(400, "bad_request", "grantId must be a non-empty string.");
    }
    const row = deps.bindings.bind({
      projectId,
      agentId,
      name,
      ownerUserId: c.var.user.userId,
      deviceId,
      grantId,
      grantExpiresAt: typeof grantExpiresAt === "string" ? grantExpiresAt : null,
      permissionCeiling: ceiling,
      publishSnapshot: publishSnapshot as Record<string, unknown>,
    });
    deps.coordinator.recordLifecycle("binding_upserted", { projectId, agentId, name, deviceId });
    return c.json(bindingView(row), 201);
  });

  app.get("/bind/:agentId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const agentId = requireTaskId(c.req.param("agentId"), "agent id");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    const rows = deps.bindings.listByAgent(projectId, agentId);
    return c.json({ bindings: rows.map(bindingView) });
  });

  app.delete("/bind/:agentId/:name", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const agentId = requireTaskId(c.req.param("agentId"), "agent id");
    const name = requireTaskId(c.req.param("name"), "schedule name");
    deps.access.requireProjectOwner(c.var.user.userId, projectId);
    const removed = deps.bindings.delete(projectId, agentId, name);
    if (!removed) throw new HttpError(404, "binding_not_found", `No binding for task: ${name}`);
    deps.coordinator.recordLifecycle("binding_removed", { projectId, agentId, name });
    return c.body(null, 204);
  });

  app.get("/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    const status = c.req.query("status");
    if (status !== undefined && !RUN_STATUSES.has(status)) {
      throw new HttpError(400, "bad_request", `Unknown status filter: ${status}`);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 200 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      throw new HttpError(400, "bad_request", "limit must be an integer in [1, 1000].");
    }
    const rows = deps.runs.listByProject(projectId, status ?? null, limit);
    return c.json({ runs: rows.map(runView) });
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const runId = requireTaskId(c.req.param("runId"), "run id");
    deps.access.requireProjectOwner(c.var.user.userId, projectId);
    const run = deps.runs.findRun(runId);
    if (!run || run.projectId !== projectId) {
      throw new HttpError(404, "run_not_found", `No run: ${runId}`);
    }
    const result = await deps.coordinator.cancelRun(runId, c.var.user.userId);
    const after = deps.runs.findRun(runId);
    return c.json({ ...result, run: after ? runView(after) : null });
  });

  return app;
}

@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "UnattendedRoutes.routes",
        prefix: "/api/projects/:projectId/unattended",
        auth: "user",
        order: 205,
      },
    ],
  },
})
export class UnattendedRoutes {
  @Use() private readonly config!: Config;
  @Use() private readonly access!: Access;
  @Use() private readonly bindingsRepo!: UnattendedBindingStore;
  @Use() private readonly runsRepo!: UnattendedRunLedger;
  @Use() private readonly lifecycleRepo!: UnattendedLifecycleStore;
  @Use() private readonly coordinator!: UnattendedCoordinator;
  @Bind("UnattendedRoutes.routes") routes!: Hono<AppEnv>;
  setup() {
    const deps: UnattendedRouteDeps = {
      config: this.config,
      access: this.access,
      bindings: this.bindingsRepo,
      runs: this.runsRepo,
      lifecycle: this.lifecycleRepo,
      coordinator: this.coordinator,
    };
    this.routes = unattendedRoutes(deps);
  }
}
