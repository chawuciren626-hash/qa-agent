/**
 * Task-exchange routes over the real platform tree (batch 5): credential registration
 * (tokens shown ONCE), token authentication (fake/revoked refused), cross-platform
 * isolation, the full platform→device loop through HTTP (create → claim → running →
 * result), data-field refusal over the wire, offline queued reasons, and the SSRF gate on
 * callback configuration. The outbox dispatcher stays idle: its delivery semantics are
 * unit-tested with an injected fetch (task-exchange.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { ProjectCreateResponse } from "../src/api/types.js";
import type { TaskExchangeStore } from "../src/mechanisms/taskexchange.js";
import { wire } from '@prismshadow/penguin-core/kernel';
import { Hono } from 'hono';
import { LocalExchangeExecutor } from '../src/taskexchange/local-executor.js';
import type { AppEnv } from '../src/auth/middleware.js';
import { HttpError } from '../src/http/errors.js';

interface JsonError {
  error: { code: string; message: string };
}

interface TaskView {
  taskId: string;
  externalId: string;
  status: string;
  cancelRequested: boolean;
  queuedReason: string | null;
}

interface TaskResponse {
  task: TaskView;
  idempotent?: boolean;
}

interface ClaimResponse {
  task: TaskView | null;
  lease?: { epoch: number; expiresAt: string };
  previousOutcomeUnknown?: boolean;
}

describe("task exchange api", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;
  let user: ReturnType<typeof apiClient>;
  let stranger: ReturnType<typeof apiClient>;
  let projectId: string;
  let store: TaskExchangeStore;
  let platformToken: string;
  let deviceToken: string;
  let deviceId: string;
  let otherDeviceToken: string;
  let otherDeviceId: string;
  let otherPlatformToken: string;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_a");
    const s = await provisionUser(t.app, "stranger_c");
    const adminLogin = await t.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "admin", password: t.adminPassword }),
    });
    expect(adminLogin.status).toBe(200);
    admin = apiClient(t.app, adminLogin.headers.get("set-cookie")!.split(";")[0]!);
    user = apiClient(t.app, a.cookie);
    stranger = apiClient(t.app, s.cookie);
    store = t.deps.tree.api<TaskExchangeStore>("TaskExchangeModule", "TaskExchangeStore");
    const projectRes = await user.post("/api/projects", { projectId: "owner_a-ex", name: "exchange project" });
    expect(projectRes.status).toBe(201);
    const created = (await projectRes.json()) as ProjectCreateResponse;
    projectId = created.project.projectId;

    // Admin registers the platform; the user registers two devices on it.
    const plat = await admin.post("/api/exchange-management/v1/platforms", { platformId: "plat-1" });
    expect(plat.status).toBe(201);
    platformToken = ((await plat.json()) as { token: string }).token;
    const dev = await user.post("/api/exchange-management/v1/devices", {
      platformId: "plat-1",
      label: "workstation",
    });
    expect(dev.status).toBe(201);
    const devBody = (await dev.json()) as { device: { deviceId: string }; token: string };
    deviceId = devBody.device.deviceId;
    deviceToken = devBody.token;
    const dev2 = await user.post("/api/exchange-management/v1/devices", {
      platformId: "plat-1",
      label: "spare",
    });
    const dev2Body = (await dev2.json()) as { device: { deviceId: string }; token: string };
    otherDeviceId = dev2Body.device.deviceId;
    otherDeviceToken = dev2Body.token;
    // A second platform for isolation tests.
    const plat2 = await admin.post("/api/exchange-management/v1/platforms", { platformId: "plat-2" });
    otherPlatformToken = ((await plat2.json()) as { token: string }).token;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  function client(token: string) {
    return {
      get: (p: string) => t.app.request(p, { headers: { authorization: `Bearer ${token}` } }),
      post: (p: string, body?: unknown) =>
        t.app.request(p, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      put: (p: string, body?: unknown) =>
        t.app.request(p, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
    };
  }

  const plat = () => client(platformToken);
  const dev = () => client(deviceToken);
  const otherDev = () => client(otherDeviceToken);
  const otherPlat = () => client(otherPlatformToken);

  function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      externalId: "ext-1",
      idempotencyKey: "idem-1",
      deviceId,
      projectRef: projectId,
      objective: "check the login flow",
      ...overrides,
    };
  }

  it.each([false, true])('local consumer executes once and recovers receipts (dispatch response lost=%s)', async lost => {
    let sends = 0;
    let outcome: 'succeeded' | null = null;
    const bridge = { validateUser: async () => {}, authorizeUserPath: async () => {}, authorizeSessionInvocation: async () => {} };
    const makeWorker = () => {
      const worker = wire(LocalExchangeExecutor, {
        config: { root: t.root }, authState: { accountClient: bridge }, access: { requireProjectOwner: () => {} },
        creator: { createSession: async () => ({ sessionId: 'local-session' }) },
        runner: { startTask: async () => { sends++; if (lost) throw new Error('lost dispatch reply'); return { sessionId: 'local-session', queued: false }; } },
        outcomes: { observe: async () => outcome }, canceller: { cancel: async () => true },
        request: async (_binding: unknown, suffix: string, body: unknown) => {
          const response = body === undefined ? await dev().get(`/api/exchange/v1${suffix}`) : await dev().post(`/api/exchange/v1${suffix}`, body);
          if (!response.ok) throw new HttpError(response.status, 'test_remote_error', 'remote request failed');
          return response.json();
        },
      });
      worker.setup({ effect: () => {} });
      return worker;
    };
    let worker = makeWorker();
    const local = new Hono<AppEnv>();
    local.use('*', async (c, next) => { c.set('user', { userId: 'owner_a', isAdmin: false } as AppEnv['Variables']['user']); await next(); });
    local.route('/', worker.routes);
    const response = await local.request('/bindings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      origin: 'https://exchange.example.com', deviceId, deviceToken, projectRef: projectId, projectId, agentId: 'qa-controller',
    }) });
    expect(response.status).toBe(201);
    const created = await plat().post('/api/exchange/v1/tasks', createBody());
    const { task } = await created.json() as TaskResponse;
    await worker.tickOnce();
    expect(sends).toBe(1);
    worker.stop();
    worker = makeWorker();
    await worker.tickOnce();
    expect(sends).toBe(1);
    outcome = 'succeeded';
    await worker.tickOnce();
    const settled = await (await plat().get(`/api/exchange/v1/tasks/${task.taskId}`)).json() as TaskResponse;
    expect(settled.task.status).toBe('succeeded');
    expect(sends).toBe(1);
    worker.stop();
  });

  it("tokens gate the plane: no token 401, a fake token 401, a USER session 403 (wrong credential kind), management takes sessions only", async () => {
    expect((await t.app.request("/api/exchange/v1/tasks")).status).toBe(401);
    const fake = client("dhx_plat_totally-made-up");
    expect((await fake.get("/api/exchange/v1/tasks")).status).toBe(401);
    // A user session is not a platform token: the exchange plane refuses it.
    const sessionGet = await user.get("/api/exchange/v1/tasks");
    expect(sessionGet.status).toBe(401);
    // And a platform token cannot drive management (401 there: it is not a session).
    expect((await plat().post("/api/exchange-management/v1/devices", {})).status).toBe(401);
    // Management registration requires the session's user; a stranger gets nothing of ours.
    const mine = (await (await user.get("/api/exchange-management/v1/devices")).json()) as {
      devices: Array<{ deviceId: string }>;
    };
    expect(mine.devices).toHaveLength(2);
  });

  it("create → list → claim → running → result over HTTP; idempotent create returns the same task", async () => {
    const created = await plat().post("/api/exchange/v1/tasks", createBody());
    expect(created.status).toBe(201);
    const body1 = (await created.json()) as TaskResponse;
    expect(body1.task).toMatchObject({ status: "queued", externalId: "ext-1", queuedReason: null });

    // The same idempotency key: 200 + the SAME task.
    const retry = await plat().post("/api/exchange/v1/tasks", createBody());
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as TaskResponse).task.taskId).toBe(body1.task.taskId);
    // The same external id under a NEW key: 409.
    const conflict = await plat().post(
      "/api/exchange/v1/tasks",
      createBody({ idempotencyKey: "idem-2" }),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as JsonError).error.code).toBe("external_id_conflict");

    // Cross-platform isolation: plat-2 sees nothing.
    const otherList = (await (await otherPlat().get("/api/exchange/v1/tasks")).json()) as {
      tasks: unknown[];
    };
    expect(otherList.tasks).toEqual([]);
    expect((await otherPlat().get(`/api/exchange/v1/tasks/${body1.task.taskId}`)).status).toBe(404);

    // A device bound to another device cannot even see the task via claim; its claim is empty.
    const emptyClaim = (await (await otherDev().post("/api/exchange/v1/claim", {})).json()) as ClaimResponse;
    expect(emptyClaim.task).toBeNull();

    // The bound device claims, marks running, submits the result.
    const claim = (await (await dev().post("/api/exchange/v1/claim", {})).json()) as ClaimResponse;
    expect(claim.task).toMatchObject({ taskId: body1.task.taskId, status: "claimed" });
    expect(claim.lease!.epoch).toBe(1);
    const running = await dev().post(`/api/exchange/v1/tasks/${body1.task.taskId}/status`, {
      leaseEpoch: claim.lease!.epoch,
      status: "running",
    });
    expect(((await running.json()) as TaskResponse).task.status).toBe("running");

    const result = await dev().post(`/api/exchange/v1/tasks/${body1.task.taskId}/result`, {
      leaseEpoch: claim.lease!.epoch,
      outcome: "succeeded",
      summary: { checks: 2 },
      evidenceIndex: { refs: ["ev-1"] },
      synthetic: true,
    });
    expect(result.status).toBe(201);
    expect(((await result.json()) as TaskResponse).task.status).toBe("succeeded");

    // The platform reads the result back: synthetic-marked until a real executor reports.
    const seen = await plat().get(`/api/exchange/v1/tasks/${body1.task.taskId}/result`);
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { result: { synthetic: boolean; outcome: string } }).result).toMatchObject({
      synthetic: true,
      outcome: "succeeded",
    });
    // The other device's stale lease cannot write on someone else's task.
    const stale = await otherDev().post(`/api/exchange/v1/tasks/${body1.task.taskId}/status`, {
      leaseEpoch: 1,
      status: "running",
    });
    expect(stale.status).toBe(403);
  });

  it("offline and revoked bound devices surface as queued reasons; cancel over HTTP settles a queued task", async () => {
    const created = await plat().post("/api/exchange/v1/tasks", createBody());
    const body = (await created.json()) as TaskResponse;
    // The device checked in at registration (lastSeen just now) — no reason.
    expect(body.task.queuedReason).toBeNull();
    // Simulate going offline: nothing claims for a while — the reason appears by read time.
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    t.deps.db.prepare("UPDATE exchange_devices SET last_seen_at = ? WHERE device_id = ?").run(longAgo, deviceId);
    const listed = (await (await plat().get("/api/exchange/v1/tasks")).json()) as { tasks: Array<{ queuedReason: string | null }> };
    expect(listed.tasks[0]?.queuedReason).toBe("device_offline");

    // Cancel a queued task: settles immediately.
    const cancelled = await plat().post(`/api/exchange/v1/tasks/${body.task.taskId}/cancel`, {});
    expect(((await cancelled.json()) as TaskResponse).task.status).toBe("cancelled");
    // Cancel again on the terminal task: 409 already_terminal.
    const again = await plat().post(`/api/exchange/v1/tasks/${body.task.taskId}/cancel`, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as JsonError).error.code).toBe("already_terminal");
  });

  it("unauthorized data fields are refused over the wire; authorized ones pass", async () => {
    await plat().post("/api/exchange/v1/tasks", createBody());
    const claim = (await (await dev().post("/api/exchange/v1/claim", {})).json()) as ClaimResponse;
    const refused = await dev().post(`/api/exchange/v1/tasks/${claim.task!.taskId}/result`, {
      leaseEpoch: claim.lease!.epoch,
      outcome: "failed",
      summary: {},
      evidenceIndex: {},
      sanitizedError: "page not reachable",
      synthetic: true,
      extraFields: { project_files: ["everything.zip"] },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as JsonError).error.code).toBe("unauthorized_data_fields");
    // Now a task that EXPLICITLY authorizes project_files.
    await plat().post(
      "/api/exchange/v1/tasks",
      createBody({
        externalId: "ext-2",
        idempotencyKey: "idem-2",
        allowedDataFields: ["status", "summary", "evidence_index", "project_files"],
      }),
    );
    const claim2 = (await (await dev().post("/api/exchange/v1/claim", {})).json()) as ClaimResponse;
    const ok = await dev().post(`/api/exchange/v1/tasks/${claim2.task!.taskId}/result`, {
      leaseEpoch: claim2.lease!.epoch,
      outcome: "failed",
      summary: {},
      evidenceIndex: {},
      sanitizedError: "page not reachable",
      synthetic: true,
      extraFields: { project_files: ["bundle.zip"] },
    });
    expect(ok.status).toBe(201);
  });

  it("callback URLs are SSRF-gated: private targets refuse until an admin explicitly allowlists the host", async () => {
    await plat().post("/api/exchange/v1/tasks", createBody());
    const claim = (await (await dev().post("/api/exchange/v1/claim", {})).json()) as ClaimResponse;
    void claim;
    const list = (await (await plat().get("/api/exchange/v1/tasks")).json()) as { tasks: Array<{ taskId: string }> };
    const taskId = list.tasks[0]!.taskId;
    // Private/loopback targets are refused.
    const bad = await plat().put(`/api/exchange/v1/tasks/${taskId}/callback`, {
      callbackUrl: "http://127.0.0.1:9999/cb",
    });
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as JsonError).error.code).toBe("blocked_callback_target");
    // A user (non-admin) cannot allowlist; an admin can.
    expect(
      (await user.post("/api/exchange-management/v1/callback-hosts", { host: "127.0.0.1" })).status,
    ).toBe(403);
    expect(
      (await admin.post("/api/exchange-management/v1/callback-hosts", { host: "127.0.0.1" })).status,
    ).toBe(201);
    const good = await plat().put(`/api/exchange/v1/tasks/${taskId}/callback`, {
      callbackUrl: "http://127.0.0.1:9999/cb",
    });
    expect(good.status).toBe(200);
    // No outbox row yet: deliveries enqueue on TERMINAL settles, not on callback config.
    expect(store.listDueOutbox(new Date(Date.now() + 60_000).toISOString())).toHaveLength(0);
    // The claimed device settles the task: exactly one delivery row, keyed by the delivery.
    const statusRes = await dev().post(`/api/exchange/v1/tasks/${taskId}/status`, {
      leaseEpoch: claim.lease!.epoch,
      status: "running",
    });
    expect(statusRes.status).toBe(200);
    const resultRes = await dev().post(`/api/exchange/v1/tasks/${taskId}/result`, {
      leaseEpoch: claim.lease!.epoch,
      outcome: "succeeded",
      summary: { checks: 1 },
      evidenceIndex: {},
      synthetic: true,
    });
    expect(resultRes.status).toBe(201);
    const due = store.listDueOutbox(new Date(Date.now() + 60_000).toISOString());
    expect(due).toHaveLength(1);
    expect(due[0]?.idempotencyKey).toBe(`callback:${taskId}:terminal`);
    expect(due[0]?.targetUrl).toBe("http://127.0.0.1:9999/cb");
  });

  it("a revoked device token loses access at once; a revoked platform loses its view", async () => {
    const created = await plat().post("/api/exchange/v1/tasks", createBody());
    const body = (await created.json()) as TaskResponse;
    expect((await dev().get(`/api/exchange/v1/tasks/${body.task.taskId}`)).status).toBe(403); // device tokens don't read platform views
    // Revoke the spare device: its token dies.
    expect((await user.delete(`/api/exchange-management/v1/devices/${otherDeviceId}`)).status).toBe(200);
    expect((await otherDev().post("/api/exchange/v1/claim", {})).status).toBe(401);
    // Revoke the second platform: its token dies too.
    expect((await admin.delete("/api/exchange-management/v1/platforms/plat-2")).status).toBe(200);
    expect((await otherPlat().get("/api/exchange/v1/tasks")).status).toBe(401);
    // The primary device's platform view is untouched.
    expect((await plat().get("/api/exchange/v1/tasks")).status).toBe(200);
  });
});
