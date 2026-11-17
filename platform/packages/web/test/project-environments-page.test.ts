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
import { button, click, mount, settle, unmountAll, waitFor } from "./helpers/dom";
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
  return { env };
});

vi.mock("../src/features/qa/project-management/api", () => ({
  listEnvironments: async () => ({ environments: [fixture.env], defaultEnv: "test" }),
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

afterEach(async () => { await unmountAll(); });

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
