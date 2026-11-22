// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, run } from "./helpers/dom";
import { QaMetricsPanel, projectMetrics } from "../src/features/qa/metrics-panel";

afterEach(async () => { await unmountAll(); });

it("computes project metrics from validated run records only", () => {
  const metrics = projectMetrics([
    { runs: [{ caseCount: 10, executed: 6, passed: 4, failed: 2, defects: [{ severity: "Blocker" }, { severity: "Major" }, {}] }] },
    { runs: [{ caseCount: 5, executed: 4, passed: 3, failed: 1, defects: [{ severity: "Critical" }, { severity: "unknown" }] }] },
  ]);
  expect(metrics.caseTotal).toBe(15);
  expect(metrics.executed).toBe(10);
  expect(metrics.passed).toBe(7);
  expect(metrics.passRate).toBe(70);
  expect(metrics.highSeverity).toBe(2);
  expect(metrics.severity.levels.Major).toBe(1);
  expect(metrics.severity.unknown).toBe(1);
  expect(metrics.severity.unrecorded).toBe(1);
  expect(projectMetrics([{ runs: [{}] }]).passRate).toBeNull();
});

it("renders the metrics panel with pass rate, high-severity count and severity distribution", async () => {
  await mount(h(QaMetricsPanel, { tasks: [{ runs: [{ caseCount: 10, executed: 5, passed: 4, failed: 1, defects: [{ severity: "Blocker" }, { severity: "Minor" }] }] }] }));
  await run(() => {});
  const panel = document.querySelector('[aria-label="项目指标"]');
  expect(panel?.textContent).toContain("用例总数");
  expect(panel?.textContent).toContain("10");
  expect(panel?.textContent).toContain("80%");
  expect(panel?.textContent).toContain("高严重度缺陷");
  expect(panel?.textContent).toContain("阻断 1");
  expect(panel?.textContent).toContain("轻微 1");
  expect(panel?.textContent).not.toContain("未评估 1");
});
