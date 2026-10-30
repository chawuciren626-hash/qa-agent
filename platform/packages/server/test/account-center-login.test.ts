import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("central login and public configuration routes", () => {
  const previous = process.env.AITEST_ACCOUNT_CENTER;
  afterEach(() => {
    if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
    else process.env.AITEST_ACCOUNT_CENTER = previous;
  });

  it("lets a signed-in administrator read access while blocking project data", async () => {
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    try {
      const config = await test.app.request("/api/account-client/config");
      expect(await config.json()).toMatchObject({ central: true });
      expect((await test.app.request("/api/control/access")).status).toBe(401);
      const login = await test.app.request("/api/auth/admin-login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "admin", password: test.adminPassword }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const access = await test.app.request("/api/control/access", { headers: { cookie: cookie! } });
      expect(access.status).toBe(200);
      expect(((await access.json()) as { modules: string[] }).modules).toContain("agents");
      expect((await test.app.request("/api/projects", { headers: { cookie: cookie! } })).status).toBe(404);
    } finally { await test.cleanup(); }
  });
});
