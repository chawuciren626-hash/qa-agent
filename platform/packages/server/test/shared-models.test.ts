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

  it("toggles the account-global default model and mirrors the pointer to every project", async () => {
    // 两个模型共存的全局配置：默认先指向 shared-v1。
    const setup = await alice.put("/api/user-models", {
      defaultModel: { provider: "custom", modelId: "shared-v2" },
      models: [
        { provider: "custom", modelId: "shared-v1", apiKey: "sk-a", baseUrl: "https://example.org/v1", clientType: "openai" },
        { provider: "custom", modelId: "shared-v2", apiKey: "sk-b", baseUrl: "https://example.org/v1", clientType: "openai" },
      ],
    });
    expect(setup.status).toBe(200);
    expect(((await (await alice.get("/api/user-models")).json()) as { defaultModel?: { modelId: string } }).defaultModel?.modelId).toBe("shared-v2");

    // 切换到 v1：用户级 default 与两个项目镜像同步变化，模型表/凭据不动。
    const toggled = await alice.put("/api/user-models/default", { defaultModel: { provider: "custom", modelId: "shared-v1" } });
    expect(toggled.status).toBe(200);
    expect(((await (await alice.get("/api/user-models")).json()) as { defaultModel?: { modelId: string } }).defaultModel?.modelId).toBe("shared-v1");
    expect(await readFile(path.join(t.root, "sharedalice-a", ".project_config.toml"), "utf8")).toContain('model_id = "shared-v1"');
    expect(await readFile(path.join(t.root, "sharedalice-b", ".project_config.toml"), "utf8")).toContain('model_id = "shared-v1"');
    const afterToggle = (await (await alice.get("/api/user-models")).json()) as { models: Array<{ modelId: string }> };
    expect(afterToggle.models.map((m) => m.modelId).sort()).toEqual(["shared-v1", "shared-v2"]);

    // 清除：用户级 default 消失（消费点回退第一条），两个模型都保留。
    const cleared = await alice.put("/api/user-models/default", { defaultModel: null });
    expect(cleared.status).toBe(200);
    expect(((await (await alice.get("/api/user-models")).json()) as { defaultModel?: unknown }).defaultModel).toBeUndefined();
    const afterClear = (await (await alice.get("/api/user-models")).json()) as { models: Array<{ modelId: string }> };
    expect(afterClear.models).toHaveLength(2);

    // 指向不存在的模型必须 400。
    expect((await alice.put("/api/user-models/default", { defaultModel: { provider: "custom", modelId: "nope" } })).status).toBe(400);
  });
});
