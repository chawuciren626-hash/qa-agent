// @vitest-environment jsdom
/**
 * 项目环境页（/qa/project/environments）的页面行为。
 *
 * 三件必须成立的事：
 * - 没探索过（lastRound=0）时说「还没探索过」，不把空地图画成 0 个模块；
 * - 环境的页/接口数为 null 时显示「—」，不显示 0（0 会被读成"探过了没有页面"）；
 * - 假设默认不授权造数，且判定历史按追加显示（旧结论不能被新结论吃掉）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { button, click, hasButton, mount, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { ProjectEnvironmentsPage } from "../src/features/qa/project-management/project-environments-page";
import type { EnvironmentKnowledge, EnvironmentView, Hypothesis } from "../src/features/qa/project-management/types";

const fixture = vi.hoisted(() => {
  const env = {
    env: "test", baseUrl: "http://10.20.31.14:8080", isDefault: true,
    status: "failed" as const, pages: null, apis: null, loginCaptcha: null,
    probedAt: "2026-11-17T08:42:00.000Z", lastError: "ConnectionError: 连接被拒绝",
    mapsPath: null, reportPath: null, revision: 3,
    steps: [1, 2, 3, 4, 5].map((index) => ({
      index,
      name: ["可达性探测", "抓取前端骨架", "提取路由", "探测登录与接口", "生成环境档案"][index - 1] ?? "",
      status: index === 1 ? ("failed" as const) : ("idle" as const),
      ms: index === 1 ? 8400 : null,
      detail: index === 1 ? "ConnectionError: 连接被拒绝" : null,
      facts: {},
    })),
  };
  const explorationSteps = [
    { index: 1, name: "准备配置", status: "done" as const, detail: "登录配置与凭据已就位" },
    { index: 2, name: "拉起浏览器", status: "done" as const, detail: "无头浏览器已启动" },
    { index: 3, name: "登录", status: "running" as const, detail: "打开登录页" },
    { index: 4, name: "采集页面", status: "idle" as const, detail: null },
    { index: 5, name: "采集接口", status: "idle" as const, detail: null },
    { index: 6, name: "合并回写", status: "idle" as const, detail: null },
  ];
  const state = {
    envStatus: "failed" as EnvironmentView["status"],
    env: env as EnvironmentView,
    explorations: [] as unknown[],
    started: null as unknown,
    answeredWith: [] as string[],
  };
  return { env, explorationSteps, state };
});

vi.mock("../src/features/qa/project-management/api", () => ({
  listEnvironments: async () => ({ environments: [{ ...fixture.env, status: fixture.state.envStatus }], defaultEnv: "test" }),
  getEnvironment: async () => fixture.env,
  saveEnvironment: async () => fixture.env,
  bootstrapEnvironment: async () => fixture.env,
  getEnvironmentKnowledge: async () => ({
    knowledge: {
      env: "test",
      layers: { module: [], flow: [], wall: [], interface: [] },
      counts: { module: 0, flow: 0, wall: 0, interface: 0 },
      lastRound: 0,
    },
    hypotheses: { open: 1, verified: 0, refuted: 1, unreachable: 0, total: 2 },
  }),
  listHypotheses: async () => ({
    hypotheses: [{
      hypothesisId: "hyp-1",
      moduleKey: "refund",
      statement: "退款申请要求存在已支付订单",
      whyUnknown: "data",
      expectation: "无已支付订单时按钮禁用",
      dataSetup: "一个已支付订单",
      allowSeed: false,
      status: "refuted",
      createdBy: "demo-admin",
      createdAt: "2026-11-17T08:00:00.000Z",
      updatedAt: "2026-11-17T09:00:00.000Z",
      verdicts: [
        { verdictId: "vd-1", round: 1, verdict: "verified", evidence: "旧结论：确实要求", sessionId: null, createdAt: "2026-11-17T09:00:00.000Z" },
        { verdictId: "vd-2", round: 2, verdict: "refuted", evidence: "新结论：游客也能申请", sessionId: null, createdAt: "2026-11-17T10:00:00.000Z" },
      ],
    }] as Hypothesis[],
    summary: { open: 1, verified: 0, refuted: 1, unreachable: 0, total: 2 },
  }),
  createHypothesis: async () => ({ hypothesisId: "hyp-2" }),
  listExplorations: async () => ({ explorations: fixture.state.explorations, latest: fixture.state.explorations[0] ?? null }),
  startExploration: async () => fixture.state.started,
  answerExplorationCaptcha: async (_p: string, _e: string, _id: string, answer: string) => {
    fixture.state.answeredWith.push(answer);
    return { ...(fixture.state.explorations[0] as Record<string, unknown>), status: "running", captcha: null };
  },
  abortExploration: async () => ({ ...(fixture.state.explorations[0] as Record<string, unknown>), status: "aborted" }),
  explorationCaptchaUrl: () => "/api/projects/proj-1/environments/test/explore/x/captcha",
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({
    currentProject: { projectId: "proj-1", name: "会员中心改版回归" },
    setCurrentProjectId: () => undefined,
    projects: [],
    reloadProjects: async () => undefined,
  }),
  projectDisplayName: (p: { name?: string; projectId: string }) => p.name ?? p.projectId,
}));

afterEach(async () => {
  await unmountAll();
  fixture.state.envStatus = "failed";
  fixture.state.explorations = [];
  fixture.state.started = null;
  fixture.state.answeredWith = [];
});

async function renderPage() {
  const mounted = await mount(
    h(MemoryRouter, { initialEntries: ["/qa/project/environments"] },
      h(Routes, null,
        h(Route, { path: "/qa/project/environments", element: h(ProjectEnvironmentsPage) }),
      ),
    ),
  );
  await settle();
  await waitFor(() => mounted.container.querySelector(".qpm-env-item") !== null);
  return mounted.container;
}

describe("project environments page", () => {
  it("shows the failed step's own words and 页面 — instead of 0", async () => {
    const root = await renderPage();
    const text = root.textContent ?? "";
    expect(text).toContain("test · 建档失败");
    expect(text).toContain("ConnectionError: 连接被拒绝");
    // 五步里第 1 步是 failed、其余 idle：进度条 20%（1/5 落定）
    expect(text).toContain("1/5 · 20%");
    expect(root.querySelector(".qpm-env-item-meta")?.textContent).toContain("页面 —");
  });

  it("says the environment was never explored instead of drawing an empty 0-module map", async () => {
    const root = await renderPage();
    expect(root.textContent).toContain("这个环境还没探索过");
    expect(root.textContent).toContain("建档只回答「有哪些地址」");
  });

  it("keeps every verdict, including the one that was later refuted", async () => {
    const root = await renderPage();
    await click(button("未知与假设 · 1"));
    await settle();
    const text = root.textContent ?? "";
    expect(text).toContain("退款申请要求存在已支付订单");
    expect(text).toContain("第 1 轮 · 已验证");
    expect(text).toContain("旧结论：确实要求");
    expect(text).toContain("第 2 轮 · 已推翻");
    // 已推翻的假设不能再被读成"已验证"。
    expect(root.querySelector(".qpm-hyp-status")?.textContent).toBe("已推翻");
  });

  it("opens 补充场景 with 造数 off by default", async () => {
    const root = await renderPage();
    await click(button("未知与假设 · 1"));
    await settle();
    await click(button("＋ 补充场景"));
    await settle();
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(document.body.textContent).toContain("允许探索时自动造前置数据");
  });
});

describe("exploration dispatch", () => {
  it("only offers 派发探索 on a registered environment", async () => {
    await renderPage();
    // 建档失败的环境没有地图可探：按钮不出现（页面上不放一个点了会 409 的假入口）。
    // 注意空态文案里本来就有「点右上角『派发探索』」这句说明，所以按按钮断，不按文本断。
    expect(hasButton("▶ 派发探索")).toBe(false);

    fixture.state.envStatus = "registered";
    await renderPage();
    expect(hasButton("▶ 派发探索")).toBe(true);
  });

  it("dispatches a round from the dialog and shows the running panel", async () => {
    fixture.state.envStatus = "registered";
    fixture.state.started = {
      explorationId: "expl-1", round: 1, status: "running",
      targetUrl: "http://10.20.31.14:8080", loginUrl: null, loginMode: "public",
      steps: fixture.explorationSteps, summary: null, lastError: null,
      startedAt: "2026-11-18T11:00:00.000Z", finishedAt: null, captcha: null,
    };
    const root = await renderPage();
    await click(button("▶ 派发探索"));
    await settle();
    expect(document.body.textContent).toContain("派发探索 · test 环境");
    expect(document.body.textContent).toContain("全程只读");
    await click(button("确认派发"));
    await settle();
    const text = root.textContent ?? "";
    expect(text).toContain("第 1 轮探索");
    expect(text).toContain("探索中");
    expect(text).toContain("公开页探索");
    // 凭据只在派发时填，不回显、不落库——弹窗关掉即不再出现密码框。
    expect(document.querySelector('.qpm-modal input[type="password"]')).toBeNull();
  });

  it("parks on the captcha card and submits the operator answer", async () => {
    fixture.state.envStatus = "registered";
    fixture.state.explorations = [{
      explorationId: "expl-2", round: 1, status: "waiting_human",
      targetUrl: "http://10.20.31.14:8080/login", loginUrl: "http://10.20.31.14:8080/login", loginMode: "authenticated",
      steps: fixture.explorationSteps, summary: null, lastError: null,
      startedAt: "2026-11-18T11:00:00.000Z", finishedAt: null,
      captcha: { available: true, strategies: ["test_bypass_code", "local_arithmetic_recognition", "captcha_service"] },
    }];
    const root = await renderPage();
    const text = root.textContent ?? "";
    expect(text).toContain("等验证码");
    expect(text).toContain("仅人工验证码需要处理");
    expect(text).toContain("已尝试：测试后门码 → 本地算术识别 → 打码服务");
    expect(root.querySelector('img[alt="目标站验证码"]')).not.toBeNull();

    const input = root.querySelector('input[aria-label="验证码答案"]') as HTMLInputElement;
    await type(input, "62");
    await settle();
    await click(button("提交答案"));
    await settle();
    expect(fixture.state.answeredWith).toEqual(["62"]);
  });

  it("states a failed round writes no assets", async () => {
    fixture.state.envStatus = "registered";
    fixture.state.explorations = [{
      explorationId: "expl-3", round: 1, status: "failed",
      targetUrl: "http://10.20.31.14:8080", loginUrl: "http://10.20.31.14:8080/login", loginMode: "authenticated",
      steps: fixture.explorationSteps.map((step, offset) => ({ ...step, status: offset === 2 ? "failed" : step.status })),
      summary: null, lastError: "登录未成功（验证码错误），不重试提交",
      startedAt: "2026-11-18T11:00:00.000Z", finishedAt: "2026-11-18T11:02:00.000Z", captcha: null,
    }];
    const root = await renderPage();
    const text = root.textContent ?? "";
    expect(text).toContain("本轮失败（未回写任何探索资产，四层保持上一轮）");
    expect(text).toContain("登录未成功（验证码错误），不重试提交");
  });
});

describe("探索 → 项目资料联动展示", () => {
  afterEach(() => {
    // 恢复公共 mock 的缺省形状，别把空 summary 泄漏给后续用例。
    fixture.state.explorations = [];
  });

  it("成功摘要带「项目资料 vN · M 条知识」chip", async () => {
    fixture.state.envStatus = "registered";
    fixture.state.explorations = [{
      explorationId: "expl-4", round: 1, status: "succeeded",
      targetUrl: "http://10.20.31.14:8080", loginUrl: null, loginMode: "public",
      steps: fixture.explorationSteps.map((step) => ({ ...step, status: "done" as const })),
      summary: {
        targetUrl: "http://10.20.31.14:8080", controls: 14, tables: 1, apis: 2,
        structureDigest: "abc12345", sessionReused: true, mapsPath: "maps-test.json",
        knowledgeLayers: ["module", "interface", "wall"], captchaStrategy: "test_bypass_code",
        limitations: [], knowledgeBuild: { documentId: "doc-explore-test", revision: 1, buildVersion: 1, unchanged: false, itemCount: 6 },
      },
      lastError: null,
      startedAt: "2026-11-19T03:00:00.000Z", finishedAt: "2026-11-19T03:02:00.000Z", captcha: null,
    }];
    const root = await renderPage();
    expect(root.textContent ?? "").toContain("项目资料 v1 · 6 条知识");
  });

  it("联动失败不改探索结论：摘要照常渲染，失败原因如实可见", async () => {
    fixture.state.envStatus = "registered";
    fixture.state.explorations = [{
      explorationId: "expl-5", round: 1, status: "succeeded",
      targetUrl: "http://10.20.31.14:8080", loginUrl: null, loginMode: "public",
      steps: fixture.explorationSteps.map((step) => ({ ...step, status: "done" as const })),
      summary: {
        targetUrl: "http://10.20.31.14:8080", controls: 14, tables: 1, apis: 2,
        structureDigest: "abc12345", sessionReused: true, mapsPath: "maps-test.json",
        knowledgeLayers: ["module", "interface", "wall"], captchaStrategy: "test_bypass_code",
        limitations: [], knowledgeBuild: { error: "knowledge_engine_unavailable" },
      },
      lastError: null,
      startedAt: "2026-11-19T03:00:00.000Z", finishedAt: "2026-11-19T03:02:00.000Z", captcha: null,
    }];
    const root = await renderPage();
    expect(root.textContent ?? "").toContain("项目资料联动失败：knowledge_engine_unavailable");
    // 探索自身的产出摘要照常展示：联动失败不吞掉探索结论。
    expect(root.textContent ?? "").toContain("已回写：");
  });
});
