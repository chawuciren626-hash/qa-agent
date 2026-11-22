// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click } from "./helpers/dom";
import { QaProjectView } from "../src/features/qa/project-view";

const state = vi.hoisted(() => ({ tasks: [] as unknown[] }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ user: { userId: "tester" }, previewIsolated: false }) }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: "demo" }, agents: [{ agentId: "test_agent" }], setCurrentAgentId: vi.fn() }), projectDisplayName: () => "测试项目" }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../src/api/client", () => ({ apiFetch: async () => ({ projectId: "demo", tasks: state.tasks }) }));
// B5-4 双源拉取后 project-view 会调 listTasks；main 上此文件缺该 mock 导致视图渲染不出任务（存量失败），这里补齐。
vi.mock("../src/features/qa/platform-tasks/api", () => ({ listTasks: async () => ({ items: (state.tasks as any[]).map(t => ({ id: t.session.sessionId, title: t.session.title, mainSessionId: t.session.sessionId })) }) }));

afterEach(async () => { await unmountAll(); localStorage.clear(); });

function taskWith(severities: (string | undefined)[]) {
  return {
    session: { sessionId: "task-1", title: "缺陷任务", agentId: "test_agent", status: "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z" },
    runs: [{
      id: "run-1", status: "completed", stages: [{ id: "execution", status: "completed" }, { id: "defects", status: "completed" }], artifacts: [],
      caseCount: 1, defectCount: severities.length, executed: 1, passed: 1,
      cases: [{ id: "case-1", title: "用例", type: "Web", status: "passed", results: [{ case_id: "case-1", status: "passed" }] }],
      defects: severities.map((severity, index) => ({ id: `BUG-${index + 1}`, title: `缺陷 ${index + 1}`, severity, source: "defects" })),
    }],
    unavailable: 0, truncated: false,
  };
}

it("shows unknown and unrecorded severity in the task overview without calling them low risk", async () => {
  state.tasks = [taskWith(["Blocker", "unknown", undefined])];
  await mount(h(QaProjectView));
  await click(document.querySelector(".qp-task-toggle") as HTMLButtonElement);
  const overview = document.querySelector(".qp-quality")?.textContent ?? "";
  expect(overview).toContain("阻断 1");
  expect(overview).toContain("未评估 1");
  expect(overview).toContain("未记录 1");
  expect(overview).toContain("未评估/未记录不代表低风险");
  expect(document.querySelector(".qp-defect-list")?.textContent).toContain("未评估");
});

it("labels the defect table and detail with the same severity vocabulary", async () => {
  state.tasks = [taskWith(["Critical", undefined])];
  await mount(h(QaProjectView));
  const defectTab = [...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.includes("缺陷清单")) as HTMLButtonElement;
  await click(defectTab);
  expect(document.querySelector(".qp-record-table tbody")?.textContent).toContain("严重");
  expect(document.querySelector(".qp-record-table tbody")?.textContent).toContain("未记录");
  await click([...document.querySelectorAll(".qp-record-table tbody button")][1] as HTMLButtonElement);
  expect(document.querySelector('[aria-label="缺陷详情"]')?.textContent).toContain("未记录");
});

it("shows the defect ledger lifecycle status and related cases per defect (A2)", async () => {
  state.tasks = [{
    session: { sessionId: "task-1", title: "缺陷任务", agentId: "test_agent", status: "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z" },
    runs: [{
      id: "run-1", status: "completed", stages: [{ id: "defects", status: "completed" }], artifacts: [],
      caseCount: 0, defectCount: 2, executed: 0, passed: 0,
      defects: [
        { id: "BUG-1", title: "登录失败", severity: "Critical", source: "defects", detail: { lifecycle_status: "confirmed", related_cases: ["case-1", "case-2"] } },
        { id: "BUG-2", title: "提示错位", severity: "Minor", source: "defects" },
      ],
    }],
    unavailable: 0, truncated: false,
  }];
  await mount(h(QaProjectView));
  await click([...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.includes("缺陷清单")) as HTMLButtonElement);
  const header = document.querySelector(".qp-record-table thead")?.textContent ?? "";
  expect(header).toContain("生命周期状态");
  expect(header).toContain("关联用例");
  const body = document.querySelector(".qp-record-table tbody")?.textContent ?? "";
  expect(body).toContain("已确认");
  expect(body).toContain("case-1、case-2");
  expect(body).toContain("未登记");
});
