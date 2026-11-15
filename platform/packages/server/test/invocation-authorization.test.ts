import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { InvocationGuard, type CentralAccessPolicy } from "../src/auth/invocation-authorization.js";

const guards: InvocationGuard[] = [];
afterEach(() => { for (const guard of guards.splice(0)) guard.close(); });

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects (project_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL);
    CREATE TABLE shared_agent_session_pins (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, local_user_id TEXT NOT NULL, bundle_hash TEXT NOT NULL);
    CREATE TABLE connectors (connector_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, project_id TEXT);`);
  db.prepare("INSERT INTO projects VALUES (?,?,?)").run("p1", "alice", new Date().toISOString());
  db.prepare("INSERT INTO project_members VALUES (?,?,?)").run("p1", "bob", new Date().toISOString());
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s1", "p1", "qa");
  db.prepare("INSERT INTO shared_agent_session_pins VALUES (?,?,?,?,?)").run("s1", "p1", "qa", "alice", "sha256:" + "a".repeat(64));
  db.prepare("INSERT INTO connectors VALUES (?,?,?)").run("c1", "bob", "p1");
  let now = 1_000;
  let policy: CentralAccessPolicy = { modules: ["agents", "plugins"], resourceIds: ["agent-1"], isAdmin: false };
  let failure: Error | null = null;
  const fetches: string[] = [];
  const guard = new InvocationGuard({
    db, now: () => now,
    fetchPolicy: async (userId) => {
      fetches.push(userId);
      if (failure) throw failure;
      return policy;
    },
  });
  guards.push(guard);
  return {
    db, guard,
    setPolicy: (next: CentralAccessPolicy) => { policy = next; },
    setFailure: (error: Error | null) => { failure = error; },
    advance: (ms: number) => { now += ms; },
    fetches,
  };
}

it('refuses connector calls after the plugins module permission is removed', async () => {
  const { guard, setPolicy } = setup();
  setPolicy({ modules: ['agents'], resourceIds: ['agent-1'] });
  expect((await guard.authorizeInvocation({userId:'bob', projectId:'p1'}, {kind:'connectors', id:'c1'}, 'tool')).reasonCode).toBe('permission_not_granted');
});

it("denies an old Agent session once the published resource is revoked", async () => {
  const { guard, setPolicy } = setup();
  const identity = { userId: "alice", projectId: "p1", sessionId: "s1", agentId: "qa" };
  const resource = { kind: "agents" as const, id: "agent-1" };
  expect((await guard.authorizeInvocation(identity, resource, "resume")).allowed).toBe(true);
  setPolicy({ modules: ["agents"], resourceIds: [], isAdmin: false });
  const denied = await guard.authorizeInvocation(identity, resource, "resume");
  expect(denied.allowed).toBe(false);
  expect(denied.reasonCode).toBe("resource_revoked");
});

it("stops a call whose resource is revoked between validation and execution", async () => {
  const { guard, setPolicy } = setup();
  const lease = await guard.beginInvocation({ userId: "alice", projectId: "p1" }, { kind: "agents", id: "agent-1" }, "invoke");
  setPolicy({ modules: ["agents"], resourceIds: [], isAdmin: false });
  const confirmed = await lease.confirm();
  expect(confirmed.allowed).toBe(false);
  expect(confirmed.reasonCode).toBe("resource_revoked");
  expect(lease.cancelled).toBe(true);
});

it("lets only the connector owner obtain a lease", async () => {
  const { guard } = setup();
  await expect(guard.beginInvocation({ userId: "alice", projectId: "p1" }, { kind: "connectors", id: "c1" }, "tool", { toolName: "echo" }))
    .rejects.toMatchObject({ decision: { reasonCode: "connector_forbidden" } });
  const own = await guard.beginInvocation({ userId: "bob", projectId: "p1" }, { kind: "connectors", id: "c1" }, "tool", { toolName: "echo" });
  expect(own.decision.allowed).toBe(true);
  guard.cancelUser("bob");
  expect(own.cancelled).toBe(true);
  expect(own.signal.aborted).toBe(true);
  expect((await own.confirm()).reasonCode).toBe("invocation_cancelled");
});

it("fails closed when the authorization query is unavailable, unless a fresh-enough snapshot is accepted", async () => {
  const { guard, setFailure } = setup();
  const identity = { userId: "alice", projectId: "p1", sessionId: "s1" };
  const resource = { kind: "agents" as const, id: "agent-1" };
  expect((await guard.authorizeInvocation(identity, resource, "resume")).allowed).toBe(true);
  setFailure(new Error("offline"));
  expect((await guard.authorizeInvocation(identity, resource, "resume")).reasonCode).toBe("policy_unavailable");
  const cached = await guard.authorizeInvocation(identity, resource, "resume", { requireFresh: false });
  expect(cached.allowed).toBe(true);
  expect(cached.usedCachedPolicy).toBe(true);
});

it("denies cross-user sessions, foreign projects and other users' connectors", async () => {
  const { db, guard } = setup();
  db.prepare("INSERT INTO shared_agent_session_pins VALUES (?,?,?,?,?)").run("s2", "p1", "qa", "bob", "sha256:" + "b".repeat(64));
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s2", "p1", "qa");
  expect((await guard.authorizeInvocation({ userId: "alice", projectId: "p1", sessionId: "s2" }, { kind: "session", id: "s2" }, "resume")).reasonCode).toBe("cross_user_resource");
  expect((await guard.authorizeInvocation({ userId: "alice", projectId: "p2" }, { kind: "project", id: "p2" }, "read")).reasonCode).toBe("project_forbidden");
  expect((await guard.authorizeInvocation({ userId: "alice", projectId: "p1" }, { kind: "connectors", id: "c1" }, "tool")).reasonCode).toBe("connector_forbidden");
});

it("expires a signed decision instead of reusing it", async () => {
  const { guard, advance } = setup();
  const lease = await guard.beginInvocation({ userId: "alice", projectId: "p1" }, { kind: "agents", id: "agent-1" }, "invoke");
  advance(10_000);
  const confirmed = await lease.confirm();
  expect(confirmed.allowed).toBe(false);
  expect(confirmed.reasonCode).toBe("decision_expired");
});

it("checks the requested project even when identity.projectId is absent or different", async () => {
  const { guard } = setup();
  expect((await guard.authorizeInvocation({ userId: "alice" }, { kind: "project", id: "foreign" }, "read")).reasonCode).toBe("project_forbidden");
  expect((await guard.authorizeInvocation({ userId: "alice", projectId: "p1" }, { kind: "project", id: "foreign" }, "write")).reasonCode).toBe("project_forbidden");
});

it("rejects a confirmation revoked while its policy fetch is pending", async () => {
  const { db } = setup();
  let release: (() => void) | undefined;
  let pause = false;
  const guard = new InvocationGuard({ db, fetchPolicy: async () => {
    if (pause) await new Promise<void>(resolve => { release = resolve; });
    return { modules: ["agents"], resourceIds: ["agent-1"] };
  } });
  guards.push(guard);
  const lease = await guard.beginInvocation({ userId: "alice" }, { kind: "agents", id: "agent-1" }, "invoke");
  pause = true;
  const confirmation = lease.confirm();
  guard.cancelUser("alice");
  release!();
  expect((await confirmation).reasonCode).toBe("invocation_cancelled");
  expect(lease.signal.aborted).toBe(true);
});

it("does not authorize expired deadlines or calls after shutdown", async () => {
  const { guard } = setup();
  expect((await guard.authorizeInvocation({ userId: "alice" }, { kind: "agents", id: "agent-1" }, "invoke", { deadlineAt: 999 })).reasonCode).toBe("decision_expired");
  guard.close();
  expect((await guard.authorizeInvocation({ userId: "alice" }, { kind: "agents", id: "agent-1" }, "invoke")).reasonCode).toBe("invocation_cancelled");
});

it("records decisions without credentials and cancels leases on logout", async () => {
  const { guard } = setup();
  await guard.authorizeInvocation({ userId: "alice", projectId: "p1", sessionId: "s1" }, { kind: "session", id: "s1" }, "resume");
  const rows = guard.history("alice");
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("token");
  const lease = await guard.beginInvocation({ userId: "bob", projectId: "p1" }, { kind: "connectors", id: "c1" }, "tool");
  guard.cancelUser("bob");
  expect(guard.activeCount("bob")).toBe(0);
  expect(lease.signal.aborted).toBe(true);
});
