/**
 * 项目管理页（外壳状态 A 的主区，路由 /qa/projects）。
 *
 * 依据《项目管理模块交互需求 2026-11-10》§4（列表/筛选/排序/分页/点击规则）、
 * §5（新建手动项目）、§6（详情侧栏/编辑）、§7（置顶/归档/恢复）、§10（页面状态全集）
 * 与《应用外壳两态布局设计规格》§3.2 实现。数据全部经 ./api.ts 适配层（mock 实现）。
 *
 * 点击语义严格分离（§4.4）：点名称 → 详情侧栏；点「进入 →」→ 校验后复用现有项目
 * 上下文（setCurrentProjectId）切换到 /qa/project；置顶与 ⋯ 菜单不触发跳转。
 * 返回本页时在会话内保留筛选/页码/滚动位置（内存级）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import type { ManagedProject, ProjectListQuery, ProjectListResult } from "./types";
import {
  createProject,
  enterProject,
  listProjects,
  restoreProject,
  setProjectPinned,
  updateProject,
} from "./api";
import { STATUS_LABEL, sourceText, timeText } from "./format";
import { CreateProjectDialog } from "./create-project-dialog";
import { ProjectDetailPanel } from "./project-detail-panel";
import { ProjectSettingsDialog } from "../../../components/layout/project-dialogs";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { useProject } from "../../../state/project";
import "./project-management.css";

/** 会话内保留的列表状态（B→A 返回时恢复；内存级，不做跨会话持久化）。 */
let savedState: ProjectListQuery | null = null;
let savedScrollTop: number | null = null;

/** 清空会话内保留的列表状态（全新会话/测试隔离用；正式路由切换不需要调用）。 */
export function resetSessionListState(): void {
  savedState = null;
  savedScrollTop = null;
}

const PAGE_SIZES: ProjectListQuery["pageSize"][] = [20, 50, 100];

function readUrlState(search: string): Partial<ProjectListQuery> & { detail?: string } | null {
  const params = new URLSearchParams(search);
  if (![...params.keys()].length) return null;
  const status = params.get("status");
  const source = params.get("source");
  const sort = params.get("sort");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  return {
    keyword: params.get("q") ?? "",
    sourceType: source === "manual" || source === "sync" ? source : "all",
    status: status === "all" || status === "archived" || status === "disabled" ? status : status === null ? "active" : "all",
    sort: sort === "name" || sort === "created" ? sort : "activity",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: pageSize === 50 || pageSize === 100 ? (pageSize as 50 | 100) : 20,
    detail: params.get("detail") ?? undefined,
  };
}

/** 运行中任务列：未知「—」，明确 0 显示 0，>0 绿点+文字（不只靠颜色）。 */
function RunningTasks({ project }: { project: ManagedProject }) {
  if (project.runningTaskCount === null || project.runningTaskCount === undefined) {
    return <span className="qpm-muted">—</span>;
  }
  if (project.runningTaskCount === 0) return <span className="qpm-muted">0</span>;
  return (
    <span className="qpm-running">
      <span aria-hidden="true">●</span> {project.runningTaskCount} 个运行中
    </span>
  );
}

export function ProjectManagementPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setCurrentProjectId, reloadProjects } = useProject();

  const initial = useMemo(() => readUrlState(location.search), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [keyword, setKeyword] = useState(initial?.keyword ?? savedState?.keyword ?? "");
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
  const [sourceType, setSourceType] = useState<ProjectListQuery["sourceType"]>(initial?.sourceType ?? savedState?.sourceType ?? "all");
  const [status, setStatus] = useState<ProjectListQuery["status"]>(initial?.status ?? savedState?.status ?? "active");
  const [sort, setSort] = useState<ProjectListQuery["sort"]>(initial?.sort ?? savedState?.sort ?? "activity");
  const [page, setPage] = useState(initial?.page ?? savedState?.page ?? 1);
  const [pageSize, setPageSize] = useState<ProjectListQuery["pageSize"]>(initial?.pageSize ?? savedState?.pageSize ?? 20);

  const [result, setResult] = useState<ProjectListResult | null>(null);
  const [loading, setLoading] = useState(true);
  /** 列表加载失败；有旧数据时保留并标明尚未刷新（§10 加载失败）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 请求序号：旧请求不得覆盖较新请求结果（§4.3）。 */
  const askRef = useRef(0);
  /** 单项操作中：对应按钮 loading，防重复，不锁整个列表。 */
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  /** ⋯ 行内菜单。 */
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  /** 详情侧栏（detail=<projectId> 可经 URL 恢复）。 */
  const [detailId, setDetailId] = useState<string | null>(initial?.detail ?? null);
  const [editOnOpen, setEditOnOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<ManagedProject | null>(null);
  /** 新建弹窗。 */
  const [creatingOpen, setCreatingOpen] = useState(false);
  /** 进入失败重试的上下文（创建成功但进入失败 → 重试进入，不重复创建）。 */
  const pendingEnterRef = useRef<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  /* 搜索 300ms 防抖；旧输入的定时器被新输入取代。 */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* 搜索/筛选变化回到第一页（§4.3）。 */
  useEffect(() => {
    setPage(1);
  }, [debouncedKeyword, sourceType, status, pageSize]);

  /* 加载列表：任何查询条件或页码变化都重新请求完整结果集分页。 */
  useEffect(() => {
    const ask = ++askRef.current;
    setLoading(true);
    listProjects({ keyword: debouncedKeyword, sourceType, status, sort, page, pageSize })
      .then((res) => {
        if (ask !== askRef.current) return;
        setResult(res);
        setLoadError(null);
        setPage(res.page);
      })
      .catch((e: unknown) => {
        if (ask !== askRef.current) return;
        setLoadError(e instanceof Error ? e.message : "项目列表加载失败");
      })
      .finally(() => {
        if (ask === askRef.current) setLoading(false);
      });
  }, [debouncedKeyword, sourceType, status, sort, page, pageSize]);

  /* 查询条件同步进 URL（§3.3：支持查询条件进入 URL，刷新后可恢复；侧栏 detail 同理）。 */
  useEffect(() => {
    const params = new URLSearchParams();
    if (keyword.trim()) params.set("q", keyword.trim());
    if (sourceType !== "all") params.set("source", sourceType);
    if (status !== "active") params.set("status", status);
    if (sort !== "activity") params.set("sort", sort);
    if (page !== 1) params.set("page", String(page));
    if (pageSize !== 20) params.set("pageSize", String(pageSize));
    if (detailId) params.set("detail", detailId);
    const qs = params.toString();
    window.history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  }, [keyword, sourceType, status, sort, page, pageSize, detailId, location.pathname]);

  /* 卸载时保存筛选/页码/滚动位置（B→A 返回恢复）。 */
  useEffect(() => {
    savedState = { keyword, sourceType, status, sort, page, pageSize };
    return () => {
      savedScrollTop = scrollRef.current?.scrollTop ?? null;
    };
  }, [keyword, sourceType, status, sort, page, pageSize]);
  useEffect(() => {
    if (savedScrollTop && scrollRef.current) scrollRef.current.scrollTop = savedScrollTop;
    savedScrollTop = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    const ask = ++askRef.current;
    setLoading(true);
    listProjects({ keyword: debouncedKeyword, sourceType, status, sort, page, pageSize })
      .then((res) => {
        if (ask !== askRef.current) return;
        setResult(res);
        setLoadError(null);
        setPage(res.page);
      })
      .catch((e: unknown) => {
        if (ask !== askRef.current) return;
        setLoadError(e instanceof Error ? e.message : "项目列表加载失败");
      })
      .finally(() => {
        if (ask === askRef.current) setLoading(false);
      });
  }, [debouncedKeyword, sourceType, status, sort, page, pageSize]);

  /** 置顶切换：失败回退并提示（§7.1）；置顶不触发行跳转。 */
  const togglePin = useCallback(async (project: ManagedProject) => {
    setPinningId(project.projectId);
    try {
      await setProjectPinned(project.projectId, !project.isPinned);
      toastSuccess(project.isPinned ? "已取消置顶" : "已置顶");
      refresh();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "置顶失败，请重试");
    } finally {
      setPinningId(null);
    }
  }, [refresh]);

  /** 进入项目：校验（适配层）→ 复用现有项目上下文切换；失败停留原位置。 */
  const enter = useCallback(async (projectId: string) => {
    setEnteringId(projectId);
    try {
      await enterProject(projectId);
      setCurrentProjectId(projectId);
      pendingEnterRef.current = null;
      navigate("/qa/project");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "进入项目失败，请重试");
    } finally {
      setEnteringId(null);
    }
  }, [navigate, setCurrentProjectId]);

  /** 创建成功后自动进入；进入失败时提供重试进入（不重复创建，§5）。 */
  const enterAfterCreate = useCallback(async (projectId: string) => {
    try {
      await enterProject(projectId);
      setCurrentProjectId(projectId);
      pendingEnterRef.current = null;
      navigate("/qa/project");
      return true;
    } catch (e) {
      toastError(e instanceof Error ? e.message : "进入项目失败，请重试");
      pendingEnterRef.current = projectId;
      return false;
    }
  }, [navigate, setCurrentProjectId]);

  const restore = useCallback(async (project: ManagedProject) => {
    try {
      await restoreProject(project.projectId);
      await reloadProjects();
      toastSuccess("项目已恢复");
      refresh();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "恢复失败，请重试");
    }
  }, [refresh, reloadProjects]);

  /** 编辑保存（详情侧栏表单）：成功刷新侧栏与列表，失败保留表单（§6.2）。 */
  const saveEdits = useCallback(async (project: ManagedProject, name: string, description: string) => {
    const next = await updateProject(project.projectId, {
      name,
      description,
      expectedRevision: project.revision,
    });
    await reloadProjects();
    refresh();
    return next;
  }, [refresh, reloadProjects]);

  const hasFilter = keyword.trim() !== "" || sourceType !== "all" || status !== "active";
  const clearFilters = () => {
    setKeyword("");
    setSourceType("all");
    setStatus("active");
    setSort("activity");
  };

  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = result?.projects ?? [];
  const noProjectsAtAll = !loading && !loadError && result !== null && total === 0 && !hasFilter;
  const noMatches = !loading && !loadError && result !== null && total === 0 && hasFilter;
  const detailProject = rows.find((p) => p.projectId === detailId) ?? null;
  const openDetail = (projectId: string, edit = false) => {
    setEditOnOpen(edit);
    setDetailId(projectId);
  };

  return (
    <main className="qpm-page" aria-label="项目管理">
      <div className="qpm-scroll" ref={scrollRef}>
        <header className="qpm-head">
          <div>
            <h1>项目管理</h1>
            <p>选择或新建一个项目后，将进入项目工作台（新建任务、项目视图、定时任务、项目资料等）。</p>
          </div>
          <div className="qpm-head-actions">
            <button type="button" className="qpm-icon-btn" aria-label="刷新项目列表" onClick={refresh} disabled={loading && !result}>
              <span aria-hidden="true">⟳</span>
            </button>
            {result?.canCreate !== false && (
              <button type="button" className="qpm-btn-main" onClick={() => setCreatingOpen(true)}>
                <span aria-hidden="true">＋</span> 新建项目
              </button>
            )}
          </div>
        </header>

        <div className="qpm-toolbar">
          <div className="qpm-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索项目名称 / 内部编号 / 外部编号"
              aria-label="搜索项目名称或编号"
            />
          </div>
          <select aria-label="筛选来源" value={sourceType} onChange={(e) => setSourceType(e.target.value as ProjectListQuery["sourceType"])}>
            <option value="all">全部来源</option>
            <option value="manual">手动创建</option>
            <option value="sync">平台同步</option>
          </select>
          <select aria-label="筛选状态" value={status} onChange={(e) => setStatus(e.target.value as ProjectListQuery["status"])}>
            <option value="active">进行中</option>
            <option value="all">全部状态</option>
            <option value="archived">已归档</option>
            <option value="disabled">已停用</option>
          </select>
          <select aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value as ProjectListQuery["sort"])}>
            <option value="activity">按最近活动</option>
            <option value="name">按名称</option>
            <option value="created">按创建时间</option>
          </select>
          {hasFilter && (
            <button type="button" className="qpm-clear" onClick={clearFilters}>
              <span aria-hidden="true">✕</span> 清空筛选
            </button>
          )}
          <span className="qpm-count" role="status">{loading ? "加载中…" : `共 ${total} 个项目`}</span>
        </div>

        {loadError && (
          <div className="qpm-error" role="alert">
            <p>{loadError}{result !== null ? "（以下为上次加载的数据，尚未刷新）" : ""}</p>
            <button type="button" className="qpm-btn-ghost" onClick={refresh}>重试</button>
          </div>
        )}

        {loading && result === null && (
          <div className="qpm-table" aria-busy="true" aria-label="项目列表加载中">
            <table>
              <thead>
                <tr>
                  <th className="qpm-col-pin" /><th>项目</th><th>来源</th><th>状态</th>
                  <th className="qpm-col-aux">最近活动</th>
                  <th className="qpm-col-aux">运行中任务</th><th className="qpm-col-acts">操作</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }, (_, c) => (
                      <td key={c} className={c === 4 || c === 5 ? "qpm-col-aux" : undefined}>
                        <span className="qpm-skeleton" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {noProjectsAtAll && (
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">暂无项目</p>
            <p className="qpm-empty-sub">平台同步的项目也会展示在这里。</p>
            {result?.canCreate !== false && (
              <button type="button" className="qpm-btn-main" onClick={() => setCreatingOpen(true)}>
                <span aria-hidden="true">＋</span> 新建项目
              </button>
            )}
          </div>
        )}

        {noMatches && (
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">没有符合条件的项目</p>
            <button type="button" className="qpm-btn-ghost" onClick={clearFilters}>清空筛选</button>
          </div>
        )}

        {!loading && (total > 0 || (result !== null && loadError !== null)) && (
          <div className="qpm-table">
            <table>
              <thead>
                <tr>
                  <th className="qpm-col-pin"><span className="sr-only">置顶</span></th>
                  <th>项目</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th className="qpm-col-aux">最近活动</th>
                  <th className="qpm-col-aux">运行中任务</th>
                  <th className="qpm-col-acts">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((project) => (
                  <tr key={project.projectId}>
                    <td className="qpm-col-pin">
                      <button
                        type="button"
                        className={`qpm-pin${project.isPinned ? " is-on" : ""}`}
                        aria-label={project.isPinned ? `取消置顶 ${project.name}` : `置顶 ${project.name}`}
                        aria-pressed={project.isPinned}
                        disabled={pinningId === project.projectId}
                        onClick={() => void togglePin(project)}
                      >
                        <span aria-hidden="true">{project.isPinned ? "★" : "☆"}</span>
                      </button>
                    </td>
                    <td>
                      <div className="qpm-name-cell">
                        <div className="qpm-name-text">
                          <button type="button" className="qpm-name" aria-label={`项目：${project.name}`} onClick={() => openDetail(project.projectId)}>
                            {project.name}
                          </button>
                          <span className="qpm-code">{project.projectId}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`qpm-tag ${project.sourceType === "sync" ? "qpm-tag-sync" : "qpm-tag-manual"}`}>{sourceText(project)}</span>
                    </td>
                    <td>
                      <span className={`qpm-tag qpm-status-${project.status}`}>{STATUS_LABEL[project.status]}</span>
                    </td>
                    <td className="qpm-col-aux"><time dateTime={project.lastActivityAt ?? undefined}>{timeText(project.lastActivityAt)}</time></td>
                    <td className="qpm-col-aux"><RunningTasks project={project} /></td>
                    <td className="qpm-col-acts">
                      <div className="qpm-row-acts">
                        {project.capabilities.canEnter ? (
                          <button
                            type="button"
                            className="qpm-enter"
                            disabled={enteringId === project.projectId}
                            onClick={() => void enter(project.projectId)}
                          >
                            {enteringId === project.projectId ? "进入中…" : "进入 →"}
                          </button>
                        ) : (
                          <span className="qpm-muted" aria-label={`不可进入：${project.capabilities.cannotEnterReason ?? "当前状态不允许进入"}`}>不可进入</span>
                        )}
                        <RowMenu
                          project={project}
                          open={rowMenuId === project.projectId}
                          onOpen={() => setRowMenuId(project.projectId)}
                          onClose={() => setRowMenuId(null)}
                          onEnter={() => void enter(project.projectId)}
                          entering={enteringId === project.projectId}
                          onDetail={() => openDetail(project.projectId)}
                          onEdit={() => openDetail(project.projectId, true)}
                          onSettings={() => setSettingsProject(project)}
                          onRestore={() => void restore(project)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="qpm-tfoot">
              <span>共 <b>{total}</b> 个项目</span>
              <div className="qpm-pager">
                <label>
                  每页{" "}
                  <select aria-label="每页条数" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value) as ProjectListQuery["pageSize"])}>
                    {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}
                  </select>
                </label>
                <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
                <span aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`}>{currentPage} / {pageCount}</span>
                <button type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {detailId && (
        <ProjectDetailPanel
          projectId={detailId}
          fallback={detailProject}
          editOnOpen={editOnOpen}
          onClose={() => setDetailId(null)}
          onSaveEdits={saveEdits}
        />
      )}

      {settingsProject && (
        <ProjectSettingsDialog
          open
          projectId={settingsProject.projectId}
          allowBasicEdits={settingsProject.capabilities.canMaintain}
          onClose={() => { setSettingsProject(null); void reloadProjects().then(refresh); }}
        />
      )}

      {creatingOpen && (
        <CreateProjectDialog
          onClose={() => setCreatingOpen(false)}
          onCreate={async input => { const created = await createProject(input); await reloadProjects(); refresh(); return created; }}
          onEnterAfterCreate={enterAfterCreate}
          retryEnter={async () => {
            const id = pendingEnterRef.current;
            if (!id) return true;
            return enterAfterCreate(id);
          }}
        />
      )}

    </main>
  );
}

/** 行内 ⋯ 菜单：点击外部/Esc 关闭；仅执行对应操作，不触发详情或项目跳转（§4.4）。 */
function RowMenu({
  project,
  open,
  onOpen,
  onClose,
  onEnter,
  entering,
  onDetail,
  onEdit,
  onSettings,
  onRestore,
}: {
  project: ManagedProject;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onEnter: () => void;
  entering: boolean;
  onDetail: () => void;
  onEdit: () => void;
  onSettings: () => void;
  onRestore: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${anchor.bottom + height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4)}px`;
    menu.style.visibility = "visible";
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);
  const items: Array<{ label: string; action: () => void; disabled?: boolean }> = [
    { label: "查看详情", action: onDetail },
    ...(project.capabilities.canEnter ? [{ label: entering ? "进入中…" : "进入项目", action: onEnter, disabled: entering }] : []),
    ...(project.capabilities.canMaintain ? [{ label: "编辑信息", action: onEdit }] : []),
    ...(project.status === "active" ? [{ label: "项目设置", action: onSettings }] : []),
    ...(project.capabilities.canRestore ? [{ label: "恢复项目", action: onRestore }] : []),
  ];
  return (
    <div className="qpm-row-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="qpm-more"
        aria-label={`更多操作：${project.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && createPortal(
        <div className="qpm-menu" ref={menuRef} role="menu" aria-label={`${project.name} 的操作`}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
