import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionService, type SessionServiceDeps } from "../src/services/session-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it("refuses an unpinned shared Session before creating its local runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-session-"));
  roots.push(root);
  const state = path.join(root, "project", "agents", "role", "agent_state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "shared-agent.json"), JSON.stringify({ version: 1, agentId: "role" }));
  const pin = vi.fn(async () => false);
  const service = new SessionService({
    root,
    projectConfig: { getDefaultModelRef: async () => ({ provider: "test", model_id: "model" }) },
    pinPublishedSession: pin,
  } as unknown as SessionServiceDeps);
  await expect(service.createSession({ projectId: "project", agentId: "role" })).rejects.toMatchObject({ code: "shared_agent_identity_unavailable" });
  expect(pin).not.toHaveBeenCalled();
  await expect(service.createSession({ projectId: "project", agentId: "role", userId: "user" })).rejects.toMatchObject({ code: "shared_agent_unavailable" });
  expect(pin).toHaveBeenCalledOnce();
});
