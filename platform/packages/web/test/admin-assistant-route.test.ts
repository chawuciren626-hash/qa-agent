// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { mount, unmountAll } from "./helpers/dom";
import { ProjectProvider } from "../src/state/project";
import { AdminHostGate, AdminLayout } from "../src/features/admin/admin-layout";
import { AdminAssistantPage } from "../src/features/admin/admin-assistant-page";

const calls = vi.hoisted(() => ({ listProjects: vi.fn(), listAgents: vi.fn(), createProject: vi.fn() }));
vi.mock("../src/api/endpoints", async importOriginal => ({ ...await importOriginal<typeof import("../src/api/endpoints")>(), ...calls }));
vi.mock("../src/api/control", () => ({ controlRequest: async (path: string) => path.endsWith("/config") ? { central: true } : { items: [] } }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ user: { userId: "admin", isAdmin: true }, sessionVia: "web" }) }));
vi.mock("../src/state/sessions", () => ({ useSessions: () => ({ sessions: [] }) }));
vi.mock("../src/features/settings/settings-dialog", () => ({ SettingsDialog: () => null }));
vi.mock("../src/features/chat/chat-page", () => ({ DRAFT_SESSION_ID: "new", ChatPage: ({ fixedAgentId }: { fixedAgentId: string }) => h("div", { "data-assistant": fixedAgentId }, "助手输入区") }));
vi.mock("../src/components/layout/app-layout", () => ({ AppLayout: ({ localHostFeatures }: { localHostFeatures: boolean }) => h("div", { "data-local-host-features": String(localHostFeatures) }, h(Outlet)) }));

afterEach(async () => { await unmountAll(); localStorage.clear(); vi.clearAllMocks(); });

it.each([null, "default_project"])("opens the central assistant under /admin basename with prior selection %s", async prior => {
  if (prior) localStorage.setItem("aitest.admin.configProjectId", prior);
  calls.listProjects.mockResolvedValue({ projects: [
    { projectId: "default_project", role: "owner" },
    { projectId: "admin_agent_catalog", role: "owner" },
  ] });
  calls.listAgents.mockImplementation(async () => ({ agents: [{ agentId: "test_agent" }, { agentId: "default_agent" }] }));
  const workspace = h(AdminHostGate, null, h(ProjectProvider, { scope: "admin", children: h(AdminLayout) }));
  await mount(h(MemoryRouter, { basename: "/admin", initialEntries: ["/admin/chat/new"] },
    h(Routes, null, h(Route, { element: workspace }, h(Route, { path: "/chat/new", element: h(AdminAssistantPage) })))));
  expect(document.querySelector('[data-assistant="default_agent"]')?.textContent).toBe("助手输入区");
  expect(localStorage.getItem("aitest.admin.configProjectId")).toBe("admin_agent_catalog");
  expect(document.querySelector('[data-local-host-features="false"]')).not.toBeNull();
  expect(calls.createProject).not.toHaveBeenCalled();
});
