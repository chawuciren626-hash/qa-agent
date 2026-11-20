/**
 * 探索派发：一轮一条、append-only、失败不写资产、验证码人工通道、并发与残留处理。
 *
 * 脚本子进程与 Python 合并器在这里都被替换成注入实现：单测不该依赖 Chromium 与网络。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "@prismshadow/penguin-core";
import { apiClient, createTestApp, loginAdmin, type TestApp } from "./helpers.js";
import {
  abortExploration,
  answerCaptcha,
  captchaImagePath,
  deriveKnowledge,
  latestExploration,
  listExplorations,
  startExploration,
  type ExplorationDeps,
  type ExplorationMerge,
  type ExplorationRun,
  type ExplorationRunInput,
  type ExplorationView,
} from "../src/services/project-exploration-service.js";
import { explorationKnowledgeSync } from "../src/services/exploration-knowledge-sync.js";
import type { ToolRunner } from "../src/services/qa-knowledge-tool.js";

let test: TestApp | undefined;
afterEach(async () => {
  await test?.cleanup();
  test = undefined;
});

async function projectWithRegisteredEnv(baseUrl = "http://gateway.example.com"): Promise<string> {
  test = await createTestApp();
  const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
  const created = await admin.post("/api/projects/managed", {
    projectId: "explore_project",
    name: "探索项目",
    environment: { env: "test", baseUrl },
  });
  expect(created.status).toBe(201);
  // 探索要求先建档：直接把环境置成 registered，省掉一次假的 Python 建档。
  test.deps.db
    .prepare(
      `UPDATE project_environments SET status='registered', pages_total=12, pages_registered=12,
         apis_total=28, api_modules='["卡池"]', login_captcha='image', probed_at=?
         WHERE project_id=? AND env='test'`,
    )
    .run(new Date().toISOString(), "explore_project");
  return "explore_project";
}

function depsOf(projectId: string, overrides: Partial<ExplorationDeps> = {}): ExplorationDeps {
  return {
    db: test!.deps.db,
    projectDir: projectDir(test!.root, projectId),
    engineRoot: "engine-root",
    ...overrides,
  };
}

async function waitForStatus(
  deps: ExplorationDeps,
  projectId: string,
  predicate: (view: ExplorationView | null) => boolean,
  timeoutMs = 3_000,
): Promise<ExplorationView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = latestExploration(deps.db, projectId, "test");
    if (predicate(view)) return view as ExplorationView;
    if (Date.now() > deadline) throw new Error(`探索状态未在 ${timeoutMs}ms 内到达预期：${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const mapsFixture: ExplorationMerge = async ({ exploreDir }) => {
  const mapsPath = path.join(exploreDir, "maps-test.json");
  const maps = {
    pages: [
      { route: "/gateway-admin/user/key-card/index", registered: true, control_count: 14 },
      { route: "/gateway-admin/user/package/index", registered: false, control_count: 0 },
    ],
    apis: [
      { method: "post", path: "/gateway-admin/sysMenu/list", module: "菜单", required: ["sort"] },
      { method: "GET", path: "/gateway-admin/captchaImage", module: "登录" },
    ],
    login: { captcha_type: "image", form_detected: true },
    stats: { pages: 2, pages_registered: 1, apis: 2, controls: 14 },
  };
  await fs.mkdir(exploreDir, { recursive: true });
  await fs.writeFile(mapsPath, JSON.stringify(maps));
  return { mapsPath: "maps-test.json", maps };
};

/** 写满探索产物后按结论返回；所有测试都用它，保证成功路径的输入形状一致。 */
function runWritingReceipt(result: { ok: boolean; error?: string }): ExplorationRun {
  return (input: ExplorationRunInput) => {
    let resolve!: (value: { ok: boolean; error: string | null }) => void;
    const done = new Promise<{ ok: boolean; error: string | null }>((r) => { resolve = r; });
    void (async () => {
      await fs.mkdir(path.join(input.outDir, "shots"), { recursive: true });
      if (result.ok) {
        await fs.writeFile(path.join(input.outDir, "structure.json"), JSON.stringify({ interactive: [{ tag: "button" }] }));
        await fs.writeFile(path.join(input.outDir, "apis.json"), JSON.stringify([{ method: "POST", path: "/x" }]));
        await fs.writeFile(path.join(input.outDir, "explore-receipt.json"), JSON.stringify({
          controls: 14, tables: 1, apis: 2, structure_digest: "abc12345", session_reused: true,
          limitations: ["单页面快照：不含业务流程与跳转链。"],
        }));
      }
      input.onEvent({ kind: "step", index: 3, status: "done", detail: "登录成功" });
      resolve({ ok: result.ok, error: result.ok ? null : result.error ?? "登录未成功" });
    })();
    return { done, answer: async () => undefined, abort: () => undefined };
  };
}

/** 全站模式 run 夹具：pages.json 多页产物（2 成功 1 失败），收尾步带「3/3 页」进度。 */
function runWritingSiteReceipt(): ExplorationRun {
  return (input: ExplorationRunInput) => {
    let resolve!: (value: { ok: boolean; error: string | null }) => void;
    const done = new Promise<{ ok: boolean; error: string | null }>((r) => { resolve = r; });
    void (async () => {
      await fs.mkdir(path.join(input.outDir, "shots", "pages"), { recursive: true });
      const structure = (tag: string) => ({ interactive: [{ tag }], tables: [], breadcrumb: [] });
      await fs.writeFile(path.join(input.outDir, "structure.json"), JSON.stringify(structure("button")));
      await fs.writeFile(path.join(input.outDir, "apis.json"), JSON.stringify([{ method: "POST", path: "/x" }]));
      await fs.writeFile(path.join(input.outDir, "pages.json"), JSON.stringify([
        { route: "/gateway-admin/user/key-card/index", ok: true, controls: 14, tables: 1, structure: structure("button") },
        { route: "/gateway-admin/user/package/index", ok: true, controls: 9, tables: 0, structure: structure("input") },
        { route: "/gateway-admin/sysSetting/index", ok: false, reason: "redirected:/gateway-admin/login" },
      ]));
      await fs.writeFile(path.join(input.outDir, "explore-receipt.json"), JSON.stringify({
        mode: "site", controls: 14, tables: 1, apis: 2, structure_digest: "abc12345", session_reused: true,
        pages_total: 3, pages_ok: 2, pages_failed: 1,
        limitations: ["全站逐页快照：只采页面结构与本页触发过的接口，不含跨页业务流程与状态迁移。"],
      }));
      input.onEvent({ kind: "step", index: 3, status: "done", detail: "登录成功" });
      input.onEvent({ kind: "step", index: 4, status: "done", detail: "全站 2/3 页 · 目标页 14 控件" });
      resolve({ ok: true, error: null });
    })();
    return { done, answer: async () => undefined, abort: () => undefined };
  };
}

describe("exploration dispatch", () => {
  it("refuses to dispatch before the environment is registered", async () => {
    test = await createTestApp();
    const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
    await admin.post("/api/projects/managed", {
      projectId: "explore_project", name: "探索项目", environment: { env: "test", baseUrl: "http://gateway.example.com" },
    });
    const res = await admin.post("/api/projects/explore_project/environments/test/explore", {});
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("environment_not_registered");
  });

  it("runs a round, merges maps and writes module/interface/wall knowledge", async () => {
    const projectId = await projectWithRegisteredEnv();
    const deps = depsOf(projectId, { run: runWritingReceipt({ ok: true }), merge: mapsFixture });
    const started = startExploration(deps, projectId, "test", {
      targetUrl: "http://gateway.example.com/gateway-admin/user/key-card/index",
      loginUrl: "http://gateway.example.com/gateway-admin/login",
      username: "admin",
      password: "secret",
    });
    expect(started.round).toBe(1);
    expect(started.status).toBe("running");
    expect(started.loginMode).toBe("authenticated");

    const finished = await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");
    expect(finished.summary).toMatchObject({ controls: 14, apis: 2, knowledgeLayers: ["module", "interface", "wall"] });
    // 凭据临时文件必须删掉（不进库、不留盘）。
    await expect(fs.stat(path.join(deps.projectDir, "explore", "test", "round-1", "credentials.json"))).rejects.toThrow();

    const admin = apiClient(test!.app, (await loginAdmin(test!.app)).cookie);
    const knowledge = await admin.get(`/api/projects/${projectId}/environments/test/knowledge`);
    expect(knowledge.status).toBe(200);
    const body = await knowledge.json() as {
      knowledge: { lastRound: number; counts: Record<string, number>; layers: Record<string, { key: string }[]> };
    };
    expect(body.knowledge.lastRound).toBe(1);
    expect(body.knowledge.counts.module).toBe(2);
    expect(body.knowledge.counts.interface).toBe(2);
    expect(body.knowledge.counts.wall).toBe(2);
    // flow 单页探索给不出：不写空层，免得把已有的链路资产擦掉。
    expect(body.knowledge.counts.flow).toBe(0);
  });

  it("site mode: multi-page receipt drives per-page registration and honest failure counts", async () => {
    const projectId = await projectWithRegisteredEnv();
    const mapsFixtureSite: ExplorationMerge = async ({ exploreDir }) => {
      const mapsPath = path.join(exploreDir, "maps-test.json");
      const maps = {
        pages: [
          { route: "/gateway-admin/user/key-card/index", registered: true, control_count: 14 },
          { route: "/gateway-admin/user/package/index", registered: true, control_count: 9 },
          { route: "/gateway-admin/sysSetting/index", registered: false, control_count: 0 },
          { route: "/gateway-admin/login", registered: false, control_count: 0 },
        ],
        apis: [{ method: "post", path: "/gateway-admin/sysMenu/list", module: "菜单", required: ["sort"] }],
        login: { captcha_type: "image", form_detected: true },
        stats: { pages: 4, pages_registered: 2, apis: 1, controls: 23 },
      };
      await fs.mkdir(exploreDir, { recursive: true });
      await fs.writeFile(mapsPath, JSON.stringify(maps));
      return { mapsPath: "maps-test.json", maps };
    };
    const deps = depsOf(projectId, { run: runWritingSiteReceipt(), merge: mapsFixtureSite });
    startExploration(deps, projectId, "test", {
      targetUrl: "http://gateway.example.com/gateway-admin/user/key-card/index",
      loginUrl: "http://gateway.example.com/gateway-admin/login",
      username: "admin",
      password: "secret",
    });
    const finished = await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");
    // 摘要如实回答三件事：什么模式、采到几页、几页没采到。
    expect(finished.summary).toMatchObject({ mode: "site", pagesOk: 2, pagesFailed: 1 });
    // 采集页步骤的 detail 带「2/3 页」：跑几页、卡在哪一眼可见。
    const step4 = finished.steps.find((step) => step.index === 4);
    expect(step4?.detail).toContain("2/3 页");
    // 四层知识只按 maps 来：两张已渲染页出现在 module 层，失败页如实标「仅路由·未采控件」。
    const moduleLayer = (finished.summary?.knowledgeLayers ?? []).includes("module");
    expect(moduleLayer).toBe(true);
  });

  it("keeps a failed round failed: no knowledge, error kept, round number still consumed", async () => {
    const projectId = await projectWithRegisteredEnv();
    const deps = depsOf(projectId, { run: runWritingReceipt({ ok: false, error: "登录未成功（验证码错误）" }), merge: mapsFixture });
    startExploration(deps, projectId, "test", {});
    const failed = await waitForStatus(deps, projectId, (view) => view?.status === "failed");
    expect(failed.lastError).toContain("登录未成功");
    expect(failed.summary).toBeNull();

    const admin = apiClient(test!.app, (await loginAdmin(test!.app)).cookie);
    const knowledge = await admin.get(`/api/projects/${projectId}/environments/test/knowledge`);
    const body = await knowledge.json() as { knowledge: { lastRound: number; counts: Record<string, number> } };
    expect(body.knowledge.lastRound).toBe(0);
    expect(body.knowledge.counts.module).toBe(0);

    // 失败轮照样占 round 号：下一轮是第 2 轮，不是「第 1 轮重来」。
    const secondDeps = depsOf(projectId, { run: runWritingReceipt({ ok: true }), merge: mapsFixture });
    const second = startExploration(secondDeps, projectId, "test", {});
    expect(second.round).toBe(2);
    await waitForStatus(secondDeps, projectId, (view) => view?.round === 2 && view.status === "succeeded");
  });

  it("parks on the human captcha channel and resumes with the operator answer", async () => {
    const projectId = await projectWithRegisteredEnv();
    const answers: string[] = [];
    let release!: () => void;
    const run: ExplorationRun = (input) => {
      let resolve!: (value: { ok: boolean; error: string | null }) => void;
      const done = new Promise<{ ok: boolean; error: string | null }>((r) => { resolve = r; });
      void (async () => {
        const captcha = path.join(input.outDir, "shots", "captcha.png");
        await fs.mkdir(path.dirname(captcha), { recursive: true });
        await fs.writeFile(captcha, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        input.onEvent({ kind: "captcha", status: "waiting", path: captcha, strategies: ["test_bypass_code", "local_arithmetic_recognition", "captcha_service"] });
        release = () => resolve({ ok: true, error: null });
      })();
      return {
        done,
        answer: async (answer: string) => { answers.push(answer); },
        abort: () => resolve({ ok: false, error: "操作员中止" }),
      };
    };
    const deps = depsOf(projectId, { run, merge: mapsFixture });
    startExploration(deps, projectId, "test", {});
    const waiting = await waitForStatus(deps, projectId, (view) => view?.status === "waiting_human");
    expect(waiting.captcha?.strategies).toEqual(["test_bypass_code", "local_arithmetic_recognition", "captcha_service"]);
    expect(captchaImagePath(deps, projectId, "test", waiting.explorationId)).toContain("captcha.png");

    const answered = await answerCaptcha(deps, projectId, "test", waiting.explorationId, "62");
    expect(answers).toEqual(["62"]);
    expect(answered.status).toBe("running");
    release();
    await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");
  });

  it("rejects a second dispatch while one is running", async () => {
    const projectId = await projectWithRegisteredEnv();
    let release!: () => void;
    const run: ExplorationRun = () => {
      const done = new Promise<{ ok: boolean; error: string | null }>((resolve) => { release = () => resolve({ ok: true, error: null }); });
      return { done, answer: async () => undefined, abort: () => release() };
    };
    const deps = depsOf(projectId, { run, merge: mapsFixture });
    startExploration(deps, projectId, "test", {});
    expect(() => startExploration(deps, projectId, "test", {})).toThrowError(/正在执行/);
    release();
    await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");
  });

  it("aborts honestly: status aborted, not succeeded, steps settled", async () => {
    const projectId = await projectWithRegisteredEnv();
    const run: ExplorationRun = () => {
      const done = new Promise<{ ok: boolean; error: string | null }>(() => undefined);
      return { done, answer: async () => undefined, abort: () => undefined };
    };
    const deps = depsOf(projectId, { run, merge: mapsFixture });
    const started = startExploration(deps, projectId, "test", {});
    const aborted = abortExploration(deps, projectId, "test", started.explorationId);
    expect(aborted.status).toBe("aborted");
    expect(aborted.lastError).toContain("中止");
    expect(aborted.steps.some((step) => step.status === "running")).toBe(false);
  });

  it("marks residue from a server restart as failed instead of spinning forever", async () => {
    const projectId = await projectWithRegisteredEnv();
    const now = new Date().toISOString();
    test!.deps.db
      .prepare(
        `INSERT INTO qa_environment_explorations
           (exploration_id, project_id, env, round, status, target_url, login_url, login_mode,
            steps_json, summary_json, last_error, started_at, finished_at, updated_at)
         VALUES ('explore-residue','explore_project','test',1,'running','http://gateway.example.com',NULL,'public',NULL,NULL,NULL,?,NULL,?)`,
      )
      .run(now, now);
    const view = latestExploration(test!.deps.db, projectId, "test");
    expect(view?.status).toBe("failed");
    expect(view?.lastError).toContain("服务重启");
  });

  it("validates input: login URL without credentials, and unknown exploration ids", async () => {
    const projectId = await projectWithRegisteredEnv();
    const deps = depsOf(projectId, { run: runWritingReceipt({ ok: true }), merge: mapsFixture });
    expect(() => startExploration(deps, projectId, "test", { loginUrl: "http://gateway.example.com/login" }))
      .toThrowError(/用户名和密码/);
    await expect(answerCaptcha(deps, projectId, "test", "not-exist", "1")).rejects.toThrowError(/不存在/);
    expect(listExplorations(deps.db, projectId, "test")).toEqual([]);
  });
});

describe("maps → knowledge layers", () => {
  it("derives only the layers a single-page exploration actually proves", () => {
    const layers = deriveKnowledge({
      pages: [{ route: "/a", registered: true, control_count: 3 }],
      apis: [{ method: "post", path: "/x", module: "m", required: ["id"] }],
      login: { captcha_type: "image", form_detected: true },
    });
    expect(layers.map((layer) => layer.layer)).toEqual(["module", "interface", "wall"]);
    expect(layers[1]?.entries[0]).toMatchObject({ key: "POST /x" });
    expect(deriveKnowledge({ pages: [], apis: [], login: null })).toEqual([]);
  });
});

describe("exploration → 项目资料联动（B1）", () => {
  /** 顶替 Python knowledge.build：原样回传知识项（位置已由 TS 侧直接给出）。 */
  const fakeKnowledgeRunner: ToolRunner = async (toolId, payload) => {
    if (toolId !== "knowledge.build") throw new Error(`unexpected tool: ${toolId}`);
    const items = (payload.items as Record<string, unknown>[]) ?? [];
    return {
      clauses: [],
      knowledge: {
        items: items.map((item, index) => ({ ...item, id: `kb-${index}` })),
        stats: { items: items.length, by_type: {}, dropped: 0, duplicates: 0 },
        content_hash: "fake-semantic-hash",
        _build_meta: { version: payload.version, actor: payload.actor, dropped: [], duplicates: [] },
      },
    };
  };

  function syncDepsOf(projectId: string, sync?: ExplorationDeps["knowledgeSync"]): ExplorationDeps {
    return depsOf(projectId, {
      run: runWritingReceipt({ ok: true }),
      merge: mapsFixture,
      knowledgeSync: sync ?? explorationKnowledgeSync({ db: test!.deps.db, engineRoot: "engine-root", run: fakeKnowledgeRunner }),
    });
  }

  it("成功轮把探索资产落成项目资料并构建知识版本：位置对得上、摘要带构建信息", async () => {
    const projectId = await projectWithRegisteredEnv();
    const deps = syncDepsOf(projectId);
    startExploration(deps, projectId, "test", {});
    const finished = await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");

    const kb = finished.summary?.knowledgeBuild as { documentId: string; revision: number; buildVersion: number; unchanged: boolean; itemCount: number } | undefined;
    expect(kb).toBeDefined();
    expect(kb!.documentId).toBe("doc-explore-test");
    expect(kb!.buildVersion).toBe(1);
    expect(kb!.unchanged).toBe(false);
    // 2 模块 + 2 接口 + 2 访问墙，全部进知识。
    expect(kb!.itemCount).toBe(6);

    const doc = test!.deps.db
      .prepare("SELECT title, status, current_revision FROM qa_documents WHERE project_id=? AND document_id=?")
      .get(projectId, "doc-explore-test") as { title: string; status: string; current_revision: number };
    expect(doc.status).toBe("active");
    expect(doc.title).toBe("环境探索快照（test）");
    expect(doc.current_revision).toBe(1);
    expect(kb!.revision).toBe(1);

    const content = (test!.deps.db
      .prepare("SELECT content FROM qa_document_revisions WHERE document_id=? AND revision=1")
      .get("doc-explore-test") as { content: string }).content;
    const docLines = content.split("\n");
    const buildRow = test!.deps.db
      .prepare("SELECT items_json FROM qa_knowledge_builds WHERE project_id=? AND version=1")
      .get(projectId) as { items_json: string };
    const items = JSON.parse(buildRow.items_json) as { type: string; name: string; source: { file: string; line: number } }[];
    expect(items).toHaveLength(6);
    for (const item of items) {
      // 原文位置必须是真证据：file 指向快照资料，行号那行真的写着这条事实。
      expect(item.source.file).toBe("doc-explore-test");
      expect(docLines[item.source.line - 1]).toContain(item.name);
    }
    const types = new Set(items.map((item) => item.type));
    expect(types).toEqual(new Set(["entity", "constraint", "rule"]));
  });

  it("同一份事实重跑：不修订资料、构建沿用既有版本（unchanged）", async () => {
    const projectId = await projectWithRegisteredEnv();
    const firstDeps = syncDepsOf(projectId);
    startExploration(firstDeps, projectId, "test", {});
    await waitForStatus(firstDeps, projectId, (view) => view?.status === "succeeded");

    const secondDeps = syncDepsOf(projectId);
    startExploration(secondDeps, projectId, "test", {});
    const second = await waitForStatus(secondDeps, projectId, (view) => view?.round === 2 && view.status === "succeeded");
    const kb = second.summary?.knowledgeBuild as { revision: number; buildVersion: number; unchanged: boolean } | undefined;
    expect(kb).toBeDefined();
    expect(kb!.unchanged).toBe(true);
    expect(kb!.buildVersion).toBe(1);
    expect(kb!.revision).toBe(1);

    const revisions = test!.deps.db
      .prepare("SELECT count(*) AS n FROM qa_document_revisions WHERE document_id=?")
      .get("doc-explore-test") as { n: number };
    expect(revisions.n).toBe(1);
    const builds = test!.deps.db
      .prepare("SELECT count(*) AS n FROM qa_knowledge_builds WHERE project_id=?")
      .get(projectId) as { n: number };
    expect(builds.n).toBe(1);
  });

  it("联动失败不改探索结论：轮次成功，摘要如实带 error", async () => {
    const projectId = await projectWithRegisteredEnv();
    const deps = syncDepsOf(projectId, async () => {
      throw new Error("知识引擎不可用");
    });
    startExploration(deps, projectId, "test", {});
    const finished = await waitForStatus(deps, projectId, (view) => view?.status === "succeeded");
    const kb = finished.summary?.knowledgeBuild as { error: string } | undefined;
    expect(kb).toBeDefined();
    expect(kb!.error).toContain("知识引擎不可用");
    // 环境四层知识照常回写：联动失败不该连累探索本身的产出。
    const knowledge = latestExploration(deps.db, projectId, "test");
    expect(knowledge?.summary?.knowledgeLayers).toEqual(["module", "interface", "wall"]);
  });
});
