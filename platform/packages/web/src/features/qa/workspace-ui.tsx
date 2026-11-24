/** Connect the original product presentation to the source platform's public components. */
import * as React from "react";
import { useLocation, useNavigate } from "react-router";
import { Modal, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { SiteMarkdown } from "@prismshadow/penguin-ui/site";
import { createWorkspaceUI } from "../../../../../../penguin/ui/workspace-ui.mjs";
import clientStyles from "../../../../../../penguin/ui/workspace-ui.css?raw";
import brandLogo from "../../../../../../penguin/ui/aith-logo.svg?url";
import brandLogoLight from "../../../../../../penguin/ui/aith-logo-light.svg?url";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { useAllProjectSessions } from "../../state/session-index";
import { useAuth } from "../../state/auth";
import { apiFetch } from "../../api/client";
import { WorkspaceSelect } from "../chat/workspace-select";
import { UserMenu } from "../../components/layout/user-menu";
import { prepareNewChatDraft } from "../chat/new-chat";
import { QaProjectBreadcrumb } from "./project-breadcrumb";
import { ProjectKnowledgePage } from "./project-knowledge-page";
import { PersonalReferenceActions, ProjectReferenceSearch } from "./library-knowledge-bridge";
import "./workspace-layout.css";

export const QaSessionActions = React.createContext<Record<string, unknown> | null>(null);

/* 品牌区回归（2026-11-23 菜单收敛）：左上角项目选择器（ProjectNavigation）已移除，
   项目上下文唯一入口改为项目管理列表行内「视图 · 环境 · 资料」穿透；
   workspace-ui.mjs 的品牌区随之回落为 Logo + AITestHarness 文案。 */

function useQaNavigate() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentProject } = useProject();
  return (to: string, options?: { state?: unknown; replace?: boolean }) => {
    if (to === "/chat/new" && !options?.replace && user && currentProject)
      prepareNewChatDraft(user.userId, currentProject.projectId);
    navigate(to, options);
  };
}

const ui = createWorkspaceUI({
  React, useProject, useSessions, useAuth, useNavigate: useQaNavigate, useLocation,
  useAllProjectSessions,
  FolderPicker: WorkspaceSelect, Modal, AccountMenu: UserMenu,
  useSessionActions: () => React.useContext(QaSessionActions),
  ProjectBreadcrumb: QaProjectBreadcrumb,
  ProjectKnowledgePanel: ({ tab, documentId }: { tab: "documents" | "candidates" | "rules" | "assets" | "system_map" | "run_archive"; documentId?: string }) => <ProjectKnowledgePage embedded initialTab={tab} initialDocumentId={documentId} />,
  PersonalReferenceActions, ProjectReferenceSearch,
  request: apiFetch, notify: toastSuccess, reportError: toastError,
  Markdown: ({ text }: { text: string }) => <SiteMarkdown variant="doc">{text}</SiteMarkdown>,
  clientStyles, brandLogo, brandLogoLight,
});
export const QaSidebar = ui.Sidebar;
export const QaHero = ui.Hero;
export const QaSessionContext = ui.SessionContext;
export { QaProjectBreadcrumb } from "./project-breadcrumb";
export function QaSectionPage({ view }: { view: "library" | "schedules" }) {
  return <ui.SectionPage view={view} />;
}
