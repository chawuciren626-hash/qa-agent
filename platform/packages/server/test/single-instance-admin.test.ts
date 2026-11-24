import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const previous = process.env.AITEST_ACCOUNT_CENTER;
afterEach(() => {
  if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
  else process.env.AITEST_ACCOUNT_CENTER = previous;
});

describe("unified administrator and user server", () => {
  it("serves management and business APIs from the same app regardless of the retired mode flag", async () => {
    // The flag used to turn this process into a restricted, separate account-center server.
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    try {
      const config = await test.app.request("/api/account-client/config");
      expect(config.status).toBe(200);
      expect(await config.json()).toMatchObject({ enabled: false, central: false });

      // Missing authentication reaches each route's normal auth middleware. A 404 here
      // means the old account-center route whitelist still owns deployment behavior.
      expect((await test.app.request("/api/control/admin/menus")).status).toBe(401);
      expect((await test.app.request("/api/admin/task-platform/settings")).status).toBe(401);
    } finally {
      await test.cleanup();
    }
  });
});
