import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { accountCenterGate } from "../src/http/account-center.js";

describe("central Web boundary", () => {
  const app = new Hono();
  app.use("*", accountCenterGate(true));
  app.all("*", c => c.text("downstream authentication and routes"));
  it("allows both Web entries and upstream personal settings to reach their normal auth routes", async () => {
    for (const [method, path] of [["GET", "/user/"], ["GET", "/user/login"], ["GET", "/admin/overview"], ["GET", "/aith-logo.svg"], ["GET", "/api/me/prefs"], ["PUT", "/api/me/profile"], ["PUT", "/api/me/prefs"]]) {
      expect((await app.request(path!, { method })).status).toBe(200);
    }
  });
  it("admits the central administrator assistant's scoped runtime routes", async () => {
    for (const [method, path] of [["GET", "/api/projects"], ["POST", "/api/projects"], ["GET", "/api/projects/admin_agent_catalog/agents"], ["POST", "/api/projects/admin_agent_catalog/agents/default_agent/sessions"], ["GET", "/api/sessions/s1/messages"], ["POST", "/api/sessions/s1/tasks"], ["GET", "/api/events"]]) {
      expect((await app.request(path!, { method })).status).toBe(200);
    }
  });
  it("still blocks unrelated project, task and file routes in the central service", async () => {
    for (const [method, path] of [["GET", "/api/projects/other_project/agents"], ["POST", "/api/projects/other_project/agents/default_agent/sessions"], ["POST", "/api/sessions"], ["GET", "/api/files"], ["PUT", "/api/admin/settings"], ["DELETE", "/api/me/profile"]]) {
      expect((await app.request(path!, { method })).status).toBe(404);
    }
  });
});
