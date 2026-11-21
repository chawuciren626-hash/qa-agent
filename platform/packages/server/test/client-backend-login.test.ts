import { expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createTestApp, provisionUser, restartTestApp, apiClient, type TestApp } from "./helpers.js";

it("uses backend-managed accounts for client login, logout and relogin, with administrator-only backend access", async () => {
  const previous = process.env.AITEST_ACCOUNT_CENTER;
  process.env.AITEST_ACCOUNT_CENTER = "1";
  const central = await createTestApp();
  let client: TestApp | undefined;
  let server: ReturnType<typeof serve> | undefined;
  try {
    await provisionUser(central.app, "client_user");
    const port = await new Promise<number>(resolve => {
      server = serve({ fetch: central.app.fetch, hostname: "127.0.0.1", port: 0 }, info => resolve(info.port));
    });
    delete process.env.AITEST_ACCOUNT_CENTER;
    client = await createTestApp({config:{accountClient:{origin:`http://localhost:${port}`,ownerUserId:"admin"}},durableDatabase:true});
    for (const [userId,password] of [["admin",central.adminPassword],["client_user","password-123"]]) {
      const response = await client.app.request("/api/account-client/api/auth/login", {method:"POST",headers:{"content-type":"application/json",origin:"http://localhost"},body:JSON.stringify({userId,password})});
      expect(response.status, await response.clone().text()).toBe(200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const api = apiClient(client.app,cookie);
      expect((await api.get("/api/me")).status).toBe(200);
      expect((await api.get("/api/account-client/api/admin/users")).status).toBe(userId === "admin" ? 200 : 403);
      expect((await api.post("/api/auth/logout",{})).status).toBe(204);
      client = await restartTestApp(client);
      expect((await apiClient(client.app,cookie).get("/api/me")).status).toBe(401);
      expect((await client.app.request("/api/me")).status).toBe(401);
    }
    const denied = await central.app.request("/api/auth/admin-login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userId:"client_user",password:"password-123"})});
    expect(denied.status).toBe(403);
  } finally {
    await client?.cleanup();
    if (server) await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
    await central.cleanup();
    if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
    else process.env.AITEST_ACCOUNT_CENTER = previous;
  }
});
