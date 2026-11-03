// @vitest-environment jsdom
/**
 * The read-only Q3 surfaces (T4). The suites pin the honesty rules the components exist for:
 * linked coverage is not a pass, a missing result is not a pass, a missing report index says
 * "尚未登记", a stale report says so, and defect confirmation/retest/publication never appear
 * as actions here. The Q3 service itself is covered by the server suites.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { click, hasButton, mount, unmountAll } from "./helpers/dom";
import {
  CoverageRiskView,
  DefectStatusView,
  ReportIndexViewPanel,
} from "../src/features/qa/quality-traceability-views";
import type {
  CaseResultView,
  CoverageView,
  DefectDetailView,
  DefectView,
  ReportIndexView,
} from "../src/features/qa/quality-traceability-model";

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

const text = () => document.body.textContent ?? "";

const failedEvidence = {
  type: "execution" as const,
  sessionId: "session-1",
  runId: "run-1",
  evidencePath: "execution/lockout.png",
};

function coverageFixture(): CoverageView {
  return {
    projectId: "demo",
    sessionId: "session-1",
    runId: "run-1",
    designRevision: 2,
    designStatus: "frozen",
    counts: {
      points: 2,
      cases: 3,
      coveredPoints: 2,
      uncoveredPoints: 0,
      executed: 2,
      passed: 0,
      failed: 1,
      skipped: 1,
      blocked: 0,
      untestedCases: 1,
    },
    rates: { pointCoverage: 1, caseExecution: 2 / 3, passRate: 0 },
    risk: {
      high: { points: 1, covered: 1, executed: 1, failed: 1, untested: 0 },
      medium: { points: 1, covered: 1, executed: 1, failed: 0, untested: 1 },
      low: { points: 0, covered: 0, executed: 0, failed: 0, untested: 0 },
    },
    gate: {
      qualityGate: "blocked",
      conclusion: "failed",
      allPassed: false,
      complete: false,
      evidenceComplete: true,
      reasons: ["存在失败用例"],
    },
    points: [
      {
        pointKey: "P-1",
        module: "登录",
        feature: "锁定",
        risk: "high",
        coveredBy: ["CASE-001", "CASE-002"],
        status: "failed",
        caseCounts: { passed: 0, failed: 1, skipped: 1, blocked: 0, notRun: 0 },
        untestedReason: null,
      },
      {
        pointKey: "P-2",
        module: "登录",
        feature: "找回密码",
        risk: "medium",
        coveredBy: ["CASE-003"],
        status: "untested",
        caseCounts: { passed: 0, failed: 0, skipped: 0, blocked: 0, notRun: 1 },
        untestedReason: "本次运行未执行",
      },
    ],
    untested: [{ kind: "case", id: "CASE-003", reason: "本次运行未执行" }],
  };
}

const resultsFixture: CaseResultView[] = [
  {
    caseKey: "CASE-001",
    status: "failed",
    reason: "断言不成立",
    invocationId: "inv-1",
    evidenceRefs: [failedEvidence],
    updatedAt: "2026-11-03T01:00:00Z",
  },
  {
    caseKey: "CASE-002",
    status: "skipped",
    reason: "依赖环境未就绪",
    invocationId: "inv-2",
    evidenceRefs: [],
    updatedAt: "2026-11-03T01:00:00Z",
  },
];

function defectFixture(over: Partial<DefectView> = {}): DefectView {
  return {
    defectId: "defect-1",
    projectId: "demo",
    fingerprint: "sha256:1111222233334444",
    title: "连续失败未锁定账号",
    category: "product_defect",
    status: "confirmed",
    confidence: "strong",
    severity: "Critical",
    priority: "P0",
    expectedResult: "失败五次锁定三十分钟",
    actualResult: "仍可继续登录",
    analysis: "计数未生效",
    relatedCases: ["CASE-001"],
    evidenceRefs: [failedEvidence],
    originSessionId: "session-1",
    originRunId: "run-1",
    firstSeenAt: "2026-11-03T00:30:00Z",
    updatedAt: "2026-11-03T02:00:00Z",
    revision: 3,
    eventCount: 2,
    ...over,
  };
}

function detailFixture(): DefectDetailView {
  return {
    defect: defectFixture(),
    occurrences: [
      {
        occurrenceId: "occ-1",
        sessionId: "session-1",
        runId: "run-1",
        caseKey: "CASE-001",
        evidenceRefs: [failedEvidence],
        observedAt: "2026-11-03T00:30:00Z",
      },
    ],
    events: [
      {
        eventId: "event-1",
        sequence: 1,
        action: "discovered",
        fromStatus: "",
        toStatus: "needs_review",
        actorUserId: "agent-1",
        reason: "自动发现",
        evidenceRefs: [],
        prevEventHash: "",
        eventHash: "sha256:aaaaaaaaaaaaaaaa",
        createdAt: "2026-11-03T00:30:00Z",
      },
      {
        eventId: "event-2",
        sequence: 2,
        action: "confirm",
        fromStatus: "needs_review",
        toStatus: "confirmed",
        actorUserId: "owner-1",
        reason: "复现确认",
        evidenceRefs: [failedEvidence],
        prevEventHash: "sha256:aaaaaaaaaaaaaaaa",
        eventHash: "sha256:deadbeefcafebabe",
        createdAt: "2026-11-03T02:00:00Z",
      },
    ],
    retests: [
      {
        retestId: "retest-1",
        defectId: "defect-1",
        sessionId: "session-retest",
        runId: "run-retest",
        batchId: "batch-retest",
        result: "passed",
        caseResults: [{ caseKey: "CASE-001", status: "passed" }],
        evidenceRefs: [],
        createdAt: "2026-11-04T00:00:00Z",
        createdBy: "owner-1",
      },
    ],
  };
}

function reportFixture(over: Partial<ReportIndexView> = {}): ReportIndexView {
  return {
    reportId: "report-1",
    projectId: "demo",
    sessionId: "session-1",
    runId: "run-1",
    batchId: "batch-1",
    designRevision: 2,
    revision: 2,
    status: "published",
    htmlPath: "report/report-task.html",
    htmlSha256: "sha256:9999888877776666",
    conclusion: "failed",
    qualityGate: "blocked",
    counts: coverageFixture().counts,
    coverage: { pointCoverage: 1, caseExecution: 2 / 3, passRate: 0, allPassed: false },
    untested: [{ kind: "point", id: "P-2", reason: "未设计用例" }],
    evidence: [
      {
        label: "锁定失败截图",
        ref: failedEvidence,
        path: "execution/lockout.png",
        sha256: "sha256:5555666677778888",
      },
    ],
    limitations: ["仅验证登录锁定场景"],
    openDefects: [{ defectId: "defect-1", status: "confirmed", severity: "Critical" }],
    resultsFingerprint: "sha256:abcdefabcdef",
    createdAt: "2026-11-03T03:00:00Z",
    createdBy: "owner-1",
    contentHash: "sha256:123412341234",
    ...over,
  };
}

it("shows failure, skip and missing results with their reasons and evidence, never as a pass", async () => {
  await mount(h(CoverageRiskView, { coverage: coverageFixture(), results: resultsFixture }));

  expect(text()).toContain("覆盖只表示有关联用例，不等于通过；跳过、阻塞和无结果都不计为通过。");
  expect(text()).toContain("质量门：阻断");
  expect(text()).toContain("存在失败用例");

  expect(text()).toContain("原因：存在失败用例");
  expect(text()).toContain("原因：本次运行未执行");
  expect(text()).toContain("CASE-001 · 失败 · 原因：断言不成立");
  expect(text()).toContain("证据：执行 session-1/run-1 · execution/lockout.png");
  expect(text()).toContain("CASE-002 · 跳过 · 原因：依赖环境未就绪");
  expect(text()).toContain("CASE-003 · 无执行结果（不得视为通过）");
  expect(text()).toContain("用例 CASE-003：本次运行未执行");
  expect(document.querySelectorAll(".qt-case-result")).toHaveLength(3);
});

it("says a report index is missing instead of inferring a conclusion from the session", async () => {
  await mount(h(ReportIndexViewPanel, { response: { report: null, stale: false } }));

  expect(text()).toContain("尚未登记报告索引");
  expect(text()).toContain("不得根据会话文本、截图文件名或日志推断本次运行通过");
  expect(text()).not.toContain("结论 通过");
});

it("labels a stale report and keeps its evidence sources and untested items", async () => {
  await mount(
    h(ReportIndexViewPanel, { response: { report: reportFixture(), stale: true } }),
  );

  expect(text()).toContain("已发布 · 失败 · 结果已变化，不是当前报告");
  expect(document.querySelector('[role="alert"]')?.textContent ?? "").toContain("结果已变化");
  expect(text()).toContain("锁定失败截图");
  expect(text()).toContain("执行 session-1/run-1 · execution/lockout.png");
  expect(text()).toContain("测试点 P-2：未设计用例");
  expect(text()).toContain("仅验证登录锁定场景");
  expect(text()).toContain("defect-1 · 已确认 · Critical");
  expect(hasButton("发布报告")).toBe(false);
  expect(hasButton("确认")).toBe(false);
});

it("shows the defect lifecycle read-only with occurrences, event chain and retests", async () => {
  const onSelect = vi.fn();
  await mount(
    h(DefectStatusView, { defects: [defectFixture()], detail: detailFixture(), onSelect }),
  );

  expect(text()).toContain("只读视图：确认、修复声明和关闭都不在这里发生");
  expect(text()).toContain("连续失败未锁定账号");
  expect(text()).toContain("已确认");
  expect(text()).toContain("产品缺陷");
  expect(text()).toContain("期望：失败五次锁定三十分钟");
  expect(text()).toContain("session-1/run-1 · 用例 CASE-001");
  expect(text()).toContain("证据：执行 session-1/run-1 · execution/lockout.png");
  expect(text()).toContain("#2 confirm · needs_review → confirmed · owner-1");
  expect(text()).toContain("deadbeef");
  expect(text()).toContain("通过 · session-retest/run-retest");
  for (const action of ["确认缺陷", "标记修复", "复测", "发布报告", "关闭缺陷"]) {
    expect(hasButton(action)).toBe(false);
  }

  await click(document.querySelector(".qt-defect")!);
  expect(onSelect).toHaveBeenCalledWith("defect-1");
});
