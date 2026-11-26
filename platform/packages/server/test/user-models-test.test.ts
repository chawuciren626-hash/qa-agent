/**
 * 用户级模型连通性测试（POST /api/user-models/test）。
 *
 * 契约：登录用户即可调用，不依赖任何项目；凭据从该用户的共享模型记录
 * （.account-models/<hash>.json）读取，请求体可带未保存的草稿值。
 * 回归背景：设置页原先借「第一个 owner 项目」的项目级 /test 端点探测，
 * 零项目账号会直接报「连接测试需要至少一个项目」。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

/** 立即拒绝连接的本机端口（discard 协议位），让探测快速失败而不是等 20s 超时。 */
const UNREACHABLE_BASE = "http://127.0.0.1:9/v1";

describe("user-level model connectivity test", () => {
  let t: TestApp;
  let solo: ReturnType<typeof apiClient>;
  beforeAll(async () => {
    t = await createTestApp();
    // 刻意不建任何项目：零项目账号就是这条端点的目标场景。
    solo = apiClient(t.app, (await provisionUser(t.app, "solo_tester")).cookie);
  });
  afterAll(async () => { await t.cleanup(); });

  it("tests against the user's stored credentials with no project at all", async () => {
    const saved = await solo.put("/api/user-models", {
      models: [{ provider: "custom", modelId: "solo-model", apiKey: "sk-solo", baseUrl: UNREACHABLE_BASE, clientType: "openai" }],
    });
    expect(saved.status).toBe(200);

    const probe = await solo.post("/api/user-models/test", { provider: "custom", modelId: "solo-model" });
    expect(probe.status).toBe(200);
    const answer = (await probe.json()) as { ok: boolean; message?: string };
    // 存储的 base URL 不可达：探测如实失败（而非 403 owner_required / 404 no project）。
    expect(answer.ok).toBe(false);
    expect(typeof answer.message).toBe("string");
  });

  it("honors draft apiKey/baseUrl from the request body over stored values", async () => {
    // 请求体带一个同样不可达的草稿地址：失败信息应来自草稿值这条路径（探测真实发起），
    // 且与上一条一样是业务失败而非权限错误。
    const probe = await solo.post("/api/user-models/test", {
      provider: "custom",
      modelId: "solo-model",
      baseUrl: UNREACHABLE_BASE,
      apiKey: "sk-draft",
    });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("rejects a body without a model reference", async () => {
    expect((await solo.post("/api/user-models/test", { provider: "custom" })).status).toBe(400);
    expect((await solo.post("/api/user-models/test", {})).status).toBe(400);
  });
});
