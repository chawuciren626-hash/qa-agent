import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { LocalExecutionBroker, type ExecutionClient } from "../src/services/local-execution-broker.js";
const proof = "a".repeat(64);
function setup() {
  let clock = 100;
  const bindings = new Map();
  const broker = new LocalExecutionBroker({ get: id => bindings.get(id) ?? null, set: (id, value) => bindings.set(id, value) }, () => clock);
  const client: ExecutionClient = { clientId: randomUUID(), platform: "win32", node: "C:/install/node.exe", python: "C:/install/python.exe", engine: "C:/install/engine", workspaces: "C:/install/workspaces" };
  broker.register("alice", proof, client);
  return { broker, client, advance: () => { clock += 21000; } };
}
describe("local execution ownership and transport", () => {
  it("rejects another account, incorrect proof and client takeover", () => {
    const { broker, client } = setup();
    expect(() => broker.authenticate("bob", client.clientId, proof)).toThrow();
    expect(() => broker.authenticate("alice", client.clientId, "b".repeat(64))).toThrow();
    expect(() => broker.register("bob", proof, client)).toThrow();
  });
  it("persists affinity and fails closed when an executor is offline", () => {
    const { broker, client, advance } = setup();
    broker.bind("s1", "alice", client.clientId, proof);
    expect(broker.environment("s1")?.platform).toBe("win32");
    advance();
    expect(() => broker.environment("s1")).toThrow(/离线/);
    expect(broker.environment("unbound")).toBeNull();
    broker.poll("alice", client.clientId, proof);
    expect(broker.environment("s1")?.node).toContain("node.exe");
  });
  it("does not permit silently rebinding an existing session", () => {
    const { broker, client } = setup();
    broker.bind("s1", "alice", client.clientId, proof);
    const other = { ...client, clientId: randomUUID() };
    broker.register("alice", proof, other);
    expect(() => broker.bind("s1", "alice", other.clientId, proof)).toThrow(/其他客户端/);
  });
  it("fails an unacknowledged delivery instead of replaying it while polling continues", async () => {
    const { broker, client, advance } = setup();
    broker.bind("s1", "alice", client.clientId, proof);
    const generator = broker.execute("s1", {});
    const result = generator.next();
    expect(broker.poll("alice", client.clientId, proof).jobs).toHaveLength(1);
    advance();
    expect(broker.poll("alice", client.clientId, proof).jobs).toHaveLength(0);
    await expect(result).rejects.toThrow(/不会自动重放/);
  });
  it("delivers a command once and preserves output order", async () => {
    const { broker, client } = setup();
    broker.bind("s1", "alice", client.clientId, proof);
    const generator = broker.execute("s1", { cmd: "node --version" });
    const first = generator.next();
    const { jobs } = broker.poll("alice", client.clientId, proof);
    expect(jobs).toHaveLength(1);
    expect(broker.poll("alice", client.clientId, proof).jobs).toHaveLength(0);
    const event = { type: "tool_call_output", payload: { type: "tool_call_output", output: "v24" } } as any;
    broker.accept("alice", client.clientId, proof, jobs[0]!.id, { sequence: 0, events: [event], done: false });
    expect((await first).value).toEqual(event);
    broker.accept("alice", client.clientId, proof, jobs[0]!.id, { sequence: 0, events: [event], done: false });
    broker.accept("alice", client.clientId, proof, jobs[0]!.id, { sequence: 1, events: [], done: true });
    expect((await generator.next()).done).toBe(true);
  });
  it("rejects cross-client responses and out of order events", async () => {
    const { broker, client } = setup();
    broker.bind("s1", "alice", client.clientId, proof);
    const abort = new AbortController();
    const generator = broker.execute("s1", {}, abort.signal);
    const first = generator.next();
    const job = broker.poll("alice", client.clientId, proof).jobs[0]!;
    expect(() => broker.accept("bob", client.clientId, proof, job.id, { sequence: 0, events: [], done: true })).toThrow();
    expect(() => broker.accept("alice", client.clientId, proof, job.id, { sequence: 1, events: [], done: true })).toThrow();
    abort.abort();
    await expect(first).rejects.toThrow();
    expect(broker.poll("alice", client.clientId, proof, [job.id]).cancelled).toEqual([job.id]);
  });
});
