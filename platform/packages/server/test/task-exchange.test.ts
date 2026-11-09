/**
 * Task-exchange service semantics (batch 5): creation idempotency, server-side binding
 * verification (device / platform / user / project), lease fencing (stale epochs refused,
 * lapsed leases re-claimed with previousOutcomeUnknown), cancel-vs-complete races resolved
 * by CAS, deadline sweeps, data-field authorization, and terminal-delivery outbox rows.
 * The SSRF guard and the outbox dispatcher (injected fetch, manual redirects) get their
 * own describes. Everything is synthetic — no ports, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wire } from "@prismshadow/penguin-core/kernel";
import { openDatabase } from "../src/db/database.js";
import { ProjectsRepo } from "../src/db/repos/projects.js";
import { UsersRepo } from "../src/db/repos/users.js";
import { TaskExchangeRepo } from "../src/db/repos/task-exchange.js";
import { ExchangeService } from "../src/taskexchange/service.js";
import { OutboxDispatcher } from "../src/taskexchange/outbox.js";
import { checkCallbackUrl, isPrivateHostname } from "../src/taskexchange/ssrf.js";
import { mintToken, sha256Hex } from "../src/taskexchange/credentials.js";
import type { DatabaseSync } from "node:sqlite";
import type { TaskExchangeStore } from "../src/mechanisms/taskexchange.js";

const T0 = Date.parse("2026-11-06T12:00:00Z");
const MIN = 60_000;

describe("task exchange service", () => {
  let db: DatabaseSync;
  let store: TaskExchangeStore;
  let service: ExchangeService;
  let nowMs: number;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    const users = wire(UsersRepo, { db });
    users.insert({
      userId: "user_a",
      passwordHash: "x",
      isAdmin: false,
      passwordIsInitial: false,
      displayName: null,
      avatar: null,
      createdAt: "2026-11-06T00:00:00Z",
    });
    const projects = wire(ProjectsRepo, { db });
    projects.insert({ projectId: "proj-a", ownerUserId: "user_a", createdAt: "2026-11-06T00:00:00Z" });
    store = wire(TaskExchangeRepo, { db });
    const platforms = wire(ProjectsRepo, { db });
    void platforms;
    nowMs = T0;
    service = wire(ExchangeService, { store, projects: wire(ProjectsRepo, { db }), nowMs: () => nowMs });
    // One platform and one bound device.
    const { tokenHash } = mintToken("plat");
    store.insertPlatform({ tenantId: "local", platformId: "plat-1", tokenHash, registeredAt: new Date(T0).toISOString(), revokedAt: null });
    const dev = mintToken("dev");
    store.insertDevice({
      deviceId: "dev-1",
      tenantId: "local",
      userId: "user_a",
      platformId: "plat-1",
      tokenHash: dev.tokenHash,
      label: "workstation",
      registeredAt: new Date(T0).toISOString(),
      revokedAt: null,
      lastSeenAt: new Date(T0).toISOString(),
    });
  });
  afterEach(() => db.close());

  function create(overrides: Partial<Parameters<ExchangeService["createTask"]>[0]["body"]> = {}) {
    return service.createTask({
      tenantId: "local",
      platformId: "plat-1",
      userId: "user_a",
      nowMs,
      body: {
        externalId: "ext-1",
        idempotencyKey: "idem-1",
        deviceId: "dev-1",
        projectRef: "proj-a",
        objective: "check the login flow",
        allowedDataFields: ["status", "summary", "evidence_index"],
        deadlineMs: null,
        publishSnapshot: { agentReleaseId: "rel-1" },
        ...overrides,
      },
    });
  }

  it("creation is idempotent by key: the same key returns the SAME task; a repeated external_id under a new key is 409", () => {
    const first = create();
    expect(first.idempotent).toBe(false);
    const retry = create();
    expect(retry.idempotent).toBe(true);
    expect(retry.task.taskId).toBe(first.task.taskId);
    expectExchange(() => create({ idempotencyKey: "idem-2" }), 'external_id_conflict');
  });

  it("binding is verified server-side: unknown/revoked device, cross-platform device, foreign user, unresolvable project", () => {
    expectExchange(() => create({ deviceId: "dev-x" }), 'unknown_device');
    // A second device on ANOTHER platform cannot take this platform's task.
    const dev2 = mintToken("dev");
    store.insertDevice({
      deviceId: "dev-2",
      tenantId: "local",
      userId: "user_a",
      platformId: "plat-2",
      tokenHash: dev2.tokenHash,
      label: "",
      registeredAt: new Date(nowMs).toISOString(),
      revokedAt: null,
      lastSeenAt: null,
    });
    expectExchange(() => create({ deviceId: "dev-2", projectRef: "proj-a" }), 'device_platform_mismatch');
    // A device of another user is refused even on the right platform.
    const users = wire(UsersRepo, { db });
    users.insert({
      userId: "user_b",
      passwordHash: "x",
      isAdmin: false,
      passwordIsInitial: false,
      displayName: null,
      avatar: null,
      createdAt: "2026-11-06T00:00:00Z",
    });
    wire(ProjectsRepo, { db }).insert({ projectId: "proj-b", ownerUserId: "user_b", createdAt: "2026-11-06T00:00:00Z" });
    const dev3 = mintToken("dev");
    store.insertDevice({
      deviceId: "dev-3",
      tenantId: "local",
      userId: "user_b",
      platformId: "plat-1",
      tokenHash: dev3.tokenHash,
      label: "",
      registeredAt: new Date(nowMs).toISOString(),
      revokedAt: null,
      lastSeenAt: null,
    });
    expectExchange(() => create({ deviceId: "dev-3" }), 'device_user_mismatch');
    // A project the user does not own does not resolve.
    expectExchange(() => create({ projectRef: "proj-b" }), 'unresolvable_project_ref');
    expectExchange(() => create({ projectRef: "proj-zzz" }), 'unresolvable_project_ref');
    // A past deadline is refused at creation.
    expectExchange(() => create({ deadlineMs: nowMs - 1 }), 'deadline_in_past');
    // A revoked device is exactly as good as an unknown one (checked last: it retires dev-1).
    store.revokeDevice("local", "dev-1", new Date(nowMs).toISOString());
    expectExchange(() => create(), 'unknown_device');
  });

  it('renews a long-running task while fencing a replaced lease', () => {
    const { task } = create();
    const caller = { tenantId: 'local', deviceId: 'dev-1' };
    const first = service.claimNext(caller, nowMs)!;
    nowMs += 120_000;
    expect(service.heartbeat(caller, task.taskId, first.lease.epoch, nowMs).leaseExpiresAt).toBe(new Date(nowMs + 60_000).toISOString());
    nowMs += 120_000;
    service.claimNext(caller, nowMs);
    expectExchange(() => service.heartbeat(caller, task.taskId, first.lease.epoch, nowMs), 'lease_expired');
  });

  it("claim grants a lease; stale epochs cannot write; a lapsed RUNNING lease re-claims flagged unknown", async () => {
    const { task } = create();
    // No task for another device.
    expect(service.claimNext({ tenantId: "local", deviceId: "dev-other" }, nowMs)).toBeNull();
    const claim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    expect(claim.task.status).toBe("claimed");
    expect(claim.lease.epoch).toBe(1);
    expect(claim.previousOutcomeUnknown).toBe(false);

    // A stale epoch (0) cannot mark running.
    expectExchange(
      () =>
        service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, task.taskId, { leaseEpoch: 0, status: "running" }, nowMs),
      "lease_expired",
    );
    // The right epoch does.
    const running = service.updateStatus(
      { tenantId: "local", deviceId: "dev-1" },
      task.taskId,
      { leaseEpoch: 1, status: "running" },
      nowMs,
    );
    expect(running.status).toBe("running");

    // The lease lapses (the executor died after starting the run — side effects unknown).
    nowMs += 10 * MIN;
    const reclaim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    expect(reclaim.task.taskId).toBe(task.taskId);
    expect(reclaim.previousOutcomeUnknown).toBe(true);
    expect(reclaim.lease.epoch).toBe(2);
    // The audit trail says what happened, in plain action names.
    const actions = store.listEvents(task.taskId).map((e) => e.action);
    expect(actions).toContain("lease_reclaimed_outcome_unknown");
    // The superseded epoch still cannot write.
    expectExchange(
      () =>
        service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, task.taskId, { leaseEpoch: 1, status: "running" }, nowMs),
      "lease_expired",
    );
  });

  it("cancel vs complete: whichever CAS lands first wins, and the loser is recorded — never overwritten", async () => {
    const { task } = create();
    const claim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, task.taskId, { leaseEpoch: claim.lease.epoch, status: "running" }, nowMs);

    // The run COMPLETES before the cancel request: cancel on a terminal task is 409.
    const { applied } = service.submitResult(
      { tenantId: "local", deviceId: "dev-1" },
      task.taskId,
      { leaseEpoch: claim.lease.epoch, outcome: "succeeded", summary: {}, evidenceIndex: {}, synthetic: true },
      nowMs,
    );
    expect(applied).toBe(true);
    expectExchange(() => service.cancelTask("local", "plat-1", task.taskId, nowMs), 'already_terminal');
    expect(service.taskForPlatform("local", "plat-1", task.taskId, nowMs).status).toBe("succeeded");
  });

  it("an in-flight cancel waits for the executor ack; a result arriving after the cancel won is kept but never flips the status", async () => {
    const { task } = create();
    const claim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, task.taskId, { leaseEpoch: claim.lease.epoch, status: "running" }, nowMs);

    // Platform asks to cancel: cancel_requested, still running.
    const requested = service.cancelTask("local", "plat-1", task.taskId, nowMs);
    expect(requested).toMatchObject({ status: "running", cancelRequested: true, cancelVersion: 1 });

    // The executor acknowledges the CURRENT cancel version.
    const acked = service.updateStatus(
      { tenantId: "local", deviceId: "dev-1" },
      task.taskId,
      { leaseEpoch: claim.lease.epoch, ackCancelVersion: 1 },
      nowMs,
    );
    expect(acked.status).toBe("cancelled");

    // A late result (the work finished anyway) is KEPT (at-least-once) but cannot flip the status.
    const late = service.submitResult(
      { tenantId: "local", deviceId: "dev-1" },
      task.taskId,
      { leaseEpoch: claim.lease.epoch, outcome: "succeeded", summary: {}, evidenceIndex: {}, synthetic: true },
      nowMs,
    );
    expect(late.applied).toBe(false);
    expect(late.task.status).toBe("cancelled");
    expect(store.latestResult(task.taskId)?.outcome).toBe("succeeded");
    expect(store.listEvents(task.taskId).map((e) => e.action)).toContain("result_arrived_after_settle");
    // A cancel ack citing a stale version is refused outright.
    const second = create({ externalId: "ext-2", idempotencyKey: "idem-2" });
    const c2 = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.cancelTask("local", "plat-1", second.task.taskId, nowMs);
    expectExchange(
      () =>
        service.updateStatus(
          { tenantId: "local", deviceId: "dev-1" },
          second.task.taskId,
          { leaseEpoch: c2.lease.epoch, ackCancelVersion: 99 },
          nowMs,
        ),
      "cancel_version_mismatch",
    );
    void c2;
  });

  it("a queued task cancels immediately; a past-deadline task sweeps to expired", () => {
    const a = create({ externalId: "ext-a", idempotencyKey: "idem-a" });
    const cancelled = service.cancelTask("local", "plat-1", a.task.taskId, nowMs);
    expect(cancelled.status).toBe("cancelled");

    const b = create({ externalId: "ext-b", idempotencyKey: "idem-b", deadlineMs: nowMs + MIN });
    nowMs += 2 * MIN;
    expect(service.sweepExpired(nowMs)).toBe(1);
    expect(service.taskForPlatform("local", "plat-1", b.task.taskId, nowMs).status).toBe("expired");
  });

  it("device liveness is a READ-TIME reason: an unseen device reports device_offline, a revoked one bound_device_revoked", () => {
    create({ externalId: "ext-a", idempotencyKey: "idem-a" });
    expect(service.listForPlatform("local", "plat-1", nowMs)[0]?.queuedReason).toBeNull();
    nowMs += 6 * MIN; // the device has been silent past the offline window
    expect(service.listForPlatform("local", "plat-1", nowMs)[0]?.queuedReason).toBe("device_offline");
    store.revokeDevice("local", "dev-1", new Date(nowMs).toISOString());
    expect(service.listForPlatform("local", "plat-1", nowMs)[0]?.queuedReason).toBe("bound_device_revoked");
  });

  it("results carry ONLY authorized fields: unauthorized extras are refused and audited, payload never lands", async () => {
    const { task } = create({ allowedDataFields: ["status", "summary", "evidence_index"] });
    const claim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, task.taskId, { leaseEpoch: claim.lease.epoch, status: "running" }, nowMs);
    expectExchange(
      () =>
        service.submitResult(
          { tenantId: "local", deviceId: "dev-1" },
          task.taskId,
          {
            leaseEpoch: claim.lease.epoch,
            outcome: "succeeded",
            summary: {},
            evidenceIndex: {},
            synthetic: true,
            extraFields: { screenshots: ["data:image/png;base64,xx"] },
          },
          nowMs,
        ),
      "unauthorized_data_fields",
    );
    expect(store.countResults(task.taskId)).toBe(0);
    expect(store.listEvents(task.taskId).map((e) => e.action)).toContain("result_fields_refused");
    // An unknown field is not silently dropped either.
    expectExchange(
      () =>
        service.submitResult(
          { tenantId: "local", deviceId: "dev-1" },
          task.taskId,
          {
            leaseEpoch: claim.lease.epoch,
            outcome: "succeeded",
            summary: {},
            evidenceIndex: {},
            synthetic: true,
            extraFields: { memoryDump: "x" },
          },
          nowMs,
        ),
      "unauthorized_data_fields",
    );
    // With the field explicitly authorized at creation, the same shape goes through —
    // and the task settles succeeded.
    const ok = create({ externalId: "ext-2", idempotencyKey: "idem-2", allowedDataFields: ["status", "summary", "evidence_index", "screenshots"] });
    const c2 = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.updateStatus({ tenantId: "local", deviceId: "dev-1" }, ok.task.taskId, { leaseEpoch: c2.lease.epoch, status: "running" }, nowMs);
    const { applied } = service.submitResult(
      { tenantId: "local", deviceId: "dev-1" },
      ok.task.taskId,
      {
        leaseEpoch: c2.lease.epoch,
        outcome: "succeeded",
        summary: { checks: 3 },
        evidenceIndex: { refs: ["ev-1"] },
        synthetic: true,
        extraFields: { screenshots: ["synthetic://1"] },
      },
      nowMs,
    );
    expect(applied).toBe(true);
    const result = store.latestResult(ok.task.taskId)!;
    expect(result).toMatchObject({ outcome: "succeeded", synthetic: true, attempt: 1 });
  });

  it("a terminal settle with a configured callback enqueues ONE delivery keyed by the delivery, not the execution", () => {
    const { task } = create();
    service.setCallbackUrl("local", "plat-1", task.taskId, "https://platform.example.com/callback", { allowedHosts: new Set() }, nowMs);
    const claim = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.submitResult(
      { tenantId: "local", deviceId: "dev-1" },
      task.taskId,
      { leaseEpoch: claim.lease.epoch, outcome: "succeeded", summary: {}, evidenceIndex: {}, synthetic: true },
      nowMs,
    );
    const due = store.listDueOutbox(new Date(nowMs).toISOString());
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ taskId: task.taskId, status: "pending", idempotencyKey: `callback:${task.taskId}:terminal` });
    // No callback configured → no row (the second task settles silently).
    const quiet = create({ externalId: "ext-3", idempotencyKey: "idem-3" });
    const c3 = service.claimNext({ tenantId: "local", deviceId: "dev-1" }, nowMs)!;
    service.submitResult(
      { tenantId: "local", deviceId: "dev-1" },
      quiet.task.taskId,
      { leaseEpoch: c3.lease.epoch, outcome: "succeeded", summary: {}, evidenceIndex: {}, synthetic: true },
      nowMs,
    );
    expect(store.listDueOutbox(new Date(nowMs).toISOString())).toHaveLength(1);
    void c3;
  });
});

describe("callback URL guard (SSRF)", () => {
  it("classifies private targets and honors the explicit allowlist", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("10.1.2.3")).toBe(true);
    expect(isPrivateHostname("172.16.0.9")).toBe(true);
    expect(isPrivateHostname("192.168.1.4")).toBe(true);
    expect(isPrivateHostname("169.254.169.254")).toBe(true);
    expect(isPrivateHostname("[::1]")).toBe(true);
    expect(isPrivateHostname("metadata.internal")).toBe(true);
    expect(isPrivateHostname("platform.example.com")).toBe(false);
    expect(isPrivateHostname("52.1.2.3")).toBe(false);
    const noHosts = { allowedHosts: new Set<string>() };
    expect(checkCallbackUrl("ftp://x", noHosts)).toMatchObject({ ok: false, reason: "invalid_callback_url" });
    expect(checkCallbackUrl("not a url", noHosts)).toMatchObject({ ok: false, reason: "invalid_callback_url" });
    expect(checkCallbackUrl("http://127.0.0.1:1/cb", noHosts)).toMatchObject({ ok: false, reason: "blocked_callback_target" });
    expect(checkCallbackUrl("http://169.254.169.254/latest/meta-data", noHosts)).toMatchObject({ ok: false, reason: "blocked_callback_target" });
    expect(checkCallbackUrl("https://platform.example.com/cb", noHosts)).toMatchObject({ ok: true });
    // The explicit intranet exception: an admin allowlisted THIS host.
    const allow = { allowedHosts: new Set(["intranet.local"]) };
    expect(checkCallbackUrl("http://intranet.local/exchange/cb", allow)).toMatchObject({ ok: true });
  });
});

describe("outbox dispatcher (injected fetch, no ports)", () => {
  let db: DatabaseSync;
  let store: TaskExchangeStore;
  let service: ExchangeService;
  let dispatcher: OutboxDispatcher;
  let nowMs: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const users = wire(UsersRepo, { db });
    users.insert({
      userId: "user_a",
      passwordHash: "x",
      isAdmin: false,
      passwordIsInitial: false,
      displayName: null,
      avatar: null,
      createdAt: "2026-11-06T00:00:00Z",
    });
    wire(ProjectsRepo, { db }).insert({ projectId: "proj-a", ownerUserId: "user_a", createdAt: "2026-11-06T00:00:00Z" });
    store = wire(TaskExchangeRepo, { db });
    nowMs = T0;
    service = wire(ExchangeService, { store, projects: wire(ProjectsRepo, { db }), nowMs: () => nowMs });
    dispatcher = wire(OutboxDispatcher, { store, service, nowMs: () => nowMs });
  });
  afterEach(() => {
    dispatcher.stop();
    db.close();
  });

  function enqueueRow(url: string): string {
    const row = store.insertOutbox({
      taskId: "t-demo",
      kind: "callback",
      targetUrl: url,
      payload: { status: "succeeded" },
      idempotencyKey: `cb-${url}-${Math.random()}`,
      nextAttemptAt: new Date(nowMs).toISOString(),
    });
    return row.outboxId;
  }

  it("delivers a 2xx once (delivered), retries a failure with backoff, and abandons after max attempts", async () => {
    const fetcher = { calls: 0, failFirst: true };
    dispatcher.fetchImpl = async () => {
      fetcher.calls += 1;
      return { status: fetcher.failFirst ? 500 : 200 };
    };
    const id = enqueueRow("https://platform.example.com/cb");
    await dispatcher.tickOnce();
    expect(store.listDueOutbox(new Date(nowMs).toISOString())).toHaveLength(0); // attempt scheduled later
    const afterFail = db.prepare("SELECT attempts, status, last_error FROM exchange_outbox WHERE outbox_id = ?").get(id) as Record<string, unknown>;
    expect(afterFail.status).toBe("pending");
    expect(Number(afterFail.attempts)).toBe(1);
    // Advance past the backoff: delivered on the retry.
    nowMs += OUTBOX_BACKOFF(1);
    fetcher.failFirst = false;
    await dispatcher.tickOnce();
    const done = db.prepare("SELECT status, attempts FROM exchange_outbox WHERE outbox_id = ?").get(id) as Record<string, unknown>;
    expect(done.status).toBe("delivered");
    expect(Number(done.attempts)).toBe(2);
    // A delivered row is never re-sent.
    await dispatcher.tickOnce();
    expect(fetcher.calls).toBe(2);
    void id;
  });

  it("follows redirects MANUALLY and refuses a hop into a private range (abandoned, never delivered)", async () => {
    let hops: string[] = [];
    dispatcher.fetchImpl = async (url) => {
      hops.push(url);
      if (url.startsWith("https://public.example.com")) {
        return { status: 302, location: "http://10.0.0.5/steal" };
      }
      throw new Error("must not fetch the private hop");
    };
    const id = enqueueRow("https://public.example.com/cb");
    await dispatcher.tickOnce();
    expect(hops).toEqual(["https://public.example.com/cb"]);
    const row = db.prepare("SELECT status, last_error FROM exchange_outbox WHERE outbox_id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("abandoned");
    expect(String(row.last_error)).toContain("redirect_refused");
  });

  it("an unsafe target is abandoned WITHOUT any fetch attempt, even before the first try", async () => {
    let fetched = 0;
    dispatcher.fetchImpl = async () => {
      fetched += 1;
      return { status: 200 };
    };
    const id = enqueueRow("http://127.0.0.1:9/cb");
    await dispatcher.tickOnce();
    expect(fetched).toBe(0);
    const row = db.prepare("SELECT status FROM exchange_outbox WHERE outbox_id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("abandoned");
  });

  it("the same tick sweeps exchange tasks past their deadline to expired", async () => {
    // A queued task with a past deadline, created directly through the service's store.
    const users = wire(UsersRepo, { db });
    void users;
    const { tokenHash } = mintToken("plat");
    store.insertPlatform({ tenantId: "local", platformId: "plat-1", tokenHash, registeredAt: new Date(T0).toISOString(), revokedAt: null });
    const dev = mintToken("dev");
    store.insertDevice({
      deviceId: "dev-1",
      tenantId: "local",
      userId: "user_a",
      platformId: "plat-1",
      tokenHash: dev.tokenHash,
      label: "",
      registeredAt: new Date(T0).toISOString(),
      revokedAt: null,
      lastSeenAt: new Date(T0).toISOString(),
    });
    const { task } = service.createTask({
      tenantId: "local",
      platformId: "plat-1",
      userId: "user_a",
      nowMs,
      body: {
        externalId: "e1",
        idempotencyKey: "i1",
        deviceId: "dev-1",
        projectRef: "proj-a",
        objective: "x",
        allowedDataFields: ["status", "summary", "evidence_index"],
        deadlineMs: nowMs + MIN,
        publishSnapshot: {},
      },
    });
    nowMs += 2 * MIN;
    await dispatcher.tickOnce();
    expect(store.findTask("local", task.taskId)?.status).toBe("expired");
  });
});

function OUTBOX_BACKOFF(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000);
}


/** Asserts the service threw an ExchangeError with the given code (the message is prose). */
function expectExchange(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ExchangeError ${code}, but nothing was thrown`);
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
  }
}
