import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PublishedBundleCache } from "../src/auth/published-bundle-cache.js";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";
import { TaskContentSnapshotStore } from "../src/auth/task-content-snapshot.js";
import { localAdapterHash } from "../src/auth/trusted-local-adapters.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("records the actual Skill files, plugin executable and model revision as fixed task evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-snapshot-"));
  roots.push(root);
  const engineRoot = path.join(root, "engine");
  const adapterDir = path.join(engineRoot, "penguin", "hooks", "qa-default-entry");
  await fs.mkdir(adapterDir, { recursive: true });
  await fs.writeFile(path.join(adapterDir, "hooks.json"), "{}");
  await fs.writeFile(path.join(adapterDir, "guard.mjs"), "export default {};");
  const adapterHash = await localAdapterHash(engineRoot, "qa-default-entry");

  const agent = { id: "a".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: { agentId: "qa", prompt: "prompt", agentsMd: "instructions", modelResource: "c".repeat(36), skillResources: ["d".repeat(36)], pluginResources: ["e".repeat(36)] }, audience: ["alice"], revision: 0, version: 2, published: true, updatedAt: "2026-11-06T00:00:00.000Z" };
  const model = { id: "c".repeat(36), kind: "models" as const, name: "m", description: "", payload: { modelRevision: "2026-11-06-model.7" }, audience: ["alice"], revision: 0, version: 3, published: true, updatedAt: "2026-11-06T00:00:00.000Z" };
  const skill = { id: "d".repeat(36), kind: "skills" as const, name: "review", description: "", payload: { skillName: "review", content: "# Review v1\n" }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-06T00:00:00.000Z" };
  const plugin = { id: "e".repeat(36), kind: "plugins" as const, name: "echo", description: "", payload: { source: "trusted-local-adapter", pluginName: "qa-default-entry", adapterVersion: "1.0.0", adapterHash }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-06T00:00:00.000Z" };
  const resources = [agent, model, skill, plugin];
  const versions = resources.map(resource => publishedResourceRef(resource));
  const bundle = { rootId: agent.id, versions, bundleHash: resolvedBundleHash(versions), resources };
  const cache = new PublishedBundleCache(root);
  await cache.store("alice", bundle);
  const definition = await cache.definition("alice", bundle.bundleHash);

  const db = new DatabaseSync(":memory:");
  try {
    const store = new TaskContentSnapshotStore(db, root);
    const snapshot = await store.capture(definition, { userId: "alice", projectId: "p1", sessionId: "s1", taskId: "t1", engineRoot });
    expect(snapshot.agentId).toBe("qa");
    expect(snapshot.modelRevision).toBe("2026-11-06-model.7");
    expect(snapshot.snapshot.model?.revision).toBe("2026-11-06-model.7");
    expect(snapshot.snapshot.skills[0]!.files).toHaveLength(1);
    const file = path.join(definition.skills[0]!.directory, "SKILL.md");
    const expected = `sha256:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
    expect(snapshot.snapshot.skills[0]!.files[0]).toEqual({ path: "SKILL.md", sha256: expected });
    expect(snapshot.snapshot.plugins[0]!.executableHash).toBe(adapterHash);

    await fs.writeFile(file, "# Review changed\n");
    const again = await store.capture(definition, { userId: "alice", projectId: "p1", sessionId: "s1", engineRoot });
    expect(again.snapshotId).toBe(snapshot.snapshotId);
    expect(again.snapshot.skills[0]!.files[0]!.sha256).toBe(expected);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_content_snapshots").get()).toMatchObject({ n: 1 });
  } finally { db.close(); }
});
