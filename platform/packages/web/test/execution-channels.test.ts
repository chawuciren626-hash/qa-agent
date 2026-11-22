// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, run } from "./helpers/dom";
import { EndsReportSection, reportEndSections } from "../src/features/qa/ends-report";
import { ExecutionChannelAuthorization, executionChannels } from "../src/features/qa/execution-channels";
import type { EnvironmentView } from "../src/features/qa/project-management/types";

const environment = (overrides: Partial<EnvironmentView>): EnvironmentView => ({
  env: "staging", endType: "web", baseUrl: "https://staging.example.com", isDefault: true,
  status: "registered", pages: null, apis: null, loginCaptcha: null, probedAt: null,
  lastError: null, mapsPath: null, reportPath: null, steps: [], revision: 0, ...overrides,
});

afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); });

it("groups report sections by end in document order and keeps unknown parts as overall (A8)", () => {
  const markdown = "# 测试报告\n\n总体说明。\n\n## Web 端结论\n\n全部通过。\n\n### Web 端未测范围\n\n后台导出。\n\n## 接口端结论\n\n2 项失败。\n\n## 风险与建议\n\n关注权限。";
  const groups = reportEndSections(markdown);
  expect(groups.map(group => group.end)).toEqual(["overall", "web", "api"]);
  expect(groups[0]?.label).toBe("总体");
  expect(groups.find(group => group.end === "web")?.sections).toHaveLength(2);
  expect(groups.find(group => group.end === "api")?.sections).toHaveLength(1);
});

it("renders grouped report with an end navigation, and degrades to plain rendering without ends (A8)", async () => {
  const multi = "# 报告\n\n## Web 端结论\n\n通过。\n\n## 小程序端结论\n\n未纳入。\n\n## 风险\n\n低。";
  await mount(h(EndsReportSection, { markdown: multi, label: "测试报告" }));
  await run(() => {});
  expect(document.querySelector(".qtd-ends-nav")?.textContent).toContain("Web 端");
  expect(document.querySelector(".qtd-ends-nav")?.textContent).toContain("小程序端");
  expect(document.querySelector('[aria-label="总体"]')?.textContent).toContain("风险");
  await unmountAll();
  await mount(h(EndsReportSection, { markdown: "# 报告\n\n没有分端信息的结论。", label: "测试报告" }));
  await run(() => {});
  expect(document.querySelector(".qtd-ends-nav")).toBeNull();
  expect(document.querySelector('[aria-label="测试报告"]')?.textContent).toContain("没有分端信息的结论");
});

it("maps the run's channel from stage, platform and the default environment (A7)", () => {
  const environments = [
    environment({ env: "staging", baseUrl: "https://staging.example.com", isDefault: false }),
    environment({ env: "prod", baseUrl: "https://prod.example.com", isDefault: true }),
  ];
  const ui = executionChannels("execution", "android", environments);
  expect(ui).toHaveLength(1);
  expect(ui[0]).toMatchObject({ kind: "UI 自动化", end: "App", env: "prod", baseUrl: "https://prod.example.com" });
  expect(ui[0]?.impact).toContain("业务数据");
  const api = executionChannels("api_execution", "web", environments);
  expect(api[0]).toMatchObject({ kind: "接口自动化", end: "接口" });
  expect(executionChannels("execution", "web", [])).toEqual([]);
});

vi.mock("../src/features/qa/project-management/api", () => ({
  listEnvironments: async () => ({ environments: [{ env: "staging", endType: "web", baseUrl: "https://staging.example.com", isDefault: true }], defaultEnv: "staging" }),
}));

it("lists the authorized channel with target environment and data impact before confirmation (A7)", async () => {
  await mount(h(ExecutionChannelAuthorization, { projectId: "demo", stageId: "execution", executionPlatform: "web" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const panel = document.querySelector('[aria-label="执行授权通道"]');
  expect(panel?.textContent).toContain("本次确认将授权的执行通道");
  expect(panel?.textContent).toContain("UI 自动化 · Web端");
  expect(panel?.textContent).toContain("https://staging.example.com");
  expect(panel?.textContent).toContain("数据影响");
});
