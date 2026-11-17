/**
 * 被测环境（B1）：地址归环境、四态状态机、失败不冒充成功。
 *
 * 建档子进程在这里被替换成注入的执行器：单测不该依赖 Python 与网络。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { projectDir } from "@prismshadow/penguin-core";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";
import {
  awaitBootstrap,
  findEnvironment,
  startBootstrap,
  type BootstrapRun,
} from "../src/services/project-environment-service.js";

let test: TestApp | undefined;
afterEach(async () => { await test?.cleanup(); test = undefined; });

async function projectWithEnvironment(baseUrl = "http://gateway.example.com") {
  test = await createTestApp();
  const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
  const created = await admin.post("/api/projects/managed", {
    projectId: "env_project", name: "环境项目", environment: { env: "test", baseUrl },
  });
  return { admin, created };
}

describe("project environments", () => {
  it("stores the address on the environment and shows 未建档 instead of 0 pages", async () => {
    const { admin, created } = await projectWithEnvironment();
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: { projectId: string; environment: Record<string, unknown> } };
    expect(project.environment).toMatchObject({
      env: "test", baseUrl: "http://gateway.example.com", isDefault: true, status: "unregistered", pages: null, apis: null,
    });
    const list = await admin.get(`/api/projects/${project.projectId}/environments`);
    expect(list.status).toBe(200);
    const body = await list.json() as { defaultEnv: string; environments: { env: string }[] };
    expect(body.defaultEnv).toBe("test");
    expect(body.environments.map(item => item.env)).toEqual(["test"]);
  });

  it("rejects non-http, credential-bearing and metadata addresses, and bad env names", async () => {
    test = await createTestApp();
    const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
    for (const baseUrl of ["ftp://gateway.example.com", "http://user:pass@gateway.example.com", "http://169.254.169.254/latest/meta-data", "not-a-url"]) {
      const res = await admin.post("/api/projects/managed", { projectId: `bad_${Math.random().toString(36).slice(2, 8)}`, name: "坏地址", environment: { baseUrl } });
      expect(res.status, baseUrl).toBe(400);
    }
    const badName = await admin.post("/api/projects/managed", { projectId: "bad_env_name", name: "坏环境名", environment: { env: "TEST", baseUrl: "http://gateway.example.com" } });
    expect(badName.status).toBe(400);
    // 校验失败不留半创建：这些 id 都能被正常创建出来。
    const again = await admin.post("/api/projects/managed", { projectId: "bad_env_name", name: "重新建", environment: { env: "test", baseUrl: "http://gateway.example.com" } });
    expect(again.status).toBe(201);
  });

  it("keeps a failed bootstrap failed — no pages, no success status", async () => {
    const { created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const run: BootstrapRun = async () => ({ ok: false, error: "首页不可达", report: null, paths: null });
    const deps = {
      db: test!.deps.db,
      projectDir: projectDir(test!.root, project.projectId),
      engineRoot: "engine-root",
      run,
    };
    const started = startBootstrap(deps, project.projectId, "test");
    expect(started.status).toBe("probing");
    const finished = await awaitBootstrap(deps, project.projectId, "test");
    expect(finished.status).toBe("failed");
    expect(finished.pages).toBeNull();
    expect(finished.apis).toBeNull();
    expect(finished.lastError).toBe("首页不可达");
    expect(finished.probedAt).not.toBeNull();
  });

  it("records the summary a successful bootstrap produced", async () => {
    const { created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const dir = projectDir(test!.root, project.projectId);
    const run: BootstrapRun = async ({ outDir }) => ({
      ok: true,
      error: null,
      report: {
        pages: { total: 12, registered: 0 },
        apis: { count: 34, modules: ["order", "user"] },
        login: { captcha_type: "image" },
        warnings: [],
      },
      paths: { maps: path.join(outDir, "maps-test.yaml"), report: path.join(outDir, "bootstrap-report-test.md") },
    });
    const deps = { db: test!.deps.db, projectDir: dir, engineRoot: "engine-root", run };
    startBootstrap(deps, project.projectId, "test");
    const finished = await awaitBootstrap(deps, project.projectId, "test");
    expect(finished.status).toBe("registered");
    expect(finished.pages).toEqual({ total: 12, registered: 0 });
    expect(finished.apis).toEqual({ total: 34, modules: ["order", "user"] });
    expect(finished.loginCaptcha).toBe("image");
    expect(finished.mapsPath).toBe("maps/test/maps-test.yaml");
    expect(finished.lastError).toBeNull();
  });

  it("resets the summary when the address changes, so old counts never describe a new site", async () => {
    const { admin, created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const run: BootstrapRun = async () => ({
      ok: true, error: null,
      report: { pages: { total: 3, registered: 0 }, apis: { count: 1, modules: ["a"] } },
      paths: null,
    });
    const deps = { db: test!.deps.db, projectDir: projectDir(test!.root, project.projectId), engineRoot: "engine-root", run };
    startBootstrap(deps, project.projectId, "test");
    await awaitBootstrap(deps, project.projectId, "test");
    expect(findEnvironment(test!.deps.db, project.projectId, "test")?.status).toBe("registered");
    const changed = await admin.post(`/api/projects/${project.projectId}/environments`, { env: "test", baseUrl: "http://other.example.com" });
    expect(changed.status).toBe(201);
    const view = (await changed.json() as { environment: { status: string; pages: unknown } }).environment;
    expect(view.status).toBe("unregistered");
    expect(view.pages).toBeNull();
  });

  it("denies environments to a non-member", async () => {
    const { created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const outsider = apiClient(test!.app, (await provisionUser(test!.app, "env_outsider")).cookie);
    expect((await outsider.get(`/api/projects/${project.projectId}/environments`)).status).toBe(404);
    expect((await outsider.post(`/api/projects/${project.projectId}/environments`, { baseUrl: "http://x.example.com" })).status).toBe(404);
  });
});
