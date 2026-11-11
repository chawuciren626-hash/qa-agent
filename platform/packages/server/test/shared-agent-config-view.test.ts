import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config-service.js";
import type { ResolvedPublishedBundle } from "../src/auth/published-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("shows the published prompt and local Skill overrides without exposing the legacy prompt as current", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-config-view-"));
  roots.push(root);
  const state = path.join(root, "project", "agents", "role", "agent_state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "AGENTS.md"), "Old project instructions");
  await fs.writeFile(path.join(state, "system_config.yaml"), "system_prompt: Old project template\n");
  await fs.writeFile(path.join(state, "shared-agent.json"), JSON.stringify({ version: 1, agentId: "role", localSkillOverrides: ["local-skill"] }));
  const service = new AgentConfigService();
  Object.assign(service, { paths: { root } });
  const published = { bundleHash: "sha256:" + "a".repeat(64), resources: [
    { version: 3, kind: "agents", payload: { agentId: "role", prompt: "Published template", agentsMd: "Published instructions",
      model: { maxTokens: 4096, timeoutMs: 30000, thinkingLevel: "high" },
      compaction: { maxContextLength: 50000, mode: "discard" },
      toolsBuiltin: [{ name: "read_file", description: "Read files", permission: "r" }],
    } },
    { kind: "skills", name: "Published Skill", payload: { skillName: "published-skill" } },
    { kind: "plugins", name: "Published Hook", payload: {} },
  ] } as unknown as ResolvedPublishedBundle;
  const view = await service.getConfig("project", "role", published);
  expect(view.agentsMd).toBe("Published instructions");
  expect(view.config.systemPrompt).toBe("Published template");
  expect(view.systemConfigYaml).not.toContain("Old project template");
  expect(view.config.model).toMatchObject({ maxTokens: 4096, timeoutMs: 30000, thinkingLevel: "high" });
  expect(view.config.compaction).toMatchObject({ maxContextLength: 50000, mode: "discard" });
  expect(view.config.toolsBuiltin).toEqual([{ name: "read_file", description: "Read files", permission: "r" }]);
  expect(view.managed).toEqual({ bundleHash: published.bundleHash, version: 3,
    skills: ["published-skill"], plugins: ["Published Hook"], localSkillOverrides: ["local-skill"] });
  await expect(service.getConfig("project", "role")).rejects.toThrow("共享智能体定义暂不可用");
  await expect(service.updateConfig("project", "role", { agentsMd: "edit" })).rejects.toThrow("共享服务统一管理");
});

it("reads a published general Agent through the managed default Agent identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-alias-view-"));
  roots.push(root);
  const state = path.join(root, "project", "agents", "default_agent", "agent_state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "shared-agent.json"), JSON.stringify({ version: 1, agentId: "default_agent" }));
  const service = new AgentConfigService();
  Object.assign(service, { paths: { root } });
  const published = { bundleHash: "sha256:" + "b".repeat(64), resources: [
    { version: 6, kind: "agents", payload: { agentId: "general_agent", prompt: "General", agentsMd: "General instructions" } },
  ] } as unknown as ResolvedPublishedBundle;
  const view = await service.getConfig("project", "default_agent", published);
  expect(view.config.systemPrompt).toBe("General");
  expect(view.agentsMd).toBe("General instructions");
});
