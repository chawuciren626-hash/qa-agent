/**
 * 项目详情侧栏（从列表右侧打开，宽 560px；窄屏全屏；背景保留列表，Esc/关闭后焦点回到触发处）。
 *
 * 信息顺序为项目名称/来源/状态、基本信息与同步项目信息（外部字段只读）。
 * 同步元数据缺失显示「—」；外部链接仅允许 HTTP(S) 且经适配层返回的已校验地址。
 * 编辑表单（§6.2）：手动项目有维护权限可改名称/简介；保存成功刷新侧栏与列表，
 * 失败保留表单并提示；并发冲突提示「项目已被更新，请刷新后重试」。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ManagedProject } from "./types";
import { getProject } from "./api";
import { STATUS_LABEL, sourceText, timeText, fullTimeText } from "./format";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";

function isSafeHttpUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** 详情字段行：缺失值统一「—」，不虚构同步成功状态（§10 同步元数据缺失）。 */
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="qpm-field">
      <span className="qpm-field-label">{label}</span>
      <span className={mono ? "qpm-field-value qpm-mono" : "qpm-field-value"}>{value}</span>
    </div>
  );
}

export function ProjectDetailPanel({
  projectId,
  fallback,
  editOnOpen = false,
  onClose,
  onSaveEdits,
}: {
  projectId: string;
  /** 列表行数据（侧栏先以它呈现，同时向适配层请求最新详情）。 */
  fallback: ManagedProject | null;
  editOnOpen?: boolean;
  onClose: () => void;
  onSaveEdits: (project: ManagedProject, name: string, description: string) => Promise<ManagedProject>;
}) {
  const [project, setProject] = useState<ManagedProject | null>(fallback);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  /* 打开时请求最新详情；失败显示可关闭的提示，不显示上一个项目的旧数据之外的内容。 */
  useEffect(() => {
    let alive = true;
    setProject(fallback);
    setLoadError(null);
    getProject(projectId)
      .then((p) => {
        if (alive) {
          setProject(p);
          if (editOnOpen && p.capabilities.canMaintain) {
            setEditName(p.name);
            setEditDescription(p.description ?? "");
            setEditing(true);
          }
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setLoadError(e instanceof Error ? e.message : "项目详情加载失败");
          setProject(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, editOnOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Esc 关闭；打开时焦点进关闭按钮，关闭后焦点回到触发元素（§12.1）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus?.();
    };
  }, [onClose]);

  const save = async () => {
    if (!project) return;
    setSaving(true);
    setEditError(null);
    try {
      const next = await onSaveEdits(project, editName, editDescription);
      setProject(next);
      setEditing(false);
      toastSuccess("已保存");
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const externalUrl = isSafeHttpUrl(project?.externalUrl ?? null);

  return createPortal(
    <div className="qpm-panel-root" role="presentation">
      <aside className="qpm-panel" role="dialog" aria-label={project ? `项目详情：${project.name}` : "项目详情"}>
        <header className="qpm-panel-head">
          {project ? (
            <div className="qpm-panel-title">
              <div>
                <h2>{project.name}</h2>
                <div className="qpm-panel-tags">
                  <span className={`qpm-tag ${project.sourceType === "sync" ? "qpm-tag-sync" : "qpm-tag-manual"}`}>{sourceText(project)}</span>
                  <span className={`qpm-tag qpm-status-${project.status}`}>{STATUS_LABEL[project.status]}</span>
                </div>
              </div>
            </div>
          ) : (
            <h2>项目详情</h2>
          )}
          <button type="button" className="qpm-icon-btn" ref={closeRef} aria-label="关闭详情" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="qpm-panel-body">
          {loadError && (
            <div className="qpm-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="qpm-btn-ghost" onClick={onClose}>关闭</button>
            </div>
          )}
          {project && !loadError && (
            <>
              <section aria-label="基本信息">
                <h3>基本信息</h3>
                {editing ? (
                  <div className="qpm-edit-form">
                    <label>
                      项目名称 <em aria-hidden="true">*</em>
                      <input
                        value={editName}
                        maxLength={80}
                        aria-label="项目名称"
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </label>
                    <label>
                      项目简介
                      <textarea
                        value={editDescription}
                        maxLength={500}
                        rows={3}
                        aria-label="项目简介"
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                      <span className="qpm-count">{editDescription.length}/500</span>
                    </label>
                    {editError && <p className="qpm-field-error" role="alert">{editError}</p>}
                    <div className="qpm-edit-actions">
                      <button type="button" className="qpm-btn-ghost" onClick={() => setEditing(false)} disabled={saving}>取消</button>
                      <button type="button" className="qpm-btn-main" onClick={() => void save()} disabled={saving}>
                        {saving ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Field label="项目简介" value={project.description ?? "—"} />
                    <Field label="项目编号" value={project.projectId} mono />
                    <Field label="创建者" value={project.createdByDisplayName} />
                    <Field label="创建时间" value={fullTimeText(project.createdAt)} />
                    <Field label="最近活动" value={timeText(project.lastActivityAt)} />
                  </>
                )}
              </section>

              {project.sourceType === "sync" && (
                <section aria-label="同步项目信息">
                  <h3>同步项目信息</h3>
                  <p className="qpm-panel-note">以下字段由来源平台维护，本地只读。</p>
                  <Field label="来源平台" value={project.sourceSystemName ?? "—"} />
                  <Field label="外部项目编号" value={project.externalProjectId ?? "—"} mono />
                  <Field label="最近同步时间" value={fullTimeText(project.lastSyncedAt)} />
                  {externalUrl && (
                    <div className="qpm-field">
                      <span className="qpm-field-label">外部链接</span>
                      <a className="qpm-field-value qpm-link" href={externalUrl.href} target="_blank" rel="noreferrer noopener">
                        {externalUrl.href}
                      </a>
                    </div>
                  )}
                </section>
              )}

            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
