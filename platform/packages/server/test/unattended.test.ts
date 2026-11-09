/**
 * Unattended scheduling semantics (batch 4): the authorization gate before every send,
 * the durable per-fire run ledger with fencing, cancel-vs-complete races, deadline and
 * approval-decision expiry, unknown-outcome honesty, restart redispatch, and lifecycle
 * records — plus the one legacy rule that must NOT change: an UNBOUND task keeps the
 * previously verified behavior (including the allow-all session creation), while a BOUND
 * task only escalates on an explicit ceiling grant.
 *
 * All tests use doubles and a controlled clock — no real LLM / core Session, no real
 * browser. Real sleep/resume and installed-version acceptance stay with Codex.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scheduleDir } from "@prismshadow/penguin-core";
import { wire } from "@prismshadow/penguin-core/kernel";
import { openDatabase } from "../src/db/database.js";
import { ProjectsRepo } from "../src/db/repos/projects.js";
import { SchedulesRepo } from "../src/db/repos/schedules.js";
import { SessionsRepo } from "../src/db/repos/sessions.js";
import { UsersRepo } from "../src/db/repos/users.js";
import { UnattendedBindingsRepo } from "../src/db/repos/unattended-bindings.js";
import { UnattendedLifecycleRepo } from "../src/db/repos/unattended-lifecycle.js";
import { UnattendedRunsRepo } from "../src/db/repos/unattended-runs.js";
import type { DatabaseSync } from "node:sqlite";
import type { AmspRecord } from "@prismshadow/penguin-core";
import type { ErrorRecordArgs } from "../src/runtime/error-recorder.js";
import type { ScheduleSessionCreator, ScheduleTaskRunner } from "../src/runtime/scheduler.js";
import { Scheduler } from "../src/runtime/scheduler.js";
import { ProjectConfigService } from "../src/services/project-config-service.js";
import {
  DefaultUnattendedCoordinator,
  REDISPATCH_AFTER_MS,
  UNKNOWN_AFTER_MS,
} from "../src/runtime/unattended/coordinator.js";
import type {
  AuthorizationDecision,
  RunCanceller,
  RunOutcomeSource,
  UnattendedAuthorizer,
  UnattendedCoordinator,
  UnattendedRedispatchRequest,
} from "../src/runtime/unattended/types.js";
import type { ScheduleServerEvent } from "../src/api/types.js";
import { makeTempRoot } from "./helpers.js";

const P = "p1";
const A = "agent_x";
const T0 = Date.parse("2026-11-06T09:00:00Z"); // a fixed instant (same day as the delivery plan)
const MIN = 60_000;

/** An allow decision with the metadata the ledger records. */
function allowDecision(at: number): AuthorizationDecision {
  return {
    allowed: true,
    outcome: "allow",
    reasonCode: "granted",
    decisionId: "dec-1",
    policyRevision: "pol-1",
    checkedAt: new Date(at).toISOString(),
    expiresAt: null,
  };
}

describe("unattended coordinator", () => {
  let root: string;
  let db: DatabaseSync;
  let runs: UnattendedRunsRepo;
  let bindings: UnattendedBindingsRepo;
  let lifecycle: UnattendedLifecycleRepo;
  let nowMs: number;
  let authorizer: UnattendedAuthorizer | undefined;
  let outcomes: RunOutcomeSource | undefined;
  let canceller: RunCanceller | undefined;
  let cancellerCalls: string[];
  let cancellerAnswer: boolean;
  let published: Array<{ key: string; event: ScheduleServerEvent }>;
  let coordinator: DefaultUnattendedCoordinator;

  beforeEach(async () => {
    root = await makeTempRoot();
    db = openDatabase(":memory:");
    const users = wire(UsersRepo, { db });
    users.insert({
      userId: "owner_a",
      passwordHash: "x",
      isAdmin: false,
      passwordIsInitial: false,
      displayName: null,
      avatar: null,
      createdAt: "2026-11-06T00:00:00Z",
    });
    const projects = wire(ProjectsRepo, { db });
    projects.insert({ projectId: P, ownerUserId: "owner_a", createdAt: "2026-11-06T00:00:00Z" });
    runs = wire(UnattendedRunsRepo, { db });
    bindings = wire(UnattendedBindingsRepo, { db });
    lifecycle = wire(UnattendedLifecycleRepo, { db });
    nowMs = T0;
    authorizer = {
      authorizeInvocation: async () => allowDecision(nowMs),
    };
    outcomes = undefined;
    cancellerCalls = [];
    cancellerAnswer = true;
    canceller = {
      cancel: async (sessionId: string) => {
        cancellerCalls.push(sessionId);
        return cancellerAnswer;
      },
    };
    published = [];
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      ...(authorizer !== undefined ? { authorizer } : {}),
      ...(outcomes !== undefined ? { outcomes } : {}),
      ...(canceller !== undefined ? { canceller } : {}),
      channels: {
        get: (_key: string) => ({
          publish: (event: ScheduleServerEvent, _kind?: string) => {
            published.push({ key: _key, event });
          },
        }),
      },
      nowMs: () => nowMs,
    });
  });

  afterEach(() => {
    db.close();
  });

  function bindTask(
    name: string,
    overrides: Partial<Parameters<UnattendedBindingsRepo["bind"]>[0]> = {},
  ): void {
    bindings.bind({
      projectId: P,
      agentId: A,
      name,
      ownerUserId: "owner_a",
      deviceId: "dev-1",
      grantId: "grant-1",
      grantExpiresAt: null,
      permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
      publishSnapshot: { agentReleaseId: "rel-1", packageHash: "h" },
      ...overrides,
    });
  }

  async function openRun(name: string, slotMs: number): Promise<string> {
    bindTask(name);
    const { runId } = await coordinator.beginFire({ projectId: P, agentId: A, name, slotMs });
    return runId;
  }

  function backdateRunCreated(runId: string, createdAtMs: number): void {
    db.prepare("UPDATE unattended_runs SET created_at = ? WHERE run_id = ?")
      .run(new Date(createdAtMs).toISOString(), runId);
  }

  it("beginFire is idempotent per slot: the same slot returns the same run, a new slot opens a new run", async () => {
    bindTask("t");
    const first = await coordinator.beginFire({ projectId: P, agentId: A, name: "t", slotMs: T0 });
    expect(first.fresh).toBe(true);
    const again = await coordinator.beginFire({ projectId: P, agentId: A, name: "t", slotMs: T0 });
    expect(again).toEqual({ runId: first.runId, fresh: false });
    const secondSlot = await coordinator.beginFire({
      projectId: P,
      agentId: A,
      name: "t",
      slotMs: T0 + 5 * MIN,
    });
    expect(secondSlot.fresh).toBe(true);
    expect(secondSlot.runId).not.toBe(first.runId);
    const row = runs.find(first.runId);
    expect(row).toMatchObject({ status: "queued", statusVersion: 1, ownerUserId: "owner_a", deviceId: "dev-1", grantId: "grant-1" });
  });

  it("a MISSING authorizer fails closed: blocked authorizer_missing, lifecycle recorded, nothing proceeds", async () => {
    authorizer = undefined;
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      channels: {
        get: (_key: string) => ({ publish: (event: ScheduleServerEvent) => void published.push({ key: "", event }) }),
      },
      nowMs: () => nowMs,
    });
    const runId = await openRun("noauth", T0);
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "blocked", reasonCode: "authorizer_missing" });
    expect(runs.find(runId)?.status).toBe("blocked");
    expect(lifecycle.listRecent().some((e) => e.kind === "fire_blocked")).toBe(true);
    expect(published.map((p) => p.event).some((e) => e.type === "schedule_unattended" && e.reasonCode === "authorizer_missing")).toBe(true);
    // A blocked run cannot be re-opened for the same slot: idempotency keeps the verdict.
    const again = await coordinator.beginFire({ projectId: P, agentId: A, name: "noauth", slotMs: T0 });
    expect(again.fresh).toBe(false);
  });

  it("a valid grant authorizes: claimed with the decision recorded, ceiling returned", async () => {
    const runId = await openRun("ok", T0);
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict.proceed).toBe(true);
    expect(verdict.status).toBe("claimed");
    expect(verdict.ceiling).toEqual({ allowedOperations: ["schedule.dispatch"] });
    const row = runs.find(runId);
    expect(row).toMatchObject({ status: "claimed", decisionId: "dec-1", policyRevision: "pol-1" });
    expect(row?.statusVersion).toBe(2);
  });

  it("an expired decision cannot authorize a physical send", async () => {
    bindTask("expired-decision");
    authorizer!.authorizeInvocation = async () => ({ ...allowDecision(nowMs), expiresAt: new Date(nowMs - 1).toISOString() });
    const { runId } = await coordinator.beginFire({ projectId: P, agentId: A, name: "expired-decision", slotMs: nowMs });
    expect(await coordinator.authorizeFire(runId)).toMatchObject({ proceed: false, reasonCode: "decision_expired" });
  });

  it("an expired grant blocks with grant_expired", async () => {
    const runId = await openRun("stale-grant", T0);
    const row = runs.find(runId)!;
    expect(row).not.toBeNull();
    // The binding's grant expired a minute before the fire.
    db.prepare("UPDATE unattended_bindings SET grant_expires_at = ? WHERE project_id = ? AND agent_id = ? AND name = ?")
      .run(new Date(nowMs - MIN).toISOString(), P, A, "stale-grant");
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "blocked", reasonCode: "grant_expired" });
  });

  it("an operation outside the ceiling blocks without consulting the authorizer", async () => {
    bindTask("narrow", {
      permissionCeiling: { allowedOperations: ["something.else"] },
    });
    const { runId } = await coordinator.beginFire({ projectId: P, agentId: A, name: "narrow", slotMs: T0 });
    let consulted = false;
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer: {
        authorizeInvocation: async () => {
          consulted = true;
          return allowDecision(nowMs);
        },
      },
      nowMs: () => nowMs,
    });
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "blocked", reasonCode: "operation_not_allowed" });
    expect(consulted).toBe(false);
  });

  it("an authorizer denial blocks with the decision's reasonCode; the owner is notified", async () => {
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer: {
        authorizeInvocation: async () => ({
          allowed: false,
          outcome: "deny",
          reasonCode: "logged_out",
          decisionId: "dec-x",
          policyRevision: "pol-2",
          checkedAt: new Date(nowMs).toISOString(),
          expiresAt: null,
        }),
      },
      channels: {
        get: (key: string) => ({ publish: (event: ScheduleServerEvent) => void published.push({ key, event }) }),
      },
      nowMs: () => nowMs,
    });
    const runId = await openRun("denied", T0);
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "blocked", reasonCode: "logged_out" });
    expect(published.map((p) => p.event.type)).toContain("schedule_unattended");
    expect(published[0]?.key).toBe("user:owner_a");
  });

  it("needs_approval waits with the decision's expiry, then lapses to blocked — never escalates to a send", async () => {
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer: {
        authorizeInvocation: async () => ({
          allowed: true,
          outcome: "needs_approval",
          reasonCode: "ask_required",
          decisionId: "dec-a",
          policyRevision: "pol-1",
          checkedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + 30 * MIN).toISOString(),
        }),
      },
      channels: {
        get: (_key: string) => ({ publish: (event: ScheduleServerEvent) => void published.push({ key: "", event }) }),
      },
      nowMs: () => nowMs,
    });
    const runId = await openRun("ask", T0);
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "needs_approval", reasonCode: "ask_required" });
    expect(runs.find(runId)).toMatchObject({ status: "needs_approval", decisionExpiresAt: new Date(T0 + 30 * MIN).toISOString() });

    // Before the window lapses the sweep leaves it waiting.
    nowMs = T0 + 29 * MIN;
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => true });
    expect(runs.find(runId)?.status).toBe("needs_approval");

    // Past the window it is blocked for good.
    nowMs = T0 + 31 * MIN;
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => true });
    expect(runs.find(runId)).toMatchObject({ status: "blocked", reasonCode: "approval_expired" });
  });

  it("a run past its deadline expires, the executor cancellation signal goes out, and delivery is recorded", async () => {
    bindTask("deadline", {
      permissionCeiling: { allowedOperations: ["schedule.dispatch"], defaultRunDeadlineMs: 10 * MIN },
    });
    const { runId } = await coordinator.beginFire({ projectId: P, agentId: A, name: "deadline", slotMs: T0 });
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-1");
    nowMs = T0 + 11 * MIN;
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => true });
    const row = runs.find(runId);
    expect(row).toMatchObject({ status: "expired", reasonCode: "deadline_exceeded", cancelSignalDelivered: true });
    expect(cancellerCalls).toEqual(["session-1"]);
  });

  it("a dispatched run with no outcome goes UNKNOWN after the window — pending, never silently re-fired", async () => {
    const runId = await openRun("crash", T0);
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-crash");
    // Just inside the window: still running.
    nowMs = T0 + UNKNOWN_AFTER_MS - MIN;
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => { throw new Error("must not redispatch a dispatched run"); } });
    expect(runs.find(runId)?.status).toBe("running");
    // Past the window: unknown, and no redispatch happens (the side effect already exists).
    nowMs = T0 + UNKNOWN_AFTER_MS + MIN;
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => { throw new Error("must not redispatch a dispatched run"); } });
    expect(runs.find(runId)).toMatchObject({ status: "unknown", reasonCode: "outcome_unverified" });
  });

  it("outcome polling settles a running run when a source reports", async () => {
    const seen: string[] = [];
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer,
      outcomes: {
        observe: async (sessionId: string) => {
          seen.push(sessionId);
          return "succeeded";
        },
      },
      nowMs: () => nowMs,
    });
    const runId = await openRun("polled", T0);
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-p");
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => true });
    expect(seen).toEqual(["session-p"]);
    expect(runs.find(runId)).toMatchObject({ status: "succeeded", settledAt: new Date(nowMs).toISOString() });
  });

  it("CANCEL wins over settle: the authoritative status stays cancelled and the physical outcome is recorded as evidence", async () => {
    const runId = await openRun("race", T0);
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-race");
    const cancelled = await coordinator.cancelRun(runId, "owner_a");
    expect(cancelled).toMatchObject({ ok: true, status: "cancelled" });
    // The work completes after the cancellation was requested: recorded, never a fake success.
    const settled = await coordinator.noteSettled(runId, "succeeded", { reportRef: "r-1" });
    expect(settled.applied).toBe(false);
    const row = runs.find(runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.evidence).toMatchObject({ physicalOutcome: "succeeded", reportRef: "r-1" });
    expect(lifecycle.listRecent().some((e) => e.kind === "fire_settled_after_cancel")).toBe(true);
  });

  it("SETTLE wins over cancel: a terminal run refuses cancellation", async () => {
    const runId = await openRun("first", T0);
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-f");
    await coordinator.noteSettled(runId, "succeeded");
    const cancelled = await coordinator.cancelRun(runId, "owner_a");
    expect(cancelled).toMatchObject({ ok: false, reasonCode: "already_terminal" });
    expect(runs.find(runId)?.status).toBe("succeeded");
  });

  it("cancel without a wired canceller records the UNDELIVERED signal, not a claimed delivery", async () => {
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer,
      nowMs: () => nowMs,
    });
    const runId = await openRun("nosignal", T0);
    await coordinator.authorizeFire(runId);
    await coordinator.noteDispatched(runId, "session-n");
    const result = await coordinator.cancelRun(runId, "owner_a");
    expect(result.ok).toBe(true);
    expect(runs.find(runId)?.cancelSignalDelivered).toBe(false);
    expect(lifecycle.listRecent().some((e) => e.kind === "cancel_signal_failed")).toBe(true);
  });

  it("restart redispatch: a never-sent queued run is resumed once; inFlight keeps the owner's claim", async () => {
    const runId = await openRun("resume", T0);
    // Simulate the crash window: the row was written, then the process died — its created_at
    // is already older than the redispatch threshold when the next process sweeps.
    backdateRunCreated(runId, nowMs - REDISPATCH_AFTER_MS - MIN);
    const calls: string[] = [];
    const onRedispatch = async (request: UnattendedRedispatchRequest): Promise<boolean> => {
      calls.push(request.run.runId);
      await coordinator.authorizeFire(request.run.runId);
      return true;
    };
    // Still owned by its process's busy queue: left alone.
    await coordinator.sweep({ nowMs, inFlight: new Set([runId]), onRedispatch });
    expect(calls).toEqual([]);
    // Owner gone: resumed once (the callback re-authorized → claimed), and the next sweep
    // does not consider it again (claimed runs are not queued).
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch });
    expect(calls).toEqual([runId]);
    expect(runs.find(runId)?.status).toBe("claimed");
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch });
    expect(calls).toEqual([runId]);
  });

  it("a redispatch refusal settles the run as failed, stopping the per-tick retry", async () => {
    const runId = await openRun("gone", T0);
    backdateRunCreated(runId, nowMs - REDISPATCH_AFTER_MS - MIN);
    await coordinator.sweep({ nowMs, inFlight: new Set(), onRedispatch: async () => false });
    expect(runs.find(runId)).toMatchObject({ status: "failed", reasonCode: "redispatch_refused" });
  });

  it("dropTask removes the binding (runs stay as audit) and a bound fire afterwards fails at the gate", async () => {
    const runId = await openRun("bye", T0);
    coordinator.dropTask(P, A, "bye");
    expect(bindings.find(P, A, "bye")).toBeNull();
    // The already-open run's gate refuses on the removed binding.
    const verdict = await coordinator.authorizeFire(runId);
    expect(verdict).toMatchObject({ proceed: false, status: "blocked", reasonCode: "binding_removed" });
  });

  it("recordLifecycle stores auditable records", () => {
    coordinator.recordLifecycle("startup_reconcile", { ok: true });
    const rows = lifecycle.listRecent();
    expect(rows[0]).toMatchObject({ kind: "startup_reconcile", detail: { ok: true } });
  });
});

describe("unattended scheduler integration", () => {
  let root: string;
  let db: DatabaseSync;
  let nowMs: number;
  let busy: Set<string>;
  let started: Array<{ sessionId: string; text: string }>;
  let created: Array<Parameters<ScheduleSessionCreator["createSession"]>[0]>;
  let errors: ErrorRecordArgs[];
  let authorizerDecisions: AuthorizationDecision[];
  let scheduler: Scheduler;
  let coordinator: DefaultUnattendedCoordinator;
  let runs: UnattendedRunsRepo;
  let bindings: UnattendedBindingsRepo;
  let lifecycle: UnattendedLifecycleRepo;

  beforeEach(async () => {
    root = await makeTempRoot();
    db = openDatabase(":memory:");
    await fs.mkdir(scheduleDir(root, P, A), { recursive: true });
    await (await import("@prismshadow/penguin-core")).saveProjectConfig(root, P, {
      default_model: { provider: "custom", model_id: "m-bench" },
      models: [{ provider: "custom", model_id: "m-bench" }],
    });
    const users = wire(UsersRepo, { db });
    users.insert({
      userId: "owner_a",
      passwordHash: "x",
      isAdmin: false,
      passwordIsInitial: false,
      displayName: null,
      avatar: null,
      createdAt: "2026-11-06T00:00:00Z",
    });
    const projects = wire(ProjectsRepo, { db });
    projects.insert({ projectId: P, ownerUserId: "owner_a", createdAt: "2026-11-06T00:00:00Z" });
    const sessions = wire(SessionsRepo, { db });
    const schedulesRepo = wire(SchedulesRepo, { db });
    runs = wire(UnattendedRunsRepo, { db });
    bindings = wire(UnattendedBindingsRepo, { db });
    lifecycle = wire(UnattendedLifecycleRepo, { db });
    nowMs = T0;
    busy = new Set();
    started = [];
    created = [];
    errors = [];
    authorizerDecisions = [allowDecision(nowMs)];
    const runner: ScheduleTaskRunner = {
      statusOf: (id: string) => (busy.has(id) ? "running" : "idle"),
      startTask: async (sessionId: string, input: AmspRecord[]) => {
        started.push({ sessionId, text: JSON.stringify(input[0]?.payload ?? "") });
        return { sessionId, queued: false };
      },
    };
    let seq = 0;
    const sessionCreator: ScheduleSessionCreator = {
      createSession: async (args) => {
        created.push(args);
        const sessionId = `session-new-${++seq}`;
        sessions.insert({
          sessionId,
          projectId: P,
          agentId: A,
          modelId: "m1",
          provider: "custom",
          workspace: "/tmp/w",
          approvalMode: args.approvalMode ?? "read-only",
          ownerUserId: args.userId ?? null,
          title: null,
          createdAt: new Date(nowMs).toISOString(),
          lastActiveAt: new Date(nowMs).toISOString(),
        });
        return { sessionId };
      },
    };
    coordinator = wire(DefaultUnattendedCoordinator, {
      runs,
      bindings,
      lifecycle,
      authorizer: {
        authorizeInvocation: async () => {
          const decision = authorizerDecisions[0] ?? { ...allowDecision(nowMs), allowed: false, outcome: "deny" as const, reasonCode: "logged_out" };
          return decision;
        },
      },
      nowMs: () => nowMs,
    });
    scheduler = wire(Scheduler, {
      paths: { root },
      repo: schedulesRepo,
      projects: wire(ProjectsRepo, { db }),
      sessions,
      runner,
      sessionCreator,
      projectConfig: wire(ProjectConfigService, { paths: { root } }),
      errors: { record: (args: ErrorRecordArgs) => void errors.push(args) },
      unattended: coordinator as unknown as UnattendedCoordinator,
      now: () => nowMs,
    });
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  async function writeFile(name: string, lines: string[]): Promise<void> {
    await fs.writeFile(path.join(scheduleDir(root, P, A), `${name}.toml`), lines.join("\n"), "utf8");
  }

  function bindTask(name: string, overrides: Partial<Parameters<UnattendedBindingsRepo["bind"]>[0]> = {}): void {
    bindings.bind({
      projectId: P,
      agentId: A,
      name,
      ownerUserId: "owner_a",
      deviceId: "dev-1",
      grantId: "grant-1",
      grantExpiresAt: null,
      permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
      publishSnapshot: { agentReleaseId: "rel-1" },
      ...overrides,
    });
  }

  function runFor(name: string, slotMs: number) {
    return runs.byKey(P, A, name, slotMs);
  }

  it("a bound task fires through the gate: allowed → sent once, run running with dispatchedAt", async () => {
    insertSession("session-1");
    bindTask("gated");
    await writeFile("gated", [
      `prompt = "g"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
      `session_id = "session-1"`,
    ]);
    await scheduler.tickOnce();
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(1);
    const run = runFor("gated", T0 + MIN)!;
    expect(run).toMatchObject({ status: "running", sessionId: "session-1" });
    expect(run.dispatchedAt).not.toBeNull();
    expect(run.decisionId).toBe("dec-1");
    // The slot never fires twice.
    await scheduler.tickOnce();
    expect(started).toHaveLength(1);
  });

  it("a bound task DENIED creates nothing: no session, no send; the run blocks and the reason reaches the ledger", async () => {
    bindTask("denied");
    await writeFile("denied", [
      `prompt = "d"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
    ]);
    await scheduler.tickOnce(); // registration while still in the future
    authorizerDecisions = [
      { ...allowDecision(nowMs), allowed: false, outcome: "deny", reasonCode: "revoked", decisionId: "dec-d", policyRevision: "pol-9" },
    ];
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    expect(created).toHaveLength(0);
    const run = runFor("denied", T0 + MIN)!;
    expect(run).toMatchObject({ status: "blocked", reasonCode: "revoked", decisionId: "dec-d" });
    // Logging back in (allow again) does NOT revive this slot: consumed and blocked.
    authorizerDecisions = [allowDecision(nowMs)];
    nowMs = T0 + 2 * MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    expect(runs.byKey(P, A, "denied", T0 + 2 * MIN)).toBeNull(); // the next slot never existed (one-shot)
  });

  it("a bound task answering needs_approval creates nothing, and the slot stays consumed — approval never auto-resolves into a send", async () => {
    bindTask("ask");
    await writeFile("ask", [
      `prompt = "a"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
    ]);
    await scheduler.tickOnce(); // registration while still in the future
    authorizerDecisions = [
      { ...allowDecision(nowMs), outcome: "needs_approval", reasonCode: "ask_required", decisionId: "dec-a", expiresAt: new Date(T0 + 30 * MIN).toISOString() },
    ];
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(runFor("ask", T0 + MIN)).toMatchObject({ status: "needs_approval", reasonCode: "ask_required" });
    // The user approves in the authorizer afterwards: the SAME slot must not fire (it was
    // consumed at its time; approval is a policy for FUTURE fires, not a retroactive send).
    authorizerDecisions = [allowDecision(nowMs)];
    nowMs = T0 + 2 * MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("bound default ceiling sends WITHOUT approvalMode escalation; explicit allow-all and legacy keep theirs", async () => {
    insertSession("session-b");
    // 1. Bound + default ceiling + bound session: send happens (session-bound fires don't
    //    create sessions), and nothing is escalated — there is no approvalMode anywhere.
    bindTask("s-bound");
    await writeFile("s-bound", [
      `prompt = "b"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
      `session_id = "session-b"`,
    ]);
    await scheduler.tickOnce(); // registration
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started.map((s) => s.sessionId)).toEqual(["session-b"]);

    // 2. Bound new-Session mode + default ceiling: session created WITHOUT allow-all.
    bindTask("s-new-default");
    await writeFile("s-new-default", [
      `prompt = "n"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + 3 * MIN).toISOString()}"`,
    ]);
    nowMs = T0 + 2 * MIN;
    await scheduler.tickOnce(); // registration while still in the future
    nowMs = T0 + 3 * MIN;
    await scheduler.tickOnce();
    expect(created).toHaveLength(1);
    expect("approvalMode" in created[0]!).toBe(false);

    // 3. Bound new-Session mode + EXPLICIT allow-all grant: escalation only now.
    bindTask("s-new-allow", {
      permissionCeiling: { allowedOperations: ["schedule.dispatch"], unattendedApproval: "allow-all" },
    });
    await writeFile("s-new-allow", [
      `prompt = "aa"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + 5 * MIN).toISOString()}"`,
    ]);
    nowMs = T0 + 4 * MIN;
    await scheduler.tickOnce(); // registration
    nowMs = T0 + 5 * MIN;
    await scheduler.tickOnce();
    expect(created).toHaveLength(2);
    expect(created[1]!.approvalMode).toBe("allow-all");

    // 4. LEGACY (unbound) new-Session task: the previously verified allow-all stays.
    await writeFile("s-legacy", [
      `prompt = "l"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + 7 * MIN).toISOString()}"`,
    ]);
    nowMs = T0 + 6 * MIN;
    await scheduler.tickOnce(); // registration
    nowMs = T0 + 7 * MIN;
    await scheduler.tickOnce();
    expect(created).toHaveLength(3);
    expect(created[2]!.approvalMode).toBe("allow-all");
    expect(runs.byKey(P, A, "s-legacy", T0 + 7 * MIN)).toBeNull(); // unbound: no run ledger row
  });

  it("a busy session queues the bound fire; a CANCELLED queue entry never sends when the session goes idle", async () => {
    insertSession("session-q");
    busy.add("session-q");
    bindTask("q");
    await writeFile("q", [
      `prompt = "q"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
      `session_id = "session-q"`,
    ]);
    await scheduler.tickOnce(); // registration
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    const run = runFor("q", T0 + MIN)!;
    expect(run.status).toBe("claimed"); // authorized, waiting on the busy session
    await coordinator.cancelRun(run.runId, "owner_a");
    busy.delete("session-q");
    nowMs = T0 + 2 * MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(0); // the cancelled fire is dropped at the re-authorization
    expect(runFor("q", T0 + MIN)?.status).toBe("cancelled");
  });

  it("restart recovery: a fire whose run row was opened but never sent is resumed exactly once", async () => {
    insertSession("session-r");
    bindTask("resume");
    const slotMs = T0 + MIN;
    await writeFile("resume", [
      `prompt = "r"`,
      `enabled = true`,
      `start_at = "${new Date(slotMs).toISOString()}"`,
      `session_id = "session-r"`,
    ]);
    // Simulate the crash: slot consumed + run row opened, no send. The row predates the
    // redispatch threshold (the process died minutes ago).
    const schedulesRepo = wire(SchedulesRepo, { db });
    schedulesRepo.registerOrSync({
      projectId: P,
      agentId: A,
      name: "resume",
      startAtMs: slotMs,
      defHash: "h",
      creatorUserId: "owner_a",
    });
    schedulesRepo.markSlot(P, A, "resume", slotMs);
    const { runId } = await coordinator.beginFire({ projectId: P, agentId: A, name: "resume", slotMs });
    db.prepare("UPDATE unattended_runs SET created_at = ? WHERE run_id = ?")
      .run(new Date(nowMs - REDISPATCH_AFTER_MS - MIN).toISOString(), runId);

    nowMs = T0 + 2 * MIN;
    await scheduler.tickOnce();
    expect(started.map((s) => s.sessionId)).toEqual(["session-r"]);
    expect(runFor("resume", slotMs)?.status).toBe("running");
    // The resumed fire never repeats.
    nowMs = T0 + 3 * MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(1);
  });

  it("a fire dispatched then lost (crash before settle) goes unknown on the sweep and is not re-sent", async () => {
    insertSession("session-u");
    bindTask("lost");
    await writeFile("lost", [
      `prompt = "u"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + MIN).toISOString()}"`,
      `session_id = "session-u"`,
    ]);
    await scheduler.tickOnce(); // registration
    nowMs = T0 + MIN;
    await scheduler.tickOnce();
    expect(started).toHaveLength(1);
    const run = runFor("lost", T0 + MIN)!;
    expect(run.dispatchedAt).not.toBeNull();
    // The process "dies" right after the send and comes back far past the unknown window.
    nowMs = T0 + MIN + UNKNOWN_AFTER_MS + MIN;
    await scheduler.tickOnce();
    expect(runs.find(run.runId)?.status).toBe("unknown");
    expect(started).toHaveLength(1);
  });

  it("lifecycle: startup reconcile and shutdown are recorded; a tick gap beyond 3 intervals is recorded as SUSPECTED suspension", async () => {
    insertSession("session-l");
    bindTask("l");
    await writeFile("l", [
      `prompt = "l"`,
      `enabled = true`,
      `start_at = "${new Date(T0 + 10 * MIN).toISOString()}"`,
      `session_id = "session-l"`,
    ]);
    await scheduler.start();
    await scheduler.stop();
    nowMs = T0 + 91_000; // > 3 × the 30s tick interval: the process was not ticking
    await scheduler.tickOnce();
    const kinds = lifecycle.listRecent(20).map((e) => e.kind);
    expect(kinds).toContain("startup_reconcile");
    expect(kinds).toContain("shutdown");
    expect(kinds).toContain("tick_gap_suspected");
    const gap = lifecycle.listRecent(20).find((e) => e.kind === "tick_gap_suspected");
    expect(gap?.detail).toMatchObject({ gapMs: 91_000 });
  });

  it("an explicit +08:00 offset start_at fires at its exact UTC instant; a periodic task keeps UTC spacing across a DST boundary", async () => {
    insertSession("session-tz");
    bindTask("tz");
    // 2026-11-06T19:30:00+08:00 == 2026-11-06T11:30:00Z. The scheduler works in epoch ms
    // only: an offset start_at is an instant, never a local wall clock.
    await writeFile("tz", [
      `prompt = "tz"`,
      `enabled = true`,
      `start_at = "2026-11-06T19:30:00+08:00"`,
      `session_id = "session-tz"`,
    ]);
    nowMs = Date.parse("2026-11-06T11:29:59Z");
    await scheduler.tickOnce();
    expect(started).toHaveLength(0);
    nowMs = Date.parse("2026-11-06T11:30:00Z");
    await scheduler.tickOnce();
    expect(started).toHaveLength(1);

    // Fixed-period tasks step in epoch ms: across the US fall-back (2026-11-01T08:00Z,
    // 02:00 EDT → 01:00 EST) the UTC spacing stays exactly one period. A task first seen
    // PAST its slot is registered consumed (no backfill), then fires at the NEXT slot.
    bindTask("dst");
    await writeFile("dst", [
      `prompt = "dst"`,
      `enabled = true`,
      `start_at = "2026-11-01T07:45:00Z"`,
      `period = "30m"`,
      `session_id = "session-tz"`,
    ]);
    nowMs = Date.parse("2026-11-01T08:15:00Z"); // registration: the 07:45 slot is already past → consumed, never fired
    await scheduler.tickOnce();
    expect(started).toHaveLength(1); // only tz fired; dst's past slots were consumed without firing
    const state = wire(SchedulesRepo, { db }).find(P, A, "dst")!;
    expect(state.lastSlotMs).toBe(Date.parse("2026-11-01T08:15:00Z"));
    // The next slot (08:45Z — 15 minutes after the fall-back instant, 00:45 EST on a clock
    // that had said 01:45) fires exactly one period after the consumed one, in UTC ms.
    nowMs = Date.parse("2026-11-01T08:45:00Z");
    await scheduler.tickOnce();
    expect(started).toHaveLength(2);
    expect(wire(SchedulesRepo, { db }).find(P, A, "dst")!.lastSlotMs).toBe(
      Date.parse("2026-11-01T08:45:00Z"),
    );
  });

  // -- helpers ----------------------------------------------------------//

  function insertSession(sessionId: string): void {
    wire(SessionsRepo, { db }).insert({
      sessionId,
      projectId: P,
      agentId: A,
      modelId: "m1",
      provider: "custom",
      workspace: "/tmp/w",
      approvalMode: "read-only",
      ownerUserId: "owner_a",
      title: null,
      createdAt: new Date(nowMs).toISOString(),
      lastActiveAt: new Date(nowMs).toISOString(),
    });
  }
});
