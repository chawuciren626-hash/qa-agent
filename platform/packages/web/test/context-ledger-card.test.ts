// @vitest-environment jsdom
/**
 * 上下文装配账目卡：人从哪里看出"这一轮模型到底看了什么"。
 *
 * 三件事必须成立：被裁项逐条可查、降级装配一眼能认出、没有记录时不假装装配正常。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, settle, unmountAll, waitFor } from "./helpers/dom";

const state = vi.hoisted(() => ({
  answer: { ledger: null as unknown },
  error: null as Error | null,
  calls: [] as string[],
}));

vi.mock("../src/api/client", () => ({
  apiFetch: async (url: string) => {
    state.calls.push(url);
    if (state.error) throw state.error;
    return state.answer;
  },
}));

import { ContextLedgerCard } from "../src/features/qa/context-ledger-card";

afterEach(async () => {
  await unmountAll();
  state.answer = { ledger: null };
  state.error = null;
  state.calls = [];
});

const ledger = (over: Record<string, unknown> = {}) => ({
  version: 1,
  ledgerId: "led-1",
  budgetTokens: 8000,
  tokensEst: 5240,
  loaded: { knowledge: { loaded: 12, total: 18, version: 3 }, documents: 2, rules: 5 },
  dropped: [
    { kind: "knowledge", ref: { title: "退款上限" }, tokens: 640, reason: "over_budget" },
    { kind: "document", ref: { documentId: "doc-9" }, tokens: 1800, reason: "over_budget" },
  ],
  assembler: "python:context.assemble",
  statement: "装载知识 12/18 条、资料 2 篇，5240/8000 tokens",
  ...over,
});

it("lists every dropped entry with its own reason, so the budget can be checked", async () => {
  state.answer = { ledger: ledger() };
  await mount(h(ContextLedgerCard, { projectId: "demo", sessionId: "s-1" }));
  await waitFor(() => (document.body.textContent ?? "").includes("本次装配账目"));

  expect(state.calls[0]).toBe("/api/projects/demo/agents/qa/tasks/s-1/context-ledger");
  expect(document.body.textContent).toContain("装载知识 12/18 条、资料 2 篇，5240/8000 tokens");
  expect(document.body.textContent).toContain("裁掉 2 项");
  expect(document.body.textContent).toContain("知识 12/18 条");
  expect(document.body.textContent).toContain("资料 2 篇");
  expect(document.body.textContent).toContain("知识版本 3");
  // 每条被裁项都要能被认出来：只有"裁了 2 项"等于没说。
  expect(document.body.textContent).toContain("退款上限");
  expect(document.body.textContent).toContain("doc-9");
  expect(document.body.textContent).toContain("超出 token 预算");
  expect(document.body.textContent).toContain("640 tokens");
});

it("marks a degraded assembly so its conclusions cannot pass as verified against documents", async () => {
  state.answer = {
    ledger: ledger({
      assembler: "fallback:index_only",
      tokensEst: 210,
      loaded: { knowledge: { loaded: 0, total: 18, version: 3 }, documents: 0, rules: 0 },
      dropped: [{ kind: "document", ref: { documentId: "doc-9" }, tokens: 0, reason: "assembler_unavailable: boom" }],
    }),
  };
  await mount(h(ContextLedgerCard, { projectId: "demo", sessionId: "s-1" }));
  await waitFor(() => (document.body.textContent ?? "").includes("本次装配账目"));

  expect(document.body.textContent).toContain("降级装配");
  expect(document.body.textContent).toContain("降级：index_only");
  expect(document.body.textContent).toContain("正文一个字都不进");
  expect(document.body.textContent).toContain("装配器不可用：boom");
});

it("says there is no record instead of showing a zeroed-out ledger", async () => {
  state.answer = { ledger: null };
  await mount(h(ContextLedgerCard, { projectId: "demo", sessionId: "s-1" }));
  await waitFor(() => (document.body.textContent ?? "").includes("还没有上下文装配记录"));
  expect(document.body.textContent).toContain("任务开始派单后");
  expect(document.body.textContent).not.toContain("0 / 8000 tokens");
});

it("says an unreadable ledger does not mean nothing was dropped", async () => {
  state.error = new Error("network down");
  await mount(h(ContextLedgerCard, { projectId: "demo", sessionId: "s-1" }));
  await waitFor(() => (document.querySelector('[role="alert"]')?.textContent ?? "").includes("装配账目读不到"));
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("不代表没有裁剪");
});
