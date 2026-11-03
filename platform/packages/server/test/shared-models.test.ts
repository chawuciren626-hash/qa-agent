import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("account shared models", () => {
  let t: TestApp;
  let alice: ReturnType<typeof apiClient>;
  let bob: ReturnType<typeof apiClient>;
  const models = (id: string) => `/api/projects/${id}/models`;
  beforeAll(async () => {
    t = await createTestApp();
    alice = apiClient(t.app, (await provisionUser(t.app, "sharedalice")).cookie);
    bob = apiClient(t.app, (await provisionUser(t.app, "sharedbob")).cookie);
    for (const [client, id] of [[alice, "sharedalice-a"], [alice, "sharedalice-b"], [bob, "sharedbob-other"]] as const) {
      expect((await client.post("/api/projects", { projectId: id, name: id })).status).toBe(201);
    }
  });
  afterAll(async () => { await t.cleanup(); });

  it("shares the first model edit automatically, isolates other accounts, propagates edits, and seeds future projects", async () => {
    const source = await alice.put(models("sharedalice-a"), { defaultModel: { provider: "custom", modelId: "shared-v1" }, models: [{ provider: "custom", modelId: "shared-v1", apiKey: "sk-shared-secret", baseUrl: "https://example.org/v1", clientType: "openai" }] });
    expect(source.status).toBe(200);
    const copied = await readFile(path.join(t.root, "sharedalice-b", ".project_config.toml"), "utf8");
    expect(copied).toContain("sk-shared-secret");
    expect((await readFile(path.join(t.root, "sharedbob-other", ".project_config.toml"), "utf8"))).not.toContain("shared-v1");
    const update = await alice.put(models("sharedalice-b"), { defaultModel: { provider: "custom", modelId: "shared-v2" }, models: [{ provider: "custom", modelId: "shared-v2", apiKey: "sk-shared-next", baseUrl: "https://example.org/v1", clientType: "openai" }] });
    expect(update.status).toBe(200);
    expect((await readFile(path.join(t.root, "sharedalice-a", ".project_config.toml"), "utf8"))).toContain("shared-v2");
    expect((await alice.post("/api/projects", { projectId: "sharedalice-c", name: "Future" })).status).toBe(201);
    expect((await readFile(path.join(t.root, "sharedalice-c", ".project_config.toml"), "utf8"))).toContain("shared-v2");
    expect(JSON.stringify(await (await alice.get(`${models("sharedalice-a")}/shared`)).json())).not.toContain("sk-shared-next");
  });
});
