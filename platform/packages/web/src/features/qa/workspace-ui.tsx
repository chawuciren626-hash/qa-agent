/** Connect the original product presentation to the source platform's public components. */
import * as React from "react";
import { useLocation, useNavigate } from "react-router";
import { Modal, Dropdown, MenuRadioItem, MenuItem, MenuSeparator, ICONS, toastError, toastSuccess } from "@prismshadow/penguin-ui";
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
import { enterProject, quickSwitchProjects } from "./project-management/api";
import { ProjectKnowledgePage } from "./project-knowledge-page";
import { PersonalReferenceActions, ProjectReferenceSearch } from "./library-knowledge-bridge";
import "./workspace-layout.css";

export const QaSessionActions = React.createContext<Record<string, unknown> | null>(null);

function ProjectNavigation() {
  const { projects, currentProject, setCurrentProjectId } = useProject();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<{ projectId: string; name: string }[]>([]);
  // 两态外壳（工作台态）左上角项目选择器（应用外壳两态布局规格 §4.1）：当前项目在前、
  // 最多展示 8 个候选；展示顺序为「当前 → 其余项目」，数据始终来自真实项目上下文
  // （useProject），mock 适配层的候选排序（置顶优先/最近访问）待 Codex 接入后替换。
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    void quickSwitchProjects(currentProject?.projectId ?? null)
      .then(rows => { if (active) setCandidates(rows.map(row => ({ projectId: row.projectId, name: row.name }))); })
      .catch(error => { if (active) toastError(error instanceof Error ? error.message : "项目列表加载失败"); });
    return () => { active = false; };
  }, [open, currentProject?.projectId]);
  return <>
    <span className="qa-project-switcher-row">
      <Dropdown open={open} setOpen={setOpen} className="qa-project-switcher"
        portal={{ direction: "down", align: "left" }} menuClass="w-64"
        button={<button className="qa-project-trigger" aria-label="业务项目菜单" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="qa-project-name">{currentProject?.name ?? currentProject?.projectId ?? "选择业务项目"}</span><span aria-hidden="true">⌄</span>
        </button>}>
        {candidates.map(p => <MenuRadioItem key={p.projectId} label={p.name ?? p.projectId}
          checked={p.projectId === currentProject?.projectId} onSelect={() => { void enterProject(p.projectId).then(() => { setCurrentProjectId(p.projectId); setOpen(false); navigate("/qa/project"); }).catch(error => toastError(error instanceof Error ? error.message : "进入项目失败")); }} />)}
        {projects.length > candidates.length && <MenuRadioItem label={`其余 ${projects.length - candidates.length} 个项目…`} checked={false}
          onSelect={() => { setOpen(false); navigate("/qa/projects"); }} />}
        <MenuSeparator />
        <MenuItem glyph={ICONS.chevronLeft} label="返回项目管理" onSelect={() => { setOpen(false); navigate("/qa/projects"); }} />
      </Dropdown>
    </span>
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
  ProjectNavigation,
  ProjectKnowledgePanel: ({ tab, documentId }: { tab: "documents" | "candidates" | "rules"; documentId?: string }) => <ProjectKnowledgePage embedded initialTab={tab} initialDocumentId={documentId} />,
  PersonalReferenceActions, ProjectReferenceSearch,
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
