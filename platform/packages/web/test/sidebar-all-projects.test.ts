// @vitest-environment jsdom
/**
 * 侧栏「全部项目」模式（penguin/ui/workspace-ui.mjs 的 Sidebar）。
 *
 * 这是本次改动里唯一没有既有测试覆盖的部分：侧栏原本只渲染「当前项目」的会话，
 * 现在多一条只读旁路——跨项目快照平铺，每行带所属项目名，点击先把当前项目切过去。
 *
 * 断言三件事：
 * - 关闭时不渲染跨项目行（原行为不变）；
 * - 打开时平铺出两个项目的会话，行上带项目名；
 * - 点某一行会切到它所属的项目，再进入该会话。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createWorkspaceUI } from "../../../../penguin/ui/workspace-ui.mjs";
import { mount, settle, unmountAll } from "./helpers/dom";

afterEach(async () => {
  await unmountAll();
  localStorage.clear();
});

const ITEMS = [
  {
    sessionId: "s-alpha",
    projectId: "p-alpha",
    agentId: "default_agent",
    title: "会员中心登录回归",
    workspace: "/srv/alpha",
    lastActiveAt: "2026-11-24T08:00:00.000Z",
  },
  {
    sessionId: "s-beta",
    projectId: "p-beta",
    agentId: "default_agent",
    title: "订单导出排查",
    workspace: "/srv/beta",
    lastActiveAt: "2026-11-23T08:00:00.000Z",
  },
];

function buildUI(options: {
  enabled: boolean;
  onToggle?: () => void;
  onNavigate?: (path: string) => void;
}) {
  const navigate = vi.fn();
  const setCurrentProjectId = vi.fn();
  const setCurrentAgentId = vi.fn();
  const ui = createWorkspaceUI({
    React,
    useProject: () => ({
      projects: [
        { projectId: "p-alpha", name: "会员中心" },
        { projectId: "p-beta", name: "订单中心" },
      ],
      projectsLoading: false,
      currentProject: { projectId: "p-alpha", name: "会员中心" },
      setCurrentProjectId,
      reloadProjects: async () => undefined,
      agents: [{ agentId: "default_agent" }],
      agentsLoading: false,
      currentAgent: { agentId: "default_agent" },
      setCurrentAgentId,
      reloadAgents: async () => undefined,
    }),
    useSessions: () => ({
      sessions: [],
      loading: false,
      hasMoreFor: () => false,
      loadMoreFor: async () => undefined,
      reload: async () => undefined,
    }),
    useAuth: () => ({ user: { userId: "u1", displayName: "测试", isAdmin: false } }),
    useNavigate: () => (path: string) => {
      navigate(path);
      options.onNavigate?.(path);
    },
    useLocation: () => ({ pathname: "/qa/projects", search: "", state: null }),
    FolderPicker: () => null,
    Modal: () => null,
    AccountMenu: () => null,
    useSessionActions: () => null,
    useAllProjectSessions: () => ({
      enabled: options.enabled,
      toggle: options.onToggle ?? (() => undefined),
      items: ITEMS,
      loading: false,
      error: "",
      refresh: () => undefined,
    }),
    request: async () => ({}),
    notify: () => undefined,
    reportError: () => undefined,
    clientStyles: "",
    brandLogo: "",
    brandLogoLight: "",
  });
  return { Sidebar: ui.Sidebar, navigate, setCurrentProjectId, setCurrentAgentId };
}

describe("侧栏全部项目模式", () => {
  it("关闭时保持原样：只渲染当前项目的工作空间分组，不出现跨项目行", async () => {
    const { Sidebar } = buildUI({ enabled: false });
    const mounted = await mount(React.createElement(Sidebar, {}));
    await settle();
    expect(mounted.container.querySelectorAll(".qa-global-session").length).toBe(0);
    expect(mounted.container.textContent).not.toContain("订单中心");
  });

  it("打开时平铺两个项目的会话，每行带所属项目名", async () => {
    const { Sidebar } = buildUI({ enabled: true });
    const mounted = await mount(React.createElement(Sidebar, {}));
    await settle();
    const rows = mounted.container.querySelectorAll(".qa-global-session");
    expect(rows.length).toBe(2);
    // 最近活动在前：alpha 在 beta 之前。
    expect(rows[0]?.textContent).toContain("会员中心");
    expect(rows[0]?.textContent).toContain("会员中心登录回归");
    expect(rows[1]?.textContent).toContain("订单中心");
    expect(rows[1]?.textContent).toContain("订单导出排查");
  });

  it("点另一个项目的会话：先切项目，再进入该会话", async () => {
    const { Sidebar, navigate, setCurrentProjectId, setCurrentAgentId } = buildUI({
      enabled: true,
    });
    const mounted = await mount(React.createElement(Sidebar, {}));
    await settle();
    const beta = mounted.container.querySelectorAll(".qa-global-session")[1] as HTMLElement;
    beta.click();
    await settle();
    expect(setCurrentProjectId).toHaveBeenCalledWith("p-beta");
    expect(setCurrentAgentId).toHaveBeenCalledWith("default_agent");
    expect(navigate).toHaveBeenCalledWith("/chat/s-beta");
  });
});
