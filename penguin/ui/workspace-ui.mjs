// Presentation-only project groups, scoped to installation, account and host configuration.
// Never changes credentials, agent configuration, source folders, or historical task files.
export function qaScope(projectId, userId, storage = globalThis.localStorage) {
  return `aitest.client.v2.${encodeURIComponent(storage.getItem("penguin.installId") || "local")}.${encodeURIComponent(userId || "anonymous")}.${encodeURIComponent(projectId || "default")}`;
}
export function qaRead(scope, storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(scope) || "{}");
    return {
      projects: Array.isArray(value.projects)
        ? value.projects.filter(
            (p) =>
              typeof p.id === "string" &&
              typeof p.name === "string" &&
              Array.isArray(p.folders),
          )
        : [],
      bindings:
        value.bindings && typeof value.bindings === "object"
          ? value.bindings
          : {},
    };
  } catch {
    return { projects: [], bindings: {} };
  }
}
export function qaWrite(scope, value, storage = globalThis.localStorage) {
  storage.setItem(scope, JSON.stringify(value));
  globalThis.window?.dispatchEvent(
    new CustomEvent("aitest:projects", { detail: scope }),
  );
}
export function qaBindProject(
  projectId,
  userId,
  groupId,
  sessionId,
  storage = globalThis.localStorage,
) {
  if (!groupId) return;
  const scope = qaScope(projectId, userId, storage),
    value = qaRead(scope, storage);
  if (!value.projects.some((p) => p.id === groupId)) return;
  value.bindings[sessionId] = groupId;
  qaWrite(scope, value, storage);
}
export function qaProjectForSession(projects, bindings, session) {
  const bound = bindings[session.sessionId];
  if (bound) return projects.find((p) => p.id === bound) || null;
  const normalize = (value) =>
    String(value || "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const workspace = normalize(session.workspace);
  const matches = projects
    .flatMap((p) =>
      p.folders
        .filter((path) => {
          const root = normalize(path);
          return (
            root && (workspace === root || workspace.startsWith(root + "/"))
          );
        })
        .map((path) => ({ project: p, length: normalize(path).length })),
    )
    .sort((a, b) => b.length - a.length);
  if (
    !matches.length ||
    (matches[1] &&
      matches[1].length === matches[0].length &&
      matches[1].project.id !== matches[0].project.id)
  )
    return null;
  return matches[0].project;
}
export function qaTaskStatus(session, live = {}) {
  if (live.humanWaiting) return { label: "等待人工操作", kind: "waiting" };
  if (live.error) return { label: "连接异常", kind: "error" };
  if (live.pending > 0) return { label: "等待确认", kind: "waiting" };
  const status = live.status ?? session?.status;
  if (status === "running") return { label: "运行中", kind: "running" };
  if (status === "compacting") return { label: "整理上下文", kind: "running" };
  if (
    status === "failed" ||
    status === "error" ||
    live.stopReason === "failed" ||
    live.stopReason === "error"
  )
    return { label: "执行失败", kind: "error" };
  if (
    status === "cancelled" ||
    status === "canceled" ||
    live.stopReason === "cancelled" ||
    live.stopReason === "interrupted" ||
    live.stopReason === "aborted"
  )
    return { label: "已停止", kind: "idle" };
  if (live.stopReason === "completed" || status === "completed")
    return { label: "本轮已完成", kind: "done" };
  return { label: session?.hasTrace ? "待继续" : "未开始", kind: "idle" };
}
export function qaLastOutcome(items = []) {
  for (const item of [...items].reverse()) {
    if (item.kind === "user_text") return undefined;
    if (item.kind === "abort")
      return item.errorCode || item.errorMessage ? "failed" : "aborted";
    if (item.kind === "assistant_text" && item.stopReason)
      return item.stopReason;
  }
  return undefined;
}
// Temporarily disabled until the scene-specific workflow is defined.
export const qaScenesEnabled = false;
const qaGeneralPrompts = [
  "帮我新建一个测试任务",
  "根据需求生成测试用例",
  "执行一轮回归测试",
  "汇总本轮测试结果并输出测试报告",
  "分析目标的性能与安全测试范围",
];
export const qaScenes = [
  {
    name: "功能测试",
    icon: "bolt",
    prefix: "请按功能测试场景处理：",
    prompts: [
      "帮我新建一个功能测试任务",
      "根据需求生成测试用例",
      "执行一轮功能回归测试",
      "汇总本轮测试结果并输出测试报告",
      "分析目标的性能与安全测试范围",
    ],
  },
  {
    name: "接口自动化",
    icon: "plug",
    prefix: "请按接口自动化测试场景处理：",
    prompts: [
      "帮我新建一个接口自动化测试任务",
      "根据接口文档生成测试用例",
      "执行一轮接口自动化回归测试",
      "汇总接口测试结果并输出测试报告",
      "分析接口的性能与安全测试范围",
    ],
  },
  {
    name: "Web 自动化",
    icon: "globe",
    prefix: "请按 Web 自动化测试场景处理：",
    prompts: [
      "帮我新建一个 Web 自动化测试任务",
      "根据页面需求生成测试用例",
      "执行一轮 Web 自动化回归测试",
      "汇总 Web 自动化测试结果并输出测试报告",
      "分析网页的性能与安全测试范围",
    ],
  },
];
export function createWorkspaceUI(deps) {
  const {
    React: R,
    useProject,
    useSessions,
    useAuth,
    useNavigate,
    useLocation,
    FolderPicker,
    Modal,
    AccountMenu,
    LegacySidebar,
    notify,
    reportError,
  } = deps;
  const h = R.createElement;
  function BrandLogo({className = "qa-sidebar-logo"}) {
    return h("span", {className: `qa-brand-mark ${className}`, role: "img", "aria-label": "AITestHarness Logo"},
      h("img", {src: qaBrandLogo, className:"qa-logo-default", alt:"", "aria-hidden":true, draggable:false}),
      h("img", {src: qaBrandLogoLight, className:"qa-logo-light", alt:"", "aria-hidden":true, draggable:false}));
  }
  if (
    typeof document !== "undefined" &&
    !document.getElementById("aitest-client-styles")
  ) {
    const el = document.createElement("style");
    el.id = "aitest-client-styles";
    el.textContent = qaClientStyles;
    document.head.append(el);
    document.documentElement.dataset.qaClient = "v2";
  }
  const paths = {
    folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3Z",
    plus: "M12 5v14M5 12h14",
    chevron: "m9 5 7 7-7 7",
    edit: "m16 3 5 5-12 12-6 1 1-6Z",
    clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    book: "M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z",
    bot: "M8 3h4v4M3 9h18v12H3ZM7 13h1m8 0h1M8 17h8",
    box: "m12 2 10 5v10l-10 5-10-5V7Zm0 10v10M2 7l10 5 10-5",
    bolt: "m13 2-9 12h7l-1 8 10-13h-7Z",
    plug: "M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-14 0ZM12 18v4",
    globe:
      "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
    refresh: "M20 7V2l-4 4a9 9 0 1 0 4 10M20 7h-5",
    back: "M20 12H4m7-7-7 7 7 7",
    more: "M4 12h1m6 0h1m6 0h1",
    close: "m6 6 12 12M6 18 18 6",
  };
  function Icon({ name, size = 16 }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      h("path", { d: paths[name] || paths.folder }),
    );
  }
  function useGroups() {
    const { currentProject } = useProject(),
      { user } = useAuth();
    const scope = qaScope(currentProject?.projectId, user?.userId);
    const [, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => {
      const change = () => bump();
      window.addEventListener("aitest:projects", change);
      window.addEventListener("storage", change);
      return () => {
        window.removeEventListener("aitest:projects", change);
        window.removeEventListener("storage", change);
      };
    }, []);
    const value = qaRead(scope);
    let previous = [];
    try {
      previous = JSON.parse(
        localStorage.getItem(
          "penguin.sidebarWorkspaces." + currentProject?.projectId,
        ) || "[]",
      );
    } catch {}
    const imported = Array.isArray(previous)
      ? previous
          .map((p) => (typeof p === "string" ? { path: p } : p))
          .filter((p) => p && typeof p.path === "string" && p.path.trim())
          .map((p) => ({
            id: "workspace:" + p.path,
            name: p.alias || p.path.split(/[\\/]/).filter(Boolean).pop(),
            folders: [p.path],
          }))
      : [];
    return {
      scope,
      ...value,
      projects: [
        ...value.projects,
        ...imported.filter(
          (p) => !value.projects.some((v) => v.folders.includes(p.folders[0])),
        ),
      ],
    };
  }
  function ProjectModal({ open, onClose, onCreated }) {
    const { currentProject } = useProject(),
      groups = useGroups();
    const [name, setName] = R.useState(""),
      [folders, setFolders] = R.useState([]),
      [error, setError] = R.useState("");
    R.useEffect(() => {
      if (open) {
        setName("");
        setFolders([]);
        setError("");
      }
    }, [open]);
    function create() {
      const label = name.trim();
      if (!label) return setError("请输入项目名称后再创建");
      if (groups.projects.some((p) => p.name === label))
        return setError("已有同名项目，请使用其他名称");
      const project = {
        id: crypto.randomUUID(),
        name: label,
        folders,
        createdAt: new Date().toISOString(),
      };
      try {
        const latest = qaRead(groups.scope);
        qaWrite(groups.scope, {
          ...latest,
          projects: [...latest.projects, project],
        });
        onCreated(project);
        notify(`项目「${label}」已创建`);
      } catch {
        setError("项目保存失败，请检查本机存储空间后重试");
      }
    }
    return h(
      Modal,
      {
        open,
        title: "新建项目",
        onClose,
        widthClass: "qa-project-modal",
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          h("button", { className: "qa-button", onClick: onClose }, "取消"),
          h(
            "button",
            {
              className: "qa-button qa-primary",
              disabled: !name.trim(),
              onClick: create,
            },
            "创建项目",
          ),
        ),
      },
      h(
        "div",
        { className: "qa-project-form" },
        h(
          "label",
          { htmlFor: "qa-project-name", className: "qa-sr" },
          "项目名称",
        ),
        h(
          "div",
          { className: `qa-name-input ${error ? "qa-invalid" : ""}` },
          h(Icon, { name: "folder" }),
          h("input", {
            id: "qa-project-name",
            autoFocus: true,
            maxLength: 80,
            placeholder: "项目名称",
            value: name,
            "aria-invalid": !!error,
            onChange: (e) => {
              setName(e.target.value);
              setError("");
            },
            onKeyDown: (e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
            },
          }),
        ),
        error && h("p", { role: "alert", className: "qa-error" }, error),
        h("h3", null, "来源文件夹"),
        h(
          "div",
          { className: "qa-source-box" },
          folders.length
            ? h(
                "div",
                { className: "qa-folder-list" },
                ...folders.map((path) =>
                  h(
                    "div",
                    { className: "qa-folder-row", key: path },
                    h(Icon, { name: "folder" }),
                    h("span", { title: path }, path),
                    h(
                      "button",
                      {
                        className: "qa-icon-button",
                        "aria-label": `移除 ${path}`,
                        onClick: () =>
                          setFolders(folders.filter((f) => f !== path)),
                      },
                      h(Icon, { name: "close", size: 14 }),
                    ),
                  ),
                ),
              )
            : h(
                "p",
                { className: "qa-empty" },
                "尚未添加文件夹，任务将使用独立工作区",
              ),
          h(FolderPicker, {
            projectId: currentProject?.projectId || "",
            workspace: "",
            fieldLabel: "来源文件夹",
            onChange: (path) => {
              if (path && !folders.includes(path))
                setFolders([...folders, path]);
            },
            trigger: (isOpen, toggle) =>
              h(
                "button",
                {
                  className: "qa-button qa-add-folder",
                  onClick: toggle,
                  "aria-expanded": isOpen,
                },
                h(Icon, { name: "plus" }),
                folders.length ? "继续添加" : "添加本机文件夹",
              ),
          }),
          folders.length > 0 &&
            h(
              "p",
              { className: "qa-hint" },
              "来源：本机 · 发起任务时可选择工作文件夹",
            ),
        ),
      ),
    );
  }
  function Sidebar({ onNavigate, onCollapse }) {
    const project = useProject(),
      sessionState = useSessions(),
      { user } = useAuth(),
      navigate = useNavigate(),
      location = useLocation(),
      groups = useGroups();
    const [modal, setModal] = R.useState(false),
      [legacy, setLegacy] = R.useState(false),
      [collapsed, setCollapsed] = R.useState({}),
      [more, setMore] = R.useState(false),
      [recentLimit, setRecentLimit] = R.useState(3),
      [search, setSearch] = R.useState(""),
      [refreshing, setRefreshing] = R.useState(false);
    const selectedId = location.pathname.split("/chat/")[1];
    const sessions = sessionState.sessions.filter(
      (s) =>
        !s.origin?.length &&
        s.source !== "subagent" &&
        s.source !== "benchmark" &&
        !String(s.source).startsWith("org_") &&
        !s.archived &&
        s.status !== "archived",
    );
    const agentId =
      project.agents.find((a) => a.agentId === "test_agent")?.agentId ||
      project.currentAgent?.agentId;
    function go(path, state) {
      navigate(path, state ? { state } : undefined);
      onNavigate?.();
    }
    function start(group) {
      go("/chat/new", {
        agentId,
        workspace: group?.folders[0] || "",
        qaProjectId: group?.id || null,
      });
    }
    function task(session) {
      project.setCurrentAgentId(session.agentId);
      go(`/chat/${encodeURIComponent(session.sessionId)}`);
    }
    function toggle(id) {
      setCollapsed((current) => ({ ...current, [id]: !current[id] }));
    }
    const matches = (s) =>
      !search || (s.title || "").toLowerCase().includes(search.toLowerCase());
    const recent = [...sessions]
      .filter(matches)
      .sort((a, b) =>
        String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)),
      );
    const projectActivity = (group) =>
      sessions.reduce(
        (latest, session) =>
          qaProjectForSession(groups.projects, groups.bindings, session)?.id ===
            group.id && (session.lastActiveAt || "") > latest
            ? session.lastActiveAt
            : latest,
        group.createdAt || "",
      );
    const taskRow = (s) => {
      const status = qaTaskStatus(s);
      return h(
        "button",
        {
          key: s.sessionId,
          className: `qa-task ${s.sessionId === selectedId ? "is-active" : ""}`,
          "aria-current": s.sessionId === selectedId ? "page" : undefined,
          onClick: () => task(s),
          title: `${s.title || "未命名任务"} · ${status.label}`,
        },
        h("span", {
          className: `qa-dot ${status.kind}`,
          "aria-label": status.label,
        }),
        h("span", { className: "qa-task-title" }, s.title || "未命名任务"),
        h(
          "time",
          { dateTime: s.lastActiveAt, title: s.lastActiveAt },
          relativeTime(s.lastActiveAt),
        ),
      );
    };
    const nav = (label, icon, path) =>
      h(
        "button",
        {
          className: `qa-nav ${location.pathname + location.search === path ? "is-active" : ""}`,
          onClick: () => go(path),
          key: label,
        },
        h(Icon, { name: icon }),
        label,
      );
    return h(
      "div",
      { className: "qa-sidebar" },
      h(
        "div",
        { className: "qa-brand" },
        h(BrandLogo),
        h("span", null, "AITestHarness"),
        onCollapse &&
          h(
            "button",
            {
              className: "qa-icon-button",
              onClick: onCollapse,
              "aria-label": "收起侧栏",
            },
            h(Icon, { name: "back" }),
          ),
      ),
      h(
        "button",
        { className: "qa-new-task", onClick: () => start() },
        h(Icon, { name: "edit" }),
        "新建任务",
      ),
      h(
        "nav",
        { className: "qa-nav-list", "aria-label": "功能导航" },
        nav("定时任务", "clock", "/chat?view=schedules"),
        nav("资料库", "book", "/chat?view=library"),
        nav("智能体", "bot", "/agents"),
        nav("模型库", "box", "/models"),
      ),
      h(
        "div",
        { className: "qa-sidebar-scroll" },
        h(
          "div",
          { className: "qa-section-heading" },
          h(
            "button",
            {
              onClick: () => toggle("projects"),
              "aria-label": "项目",
              "aria-expanded": !collapsed.projects,
            },
            h(
              "span",
              { className: collapsed.projects ? "" : "qa-expanded" },
              h(Icon, { name: "chevron", size: 12 }),
            ),
            "项目",
          ),
          h(
            "button",
            {
              className: "qa-icon-button",
              "aria-label": "新建项目",
              title: "新建项目",
              onClick: () => setModal(true),
            },
            h(Icon, { name: "plus" }),
          ),
        ),
        !collapsed.projects &&
          h(
            "div",
            null,
            ...[...groups.projects]
              .sort((a, b) =>
                projectActivity(b).localeCompare(projectActivity(a)),
              )
              .slice(0, more ? undefined : 3)
              .map((group) =>
                h(
                  "section",
                  { key: group.id, className: "qa-project" },
                  h(
                    "div",
                    { className: "qa-project-row" },
                    h(
                      "button",
                      {
                        onClick: () => toggle(group.id),
                        "aria-expanded": !collapsed[group.id],
                      },
                      h(Icon, { name: "folder" }),
                      h("span", null, group.name),
                      h(
                        "span",
                        { className: collapsed[group.id] ? "" : "qa-expanded" },
                        h(Icon, { name: "chevron", size: 12 }),
                      ),
                    ),
                    h(
                      "button",
                      {
                        className: "qa-icon-button",
                        "aria-label": `在${group.name}中新建任务`,
                        onClick: () => start(group),
                      },
                      h(Icon, { name: "plus", size: 14 }),
                    ),
                  ),
                  !collapsed[group.id] &&
                    h(
                      "div",
                      { className: "qa-project-tasks" },
                      ...recent
                        .filter(
                          (s) =>
                            qaProjectForSession(
                              groups.projects,
                              groups.bindings,
                              s,
                            )?.id === group.id && matches(s),
                        )
                        .slice(0, collapsed["more:" + group.id] ? undefined : 3)
                        .map(taskRow),
                      recent.filter(
                        (s) =>
                          qaProjectForSession(
                            groups.projects,
                            groups.bindings,
                            s,
                          )?.id === group.id,
                      ).length > 3 &&
                        h(
                          "button",
                          {
                            className: "qa-show-more",
                            onClick: () => toggle("more:" + group.id),
                          },
                          collapsed["more:" + group.id]
                            ? "收起任务"
                            : "显示更多任务",
                        ),
                      !sessions.some(
                        (s) =>
                          qaProjectForSession(
                            groups.projects,
                            groups.bindings,
                            s,
                          )?.id === group.id,
                      ) &&
                        h(
                          "button",
                          {
                            className: "qa-empty-task",
                            onClick: () => start(group),
                          },
                          "开始第一个测试任务",
                        ),
                    ),
                ),
              ),
            !groups.projects.length &&
              h(
                "button",
                { className: "qa-empty-task", onClick: () => setModal(true) },
                "创建项目，组织测试任务",
              ),
            groups.projects.length > 3 &&
              h(
                "button",
                { className: "qa-show-more", onClick: () => setMore(!more) },
                more ? "收起" : "显示更多",
              ),
          ),
        h(
          "div",
          { className: "qa-section-heading" },
          h(
            "button",
            {
              onClick: () => toggle("recents"),
              "aria-label": "任务",
              "aria-expanded": !collapsed.recents,
            },
            h(
              "span",
              { className: collapsed.recents ? "" : "qa-expanded" },
              h(Icon, { name: "chevron", size: 12 }),
            ),
            "任务",
          ),
          h(
            "button",
            {
              className: "qa-icon-button",
              disabled: refreshing,
              "aria-label": "刷新任务列表",
              onClick: async () => {
                setRefreshing(true);
                try {
                  await sessionState.reload();
                  notify("任务列表已刷新");
                } catch {
                  reportError("刷新失败，请稍后重试");
                } finally {
                  setRefreshing(false);
                }
              },
            },
            h(Icon, { name: "refresh", size: 14 }),
          ),
        ),
        !collapsed.recents &&
          h(
            "div",
            null,
            h("input", {
              className: "qa-search",
              "aria-label": "搜索任务",
              placeholder: "搜索任务…",
              value: search,
              onChange: (e) => setSearch(e.target.value),
            }),
            ...recent.slice(0, recentLimit).map(taskRow),
            recentLimit > 3 &&
              h(
                "button",
                { className: "qa-show-more", onClick: () => setRecentLimit(3) },
                "收起任务",
              ),
            !recent.length &&
              h(
                "p",
                { className: "qa-empty" },
                sessionState.loading
                  ? "正在加载任务…"
                  : search
                    ? "没有匹配的任务"
                    : "暂无任务",
              ),
            (recent.length > recentLimit ||
              project.agents.some((a) =>
                sessionState.hasMoreFor(a.agentId, "active"),
              )) &&
              h(
                "button",
                {
                  className: "qa-show-more",
                  onClick: async () => {
                    setRecentLimit(recentLimit + 20);
                    try {
                      await Promise.all(
                        project.agents
                          .filter((a) =>
                            sessionState.hasMoreFor(a.agentId, "active"),
                          )
                          .map((a) =>
                            sessionState.loadMoreFor(a.agentId, "active"),
                          ),
                      );
                    } catch {
                      reportError("加载更多任务失败");
                    }
                  },
                },
                "显示更多",
              ),
          ),
      ),
      h(
        "button",
        { className: "qa-more-tools", onClick: () => setLegacy(true) },
        h(Icon, { name: "more" }),
        "更多功能与历史项目",
      ),
      h(
        "div",
        { className: "qa-account" },
        h(AccountMenu, {
          menuClass: "bottom-full left-0 right-0 mb-1 origin-bottom",
          trigger: ({ open, toggle }) =>
            h(
              "button",
              {
                onClick: toggle,
                "aria-haspopup": "menu",
                "aria-expanded": open,
              },
              h(
                "span",
                { className: "qa-avatar" },
                (user?.displayName || user?.userId || "U")
                  .slice(0, 1)
                  .toUpperCase(),
              ),
              h("span", null, user?.displayName || user?.userId || "用户"),
              h("small", null, user?.isAdmin ? "管理员" : "成员"),
            ),
        }),
      ),
      h(ProjectModal, {
        open: modal,
        onClose: () => setModal(false),
        onCreated: (group) => {
          setModal(false);
          start(group);
        },
      }),
      h(
        Modal,
        {
          open: legacy,
          title: "更多功能与历史项目",
          onClose: () => setLegacy(false),
        },
        h(
          "div",
          { className: "qa-legacy-sidebar" },
          h(LegacySidebar, {
            onNavigate: () => {
              setLegacy(false);
              onNavigate?.();
            },
          }),
        ),
      ),
    );
  }
  function Hero({
    controlRef,
    scene,
    onSceneChange,
    groupId,
    workspace,
    onWorkspaceChange,
  }) {
    const groups = useGroups(),
      group = groups.projects.find((p) => p.id === groupId);
    const labels = [
      "新建测试任务",
      "生成测试用例",
      "执行回归测试",
      "输出测试报告",
      "性能与安全",
    ];
    return h(
      "div",
      { className: "qa-hero" },
      h("h1", null, "AITestHarness, 我帮你"),
      qaScenesEnabled && h(
        "div",
        { className: "qa-scenes", role: "group", "aria-label": "测试场景" },
        ...qaScenes.map((s, i) =>
          h(
            "button",
            {
              key: s.name,
              className: `qa-chip ${scene === i ? "is-active" : ""}`,
              "aria-pressed": scene === i,
              onClick: () => onSceneChange(i),
            },
            h(Icon, { name: s.icon, size: 14 }),
            s.name,
          ),
        ),
      ),
      h(
        "div",
        { className: "qa-quick-actions" },
        ...labels.map((label, i) =>
          h(
            "button",
            {
              key: label,
              className: "qa-quick-chip",
              onClick: () =>
                controlRef.current?.fillPrompt(qaScenesEnabled ? qaScenes[scene].prompts[i] : qaGeneralPrompts[i], []),
            },
            label,
          ),
        ),
      ),
      group &&
        h(
          "div",
          { className: "qa-project-context" },
          h(Icon, { name: "folder", size: 14 }),
          h("span", null, group.name),
          group.folders.length > 1 &&
            h(
              "select",
              {
                "aria-label": "项目工作文件夹",
                value: workspace,
                onChange: (e) => onWorkspaceChange(e.target.value),
              },
              ...group.folders.map((path) =>
                h("option", { value: path, key: path }, path),
              ),
            ),
        ),
    );
  }
  function SessionContext({ session, status, pending, error, items, onBack }) {
    const [human, setHuman] = R.useState({ session: null, actions: [] });
    const [busy, setBusy] = R.useState(false), [humanError, setHumanError] = R.useState("");
    const submitting = R.useRef(false);
    const base = session?.sessionId ? `/api/sessions/${encodeURIComponent(session.sessionId)}/human-actions` : null;
    R.useEffect(() => {
      let alive = true, timer;
      setHuman({ session: session?.sessionId, actions: [] });setHumanError("");setBusy(false);
      async function refresh() {
        try {
          const data = await deps.request(base);
          if (alive) setHuman({ session: session.sessionId, actions: data.actions ?? [] });
        } catch { /* Keep an existing waiting card across temporary network loss. */ }
        finally { if (alive) timer = setTimeout(refresh, 2500); }
      }
      if (base && session?.agentId === "test_agent") refresh();
      return () => { alive = false; clearTimeout(timer); };
    }, [base, session?.agentId]);
    const actions = human.session === session?.sessionId ? human.actions : [];
    async function answer(action, decision) {
      if (submitting.current) return;
      submitting.current = true;setBusy(true);setHumanError("");
      try {
        const result = await deps.request(base, { method: "POST", body: { run_id: action.run_id, action_id: action.action_id, decision } });
        if(decision !== "wait") setHuman(previous => ({ ...previous, actions: previous.actions.map(item => item.action_id === action.action_id ? { ...item, status: result.status, decision } : item) }));
      } catch { setHumanError("暂时无法续接原任务。请稍后刷新查看，未重新派发或重放操作。"); }
      finally { submitting.current = false;setBusy(false); }
    }
    const groups = useGroups(),
      group = qaProjectForSession(groups.projects, groups.bindings, session);
    const outcome = qaLastOutcome(items);
    const state = qaTaskStatus(session, {
      status,
      pending,
      error,
      stopReason: outcome,
      humanWaiting: actions.length > 0,
    });
    return h(R.Fragment, null, h(
      "div",
      { className: "qa-session-context" },
      h(
        "button",
        { className: "qa-back", onClick: onBack },
        h(Icon, { name: "back", size: 14 }),
        "返回",
      ),
      h(
        "span",
        { className: "qa-breadcrumb", title: group?.name || "任务" },
        group?.name || "任务",
        " /",
      ),
      h(
        "span",
        { className: `qa-status ${state.kind}`, role: "status" },
        h("span", { className: `qa-dot ${state.kind}` }),
        state.label,
      ),
    ), ...actions.map(action => {
      const available = ["waiting_human", "not_sent"].includes(action.status);
      return h("section", { className: "qa-human-card", key: action.action_id, "aria-label": "人工操作", role: "region" },
        h("strong", null, available ? "需要你完成操作" : action.status === "accepted" ? (action.decision === "cancel" ? "正在结束原任务" : "已确认，正在续接原任务") : "正在核对续接状态"),
        h("p", null, action.question),
        h("p", { className: "qa-human-note" }, "原任务和浏览器已保留，尚未完成测试。"),
        h("div", { className: "qa-human-buttons" },
          h("button", { type: "button", className: "qa-button qa-primary", disabled: busy || !available, onClick: () => answer(action, "continue") }, ["access", "captcha", "mfa"].includes(action.kind) ? "已完成登录，继续测试" : "已完成操作，继续"),
          h("button", { type: "button", className: "qa-button", disabled: busy || !available, onClick: () => answer(action, "wait") }, "继续等待"),
          h("button", { type: "button", className: "qa-button", disabled: busy || !available, onClick: () => answer(action, "cancel") }, "取消任务")),
        humanError && h("p", { role: "alert" }, humanError));
    }));
  }
  const SectionPage = createSectionsUI({ ...deps, Icon, h });
  return { Sidebar, Hero, SessionContext, SectionPage, BrandLogo };
}
function relativeTime(value) {
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60000) return "刚刚";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时`;
  return `${Math.floor(ms / 86400000)} 天`;
}

export function qaScheduleContent(item) {
  const match = /^【定时任务：([^\n]+)】\n\n/.exec(item.prompt || "");
  return {
    title: match?.[1] || item.name,
    prompt: match ? item.prompt.slice(match[0].length) : item.prompt || "",
  };
}
export function qaScheduleBody(form, original, now = Date.now()) {
  if (!form.title.trim() || /[\n\r】]/.test(form.title))
    throw Error("请输入有效的任务名称");
  if (!form.prompt.trim()) throw Error("请输入任务提示词");
  const start = new Date(form.startAt);
  if (!Number.isFinite(start.getTime())) throw Error("请选择开始日期和时间");
  if (!original && start.getTime() <= now)
    throw Error("开始时间必须晚于当前时间");
  const period = form.repeat === "custom" ? form.period.trim() : form.repeat;
  if (
    period &&
    (!/^\d+[mhd]$/.test(period) ||
      parseFloat(period) *
        { m: 60000, h: 3600000, d: 86400000 }[period.slice(-1)] <
        300000)
  )
    throw Error("重复间隔至少 5 分钟，例如 30m、12h、7d");
  const end = form.endAt ? new Date(form.endAt) : null;
  if (end && (!Number.isFinite(end.getTime()) || end <= start))
    throw Error("有效期结束时间必须晚于开始时间");
  return {
    enabled: form.enabled,
    prompt: `【定时任务：${form.title.trim()}】\n\n${form.prompt.trim()}`,
    startAt: start.toISOString(),
    ...(period ? { period } : {}),
    ...(end ? { endAt: end.toISOString() } : {}),
    ...(form.workspace ? { workspace: form.workspace } : {}),
    ...(form.model ? JSON.parse(form.model) : {}),
    ...(original?.sessionId ? { sessionId: original.sessionId } : {}),
  };
}
function createSectionsUI(deps) {
  const {
    React: R,
    h,
    Icon,
    useProject,
    useAuth,
    useSessions,
    useNavigate,
    request,
    Modal,
    FolderPicker,
    Markdown,
    notify,
  } = deps;
  const enc = encodeURIComponent;
  const localTime = (value) => {
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const dateText = (value) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  const sizeText = (n) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
  const button = (label, onClick, primary = false, props = {}) =>
    h(
      "button",
      {
        type: "button",
        className: `qa-button ${primary ? "qa-primary" : ""}`,
        onClick,
        ...props,
      },
      label,
    );
  function useLoad(url) {
    const [state, set] = R.useState({ loading: true, data: null, error: "" }),
      [version, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => {
      let alive = true;
      set({ loading: true, data: null, error: "" });
      if (!url) return;
      request(url)
        .then((data) => alive && set({ data, loading: false, error: "" }))
        .catch(
          (e) => alive && set({ data: null, loading: false, error: e.message }),
        );
      return () => {
        alive = false;
      };
    }, [url, version]);
    return { ...state, reload: bump };
  }
  const errorBox = (error) =>
    error && h("p", { role: "alert", className: "qa-page-error" }, error);
  function SectionPage({ view }) {
    const { currentProject } = useProject(),
      { user } = useAuth();
    R.useEffect(() => {
      document.title = `${view === "schedules" ? "定时任务" : "资料库"} · AITestHarness`;
    }, [view]);
    if (!currentProject)
      return h("div", { className: "qa-page-empty" }, "正在加载工作空间…");
    return h(view === "schedules" ? Schedules : Library, {
      key: `${currentProject.projectId}:${user?.userId}:${view}`,
      projectId: currentProject.projectId,
    });
  }
  const templates = [
    [
      "每日冒烟测试",
      "每天检查核心业务链路，记录通过情况和异常。",
      "对指定测试环境执行核心业务冒烟测试，核对登录、查询与主要业务操作，输出结果和失败证据。",
      "1d",
    ],
    [
      "接口自动化回归",
      "重复验证接口契约、关键参数与错误响应。",
      "根据工作文件夹中的接口用例执行回归，汇总通过率、异常响应及复现步骤。",
      "1d",
    ],
    [
      "Web 页面巡检",
      "检查页面可用性、导航及关键交互。",
      "巡检指定 Web 测试环境，验证页面导航与核心交互，保存异常截图并输出报告。",
      "1d",
    ],
    [
      "每周测试周报",
      "汇总测试进展、缺陷与下一步安排。",
      "汇总本周测试记录，列出执行情况、未解决缺陷、风险和下周测试建议。",
      "7d",
    ],
    [
      "缺陷复测提醒",
      "整理待复测缺陷及验证步骤。",
      "根据已有缺陷记录整理待复测清单，逐项核对修复结果与证据。",
      "1d",
    ],
    [
      "版本发布检查",
      "在指定时间核对发布前测试结果。",
      "检查当前版本的测试报告和未关闭缺陷，整理发布前检查清单及阻断项。",
      "",
    ],
  ];
  function Schedules({ projectId }) {
    const { agents, currentAgent } = useProject();
    const [agent, setAgent] = R.useState(
      agents.find((a) => a.agentId === "test_agent")?.agentId ||
        currentAgent?.agentId ||
        agents[0]?.agentId ||
        "test_agent",
    );
    const base = `/api/projects/${enc(projectId)}/agents/${enc(agent)}/schedules`;
    const list = useLoad(base),
      models = useLoad(`/api/projects/${enc(projectId)}/models`);
    const [edit, setEdit] = R.useState(null),
      [remove, setRemove] = R.useState(null),
      [busy, setBusy] = R.useState(false),
      [error, setError] = R.useState("");
    async function change(item, method) {
      setBusy(true);
      setError("");
      try {
        await request(`${base}/${enc(item.name)}`, {
          method,
          ...(method === "PUT"
            ? { body: { ...item, enabled: !item.enabled } }
            : {}),
        });
        setRemove(null);
        list.reload();
        notify(
          method === "DELETE"
            ? "定时任务已删除"
            : item.enabled
              ? "定时任务已暂停"
              : "定时任务已启用",
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    return h(
      "section",
      { className: "qa-section-page qa-schedules" },
      h(
        "header",
        { className: "qa-page-header" },
        h(
          "div",
          null,
          h("h1", null, "定时任务"),
          h("p", null, "按计划执行测试，持续关注质量变化"),
        ),
        h(
          "div",
          { className: "qa-header-actions" },
          h(
            "select",
            {
              "aria-label": "查看智能体的定时任务",
              value: agent,
              onChange: (e) => {
                setAgent(e.target.value);
                setError("");
              },
            },
            ...agents.map((a) =>
              h(
                "option",
                { value: a.agentId, key: a.agentId },
                a.name || a.agentId,
              ),
            ),
          ),
          button("刷新", list.reload),
          button("+ 新建", () => setEdit({}), true),
        ),
      ),
      errorBox(error || list.error),
      list.loading
        ? h("div", { className: "qa-page-empty" }, "正在加载定时任务…")
        : list.error
          ? button("重新加载", list.reload)
          : list.data?.schedules?.length
            ? h(
                "div",
                { className: "qa-schedule-list" },
                ...list.data.schedules.map((item) =>
                  h(
                    "article",
                    { className: "qa-schedule-card", key: item.name },
                    h(
                      "div",
                      { className: "qa-schedule-icon" },
                      h(Icon, { name: "clock", size: 24 }),
                    ),
                    h(
                      "div",
                      { className: "qa-schedule-info" },
                      h("h2", null, qaScheduleContent(item).title),
                      h("p", null, qaScheduleContent(item).prompt),
                      h(
                        "div",
                        { className: "qa-meta" },
                        h(
                          "span",
                          null,
                          {
                            active: "已启用",
                            disabled: "已暂停",
                            done: "已执行",
                            missed: "已错过",
                            expired: "已过期",
                            invalid: "配置异常",
                          }[item.status] || item.status,
                        ),
                        h(
                          "span",
                          null,
                          item.period ? `每 ${item.period}` : "仅一次",
                        ),
                        h(
                          "span",
                          null,
                          `下次执行：${dateText(item.nextFireAt)}`,
                        ),
                      ),
                      item.invalidReason && errorBox(item.invalidReason),
                    ),
                    h(
                      "div",
                      { className: "qa-row-actions" },
                      button("编辑", () => setEdit(item)),
                      button(
                        item.enabled ? "暂停" : "启用",
                        () => change(item, "PUT"),
                        false,
                        {
                          disabled:
                            busy ||
                            ["done", "expired", "missed", "invalid"].includes(
                              item.status,
                            ),
                        },
                      ),
                      button("删除", () => setRemove(item), false, {
                        disabled: busy,
                      }),
                    ),
                  ),
                ),
              )
            : h(
                "div",
                { className: "qa-page-empty" },
                h(Icon, { name: "clock", size: 58 }),
                h("p", null, "暂无定时任务"),
                h("span", null, "创建一个计划，让测试按时开始"),
              ),
      list.data?.invalidFiles?.length > 0 &&
        errorBox(
          `另有 ${list.data.invalidFiles.length} 个配置文件无法读取，请在智能体配置中检查。`,
        ),
      h(
        "div",
        { className: "qa-template-section" },
        h("h2", null, "试试这些常用测试任务"),
        h(
          "div",
          { className: "qa-template-grid" },
          ...templates.map(([title, description, prompt, period], i) =>
            h(
              "button",
              {
                className: "qa-template-card",
                "aria-label": title,
                key: title,
                onClick: () =>
                  setEdit({ template: true, title, prompt, period }),
              },
              h(Icon, {
                name: ["bolt", "plug", "globe", "book", "refresh", "box"][i],
                size: 22,
              }),
              h(
                "div",
                null,
                h("strong", null, title),
                h("p", null, description),
              ),
            ),
          ),
        ),
      ),
      h(
        "p",
        { className: "qa-page-note" },
        "定时任务在客户端服务运行时执行；时间按本机时区显示。",
      ),
      edit &&
        h(ScheduleEditor, {
          item: edit,
          base,
          projectId,
          models: models.data?.models || [],
          onClose: () => setEdit(null),
          onSaved: () => {
            setEdit(null);
            list.reload();
          },
        }),
      h(
        Modal,
        {
          open: !!remove,
          onClose: () => !busy && setRemove(null),
          title: "删除定时任务",
          widthClass: "qa-project-modal",
          footer: h(
            "div",
            { className: "qa-modal-actions" },
            button("取消", () => setRemove(null), false, { disabled: busy }),
            button(
              busy ? "正在删除…" : "删除",
              () => change(remove, "DELETE"),
              true,
              { disabled: busy },
            ),
          ),
        },
        h(
          "p",
          null,
          `删除「${remove ? qaScheduleContent(remove).title : ""}」后将不再自动执行，已有任务记录保留。`,
        ),
        errorBox(error),
      ),
    );
  }
  function ScheduleEditor({ item, base, projectId, models, onClose, onSaved }) {
    const original = item.name ? item : null,
      parts = original ? qaScheduleContent(item) : item;
    const [form, set] = R.useState({
      title: parts.title || "",
      prompt: parts.prompt || "",
      enabled: item.enabled ?? true,
      startAt: localTime(item.startAt || Date.now() + 3600000),
      repeat: ["", "1d", "7d"].includes(item.period || "")
        ? item.period || ""
        : "custom",
      period: item.period || "30m",
      endAt: item.endAt ? localTime(item.endAt) : "",
      workspace: item.workspace || "",
      model: item.modelId
        ? JSON.stringify({ provider: item.provider, modelId: item.modelId })
        : "",
    });
    const [busy, setBusy] = R.useState(false),
      [error, setError] = R.useState("");
    const update = (key, value) => set((f) => ({ ...f, [key]: value }));
    async function save() {
      setError("");
      try {
        const body = qaScheduleBody(form, original);
        setBusy(true);
        await request(original ? `${base}/${enc(item.name)}` : base, {
          method: original ? "PUT" : "POST",
          body: original
            ? body
            : { ...body, name: `qa-${crypto.randomUUID()}` },
        });
        notify("定时任务已保存");
        onSaved();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    const field = (label, control) =>
      h(
        "label",
        { className: "qa-field" },
        h("span", null, label),
        R.cloneElement(control, {
          "aria-label": control.props["aria-label"] || label,
        }),
      );
    return h(
      Modal,
      {
        open: true,
        title: original ? "编辑定时任务" : "新建定时任务",
        widthClass: "qa-schedule-modal",
        onClose: () => !busy && onClose(),
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          button("取消", onClose, false, { disabled: busy }),
          button(busy ? "正在保存…" : "确定", save, true, {
            disabled: busy || !form.title.trim() || !form.prompt.trim(),
          }),
        ),
      },
      h(
        "div",
        { className: "qa-schedule-form" },
        field(
          "任务名称",
          h("input", {
            "aria-label": "任务名称",
            placeholder: "输入任务名称",
            value: form.title,
            maxLength: 80,
            onChange: (e) => update("title", e.target.value),
            autoFocus: true,
          }),
        ),
        h(
          "div",
          { className: "qa-prompt-box" },
          h("textarea", {
            "aria-label": "任务提示词",
            placeholder: "描述测试目标、环境、执行范围及预期产物…",
            value: form.prompt,
            onChange: (e) => update("prompt", e.target.value),
          }),
          h(
            "div",
            { className: "qa-prompt-footer" },
            h(FolderPicker, {
              projectId,
              workspace: form.workspace,
              onChange: (v) => update("workspace", v),
              trigger: (open, toggle) =>
                button(form.workspace || "选择工作文件夹", toggle, false, {
                  "aria-expanded": open,
                  title: form.workspace,
                }),
            }),
            h(
              "select",
              {
                "aria-label": "执行模型",
                value: form.model,
                onChange: (e) => update("model", e.target.value),
              },
              h("option", { value: "" }, "使用智能体默认模型"),
              ...models.map((m) =>
                h(
                  "option",
                  {
                    key: m.provider + ":" + m.modelId,
                    value: JSON.stringify({
                      provider: m.provider,
                      modelId: m.modelId,
                    }),
                  },
                  m.displayName || m.modelId,
                ),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "qa-form-columns" },
          field(
            "重复",
            h(
              "select",
              {
                value: form.repeat,
                onChange: (e) => update("repeat", e.target.value),
              },
              ...[
                ["", "仅一次"],
                ["1d", "每天"],
                ["7d", "每周"],
                ["custom", "自定义间隔"],
              ].map(([v, t]) => h("option", { value: v, key: v }, t)),
            ),
          ),
          field(
            "开始时间",
            h("input", {
              type: "datetime-local",
              value: form.startAt,
              onChange: (e) => update("startAt", e.target.value),
            }),
          ),
          field(
            "有效期",
            h("input", {
              type: "datetime-local",
              value: form.endAt,
              onChange: (e) => update("endAt", e.target.value),
              "aria-label": "有效期结束时间",
            }),
          ),
        ),
        form.repeat === "custom" &&
          field(
            "重复间隔",
            h("input", {
              value: form.period,
              placeholder: "30m / 12h / 7d",
              onChange: (e) => update("period", e.target.value),
            }),
          ),
        h(
          "div",
          { className: "qa-form-bottom" },
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: form.enabled,
              onChange: (e) => update("enabled", e.target.checked),
            }),
            " 保存后启用",
          ),
          h(
            "span",
            null,
            "有效期留空为长期有效 · " +
              Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        ),
        errorBox(error),
      ),
    );
  }
  function Library({ projectId }) {
    const { agents } = useProject(),
      { sessions } = useSessions(),
      navigate = useNavigate();
    const agent =
      agents.find((a) => a.agentId === "test_agent")?.agentId ||
      agents[0]?.agentId ||
      "test_agent";
    const base = `/api/projects/${enc(projectId)}/agents/${enc(agent)}/memory/library`;
    const list = useLoad(base),
      [view, setView] = R.useState("mine"),
      [folder, setFolder] = R.useState(null),
      [selected, setSelected] = R.useState(null),
      [edit, setEdit] = R.useState(null),
      [menu, setMenu] = R.useState(false),
      [search, setSearch] = R.useState(""),
      [error, setError] = R.useState(""),
      [busy, setBusy] = R.useState(false),
      [remove, setRemove] = R.useState(null);
    const fileInput = R.useRef(null),
      selectionSeq = R.useRef(0);
    const rows = list.data?.entries || [];
    async function open(row) {
      const seq = ++selectionSeq.current;
      setError("");
      if (row.kind === "folder") {
        setFolder(row.id);
        setSearch("");
        setSelected(null);
        setView("mine");
        return;
      }
      setSelected(null);
      setBusy(true);
      try {
        const doc = await request(`${base}/${row.id}`);
        if (seq === selectionSeq.current) {
          setSelected(doc);
          setFolder(doc.parentId || null);
        }
      } catch (e) {
        if (seq === selectionSeq.current) setError(e.message);
      } finally {
        if (seq === selectionSeq.current) setBusy(false);
      }
    }
    async function upload(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      setBusy(true);
      setError("");
      try {
        for (const file of files) {
          if (file.size > 10 * 1024 * 1024)
            throw Error(`${file.name} 超过 10 MB，未导入`);
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(Error("文件读取失败"));
            reader.readAsDataURL(file);
          });
          await request(base, {
            method: "POST",
            body: {
              name: file.name,
              kind: "file",
              parentId: folder,
              encoding: "base64",
              content,
            },
          });
        }
        notify(`已导入 ${files.length} 个文件`);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
        list.reload();
      }
    }
    async function deleteSelected() {
      setBusy(true);
      setError("");
      try {
        await request(`${base}/${remove.id}`, {
          method: "DELETE",
          body: { revision: remove.revision },
        });
        if (selected?.id === remove.id) setSelected(null);
        setRemove(null);
        list.reload();
        notify("资料已删除");
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    function nav(mode) {
      selectionSeq.current++;
      setBusy(false);
      setView(mode);
      setSelected(null);
      setSearch("");
      setFolder(null);
      setError("");
    }
    const visible = rows.filter((row) =>
      search
        ? row.name.toLowerCase().includes(search.toLowerCase())
        : view === "recent"
          ? row.kind !== "folder"
          : row.parentId === folder,
    );
    const ancestors = [];
    let parent = rows.find((r) => r.id === folder);
    while (parent && ancestors.length < 40) {
      ancestors.unshift(parent);
      parent = rows.find((r) => r.id === parent.parentId);
    }
    return h(
      "section",
      { className: "qa-library" },
      h(
        "aside",
        { className: "qa-library-sidebar" },
        h(
          "div",
          { className: "qa-library-title" },
          h("h1", null, "资料库"),
          button("刷新", list.reload),
        ),
        h(
          "div",
          { className: "qa-library-nav" },
          ...[
            ["search", "搜索", "book"],
            ["recent", "最近", "clock"],
            ["artifacts", "本地产物", "folder"],
          ].map(([v, label, icon]) =>
            h(
              "button",
              {
                key: v,
                className: view === v ? "is-active" : "",
                onClick: () => nav(v),
              },
              h(Icon, { name: icon }),
              label,
            ),
          ),
        ),
        h(
          "div",
          { className: "qa-library-group" },
          h("button", { onClick: () => nav("mine") }, "我的资料"),
          h(
            "button",
            {
              "aria-label": "新建资料",
              "aria-expanded": menu,
              onClick: () => setMenu(!menu),
            },
            h(Icon, { name: "plus" }),
          ),
        ),
        menu &&
          h(
            "div",
            { className: "qa-library-create", role: "menu" },
            ...[
              ["文档 (.md)", "file", "未命名文档.md"],
              ["表格 (.csv)", "file", "未命名表格.csv"],
              ["文件夹", "folder", "新建文件夹"],
              ["链接", "link", "新链接"],
            ].map(([label, kind, name]) =>
              h(
                "button",
                {
                  role: "menuitem",
                  key: label,
                  onClick: () => {
                    setEdit({
                      kind,
                      name,
                      parentId: folder,
                      content:
                        kind === "file" && name.endsWith(".csv")
                          ? "字段1,字段2\n"
                          : "",
                    });
                    setMenu(false);
                  },
                },
                `新建${label}`,
              ),
            ),
            h(
              "button",
              {
                role: "menuitem",
                onClick: () => {
                  setMenu(false);
                  fileInput.current?.click();
                },
              },
              "上传和导入",
            ),
          ),
        h("input", {
          type: "file",
          multiple: true,
          hidden: true,
          ref: fileInput,
          onChange: upload,
          "aria-label": "导入资料文件",
        }),
        h(
          "div",
          { className: "qa-library-tree" },
          ...rows
            .filter((r) => !r.parentId)
            .map((row) =>
              h(
                "button",
                {
                  key: row.id,
                  className:
                    selected?.id === row.id || folder === row.id
                      ? "is-active"
                      : "",
                  onClick: () => open(row),
                  title: row.name,
                },
                h(
                  "span",
                  { className: `qa-file-icon ${row.kind}` },
                  row.kind === "folder"
                    ? "▰"
                    : row.kind === "link"
                      ? "↗"
                      : row.name.split(".").pop().slice(0, 3).toUpperCase(),
                ),
                h("span", null, row.name),
              ),
            ),
        ),
        h(
          "div",
          { className: "qa-library-storage" },
          "存储于本机 · 仅当前账号",
          h(
            "div",
            null,
            `已用 ${sizeText(list.data?.usedBytes || 0)} / 100 MB`,
          ),
        ),
      ),
      h(
        "div",
        { className: "qa-library-main" },
        h(
          "header",
          { className: "qa-library-toolbar" },
          h(
            "div",
            { className: "qa-library-crumb" },
            h("button", { onClick: () => nav("mine") }, "我的资料"),
            ...ancestors.map((r) =>
              h(
                "button",
                {
                  key: r.id,
                  onClick: () => {
                    setFolder(r.id);
                    setSelected(null);
                  },
                },
                " / " + r.name,
              ),
            ),
            selected && h("span", null, " / " + selected.name),
          ),
          selected &&
            h(
              "div",
              { className: "qa-row-actions" },
              selected.kind === "file" &&
                button("下载", () => downloadDoc(selected)),
              (selected.kind === "link" || isText(selected.name)) &&
                button("编辑", () =>
                  setEdit({
                    ...selected,
                    content: textDoc(selected),
                    encoding: "utf8",
                  }),
                ),
              button("删除", () => setRemove(selected)),
            ),
        ),
        errorBox(error || list.error),
        list.error && button("重新加载", list.reload),
        list.loading || busy
          ? h("div", { className: "qa-page-empty" }, "正在加载资料…")
          : selected
            ? h(DocumentView, { doc: selected })
            : view === "artifacts"
              ? h(ArtifactBrowser, { sessions, navigate })
              : h(
                  "div",
                  { className: "qa-library-content" },
                  h(
                    "div",
                    { className: "qa-library-heading" },
                    h(
                      "h2",
                      null,
                      view === "recent"
                        ? "最近更新"
                        : view === "search"
                          ? "搜索资料"
                          : ancestors.at(-1)?.name || "我的资料",
                    ),
                    button("+ 新建", () => setMenu(!menu), true),
                  ),
                  h("input", {
                    className: "qa-library-search",
                    value: search,
                    onChange: (e) => setSearch(e.target.value),
                    placeholder: "搜索资料名称…",
                    "aria-label": "搜索资料",
                    autoFocus: view === "search",
                  }),
                  !visible.length
                    ? h(
                        "div",
                        { className: "qa-page-empty" },
                        h(Icon, { name: "book", size: 48 }),
                        h("p", null, search ? "没有匹配的资料" : "还没有资料"),
                        h("span", null, "新建文档或导入需求、用例与测试报告"),
                      )
                    : h(
                        "div",
                        { className: "qa-library-files" },
                        ...visible.map((row) =>
                          h(
                            "div",
                            { className: "qa-library-file", key: row.id },
                            h(
                              "button",
                              { onClick: () => open(row) },
                              h(
                                "span",
                                { className: `qa-file-icon ${row.kind}` },
                                row.kind === "folder"
                                  ? "▰"
                                  : row.kind === "link"
                                    ? "↗"
                                    : row.name
                                        .split(".")
                                        .pop()
                                        .slice(0, 3)
                                        .toUpperCase(),
                              ),
                              h(
                                "span",
                                null,
                                h("strong", null, row.name),
                                h(
                                  "small",
                                  null,
                                  `${dateText(row.updatedAt)} · ${row.kind === "folder" ? "文件夹" : sizeText(row.size)}`,
                                ),
                              ),
                            ),
                            button("删除", () => setRemove(row), false, {
                              "aria-label": `删除 ${row.name}`,
                            }),
                          ),
                        ),
                      ),
                ),
      ),
      edit &&
        h(LibraryEditor, {
          doc: edit,
          base,
          onClose: () => setEdit(null),
          onSaved: (doc) => {
            setEdit(null);
            list.reload();
            if (doc.kind !== "folder") setSelected(doc);
          },
        }),
      h(
        Modal,
        {
          open: !!remove,
          title: "删除资料",
          widthClass: "qa-project-modal",
          onClose: () => !busy && setRemove(null),
          footer: h(
            "div",
            { className: "qa-modal-actions" },
            button("取消", () => setRemove(null), false, { disabled: busy }),
            button(busy ? "正在删除…" : "删除", deleteSelected, true, {
              disabled: busy,
            }),
          ),
        },
        h("p", null, `确认删除「${remove?.name || ""}」？此操作不可撤销。`),
        errorBox(error),
      ),
    );
  }
  const isText = (name) =>
    /\.(md|txt|csv|json|html?|xml|ya?ml|log)$/i.test(name);
  function textDoc(doc) {
    if (doc.encoding !== "base64") return doc.content;
    return new TextDecoder().decode(
      Uint8Array.from(atob(doc.content), (c) => c.charCodeAt(0)),
    );
  }
  function docBlob(doc) {
    return new Blob(
      [
        doc.encoding === "base64"
          ? Uint8Array.from(atob(doc.content), (c) => c.charCodeAt(0))
          : doc.content,
      ],
      {
        type: /\.pdf$/i.test(doc.name)
          ? "application/pdf"
          : "application/octet-stream",
      },
    );
  }
  function downloadDoc(doc) {
    const url = URL.createObjectURL(docBlob(doc)),
      a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function DocumentView({ doc }) {
    const [source, setSource] = R.useState(false);
    R.useEffect(() => setSource(false), [doc.id, doc.revision]);
    if (doc.kind === "link")
      return h(
        "article",
        { className: "qa-document" },
        h("h1", null, doc.name),
        h(
          "a",
          { href: doc.content, target: "_blank", rel: "noopener noreferrer" },
          doc.content,
        ),
      );
    if (!isText(doc.name))
      return h(
        "div",
        { className: "qa-page-empty" },
        h(Icon, { name: "book", size: 48 }),
        h("h2", null, doc.name),
        h("p", null, `${sizeText(doc.size)} · 下载后使用本机应用打开`),
        button("下载文件", () => downloadDoc(doc), true),
      );
    const text = textDoc(doc);
    return h(
      "article",
      { className: "qa-document" },
      h(
        "div",
        { className: "qa-document-heading" },
        h("h1", null, doc.name),
        button(source ? "阅读" : "源码", () => setSource(!source)),
      ),
      source
        ? h("pre", null, text)
        : /\.md$/i.test(doc.name)
          ? h("div", { className: "md-body" }, h(Markdown, { text }))
          : /\.html?$/i.test(doc.name)
            ? h("iframe", {
                title: doc.name,
                sandbox: "",
                referrerPolicy: "no-referrer",
                srcDoc:
                  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" +
                  text,
              })
            : h("pre", null, text),
    );
  }
  function LibraryEditor({ doc, base, onClose, onSaved }) {
    const [name, setName] = R.useState(doc.name),
      [content, setContent] = R.useState(doc.content || ""),
      [error, setError] = R.useState(""),
      [busy, setBusy] = R.useState(false);
    const dirty = name !== doc.name || content !== (doc.content || "");
    R.useEffect(() => {
      if (!dirty) return;
      const warn = (e) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    function close() {
      if (!busy && (!dirty || window.confirm("放弃尚未保存的修改？")))
        onClose();
    }
    async function save() {
      setBusy(true);
      setError("");
      try {
        const saved = await request(doc.id ? `${base}/${doc.id}` : base, {
          method: doc.id ? "PUT" : "POST",
          body: { ...doc, name, content, encoding: "utf8" },
        });
        notify("资料已保存");
        onSaved(saved);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    return h(
      Modal,
      {
        open: true,
        title: doc.id
          ? "编辑资料"
          : doc.kind === "folder"
            ? "新建文件夹"
            : doc.kind === "link"
              ? "添加链接"
              : "新建资料",
        widthClass:
          doc.kind === "file" ? "qa-document-modal" : "qa-project-modal",
        onClose: close,
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          button("取消", close, false, { disabled: busy }),
          button(busy ? "正在保存…" : "保存", save, true, {
            disabled: busy || !name.trim(),
          }),
        ),
      },
      h(
        "div",
        { className: "qa-document-form" },
        h(
          "label",
          null,
          "名称",
          h("input", {
            "aria-label": "资料名称",
            value: name,
            maxLength: 160,
            onChange: (e) => setName(e.target.value),
            autoFocus: true,
          }),
        ),
        doc.kind !== "folder" &&
          h(
            "label",
            null,
            doc.kind === "link" ? "链接地址" : "内容",
            h(doc.kind === "link" ? "input" : "textarea", {
              "aria-label": "资料内容",
              value: content,
              onChange: (e) => setContent(e.target.value),
              placeholder:
                doc.kind === "link" ? "https://example.com" : "输入资料内容…",
            }),
          ),
        errorBox(error),
      ),
    );
  }
  function ArtifactBrowser({ sessions, navigate }) {
    const [session, setSession] = R.useState(null),
      [path, setPath] = R.useState("");
    const files = useLoad(
      session
        ? `/api/sessions/${enc(session.sessionId)}/files?path=${enc(path)}`
        : null,
    );
    const active = sessions.filter(
      (s) => !s.origin?.length && s.workspace && !s.archived,
    );
    return h(
      "div",
      { className: "qa-library-content" },
      h(
        "div",
        { className: "qa-library-heading" },
        h("h2", null, "本地产物"),
        session &&
          button("打开所属任务", () =>
            navigate(`/chat/${enc(session.sessionId)}`),
          ),
      ),
      h(
        "p",
        { className: "qa-page-note" },
        "浏览已有测试任务的工作文件夹，资料保留在原位置。",
      ),
      h(
        "select",
        {
          "aria-label": "选择产物所属任务",
          value: session?.sessionId || "",
          onChange: (e) => {
            setSession(
              active.find((s) => s.sessionId === e.target.value) || null,
            );
            setPath("");
          },
        },
        h("option", { value: "" }, "选择测试任务"),
        ...active.map((s) =>
          h(
            "option",
            { value: s.sessionId, key: s.sessionId },
            s.title || s.sessionId,
          ),
        ),
      ),
      session &&
        h(
          "div",
          null,
          h(
            "div",
            { className: "qa-artifact-path" },
            button(
              "上一级",
              () => setPath(path.split("/").slice(0, -1).join("/")),
              false,
              { disabled: !path },
            ),
            h("span", null, path || "/"),
          ),
          errorBox(files.error),
          files.loading
            ? h("p", null, "正在加载文件…")
            : h(
                "div",
                { className: "qa-library-files" },
                ...(files.data?.entries || []).map((file) =>
                  h(
                    "div",
                    { className: "qa-library-file", key: file.name },
                    file.kind === "dir"
                      ? button("▰ " + file.name, () =>
                          setPath([path, file.name].filter(Boolean).join("/")),
                        )
                      : h(
                          "a",
                          {
                            href: `/api/sessions/${enc(session.sessionId)}/files/content?download=1&path=${enc([path, file.name].filter(Boolean).join("/"))}`,
                            download: file.name,
                          },
                          file.name,
                        ),
                    h("small", null, sizeText(file.sizeBytes || 0)),
                  ),
                ),
                files.data?.entries?.length === 0 &&
                  h("p", null, "此文件夹为空"),
              ),
        ),
    );
  }
  return SectionPage;
}
