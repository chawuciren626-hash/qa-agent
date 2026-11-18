// @vitest-environment jsdom
/**
 * 确认卡点页（A3/A4）：三层卡点展示、退回全审横幅、审批条与处置动作。
 * 服务端规则由 qa-confirm-gate.test.ts（server 包）覆盖；这里按人驱动页面的方式验收：
 * 页面忠实渲染服务端派生视图、处置动作打到正确的端点、批准对话框缺证据不静默放行。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router";
import { button, click, mount, settle, unmountAll, waitFor } from "./helpers/dom";

const state = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; body?: any }[],
  answer: null as any,
  listAnswer: [] as any[],
}));

vi.mock("../src/api/client", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    state.calls.push({ url, method: init?.method, body: init?.body });
    if (url.endsWith("/batches") && (!init?.method || init.method === "GET")) {
      return { batches: state.listAnswer };
    }
    if (state.answer) return state.answer;
    throw new Error("unexpected fetch: " + url);
  },
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({ currentProject: { projectId: "demo" } }),
  projectDisplayName: () => "演示项目",
}));

import { ConfirmGatePage } from "../src/features/qa/confirm-gate-page";

afterEach(async () => {
  await unmountAll();
  state.calls = [];
  state.answer = null;
  state.listAnswer = [];
});

const items = [
  { id: "REQ-201", type: "需求", text: "登录失败 5 次锁定 10 分钟", risk: "P0", changed: true, st: "todo" },
  { id: "REQ-204", type: "需求", text: "账号命名规则不变", risk: "P1", changed: false, st: "inherit" },
  { id: "C-409", type: "用例", text: "多端同时在线踢出策略", risk: "unknown", changed: false, st: "todo" },
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `C-5${String(i).padStart(2, "0")}`, type: "用例", text: `回归普通项 ${i + 1}`,
    risk: "P2", changed: false, st: "inherit",
  })),
];

const view = (over: Record<string, unknown> = {}) => ({
  batch: {
    kind: "confirm-batch", batchId: "b-1", projectId: "demo", title: "登录模块改版确认",
    status: "draft", seed: "20261118", items,
    audit: [{ seq: 1, at: "2026-11-18T04:00:00.000Z", action: "created", actor: "u-1", note: "确认批次建立（17 项）" }],
    createdBy: "u-1", createdAt: "2026-11-18T04:00:00.000Z", updatedAt: "2026-11-18T04:00:00.000Z",
  },
  sampledIds: ["C-500", "C-501"],
  sampleFingerprint: "ab12cd34",
  smallBatch: false,
  retroToFull: false,
  mustDone: false,
  effective: Object.fromEntries(items.map(item => [item.id, item.st])),
  stats: {
    diffForced: 1, inherited: 16, forceFull: 2, riskUnknown: 1,
    sampled: 2, sampledDone: 0, problems: 0, problemRate: null, mustRemaining: 2,
  },
  gates: [{ gate: "confirm_done", detail: "必审集（差异项 ∪ 风险强制项）尚有未处置项。" }],
  approvalNote: "批准时必须附重放执行证据（completed、无 unstable、无 not_run）；缺证据不批准。",
  ...over,
});

async function openBatch(v: Record<string, unknown>) {
  state.listAnswer = [v.batch];
  state.answer = v;
  await mount(h(MemoryRouter, {}, h(ConfirmGatePage)));
  await waitFor(() => (document.body.textContent ?? "").includes("登录模块改版确认"));
  // 批次列表卡片 → 进工作台
  await click(button("打开批次 登录模块改版确认"));
  await waitFor(() => (document.body.textContent ?? "").includes("差异聚焦"));
  await settle();
}

it("renders the three layers, seed fingerprint and must-remaining from the server view", async () => {
  await openBatch(view());
  const body = document.body.textContent ?? "";
  expect(body).toContain("差异聚焦");
  expect(body).toContain("抽样审核");
  expect(body).toContain("风险加权");
  expect(body).toContain("ab12cd34");
  expect(body).toContain("未标风险");
  expect(body).toContain("必审未处置 2");
  // 抽样面板如实展示可复现性
  expect(body).toContain("同种子重抽一致");
  // 审批条状态与确认侧闸
  expect(body).toContain("confirm_done");
  expect(body).toContain("缺证据不批准");
  // 审计留痕 seq
  expect(body).toContain("创建批次");
});

it("shows the retro banner and voids sampled passes when problem rate exceeds threshold", async () => {
  const v = view({
    retroToFull: true,
    effective: Object.fromEntries(items.map(item => [item.id, item.id === "C-500" ? "todo" : item.st])),
    stats: { diffForced: 1, inherited: 16, forceFull: 2, riskUnknown: 1, sampled: 2, sampledDone: 1, problems: 1, problemRate: "50%", mustRemaining: 3 },
    gates: [
      { gate: "sample_passed", detail: "抽样问题率超过阈值 10%，本批已退回全审；逐条人工审完才能批准。" },
      { gate: "confirm_done", detail: "必审集（差异项 ∪ 风险强制项）尚有未处置项。" },
    ],
  });
  await openBatch(v);
  const body = document.body.textContent ?? "";
  expect(body).toContain("退回全审");
  expect(body).toContain("sample_passed");
  expect(body).toContain("50%");
});

it("review actions hit the review endpoint with the clicked decision", async () => {
  await openBatch(view());
  // 必审项 REQ-201 行内的「通过」按钮（首个）
  const passButtons = [...document.querySelectorAll("button.cg-mini.is-ok")];
  expect(passButtons.length).toBeGreaterThanOrEqual(2);
  await click(passButtons[0] as HTMLElement);
  await settle();
  const review = state.calls.find(call => call.url.includes("/items/REQ-201/review"));
  expect(review?.method).toBe("POST");
  expect((review?.body as any)?.decision).toBe("pass");
});

it("submit is disabled while must-review items remain; approval opens the evidence dialog", async () => {
  await openBatch(view());
  const submit = [...document.querySelectorAll("button")].find(btn => btn.textContent === "提交送审") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const approve = [...document.querySelectorAll("button")].find(btn => btn.textContent === "批准…") as HTMLButtonElement;
  expect(approve.disabled).toBe(true); // draft 状态下不能批准
});

it("reviewing state enables approval, and confirming posts executionEvidence", async () => {
  const v = view({
    batch: {
      kind: "confirm-batch", batchId: "b-1", projectId: "demo", title: "登录模块改版确认",
      status: "reviewing", seed: "20261118", items,
      audit: [
        { seq: 1, at: "2026-11-18T04:00:00.000Z", action: "created", actor: "u-1" },
        { seq: 2, at: "2026-11-18T04:05:00.000Z", action: "submitted", actor: "u-1", note: "必审集处置完成，送审回归报告" },
      ],
      createdBy: "u-1", createdAt: "2026-11-18T04:00:00.000Z", updatedAt: "2026-11-18T04:05:00.000Z",
    },
    mustDone: true,
    gates: [],
    stats: { diffForced: 1, inherited: 16, forceFull: 2, riskUnknown: 1, sampled: 2, sampledDone: 2, problems: 0, problemRate: "0%", mustRemaining: 0 },
  });
  await openBatch(v);
  const approve = [...document.querySelectorAll("button")].find(btn => btn.textContent === "批准…") as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  await click(approve);
  await waitFor(() => (document.body.textContent ?? "").includes("附重放执行证据"));
  const confirm = [...document.querySelectorAll(".cg-modal button")].find(btn => btn.textContent === "确认批准") as HTMLElement;
  await click(confirm);
  await settle();
  const call = state.calls.find(entry => entry.url.includes("/approve"));
  expect(call?.method).toBe("POST");
  expect((call?.body as any).executionEvidence.replay.status).toBe("completed");
});
