import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { qaAuthorization } from "../src/http/qa-authorization.js";

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("managed capability permissions", () => {
  function app(admin = false) {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("user", { userId: "owner", isAdmin: admin }); await next(); });
    app.use("*", qaAuthorization({ requireProjectAccess: () => ({ ownerUserId: "owner" }) } as never));
    app.all("*", c => c.json({ ok: true }));
    app.onError((error: any, c) => c.json({ code: error.code }, error.status ?? 500));
    return app;
  }
  it("allows reads but rejects personal uploads, selection changes and Agent capability mutations", async () => {
    const api = app();
    const base = "/api/projects/p/agents/qa/personal-resources";
    expect((await api.request(base)).status).toBe(200);
    for (const [method, path] of [
      ["POST", base], ["POST", base + "/selection"],
      ["POST", base + "/r/apply"], ["POST", base + "/r/remove"],
      ["DELETE", base + "/r"], ["POST", base + "/selection/r/consume"],
      ["POST", "/api/projects/p/agents/test_agent/skills/archive"],
      ["POST", "/api/projects/p/agents/test_agent/plugins"],
      ["DELETE", "/api/projects/p/agents/test_agent/hooks/h"],
    ]) expect((await api.request(path!, { method })).status, path).toBe(403);
  });
  it("preserves administrator configuration and normal task operations", async () => {
    expect((await app(true).request("/api/projects/p/agents/test_agent/skills/archive", { method: "POST" })).status).toBe(200);
    expect((await app().request("/api/projects/p/agents/qa/tasks/task/context-snapshot", { method: "POST" })).status).toBe(200);
  });
});
