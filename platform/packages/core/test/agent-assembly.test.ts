/**
 * AgentAssembly: what the hosting process adds to every Session — prompt sections
 * appended under their own headings.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadAgentState, systemConfigPath } from "../src/state/index.js";
import { runHookScript } from "../src/hooks/script-hook.js";
import { seedProject } from "./seeded-project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("AgentAssembly", () => {
  it("appends prompt sections under their headings, after the Agent's own prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-assembly-"));
    roots.push(root);
    // The Project a host would have seeded: core itself carries no models.
    await seedProject(root);
    const agent = await createAgent({
      root,
      assembly: { promptSections: () => [{ title: "Host", text: "You run inside a test." }] },
    });
    const session = await agent.createSession({
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    });
    const prompt = (session.metaMessage.payload as { system_prompt: string }).system_prompt;
    expect(prompt.endsWith("# Host\nYou run inside a test.")).toBe(true);
    expect(prompt.startsWith(agent.state.systemConfig.system_prompt.slice(0, 20))).toBe(true);
    session.dispose();
  });
  it("assembles a pinned published role with shared Skill paths and local project memory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-published-"));
    roots.push(root);
    await seedProject(root);
    const skillDirectory = path.join(root, ".shared-agent-definitions", "bundle", "skills", "review");
    const agent = await createAgent({
      root,
      assembly: {
        publishedDefinition: async ({ agentId }) => ({
          bundleHash: "sha256:" + "a".repeat(64),
          prompt: "# Central Role\n{{AGENTS_MD}}\n{{MEMORY}}\n{{SKILLS}}",
          agentsMd: `Shared definition for ${agentId}`,
          skills: [{ name: "review", description: "Review the result", directory: skillDirectory }],
          pluginInstructions: ["Use the approved review procedure."],
        }),
      },
    });
    const session = await agent.createSession({
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    });
    const prompt = (session.metaMessage.payload as { system_prompt: string }).system_prompt;
    expect(prompt).toContain("Shared definition for default_agent");
    expect(prompt).toContain(path.join(skillDirectory, "SKILL.md"));
    expect(prompt).toContain("Use the approved review procedure.");
    expect(prompt).toContain("User Memory Dir:");
    expect(prompt).not.toContain("# Role\nYou are PenguinHarness");
    session.dispose();
  });
  it("initializes a reference and empty local memory without copying a role definition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-shared-ref-"));
    roots.push(root);
    await seedProject(root);
    const state = await loadAgentState({ root, agentId: "review_agent", init: { shared: true } });
    await expect(fs.stat(systemConfigPath(root, state.projectId, state.agentId))).rejects.toThrow();
    expect(await fs.readFile(path.join(state.stateDir, "memory", "user", "MEMORY.md"), "utf8")).toBeDefined();
    const agent = await createAgent({ root, agentId: "review_agent" });
    await expect(agent.createSession({
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    })).rejects.toThrow("cannot fall back");
  });
  it("keeps a migrated historical Session on its local definition while refusing an unpinned new Session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-shared-legacy-"));
    roots.push(root);
    await seedProject(root);
    const state = await loadAgentState({ root, agentId: "default_agent", init: {} });
    await fs.writeFile(path.join(state.stateDir, "shared-agent.json"), JSON.stringify({
      version: 1, agentId: "default_agent", legacySessionIds: ["historical-session"],
    }));
    const agent = await createAgent({ root });
    const historical = await agent.createSession({
      sessionId: "historical-session",
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    });
    expect((historical.metaMessage.payload as { system_prompt: string }).system_prompt).toContain("You are PenguinHarness");
    historical.dispose();
    await expect(agent.createSession({
      sessionId: "new-unpinned-session",
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    })).rejects.toThrow("cannot fall back");
  });
  it("keeps declared project Skill overrides visible beside a pinned published definition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-shared-overrides-"));
    roots.push(root);
    await seedProject(root);
    const state = await loadAgentState({ root, agentId: "default_agent", init: {} });
    const localSkill = path.join(state.stateDir, "skills", "local-review");
    await fs.mkdir(localSkill, { recursive: true });
    await fs.writeFile(path.join(localSkill, "SKILL.md"), "---\nname: local-review\ndescription: Local review procedure\n---\n# Review");
    await fs.writeFile(path.join(state.stateDir, "shared-agent.json"), JSON.stringify({
      version: 1, agentId: "default_agent", legacySessionIds: [], localSkillOverrides: ["local-review"],
    }));
    const agent = await createAgent({ root, assembly: { publishedDefinition: async () => ({
      bundleHash: "sha256:" + "b".repeat(64), prompt: "{{AGENTS_MD}}\n{{SKILLS}}",
      agentsMd: "Central instruction", skills: [], pluginInstructions: [],
    }) } });
    const session = await agent.createSession({
      modelId: agent.projectConfig.default_model!.model_id,
      provider: agent.projectConfig.default_model!.provider,
      apiKey: "test-key",
    });
    const prompt = (session.metaMessage.payload as { system_prompt: string }).system_prompt;
    expect(prompt).toContain("Central instruction");
    expect(prompt).toContain("Local review procedure");
    expect(prompt).toContain(path.join(localSkill, "SKILL.md"));
    expect(prompt).toContain("Local Project Skill Overrides");
    session.dispose();
  });
  it("passes project coordinates to a shared Hook as environment values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-shared-hook-"));
    roots.push(root);
    const script = path.join(root, "hook.mjs");
    await fs.writeFile(script, "console.log(JSON.stringify({agentRoot:process.env.AITEST_QA_AGENT_ROOT,agentId:process.env.AITEST_QA_AGENT_ID}))");
    expect(await runHookScript(script, {}, { env: { AITEST_QA_AGENT_ROOT: path.join(root, "project", "agents"), AITEST_QA_AGENT_ID: "qa" } })).toEqual({
      agentRoot: path.join(root, "project", "agents"), agentId: "qa",
    });
  });
});
