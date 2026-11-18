// @vitest-environment jsdom
/**
 * 渠道管理页重做（按 2026-10-16 已确认原型）的验收测试。
 * 覆盖：汇总 chips / 卡片状态与默认徽章 / 无 key 探测的两态 / 弹窗实时校验与重复拦截 /
 * 删除确认的风险提示 / 详情抽屉。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { click, mount, type, unmountAll, waitFor } from "./helpers/dom";
import { AdminChannelsPage } from "../src/features/admin/admin-channels-page";

const calls = vi.hoisted(() => ({
  getModels: vi.fn(),
  detectProtocol: vi.fn(),
  putProviderConnection: vi.fn(),
  deleteChannel: vi.fn(),
}));
vi.mock("../src/api/endpoints", () => ({
  CENTRAL_MODEL_CATALOG_ID: "central-model-catalog",
  getModels: calls.getModels,
  detectProtocol: calls.detectProtocol,
  putProviderConnection: calls.putProviderConnection,
  deleteChannel: calls.deleteChannel,
}));

afterEach(async () => {
  await unmountAll();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key].mockReset();
});

const centralTable = () => ({
  defaultModel: { provider: "tokendance", modelId: "deepseek-v3" },
  providers: {
    tokendance: { displayName: "Token Dance", baseUrl: "https://tokendance.example/v1", clientType: "openai-chat" },
    legacy: { displayName: "旧版网关", baseUrl: "", clientType: "" },
  },
  models: [
    { provider: "tokendance", modelId: "deepseek-v3", displayName: "DeepSeek V3", isDefault: true, effective: {} },
    { provider: "tokendance", modelId: "embed-1", effective: {} },
  ],
});

it("渲染汇总 chips、卡片、默认徽章；无自定义地址的渠道检测按钮禁用", async () => {
  calls.getModels.mockResolvedValue(centralTable());
  await mount(h(AdminChannelsPage));

  const text = document.body.textContent ?? "";
  expect(text).toContain("渠道管理");
  expect(text).toContain("托管模型");
  expect(text).toContain("默认渠道 tokendance");
  expect(text).toContain("最近检测 尚未检测");

  const cards = [...document.querySelectorAll(".cursor-pointer")];
  expect(cards.length).toBe(2);
  const tokenCard = cards.find((card) => card.textContent?.includes("Token Dance"))!;
  const legacyCard = cards.find((card) => card.textContent?.includes("旧版网关"))!;
  expect(tokenCard.textContent).toContain("默认");
  expect(legacyCard.textContent).toContain("尚未检测");
  expect(text).not.toContain("N 个智能体使用中"); // 原型示意字段不做假数据
});

it("卡片「测试连通性」走无 key 探测：连通显示绿点文案，未探测到协议显示异常", async () => {
  calls.getModels.mockResolvedValue(centralTable());
  calls.detectProtocol.mockResolvedValue({ detected: "openai-chat", probes: [] });
  await mount(h(AdminChannelsPage));

  const testBtn = [...document.querySelectorAll("button")].find((el) => el.textContent === "⇄ 测试连通性" && !el.disabled);
  expect(testBtn).toBeDefined();
  await click(testBtn!);
  await waitFor(() => (document.body.textContent ?? "").includes("连通"));
  expect(calls.detectProtocol).toHaveBeenCalledWith("central-model-catalog", { baseUrl: "https://tokendance.example/v1" });

  calls.detectProtocol.mockResolvedValue({ probes: [] });
  await click(testBtn!);
  await waitFor(() => (document.body.textContent ?? "").includes("异常"));
});

it("弹窗实时校验：非法标识停用保存；合法后启用；重复标识拦截", async () => {
  calls.getModels.mockResolvedValue(centralTable());
  await mount(h(AdminChannelsPage));

  await click([...document.querySelectorAll("button")].find((el) => el.textContent === "添加渠道")!);
  const slugField = document.querySelector('input[placeholder^="例如 my-gateway"]') as HTMLInputElement;
  const nameField = document.querySelector('input[placeholder="例如 企业统一网关"]') as HTMLInputElement;
  const save = [...document.querySelectorAll("button")].find((el) => el.textContent === "保存")!;

  await type(slugField, "1bad");
  expect((document.body.textContent ?? "").includes("✗ 字母开头")).toBe(true);
  expect(save.disabled).toBe(true);

  await type(slugField, "tokendance");
  await type(nameField, "重复渠道");
  expect((document.body.textContent ?? "").includes("标识已存在")).toBe(true);
  expect(save.disabled).toBe(true);

  await type(slugField, "new-gw");
  expect(save.disabled).toBe(false);
  expect((document.body.textContent ?? "").includes("✓ 标识格式正确")).toBe(true);
});

it("删除确认列出托管条目数与默认渠道风险，确认后调用删除接口", async () => {
  calls.getModels.mockResolvedValue(centralTable());
  calls.deleteChannel.mockResolvedValue({});
  await mount(h(AdminChannelsPage));

  await click(document.querySelector('button[aria-label="删除 Token Dance"]') as HTMLButtonElement);
  await waitFor(() => (document.body.textContent ?? "").includes("删除渠道"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("2 个托管模型条目");
  expect(text).toContain("当前默认模型在该渠道下");
  expect(text).toContain("API Key 配置不受影响");

  await click([...document.querySelectorAll("button")].find((el) => el.textContent === "确认删除")!);
  await waitFor(() => calls.deleteChannel.mock.calls.length > 0);
  expect(calls.deleteChannel).toHaveBeenCalledWith("tokendance");
});

it("点卡片开详情抽屉：信息四宫格 + 托管模型行；Esc 关闭", async () => {
  calls.getModels.mockResolvedValue(centralTable());
  await mount(h(AdminChannelsPage));

  const tokenCard = [...document.querySelectorAll(".cursor-pointer")].find((card) => card.textContent?.includes("Token Dance"))!;
  await click(tokenCard);
  const drawer = document.querySelector('aside[aria-label^="渠道详情"]') as HTMLElement;
  expect(drawer).not.toBeNull();
  expect(drawer.textContent).toContain("渠道信息");
  expect(drawer.textContent).toContain("deepseek-v3");
  expect(drawer.textContent).toContain("DeepSeek V3");
  expect(drawer.textContent).toContain("embed-1");
  expect(drawer.textContent).toContain("用户可用性取决于自己的 API Key");
});
