import { DatabaseSync } from "node:sqlite";
import { createServer } from 'node:http';
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { InvocationGuard } from "../src/auth/invocation-authorization.js";
import { ConnectorError, ConnectorService, type ConnectorTransport } from "../src/connectors/service.js";

const roots: string[] = [];
const guards: InvocationGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) guard.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(transports: Record<string, ConnectorTransport> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "connectors-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects (project_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL);
    CREATE TABLE shared_agent_session_pins (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, local_user_id TEXT NOT NULL, bundle_hash TEXT NOT NULL);`);
  db.prepare("INSERT INTO projects VALUES (?,?,?)").run("p1", "alice", "now");
  db.prepare("INSERT INTO projects VALUES (?,?,?)").run("p2", "bob", "now");
  const guard = new InvocationGuard({ db, fetchPolicy: async () => ({ modules: ["agents", "plugins"], resourceIds: ["agent-1"], isAdmin: false }) });
  guards.push(guard);
  const service = new ConnectorService({ db, dataRoot: root, authorizer: guard, transports });
  return { db, guard, service };
}

function readyConnector(service: ConnectorService, recipient = "local-echo", projectId = "p1") {
  const connector = service.create("alice", { name: "test", projectId, recipient });
  service.setCredential("alice", connector.connectorId, "super-secret-token");
  return service.update("alice", connector.connectorId, { enabled: true });
}

it('uses a real local HTTP transport and redacts the stored credential from its response', async () => {
  let authorized = false;
  const server = createServer((req, res) => {
    authorized = req.headers.authorization === 'Bearer synthetic-connector-token';
    req.resume(); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: 'ok', echoed: 'synthetic-connector-token' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { service } = await setup();
    const port = (server.address() as {port:number}).port;
    const connector = service.create('alice', {name:'http probe', kind:'http', projectId:'p1', recipient:`http://127.0.0.1:${port}/`});
    service.setCredential('alice', connector.connectorId, 'synthetic-connector-token');
    service.update('alice', connector.connectorId, {enabled:true});
    const result = await service.invoke({userId:'alice', projectId:'p1'}, connector.connectorId, {toolName:'probe'});
    expect(authorized).toBe(true);
    expect(result.output).toEqual({result:'ok', echoed:'[redacted]'});
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("records location, scope and fingerprint while keeping the credential out of the audit log", async () => {
  const { service } = await setup();
  const connector = readyConnector(service);
  expect(connector).toMatchObject({ executionLocation: "local", recipient: "local-echo", transportScope: "loopback", authorization: "authorized" });
  expect(connector.credentialFingerprint).toMatch(/^sha256:/);
  expect(JSON.stringify(connector)).not.toContain("super-secret-token");

  const result = await service.invoke({ userId: "alice", projectId: "p1" }, connector.connectorId, {
    toolName: "echo", payload: { message: "hello", token: "super-secret-token" },
  });
  expect(result.output).toEqual({ echo: { message: "hello", token: "[redacted]" } });
  const audit = service.auditLog("alice", connector.connectorId);
  expect(audit[0]).toMatchObject({ outcome: "success", execution_location: "local", transport_scope: "loopback" });
  expect((audit[0]!.fields_json as Record<string, unknown>).token).toBe("[redacted]");
  expect(JSON.stringify(audit)).not.toContain("super-secret-token");
});

it("denies another user and a revoked connector", async () => {
  const { service } = await setup();
  const connector = readyConnector(service);
  await expect(service.invoke({ userId: "bob", projectId: "p2" }, connector.connectorId, { toolName: "echo" })).rejects.toMatchObject({ status: 403, code: "connector_forbidden" });
  await expect(service.invoke({ userId: "alice", projectId: "p2" }, connector.connectorId, { toolName: "echo" })).rejects.toMatchObject({ status: 403 });
  service.revoke("alice", connector.connectorId);
  await expect(service.invoke({ userId: "alice", projectId: "p1" }, connector.connectorId, { toolName: "echo" })).rejects.toMatchObject({ status: 409, code: "connector_not_authorized" });
});

it("times out and cancels an in-flight connector call with audit evidence", async () => {
  const waiters: (() => void)[] = [];
  const entered = () => new Promise<void>(resolve => waiters.push(resolve));
  const slow: ConnectorTransport = ({ signal }) => new Promise((_, reject) => {
    waiters.shift()?.();
    signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  });
  const { service, guard } = await setup({ slow });
  const connector = readyConnector(service, "slow");

  const firstEntered = entered();
  await expect(service.invoke({ userId: "alice", projectId: "p1" }, connector.connectorId, { toolName: "echo", timeoutMs: 1000 }))
    .rejects.toMatchObject({ status: 504, code: "connector_timeout" });
  await firstEntered;
  expect(service.auditLog("alice", connector.connectorId)[0]).toMatchObject({ outcome: "timeout", reason: "connector_timeout" });

  const secondEntered = entered();
  const pending = service.invoke({ userId: "alice", projectId: "p1" }, connector.connectorId, { toolName: "echo", timeoutMs: 5000 });
  await secondEntered;
  guard.cancelUser("alice");
  await expect(pending).rejects.toMatchObject({ status: 499, code: "invocation_cancelled" });
  expect(service.auditLog("alice", connector.connectorId)[0]).toMatchObject({ outcome: "cancelled" });
});

it("reports an unsupported external transport instead of silently calling it", async () => {
  const { service } = await setup();
  const connector = service.create("alice", { name: "external", projectId: "p1", kind: "http", recipient: "https://example.invalid", transportScope: "external" });
  service.setCredential("alice", connector.connectorId, "s");
  service.update("alice", connector.connectorId, { enabled: true });
  await expect(service.invoke({ userId: "alice", projectId: "p1" }, connector.connectorId, { toolName: "echo" })).rejects.toBeInstanceOf(ConnectorError);
});
