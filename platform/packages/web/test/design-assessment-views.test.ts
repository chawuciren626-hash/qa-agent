// @vitest-environment jsdom
/**
 * The review surfaces keep the handoff's honesty rules on screen: missing facts read "无法评估",
 * "可执行" is not presented as a test pass, and the residual risk groups stay separate with no
 * write actions. The model's judgements are covered in design-assessment-model.test.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { mount, unmountAll } from "./helpers/dom";
import { assessDesign, assessResidualRisk } from "../src/features/qa/design-assessment-model";
import type { DesignAssessmentData } from "../src/features/qa/design-assessment-loader";
import { DesignAssessmentView, ResidualRiskView } from "../src/features/qa/design-assessment-views";

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

const text = () => document.body.textContent ?? "";

function data(): DesignAssessmentData {
  return {
    points: [],
    cases: [],
    rules: [],
    sources: {},
    mode: "unknown",
    warnings: ["没有加载到任何来源原文；预期依据只能检查引用完整性，不能核对语义。"],
    artifacts: {
      points: null,
      cases: null,
      manifest: { path: "output/runs/run-1/manifest.json", loaded: false, verified: null, reason: "清单不可读。" },
    },
    sourceStatus: [],
  };
}

it("missing design facts read as unknown and executable is not a test pass", async () => {
  const assessment = assessDesign({ points: [], cases: [] });
  await mount(h(DesignAssessmentView, { assessment, data: data() }));

  expect(text()).toContain("无法评估");
  expect(text()).toContain("不等于产品测试通过");
  expect(text()).toContain("没有可评估的测试点");
  expect(text()).toContain("没有可评估的用例");
  expect(document.querySelectorAll("button")).toHaveLength(0);
});

it("lets a reviewer focus low-confidence cases without hiding the total", async () => {
  const design = assessDesign({
    points: [{ id: "TP-1", description: "高风险支付", risk: "高", coverage_type: ["functional"] }],
    cases: [
      {
        case_id: "CASE-OK",
        title: "有依据用例",
        steps: ["点击提交"],
        expected: "页面显示成功",
        automation_feasible: true,
        related_test_point: "TP-1",
        coverage_type: ["functional"],
        expected_basis: [{ expected: "页面显示成功", kind: "requirement", source_path: "inputs/req.txt", quote: "页面显示成功" }],
      },
      {
        case_id: "CASE-BAD",
        title: "无依据用例",
        steps: ["点击提交"],
        expected: "页面显示成功",
        automation_feasible: true,
        related_test_point: "TP-1",
        coverage_type: ["functional"],
      },
    ],
    sources: { "inputs/req.txt": "页面显示成功" },
  });
  await mount(h(DesignAssessmentView, { assessment: design, data: data() }));

  const select = document.querySelector<HTMLSelectElement>('[aria-label="用例审阅筛选"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "low_confidence");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(text()).toContain("1 / 2 条");
  expect(text()).toContain("CASE-BAD");
  expect(text()).not.toContain("CASE-OK");
});

it("residual risk keeps confirmed, pending and uncovered groups separate and offers no write action", async () => {  const assessment = assessResidualRisk({ reportLoaded: true, report: { report: null, stale: false } });
  await mount(h(ResidualRiskView, { assessment }));

  expect(text()).toContain("已确认缺陷");
  expect(text()).toContain("待核查现象");
  expect(text()).toContain("未覆盖风险");
  expect(text()).toContain("尚未登记报告索引");
  expect(text()).toContain("无法评估");
  expect(text()).toContain("没有执行结果不计为通过");
  expect(document.querySelectorAll("button")).toHaveLength(0);
});
