import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PublishedBundleCache } from "../src/auth/published-bundle-cache.js";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("per-user published bundle cache", () => {
  it("maps the published general Agent alias only at the local execution boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "published-alias-"));
    roots.push(root);
    const cache = new PublishedBundleCache(root);
    const resource = { id: "d".repeat(36), kind: "agents" as const, name: "General", description: "", payload: { agentId: "general_agent", prompt: "test", agentsMd: "General instructions" }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-11T00:00:00.000Z" };
    const versions = [publishedResourceRef(resource)];
    const bundle = { rootId: resource.id, versions, bundleHash: resolvedBundleHash(versions), resources: [resource] };
    expect(await cache.store("alice", bundle)).toEqual(bundle);
    expect((await cache.definition("alice", bundle.bundleHash)).agentId).toBe("default_agent");
    expect((await cache.load("alice", bundle.bundleHash)).resources[0]?.payload.agentId).toBe("general_agent");
  });
  it("replays versioned runtime and tool settings from the central definition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "published-runtime-"));
    roots.push(root);
    const cache = new PublishedBundleCache(root);
    const resource = { id: "c".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: {
      agentId: "qa", prompt: "test", agentsMd: "QA instructions", maxTurns: 12,
      model: { maxTokens: 4096, timeoutMs: 30000, thinkingLevel: "high" },
      compaction: { maxContextLength: 50000, mode: "discard" },
      toolsBuiltin: [{ name: "read_file", description: "Read files", permission: "r" }],
    }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-05T00:00:00.000Z" };
    const versions = [publishedResourceRef(resource)];
    const bundle = { rootId: resource.id, versions, bundleHash: resolvedBundleHash(versions), resources: [resource] };
    await cache.store("alice", bundle);
    expect(await cache.definition("alice", bundle.bundleHash)).toMatchObject({
      maxTurns: 12, model: { max_tokens: 4096, timeoutMs: 30000, thinking_level: "high" },
      compaction: { max_context_length: 50000, mode: "discard" },
      builtinTools: [{ name: "read_file", description: "Read files", permission: "r" }],
    });
  });
  it("shares one immutable bundle across projects and rejects tampered or cross-user reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "published-bundle-"));
    roots.push(root);
    const cache = new PublishedBundleCache(root);
    const resource = { id: "a".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: { prompt: "test" }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-04T00:00:00.000Z" };
    const versions = [publishedResourceRef(resource)];
    const bundle = { rootId: resource.id, versions, bundleHash: resolvedBundleHash(versions), resources: [resource] };
    expect(await cache.store("alice", bundle)).toEqual(bundle);
    expect(await cache.store("alice", bundle)).toEqual(bundle);
    expect(await cache.store("alice", { ...bundle, resources: [{ ...resource, revision: 2,
      updatedAt: "2026-11-05T00:00:00.000Z" }] })).toEqual(bundle);
    await expect(cache.load("bob", bundle.bundleHash)).rejects.toThrow();
    await expect(cache.store("alice", { ...bundle, resources: [{ ...resource, payload: { prompt: "tampered" } }] })).rejects.toThrow();
    const entry = path.join(root, ".shared-agent-definitions");
    const userDir = path.join(entry, (await readdir(entry))[0]!);
    const file = path.join(userDir, `${bundle.bundleHash.slice(7)}.json`);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("test", "evil"));
    await expect(cache.load("alice", bundle.bundleHash)).rejects.toThrow();
  });
  it("materializes verified Skill files once in the account cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "published-skill-"));
    roots.push(root);
    const cache = new PublishedBundleCache(root);
    const agent = { id: "a".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: { agentId: "qa", prompt: "test", agentsMd: "QA instructions", skillResources: ["b".repeat(36)] }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-04T00:00:00.000Z" };
    const skill = { ...agent, id: "b".repeat(36), kind: "skills" as const, name: "Review", payload: { skillName: "review", content: "---\nname: review\ndescription: Check output\n---\nInstructions" } };
    const resources = [agent, skill];
    const versions = resources.map(publishedResourceRef);
    const bundle = { rootId: agent.id, versions, bundleHash: resolvedBundleHash(versions), resources };
    const incompleteVersions = [publishedResourceRef(agent)];
    await expect(cache.store("alice", { rootId: agent.id, versions: incompleteVersions, bundleHash: resolvedBundleHash(incompleteVersions), resources: [agent] })).rejects.toThrow("dependency");
    await cache.store("alice", bundle);
    const [entry] = await cache.materializeSkills("alice", bundle.bundleHash);
    expect(entry?.name).toBe("review");
    expect(await readFile(path.join(entry!.directory, "SKILL.md"), "utf8")).toContain("Instructions");
    expect(await cache.materializeSkills("alice", bundle.bundleHash)).toEqual([entry]);
    expect(await cache.definition("alice", bundle.bundleHash)).toMatchObject({ agentId: "qa", prompt: "test", skills: [entry] });
    await writeFile(path.join(entry!.directory, "SKILL.md"), "tampered");
    await expect(cache.materializeSkills("alice", bundle.bundleHash)).rejects.toThrow("mismatch");
  });
  it("refuses a symlink replacing a cached Skill directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "published-skill-link-"));
    roots.push(root);
    const cache = new PublishedBundleCache(root);
    const agent = { id: "a".repeat(36), kind: "agents" as const, name: "QA", description: "", payload: { agentId: "qa", prompt: "test", agentsMd: "QA instructions", skillResources: ["b".repeat(36)] }, audience: ["alice"], revision: 0, version: 1, published: true, updatedAt: "2026-11-04T00:00:00.000Z" };
    const skill = { ...agent, id: "b".repeat(36), kind: "skills" as const, payload: { skillName: "review", content: "---\nname: review\ndescription: Check\n---\nInstructions" } };
    const resources = [agent, skill];
    const versions = resources.map(publishedResourceRef);
    const bundle = { rootId: agent.id, versions, bundleHash: resolvedBundleHash(versions), resources };
    await cache.store("alice", bundle);
    const [entry] = await cache.materializeSkills("alice", bundle.bundleHash);
    const target = entry!.directory + "-saved";
    await rm(target, { recursive: true, force: true });
    await rename(entry!.directory, target);
    await symlink(target, entry!.directory, process.platform === "win32" ? "junction" : "dir");
    await expect(cache.materializeSkills("alice", bundle.bundleHash)).rejects.toThrow("unsafe");
  });
});
