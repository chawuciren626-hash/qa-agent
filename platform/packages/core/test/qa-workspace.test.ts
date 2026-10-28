import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/index.js";
import { seededProjectConfig } from "./seeded-project.js";
import { saveProjectConfig } from "../src/index.js";
import { stubProviderKeys } from "./provider-keys.js";

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("QA workspace construction", () => {
  let base: string;
  let restoreKeys: () => void;
  let previous: (string | undefined)[];
  const keys = ["QA_APP_DATA_ROOT", "QA_WORKSPACE_ROOT"] as const;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "qa-platform-workspace-"));
    previous = keys.map((k) => process.env[k]);
    process.env.QA_APP_DATA_ROOT = path.join(base, "qa");
    process.env.QA_WORKSPACE_ROOT = path.join(base, "workspaces");
    restoreKeys = stubProviderKeys();
  });
  afterEach(async () => {
    keys.forEach((k, i) => {
      if (previous[i] === undefined) delete process.env[k];
      else process.env[k] = previous[i];
    });
    restoreKeys();
    await fs.rm(base, { recursive: true, force: true });
  });
  it("separates projects and restores a trace-less session without nesting its workspace", async () => {
    const root = path.join(base, "host");
    for (const projectId of ["first_project", "second_project"]) {
      await saveProjectConfig(root, projectId, seededProjectConfig());
      await fs.writeFile(
        path.join(root, projectId, "qa-project.json"),
        JSON.stringify({ version: 1, status: "ready" }),
      );
      const agent = await createAgent({ root, projectId, agentId: "test_agent" });
      const session = await agent.createSession({});
      expect(path.relative(path.join(base, "workspaces", projectId), session.workspaceDir)).toBe(
        session.sessionId.replace(/^session-/, ""),
      );
      const marker = await fs.readFile(path.join(session.workspaceDir, ".qa-session.json"), "utf8");
      expect(JSON.parse(marker).session_id).toBe(session.sessionId);
      const workspace = session.workspaceDir;
      const sessionId = session.sessionId;
      session.dispose();
      const restored = await agent.createSession({ sessionId, workspaceDir: workspace });
      expect(restored.workspaceDir).toBe(workspace);
      expect(await fs.readFile(path.join(workspace, ".qa-session.json"), "utf8")).toBe(marker);
      restored.dispose();
    }
  });
  it("refuses sessions while a project is partially initialized", async () => {
    const root = path.join(base, "host");
    await saveProjectConfig(root, "initializing_project", seededProjectConfig());
    const marker = path.join(root, "initializing_project", "qa-project.json");
    await fs.writeFile(marker, JSON.stringify({ status: "initializing" }));
    const agent = await createAgent({ root, projectId: "initializing_project", agentId: "test_agent" });
    await expect(agent.createSession({})).rejects.toThrow("尚未初始化完成");
    await fs.writeFile(marker, JSON.stringify({ status: "ready" }));
    const session = await agent.createSession({});
    expect(session.workspaceDir).toContain("initializing_project");
    session.dispose();
  });
});
