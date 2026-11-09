import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";
import { PublishedResourceSync } from "../src/auth/resource-sync.js";

const roots: string[] = [];
const syncs: PublishedResourceSync[] = [];
afterEach(async () => {
  for (const sync of syncs.splice(0)) sync.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function agentBundle(agentId: string, version: number, extra: unknown[] = []) {
  const agent = { id: String(version).repeat(36).slice(0, 36), kind: "agents" as const, name: agentId, description: "", payload: { agentId, prompt: `v${version}`, agentsMd: `${agentId} instructions`, ...(extra.length ? { pluginResources: extra.map(item => (item as { id: string }).id) } : {}) }, audience: ["alice"], revision: 0, version, published: true, updatedAt: "2026-11-06T00:00:00.000Z" };
  const resources = [agent, ...extra as { id: string; kind: string }[]];
  const versions = resources.map(item => publishedResourceRef(item as never));
  return { agentId, bundle: { rootId: agent.id, versions, bundleHash: resolvedBundleHash(versions), resources } };
}

function pluginResource(minHostVersion: string) {
  return {
    id: "b".repeat(36), kind: "plugins" as const, name: "echo", description: "",
    payload: { source: "instructions", instructions: "echo", minHostVersion }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-sync-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  let items = [agentBundle("qa", 1)];
  let failure: Error | null = null;
  let calls = 0;
  let gate: { promise: Promise<void>; release: () => void } | null = null;
  const sync = new PublishedResourceSync({
    db, dataRoot: root, intervalMs: 60_000,
    fetchBundles: async (_userId, signal) => {
      calls++;
      if (gate) await gate.promise;
      if (signal.aborted) throw Error("aborted");
      if (failure) throw failure;
      return items;
    },
  });
  syncs.push(sync);
  return {
    root, db, sync,
    setItems: (next: typeof items) => { items = next; },
    setFailure: (error: Error | null) => { failure = error; },
    gate: () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); gate = { promise, release }; return () => { gate = null; release(); }; },
    calls: () => calls,
  };
}

it("activates a verified publication and serves status without refetching on every render", async () => {
  const { sync, calls } = await setup();
  await sync.kick("alice");
  expect(sync.status("alice").state).toBe("current");
  expect(sync.status("alice").publication?.agents[0]).toMatchObject({ agentId: "qa", version: 1 });
  expect(sync.status("alice").offlineUsable).toEqual([]);
  for (let i = 0; i < 5; i++) sync.status("alice");
  expect(calls()).toBe(1);
});

it("pins a new session to the newer publication while keeping the last verified one on failure", async () => {
  const { sync, setItems, setFailure } = await setup();
  await sync.kick("alice");
  setItems([agentBundle("qa", 2)]);
  await sync.kick("alice");
  expect(sync.status("alice").publication?.agents[0]?.version).toBe(2);
  setFailure(Error("offline"));
  await sync.kick("alice");
  expect(sync.status("alice").state).toBe("offline");
  expect(sync.status("alice").publication?.agents[0]?.version).toBe(2);
});

it("rejects a tampered bundle and keeps the previous set", async () => {
  const { sync, setItems } = await setup();
  await sync.kick("alice");
  const verifiedHash = sync.status("alice").publication?.setHash;
  const tampered = agentBundle("qa", 2);
  setItems([{ ...tampered, bundle: { ...tampered.bundle, bundleHash: "sha256:" + "0".repeat(64) } }]);
  await sync.kick("alice");
  expect(sync.status("alice").state).toBe("update_failed");
  expect(sync.status("alice").update.errorCode).toBe("verification_failed");
  expect(sync.status("alice").publication?.agents[0]?.version).toBe(1);
  expect(sync.status("alice").publication?.setHash).toBe(verifiedHash);
});

it("rejects a plugin that requires a newer host version", async () => {
  const { sync, setItems } = await setup();
  await sync.kick("alice");
  setItems([agentBundle("qa", 2, [pluginResource("99.0.0")])]);
  await sync.kick("alice");
  expect(sync.status("alice").state).toBe("update_failed");
  expect(sync.status("alice").update.errorCode).toBe("plugin_incompatible");
  expect(sync.status("alice").publication?.agents[0]?.version).toBe(1);
});

it("coalesces concurrent kicks and closes every timer", async () => {
  const { sync, calls, gate } = await setup();
  const release = gate();
  const first = sync.kick("alice");
  const second = sync.kick("alice");
  expect(first).toBe(second);
  release();
  await first;
  expect(calls()).toBe(1);
  sync.start("alice");
  expect(sync.timerCount).toBe(1);
  sync.close();
  expect(sync.timerCount).toBe(0);
  await sync.kick("alice");
  expect(calls()).toBe(2);
});

it("stops logout downloads without publishing a late result and can restart", async () => {
  const { sync, gate } = await setup();
  const release = gate();
  sync.start("alice");
  const pending = sync.kick("alice");
  sync.stop("alice");
  release();
  await pending;
  expect(sync.timerCount).toBe(0);
  expect(sync.status("alice").publication).toBeNull();
  sync.start("alice");
  await sync.kick("alice");
  expect(sync.status("alice").state).toBe("current");
});
