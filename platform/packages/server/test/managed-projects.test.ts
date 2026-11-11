import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";

let test: TestApp | undefined;
afterEach(async () => { await test?.cleanup(); test = undefined; });

describe("managed projects", () => {
  it("counts in-progress test runs in the list and detail without treating planned runs as active", async () => {
    test = await createTestApp();
    const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
    const created = await admin.post("/api/projects/managed", { projectId: "run_statistics", name: "运行统计" });
    const { project } = await created.json() as { project: { projectId: string } };
    const workspace = path.join(test.root, "managed-run-workspace");
    for (const [id, status] of [["running", "in_progress"], ["planned", "planned"], ["finished", "completed"]]) {
      const dir = path.join(workspace, "output", "runs", `run-${id}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ directory_context: { session_id: "managed-session" }, status }));
    }
    test.deps.db.prepare("INSERT INTO sessions (session_id,project_id,agent_id,provider,model_id,workspace,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("managed-session", project.projectId, "qa", "test", "test", workspace, new Date().toISOString());
    const list = await admin.get("/api/projects/managed?keyword=运行统计");
    expect((await list.json() as { projects: { runningTaskCount: number }[] }).projects[0]?.runningTaskCount).toBe(1);
    const detail = await admin.get(`/api/projects/managed/${project.projectId}`);
    expect((await detail.json() as { project: { runningTaskCount: number } }).project.runningTaskCount).toBe(1);
  });

  it("creates a real project and keeps pin preferences per account", async () => {
    test = await createTestApp();
    const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
    const member = apiClient(test.app, (await provisionUser(test.app, "project_member")).cookie);
    const created = await admin.post("/api/projects/managed", { projectId: "payment_test", name: "支付测试", description: "回归" });
    expect(created.status).toBe(201);
    const row = (await created.json() as { project: { projectId: string; revision: number } }).project;
    expect(row.projectId).toBe("payment_test");
    expect((await admin.post("/api/projects/managed", { projectId: "payment_test", name: "重复" })).status).toBe(409);
    expect((await admin.post("/api/projects/managed", { projectId: "Bad-Id", name: "无效" })).status).toBe(400);
    expect((await admin.post("/api/projects/managed", { name: "缺少编号" })).status).toBe(400);
    expect((await admin.get("/api/projects/managed?status=active")).status).toBe(200);
    expect((await member.get(`/api/projects/managed/${row.projectId}`)).status).toBe(404);
    expect((await admin.put(`/api/projects/managed/${row.projectId}/pin`, { pinned: true })).status).toBe(200);
    const adminList = await admin.get("/api/projects/managed?keyword=支付测试");
    expect((await adminList.json() as { projects: { isPinned: boolean }[] }).projects[0]?.isPinned).toBe(true);
    const memberList = await member.get("/api/projects/managed?keyword=支付测试");
    expect((await memberList.json() as { total: number }).total).toBe(0);
  });

  it("enforces the owner's project id namespace", async () => {
    test = await createTestApp();
    const member = apiClient(test.app, (await provisionUser(test.app, "project_member")).cookie);
    expect((await member.post("/api/projects/managed", { projectId: "shared_project", name: "无前缀" })).status).toBe(400);
    const created = await member.post("/api/projects/managed", { projectId: "project_member-payment", name: "支付项目" });
    expect(created.status).toBe(201);
    expect((await created.json() as { project: { projectId: string } }).project.projectId).toBe("project_member-payment");
  });

  it("rejects stale edits and queued task archives", async () => {
    test = await createTestApp();
    const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
    const created = await admin.post("/api/projects/managed", { projectId: "managed_test", name: "测试项目" });
    const row = (await created.json() as { project: { projectId: string; revision: number } }).project;
    expect((await admin.patch(`/api/projects/managed/${row.projectId}`, { name: "新版", expectedRevision: row.revision })).status).toBe(200);
    expect((await admin.patch(`/api/projects/managed/${row.projectId}`, { name: "旧版", expectedRevision: row.revision })).status).toBe(409);
    test.deps.db.prepare("INSERT INTO unattended_runs (run_id,project_id,agent_id,name,slot_ms,owner_user_id,device_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("queued-1", row.projectId, "qa", "run", 1, "admin", "local", "queued", new Date().toISOString(), new Date().toISOString());
    expect((await admin.post(`/api/projects/managed/${row.projectId}/archive`, {})).status).toBe(409);
    test.deps.db.prepare("DELETE FROM unattended_runs WHERE run_id=?").run("queued-1");
    expect((await admin.post(`/api/projects/managed/${row.projectId}/archive`, {})).status).toBe(200);
    expect((await admin.post(`/api/projects/managed/${row.projectId}/enter`, {})).status).toBe(409);
    expect((await admin.post(`/api/projects/managed/${row.projectId}/restore`, {})).status).toBe(200);
  });
});
