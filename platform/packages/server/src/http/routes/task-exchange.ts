/**
 * Task-exchange routes (batch 5), two groups with separate authentication:
 *
 * `/api/exchange/v1` — exchange bearer tokens ONLY (platform or device; the middleware
 *   authenticates into c.var.exchange, never anonymous):
 *   POST  /tasks                (platform) create; idempotency-key dedup; device+project verified server-side
 *   GET   /tasks                (platform) list (with device-liveness queued reasons)
 *   GET   /tasks/:id            (platform) one task (status, cancel_requested, queued_reason)
 *   POST  /tasks/:id/cancel     (platform) cancel request (queued settles at once; in-flight waits for the ack)
 *   GET   /tasks/:id/result     (platform) the latest received result (synthetic-marked until a real executor reports)
 *   PUT   /tasks/:id/callback   (platform) configure the result callback URL (SSRF-guarded)
 *   POST  /claim                (device)   claim the next queued task (lease + fencing epoch)
 *   POST  /tasks/:id/status     (device)   running / cancel-ack (fenced)
 *   POST  /tasks/:id/result     (device)   submit the result (data-field authorization enforced)
 *
 * `/api/exchange-management/v1` — user sessions ONLY (a SIBLING prefix, not a subpath: the token-auth group owns /api/exchange/v1 and would otherwise swallow these) (auth: "user"), the registration plane:
 *   POST   /management/devices            register a device (token shown ONCE)
 *   GET    /management/devices            the user's devices (no token material)
 *   DELETE /management/devices/:deviceId  revoke
 *   POST   /management/platforms          (admin) register a platform credential (token shown ONCE)
 *   DELETE /management/platforms/:pid     (admin) revoke
 *   POST   /management/callback-hosts     (admin) EXPLICIT intranet allowlist for callback targets
 *   GET    /management/callback-hosts     (admin) list
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { ServerConfig } from "../../config.js";
import { HttpError } from "../errors.js";
import { readJson } from "../validate.js";
import type { Access } from "../../mechanisms/projects.js";
import type { ExchangeTasks, TaskExchangeStore } from "../../mechanisms/taskexchange.js";
import { ExchangeService } from "../../taskexchange/service.js";
import {
  exchangeTokenAuth,
  mintToken,
  requireDevice,
  requirePlatform,
  sha256Hex,
} from "../../taskexchange/credentials.js";
import { checkCallbackUrl } from "../../taskexchange/ssrf.js";
import {
  ExchangeError,
  newExchangeId,
  validateCreateTaskBody,
} from "../../taskexchange/types.js";
import type {
  ExchangeDeviceRow,
  ExchangeTaskRow,
} from "../../taskexchange/types.js";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Config } from "../../hmr/capabilities.js";

export interface ExchangeRouteDeps {
  config: ServerConfig;
  store: TaskExchangeStore;
  service: ExchangeTasks;
}

function taskView(task: ExchangeTaskRow): Record<string, unknown> {
  return {
    taskId: task.taskId,
    userId: task.userId,
    tenantId: task.tenantId,
    platformId: task.platformId,
    externalId: task.externalId,
    status: task.status,
    statusVersion: task.statusVersion,
    cancelRequested: task.cancelRequested,
    cancelVersion: task.cancelVersion,
    queuedReason: task.queuedReason,
    deviceId: task.deviceId,
    projectRef: task.projectRef,
    objective: task.objective,
    allowedDataFields: task.allowedDataFields,
    deadlineMs: task.deadlineMs,
    callbackConfigured: task.callbackUrl !== null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function deviceView(d: ExchangeDeviceRow): Record<string, unknown> {
  return {
    deviceId: d.deviceId,
    platformId: d.platformId,
    label: d.label,
    registeredAt: d.registeredAt,
    revokedAt: d.revokedAt,
    lastSeenAt: d.lastSeenAt,
  };
}

function requireString_(body: Record<string, unknown>, key: string, max = 200): string {
  const v = body[key];
  if (typeof v !== "string" || v === "" || v.length > max) {
    throw new HttpError(400, "bad_request", `${key} must be a non-empty string.`);
  }
  return v;
}

export function exchangeTokenRoutes(deps: ExchangeRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", exchangeTokenAuth(deps.store));
  app.get('/identity', c => {
    const caller = requireDevice(c);
    return c.json({ deviceId: caller.deviceId, userId: caller.userId, platformId: caller.platformId });
  });

  app.post("/tasks", async (c) => {
    const caller = requirePlatform(c);
    const body = await readJson(c);
    const shaped = validateCreateTaskBody(body);
    // The task's owner is the DEVICE's registered user — resolved server-side, never taken
    // from the request body (client-submitted ownership is not trusted).
    const userId = await deviceUserOf(deps, caller.tenantId, shaped.deviceId);
    const { task, idempotent } = deps.service.createTask({
      tenantId: caller.tenantId,
      platformId: caller.platformId,
      body: shaped,
      userId,
      nowMs: Date.now(),
    });
    return c.json({ task: taskView(task), idempotent }, idempotent ? 200 : 201);
  });

  app.get("/tasks", async (c) => {
    const caller = requirePlatform(c);
    const tasks = deps.service.listForPlatform(caller.tenantId, caller.platformId, Date.now());
    return c.json({ tasks: tasks.map(taskView) });
  });

  app.get("/tasks/:taskId", async (c) => {
    const caller = requirePlatform(c);
    const task = deps.service.taskForPlatform(caller.tenantId, caller.platformId, c.req.param("taskId") ?? "", Date.now());
    return c.json({ task: taskView(task) });
  });

  app.post("/tasks/:taskId/cancel", async (c) => {
    const caller = requirePlatform(c);
    const task = deps.service.cancelTask(caller.tenantId, caller.platformId, c.req.param("taskId") ?? "", Date.now());
    return c.json({ task: taskView(task) });
  });

  app.get("/tasks/:taskId/result", async (c) => {
    const caller = requirePlatform(c);
    const task = deps.service.taskForPlatform(caller.tenantId, caller.platformId, c.req.param("taskId") ?? "", Date.now());
    const result = deps.store.latestResult(task.taskId);
    if (!result) throw new HttpError(404, "result_not_found", "No result received yet.");
    return c.json({
      result: {
        outcome: result.outcome,
        summary: result.summary,
        evidenceIndex: result.evidenceIndex,
        synthetic: result.synthetic,
        receivedAt: result.receivedAt,
        attempt: result.attempt,
      },
    });
  });

  app.put("/tasks/:taskId/callback", async (c) => {
    const caller = requirePlatform(c);
    const body = await readJson(c);
    const url = requireString_(body, "callbackUrl", 2000);
    const allowed = new Set(deps.store.listAllowedHosts().map((h) => h.host));
    const verdict = checkCallbackUrl(url, { allowedHosts: allowed });
    if (!verdict.ok) {
      throw new HttpError(verdict.reason === "invalid_callback_url" ? 400 : 403, verdict.reason, verdict.detail ?? url);
    }
    const task = deps.service.setCallbackUrl(caller.tenantId, caller.platformId, c.req.param("taskId") ?? "", url, { allowedHosts: allowed }, Date.now());
    return c.json({ task: taskView(task) });
  });

  app.post("/claim", async (c) => {
    const caller = requireDevice(c);
    const claim = deps.service.claimNext(
      { tenantId: caller.tenantId, deviceId: caller.deviceId },
      Date.now(),
    );
    if (claim === null) return c.json({ task: null });
    return c.json({
      task: taskView(claim.task),
      lease: claim.lease,
      ...(claim.previousOutcomeUnknown ? { previousOutcomeUnknown: true } : {}),
    });
  });

  app.post("/tasks/:taskId/status", async (c) => {
    const caller = requireDevice(c);
    const body = await readJson(c);
    const leaseEpoch = requireInt(body, "leaseEpoch");
    const taskId = c.req.param("taskId") ?? "";
    let task: ExchangeTaskRow;
    if (body.ackCancelVersion !== undefined) {
      task = deps.service.updateStatus(
        { tenantId: caller.tenantId, deviceId: caller.deviceId },
        taskId,
        { leaseEpoch, ackCancelVersion: requireInt(body, "ackCancelVersion") },
        Date.now(),
      );
    } else {
      if (body.status !== "running") {
        throw new HttpError(400, "bad_request", "status must be \"running\" (terminal outcomes go through /result).");
      }
      task = deps.service.updateStatus(
        { tenantId: caller.tenantId, deviceId: caller.deviceId },
        taskId,
        { leaseEpoch, status: "running" },
        Date.now(),
      );
    }
    return c.json({ task: taskView(task) });
  });

  app.post('/tasks/:taskId/heartbeat', async c => {
    const caller = requireDevice(c);
    const body = await readJson(c);
    const task = deps.service.heartbeat(caller, c.req.param('taskId'), requireInt(body, 'leaseEpoch'), Date.now());
    return c.json({ task: taskView(task), lease: { epoch: task.leaseEpoch, expiresAt: task.leaseExpiresAt } });
  });

  app.post("/tasks/:taskId/result", async (c) => {
    const caller = requireDevice(c);
    const body = await readJson(c);
    const outcome = body.outcome;
    if (outcome !== "succeeded" && outcome !== "failed") {
      throw new HttpError(400, "bad_request", "outcome must be succeeded or failed.");
    }
    const summary = body.summary ?? {};
    const evidenceIndex = body.evidenceIndex ?? {};
    const extraFields = body.extraFields ?? undefined;
    const { task, applied } = deps.service.submitResult(
      { tenantId: caller.tenantId, deviceId: caller.deviceId },
      c.req.param("taskId") ?? "",
      {
        leaseEpoch: requireInt(body, "leaseEpoch"),
        outcome,
        summary: asObject(summary, "summary"),
        evidenceIndex: asObject(evidenceIndex, "evidenceIndex"),
        ...(extraFields !== undefined ? { extraFields: asObject(extraFields, "extraFields") } : {}),
        synthetic: body.synthetic !== false, // results are synthetic-marked unless a real executor explicitly denies it
        sanitizedError: typeof body.sanitizedError === "string" ? body.sanitizedError : undefined,
      },
      Date.now(),
    );
    return c.json({ task: taskView(task), applied }, applied ? 201 : 200);
  });

  return app;
}

async function deviceUserOf(
  deps: ExchangeRouteDeps,
  tenantId: string,
  deviceId: string,
): Promise<string> {
  const device = deps.store.findDevice(tenantId, deviceId);
  if (!device || device.revokedAt !== null) {
    throw new HttpError(422, "unknown_device", `No active device: ${deviceId}`);
  }
  return device.userId;
}

export function exchangeManagementRoutes(deps: ExchangeRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/devices", async (c) => {
    const user = c.var.user;
    const body = await readJson(c);
    const platformId = requireString_(body, "platformId");
    const label = typeof body.label === "string" ? body.label.slice(0, 200) : "";
    const platform = deps.store.findPlatform("local", platformId);
    if (!platform || platform.revokedAt !== null) {
      throw new HttpError(422, "unknown_platform", `No platform: ${platformId}`);
    }
    const deviceId = newExchangeId("dev");
    const { token, tokenHash } = mintToken("dev");
    const now = new Date().toISOString();
    const row: ExchangeDeviceRow = {
      deviceId,
      tenantId: "local",
      userId: user.userId,
      platformId,
      tokenHash,
      label,
      registeredAt: now,
      revokedAt: null,
      lastSeenAt: null,
    };
    deps.store.insertDevice(row);
    return c.json({ device: deviceView(row), token }, 201); // token shown ONCE
  });

  app.get("/devices", async (c) => {
    const user = c.var.user;
    const rows = deps.store.listDevices("local", user.userId);
    return c.json({ devices: rows.map(deviceView) });
  });

  app.delete("/devices/:deviceId", async (c) => {
    const user = c.var.user;
    const deviceId = c.req.param("deviceId") ?? "";
    const device = deps.store.findDevice("local", deviceId);
    if (!device || device.userId !== user.userId) {
      throw new HttpError(404, "device_not_found", `No device: ${deviceId}`);
    }
    const ok = deps.store.revokeDevice("local", deviceId, new Date().toISOString());
    return c.json({ revoked: ok });
  });

  app.post("/platforms", async (c) => {
    if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "Only an admin registers platforms.");
    const body = await readJson(c);
    const platformId = requireString_(body, "platformId");
    if (deps.store.findPlatform("local", platformId) !== null) {
      throw new HttpError(409, "platform_exists", `Platform exists: ${platformId}`);
    }
    const { token, tokenHash } = mintToken("plat");
    const now = new Date().toISOString();
    deps.store.insertPlatform({
      tenantId: "local",
      platformId,
      tokenHash,
      registeredAt: now,
      revokedAt: null,
    });
    return c.json({ platformId, token }, 201); // token shown ONCE
  });

  app.delete("/platforms/:platformId", async (c) => {
    if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "Only an admin revokes platforms.");
    const platformId = c.req.param("platformId") ?? "";
    const ok = deps.store.revokePlatform("local", platformId, new Date().toISOString());
    return c.json({ revoked: ok });
  });

  app.post("/callback-hosts", async (c) => {
    if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "Only an admin allowlists callback hosts.");
    const body = await readJson(c);
    const host = requireString_(body, "host", 253).toLowerCase();
    deps.store.insertAllowedHost(host, c.var.user.userId, new Date().toISOString());
    return c.json({ hosts: deps.store.listAllowedHosts().map((h) => h.host) }, 201);
  });

  app.get("/callback-hosts", async (c) => {
    if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "Only an admin reads the callback allowlist.");
    return c.json({ hosts: deps.store.listAllowedHosts().map((h) => h.host) });
  });

  return app;
}

function requireInt(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new HttpError(400, "bad_request", `${key} must be an integer.`);
  }
  return v;
}

function asObject(v: unknown, key: string): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new HttpError(400, "bad_request", `${key} must be an object.`);
  }
  return v as Record<string, unknown>;
}

@Component({
  contributes: {
    "HttpModule.routes": [
      { id: "ExchangeTokenRoutes.routes", prefix: "/api/exchange/v1", auth: "none", order: 210 },
      {
        id: "ExchangeTokenRoutes.management",
        prefix: "/api/exchange-management/v1",
        auth: "user",
        order: 211,
      },
    ],
  },
})
export class TaskExchangeRoutes {
  @Use() private readonly config!: Config;
  @Use() private readonly store!: TaskExchangeStore;
  @Use() private readonly service!: ExchangeTasks;
  @Bind("ExchangeTokenRoutes.routes") routes!: Hono<AppEnv>;
  @Bind("ExchangeTokenRoutes.management") management!: Hono<AppEnv>;
  setup() {
    const deps: ExchangeRouteDeps = { config: this.config, store: this.store, service: this.service };
    this.routes = exchangeTokenRoutes(deps);
    this.management = exchangeManagementRoutes(deps);
  }
}

// Re-exported for the module wiring (mechanisms are what the tree resolves).
export { sha256Hex };
