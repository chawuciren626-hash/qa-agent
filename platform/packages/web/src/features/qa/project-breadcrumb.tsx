/**
 * 项目资产面包屑（2026-11-23 侧栏菜单收敛）。
 *
 * 项目视图 / 项目环境 / 项目资料不再占一级菜单，收进项目管理列表行内穿透后，
 * 子页头部用这条轻量导航指回列表、并在兄弟页之间横跳；路由全部保留。
 * 刻意做成独立轻组件：项目视图、项目环境页直接导入它，不拖起 workspace-ui
 * 的整个共享 UI 工厂（那里依赖测试不会 mock 的 react-router 导出）。
 * 项目资料页（mjs SectionPage）经 workspace-ui.tsx 注入同一组件复用。
 */
import { useNavigate } from "react-router";
import { useProject } from "../../state/project";
import { useAuth } from "../../state/auth";
import { allowedModule } from "../../lib/module-permissions";

/** 面包屑只需要权限口径，不强制 AuthProvider：无 Provider（部分测试宿主）按无权限降级。 */
function useAuthUser(): { isAdmin: boolean; modulePermissions?: string[] } | null {
  try {
    return useAuth().user ?? null;
  } catch {
    return null;
  }
}

export function QaProjectBreadcrumb({ current }: { current: "视图" | "环境" | "资料" }) {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const user = useAuthUser();
  const libAllowed = allowedModule(user, "library");
  const name = currentProject ? (currentProject.name ?? currentProject.projectId) : null;
  const target = current === "视图" ? "/qa/project" : current === "环境" ? "/qa/project/environments" : "/qa/library";
  const crumb = (label: string, path: string, isCurrent = false) =>
    isCurrent ? (
      <span className="qa-crumbs-current" aria-current="page">{label}</span>
    ) : (
      <button type="button" className="qa-crumbs-link" onClick={() => navigate(path)}>{label}</button>
    );
  return (
    <nav className="qa-crumbs" aria-label="项目资产导航">
      {crumb("项目管理", "/qa/projects")}
      <span className="qa-crumbs-sep" aria-hidden="true">/</span>
      {name && <span className="qa-crumbs-project">{name}</span>}
      {name && <span className="qa-crumbs-sep" aria-hidden="true">/</span>}
      {crumb(current, target, true)}
      <span className="qa-crumbs-siblings">
        {current !== "视图" && crumb("视图", "/qa/project")}
        {current !== "环境" && crumb("环境", "/qa/project/environments")}
        {current !== "资料" && libAllowed && crumb("资料", "/qa/library")}
      </span>
    </nav>
  );
}
