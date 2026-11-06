import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PublishedBundleCache } from "../src/auth/published-bundle-cache.js";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";
import { SharedAgentSessionPins } from "../src/auth/shared-agent-session-pins.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("pins a verified shared definition locally and refuses version or project changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-agent-pin-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  try {
    const resource = { id: "a".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: { agentId: "qa", prompt: "v1", agentsMd: "QA instructions" }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-04T00:00:00.000Z" };
    const versions = [publishedResourceRef(resource)];
    const bundle = { rootId: resource.id, versions, bundleHash: resolvedBundleHash(versions), resources: [resource] };
    await new PublishedBundleCache(root).store("alice", bundle);
    const pins = new SharedAgentSessionPins(db, root);
    const pin = { sessionId: "session-1", projectId: "project-a", agentId: "qa", userId: "alice", bundleHash: bundle.bundleHash };
    expect((await pins.pin(pin)).prompt).toBe("v1");
    expect((await pins.resolve("session-1", "project-a", "qa"))?.bundleHash).toBe(bundle.bundleHash);
    await expect(pins.pin({ ...pin, projectId: "project-b" })).rejects.toThrow("immutable");
    await expect(pins.resolve("session-1", "project-b", "qa")).rejects.toThrow("coordinates");
    expect(await pins.resolve("unknown", "project-a", "qa")).toBeNull();
  } finally { db.close(); }
});

it("inherits another role from the parent's fixed catalog after a newer publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-agent-catalog-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  try {
    const cache = new PublishedBundleCache(root);
    const resources = ["qa", "review"].map((agentId, index) => ({ id: String(index + 1).repeat(36), kind: "agents" as const, name: agentId, description: "", payload: { agentId, prompt: `${agentId}-v1`, agentsMd: `${agentId} instructions` }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-04T00:00:00.000Z" }));
    const bundles = [];
    for (const resource of resources) {
      const versions = [publishedResourceRef(resource)];
      const bundle = { rootId: resource.id, versions, bundleHash: resolvedBundleHash(versions), resources: [resource] };
      await cache.store("alice", bundle);
      bundles.push({ agentId: resource.payload.agentId, bundleHash: bundle.bundleHash });
    }
    const pins = new SharedAgentSessionPins(db, root);
    await pins.catalog("parent", "alice", bundles);
    await pins.pin({ sessionId: "parent", projectId: "project-a", agentId: "qa", userId: "alice", bundleHash: bundles[0]!.bundleHash });
    const newer = { ...resources[1]!, version: 2, payload: { agentId: "review", prompt: "review-v2", agentsMd: "review instructions" } };
    const newVersions = [publishedResourceRef(newer)];
    await cache.store("alice", { rootId: newer.id, versions: newVersions, bundleHash: resolvedBundleHash(newVersions), resources: [newer] });
    expect((await pins.inherit("parent", "child", "project-a", "review")).prompt).toBe("review-v1");
    expect((await pins.resolve("child", "project-a", "review"))?.prompt).toBe("review-v1");
    await expect(pins.inherit("parent", "wrong", "project-b", "review")).rejects.toThrow();
  } finally { db.close(); }
});
