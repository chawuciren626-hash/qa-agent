// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { mount, settle, unmountAll } from "./helpers/dom";
import { createWorkspaceUI } from "../../../../penguin/ui/workspace-ui.mjs";

afterEach(async () => {
  await unmountAll();
});

function buildSchedulesPage() {
  const navigate = vi.fn();
  const request = vi.fn(async () => ({}));
  const ui = createWorkspaceUI({
    React,
    useProject: () => ({
      projects: [],
      projectsLoading: false,
      currentProject: null,
      agents: [],
      currentAgent: null,
    }),
    useAuth: () => ({ user: { userId: "empty-account" } }),
    useSessions: () => ({ sessions: [] }),
    useNavigate: () => navigate,
    useLocation: () => ({ pathname: "/chat", search: "?view=schedules", state: null }),
    request,
    Modal: () => null,
    notify: vi.fn(),
    reportError: vi.fn(),
  });
  return { ui, navigate, request };
}

describe("independent scheduled-task entry", () => {
  it("keeps the full scheduled-task page when the account has no Project", async () => {
    const { ui, request } = buildSchedulesPage();
    const mounted = await mount(React.createElement(ui.SectionPage, { view: "schedules" }));
    await settle();

    expect(mounted.container.querySelector("h1")?.textContent).toBe("定时任务");
    expect(mounted.container.textContent).toContain("试试这些常用测试任务");
    expect(mounted.container.textContent).not.toContain("正在加载工作空间");
    expect(request).not.toHaveBeenCalled();
  });

  it("never routes an empty scheduled-task page through Project management", async () => {
    const { ui, navigate } = buildSchedulesPage();
    const mounted = await mount(React.createElement(ui.SectionPage, { view: "schedules" }));
    await settle();
    expect(mounted.container.textContent).not.toContain("打开项目管理");
    expect(navigate).not.toHaveBeenCalled();
  });
});
