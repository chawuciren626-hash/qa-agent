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
