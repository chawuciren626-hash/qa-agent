/** Connect the original product presentation to the source platform's public components. */
import * as React from "react";
import { useLocation, useNavigate } from "react-router";
import { Modal, Dropdown, MenuRadioItem, MenuItem, MenuSeparator, Badge, ICONS, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { SiteMarkdown } from "@prismshadow/penguin-ui/site";
import { createWorkspaceUI } from "../../../../../../penguin/ui/workspace-ui.mjs";
import clientStyles from "../../../../../../penguin/ui/workspace-ui.css?raw";
import brandLogo from "../../../../../../penguin/ui/aith-logo.svg?url";
import brandLogoLight from "../../../../../../penguin/ui/aith-logo-light.svg?url";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { useAuth } from "../../state/auth";
import { apiFetch } from "../../api/client";
import { WorkspaceSelect } from "../chat/workspace-select";
import { UserMenu } from "../../components/layout/user-menu";
import { prepareNewChatDraft } from "../chat/new-chat";
import { CreateProjectDialog, ProjectSettingsDialog } from "../../components/layout/project-dialogs";
import "./workspace-layout.css";

export const QaSessionActions = React.createContext<Record<string, unknown> | null>(null);

function ProjectNavigation() {
  const { projects, currentProject, setCurrentProjectId, reloadProjects } = useProject();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  return <>
    <Dropdown open={open} setOpen={setOpen} className="qa-project-switcher"
      portal={{ direction: "down", align: "left" }} menuClass="w-64"
      button={<button className="qa-project-trigger" aria-label="业务项目菜单" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{currentProject?.name ?? currentProject?.projectId ?? "选择业务项目"}</span><span aria-hidden="true">⌄</span>
      </button>}>
      {projects.map(p => <MenuRadioItem key={p.projectId} label={p.name ?? p.projectId} trailing={<Badge>{p.role}</Badge>}
        checked={p.projectId === currentProject?.projectId} onSelect={() => { setCurrentProjectId(p.projectId); setOpen(false); navigate("/qa/project"); }} />)}
      <MenuSeparator />
      <MenuItem glyph={ICONS.plus} label="新建项目" onSelect={() => { setOpen(false); setCreating(true); }} />
      {currentProject && <MenuItem glyph={ICONS.gear} label="项目设置" onSelect={() => { setOpen(false); setSettings(true); }} />}
    </Dropdown>
    <CreateProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={id => {
      setCreating(false); void reloadProjects().then(() => { setCurrentProjectId(id); navigate("/qa/project"); });
    }} />
    {currentProject && <ProjectSettingsDialog open={settings} onClose={() => setSettings(false)} />}
  </>;
}

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
  FolderPicker: WorkspaceSelect, Modal, AccountMenu: UserMenu,
  useSessionActions: () => React.useContext(QaSessionActions),
  SidebarTools: () => <>{React.useContext(QaSessionActions)?.tools as React.ReactNode}</>,
  ProjectNavigation,
  request: apiFetch, notify: toastSuccess, reportError: toastError,
  Markdown: ({ text }: { text: string }) => <SiteMarkdown variant="doc">{text}</SiteMarkdown>,
  clientStyles, brandLogo, brandLogoLight,
});
export const QaSidebar = ui.Sidebar;
export const QaHero = ui.Hero;
export const QaSessionContext = ui.SessionContext;
export function QaSectionPage({ view }: { view: "library" | "schedules" }) {
  return <ui.SectionPage view={view} />;
}
