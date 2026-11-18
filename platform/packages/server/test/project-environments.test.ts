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
  type EnvironmentView,
} from "../src/services/project-environment-service.js";

/** 取某一步（缺了就报错，别用下标 + 断言把缺失掩盖成 undefined）。 */
function stepAt(view: Pick<EnvironmentView, "steps">, index: number) {
  const step = view.steps.find((item) => item.index === index);
  if (!step) throw new Error(`没有第 ${index} 步`);
  return step;
}

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

/**
 * 五步进度：来源只能是 Python 的 @@step 上报，不能按时间猜。
 *
 * 这里用注入的执行器发同一形状的事件，验"收到什么就写什么、没收到就是 idle"。
 */
describe("bootstrap step progress", () => {
  it("lays out five idle steps before the first run instead of a fake 0%", async () => {
    const { admin, created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const res = await admin.get(`/api/projects/${project.projectId}/environments/test`);
    const { environment } = await res.json() as { environment: EnvironmentView };
    expect(environment.steps.map(step => step.index)).toEqual([1, 2, 3, 4, 5]);
    expect(environment.steps.map(step => step.status)).toEqual(["idle", "idle", "idle", "idle", "idle"]);
    expect(stepAt(environment, 1).name).toBe("可达性探测");
    expect(environment.steps.every(step => step.ms === null)).toBe(true);
  });

  it("records what Python reported, step by step, including a still-running step", async () => {
    const { admin, created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run: BootstrapRun = async ({ onStep }) => {
      onStep?.({ index: 1, status: "running" });
      onStep?.({ index: 1, status: "done", ms: 210, detail: "HTTP 200", facts: { bytes: 4210 } });
      onStep?.({ index: 2, status: "running" });
      // 停在"第 2 步正在做"：真实建档确实会在这里停很久（抓前端骨架）。
      await gate;
      return { ok: false, error: "抓取骨架超时", report: null, paths: null };
    };
    const deps = { db: test!.deps.db, projectDir: projectDir(test!.root, project.projectId), engineRoot: "engine-root", run };
    startBootstrap(deps, project.projectId, "test");
    // 等后台那一轮把前两个事件写进去（轮询置 probing 的那一行）。
    const midway = await waitForStep(deps, project.projectId, 1, "done");
    expect(stepAt(midway, 1)).toMatchObject({ status: "done", ms: 210, detail: "HTTP 200", facts: { bytes: 4210 } });
    expect(stepAt(midway, 2).status).toBe("running");
    expect(stepAt(midway, 3).status).toBe("idle");
    expect(midway.status).toBe("probing");
    release?.();
    const finished = await awaitBootstrap(deps, project.projectId, "test");
    // 第 2 步死在半路：必须是 failed，不能永远转圈，也不能假报 done。
    expect(stepAt(finished, 2).status).toBe("failed");
    expect(stepAt(finished, 2).detail).toBe("抓取骨架超时");
    expect(stepAt(finished, 1).status).toBe("done");
    expect(stepAt(finished, 5).status).toBe("idle");
  });

  it("ignores unknown step indexes and a fresh run does not inherit the previous run's progress", async () => {
    const { created } = await projectWithEnvironment();
    const { project } = await created.json() as { project: { projectId: string } };
    const deps = { db: test!.deps.db, projectDir: projectDir(test!.root, project.projectId), engineRoot: "engine-root" };
    const first: BootstrapRun = async ({ onStep }) => {
      onStep?.({ index: 1, status: "done", ms: 10, detail: "HTTP 200" });
      onStep?.({ index: 9, status: "done", ms: 10, detail: "未来步骤" });
      return { ok: true, error: null, report: { pages: { total: 1, registered: 0 }, apis: { count: 0, modules: [] } }, paths: null };
    };
    startBootstrap({ ...deps, run: first }, project.projectId, "test");
    const done = await awaitBootstrap({ ...deps, run: first }, project.projectId, "test");
    expect(done.steps).toHaveLength(5);
    expect(stepAt(done, 1).status).toBe("done");
    // 第二轮：上一轮的 1 号 done 不能变成这一轮的进度。
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const second: BootstrapRun = async () => {
      await gate;
      return { ok: false, error: "首页不可达", report: null, paths: null };
    };
    const started = startBootstrap({ ...deps, run: second }, project.projectId, "test");
    expect(started.steps.map(step => step.status)).toEqual(["idle", "idle", "idle", "idle", "idle"]);
    release?.();
    await awaitBootstrap({ ...deps, run: second }, project.projectId, "test");
  });
});

/** 等某个步骤达到期望状态（后台执行器写库是异步的，不能靠固定 sleep）。 */
async function waitForStep(
  deps: Parameters<typeof awaitBootstrap>[0],
  projectId: string,
  index: number,
  status: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const view = findEnvironment(deps.db, projectId, "test");
    if (view?.steps.find(step => step.index === index)?.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`step ${index} 没有在 5s 内进入 ${status}`);
}
