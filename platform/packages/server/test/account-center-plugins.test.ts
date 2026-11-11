import { afterEach, expect, it } from "vitest";
import { createTestApp, provisionUser } from "./helpers.js";
const previous = process.env.AITEST_ACCOUNT_CENTER;
afterEach(() => {
  if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
  else process.env.AITEST_ACCOUNT_CENTER = previous;
});
it("restricts upstream plugin reads and mutations to service administrators", async () => {
  process.env.AITEST_ACCOUNT_CENTER = "1";
  const test = await createTestApp();
  try {
    const login = await test.app.request("/api/auth/admin-login", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({userId: "admin", password: test.adminPassword}),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const ordinary = await provisionUser(test.app, "plugin_reader");
      for (const path of ["/api/plugins", "/api/plugins/registry", "/api/admin/plugin-config"]) {
        expect((await test.app.request(path)).status).toBe(401);
        expect((await test.app.request(path, {headers: {cookie: ordinary.cookie}})).status).toBe(403);
        expect((await test.app.request(path, {headers: {cookie: cookie!}})).status).toBe(200);
      }
      for (const [method, path] of [["PUT", "/api/admin/plugin-config"], ["POST", "/api/admin/plugin-config/action"], ["POST", "/api/projects/admin_agent_catalog/plugins/installed"]]) {
        expect((await test.app.request(path!, {method, headers: {cookie: ordinary.cookie, "content-type": "application/json"}, body: "{}"})).status).toBe(403);
      }

      for (const path of ["/api/plugins", "/api/plugins/registry", "/api/admin/plugin-config"]) {
        expect((await test.app.request(path)).status).toBe(401);
        expect((await test.app.request(path, {headers: {cookie: ordinary.cookie}})).status).toBe(403);
        expect((await test.app.request(path, {headers: {cookie: cookie!}})).status).toBe(200);
      }
      for (const [method, path] of [["PUT", "/api/admin/plugin-config"], ["POST", "/api/admin/plugin-config/action"], ["POST", "/api/projects/admin_agent_catalog/plugins/installed"]]) {
        expect((await test.app.request(path!, {method, headers: {cookie: ordinary.cookie, "content-type": "application/json"}, body: "{}"})).status).toBe(403);
      }


  } finally { await test.cleanup(); }
});
