/**
 * 新建项目弹窗：Project id 使用既有语义编号规则与 AI 生成能力，名称必填 1–80 字，
 * 简介选填 ≤500 字带计数、来源固定手动创建；提交中禁用重复提交；
 * 创建成功后自动进入新项目；创建成功但进入失败时提示「项目已创建，暂时无法进入」
 * 并提供重试进入（不重复创建）；关闭有修改的表单时先确认放弃。
 * 不提供 Agent / Skill / 插件包的选择或上传入口（§2.3 / §5）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmModal } from "@prismshadow/penguin-ui";
import { ApiError } from "../../../api/client";
import { S } from "../../../lib/strings";
import { PROJECT_ID_MAX_LENGTH, PROJECT_SUFFIX_PATTERN, SEMANTIC_ID_PATTERN } from "../../../lib/semantic-id";
import { useAuth } from "../../../state/auth";
import { useProject } from "../../../state/project";
import { SemanticIdField } from "../../semantic-id/semantic-id-field";
import type { CreateProjectInput, ManagedProject } from "./types";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

export function CreateProjectDialog({
  onClose,
  onCreate,
  onEnterAfterCreate,
  retryEnter,
}: {
  onClose: () => void;
  /** 提交创建（适配层实现；失败抛错，不产生半创建）。 */
  onCreate: (input: CreateProjectInput) => Promise<ManagedProject>;
  /** 创建成功后自动进入；返回 false 表示进入失败（项目已创建）。 */
  onEnterAfterCreate: (projectId: string) => Promise<boolean>;
  /** 「重试进入」：仅重试进入已创建的项目，不再次创建。 */
  retryEnter: () => Promise<boolean>;
}) {
  const { user } = useAuth();
  const { currentProject, projects } = useProject();
  const prefix = user && !user.isAdmin ? `${user.userId}-` : "";
  const [name, setName] = useState("");
  const [idInput, setIdInput] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** idle：填写中 | creating：创建中 | enterFailed：项目已创建但进入失败。 */
  const [phase, setPhase] = useState<"idle" | "creating" | "enterFailed">("idle");
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmDiscardRef = useRef(false);

  const suffix = idInput.trim();
  const projectId = prefix + suffix;
  const idValid = prefix
    ? PROJECT_SUFFIX_PATTERN.test(suffix) && projectId.length <= PROJECT_ID_MAX_LENGTH
    : SEMANTIC_ID_PATTERN.test(projectId);
  const dirty = name.trim() !== "" || suffix !== "" || description.trim() !== "";
  const busy = phase === "creating";

  /** 关闭：有修改先确认放弃；无修改直接关（§5）。 */
  const requestClose = () => {
    if (busy) return;
    if (dirty && !confirmDiscardRef.current) {
      confirmDiscardRef.current = true;
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("请填写项目名称");
      nameRef.current?.focus();
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setNameError(`项目名称不能超过 ${NAME_MAX} 字`);
      return;
    }
    if (!idValid) {
      setIdError(suffix ? (prefix ? S.project.idPrefixHint : S.project.idHint) : "请填写 Project id");
      return;
    }
    setNameError(null);
    setIdError(null);
    setSubmitError(null);
    setPhase("creating");
    try {
      const created = await onCreate({ projectId, name: trimmed, description: description.trim() });
      const entered = await onEnterAfterCreate(created.projectId);
      if (!entered) {
        setPhase("enterFailed");
        return;
      }
      onClose();
    } catch (e) {
      setPhase("idle");
      const message = e instanceof Error ? e.message : "项目创建失败，请稍后重试";
      if (e instanceof ApiError && ["project_exists", "invalid_project_id", "project_id_prefix_required"].includes(e.code)) setIdError(message);
      else setSubmitError(message);
    }
  };

  const retry = async () => {
    setPhase("creating");
    const ok = await retryEnter();
    if (ok) {
      onClose();
    } else {
      setPhase("enterFailed");
    }
  };

  return createPortal(
    <div
      className="qpm-modal-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="qpm-modal" role="dialog" aria-modal="true" aria-labelledby="qpm-create-title">
        <header className="qpm-modal-head">
          <h2 id="qpm-create-title">新建项目</h2>
          <button type="button" className="qpm-icon-btn" aria-label="关闭新建项目弹窗" onClick={requestClose} disabled={busy}>
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="qpm-modal-body">
          <label className="qpm-form-row">
            <span>项目名称 <em aria-hidden="true">*</em></span>
            <input
              ref={nameRef}
              value={name}
              maxLength={NAME_MAX}
              placeholder="例如：会员中心改版回归"
              aria-label="项目名称"
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? "qpm-create-name-error" : undefined}
              disabled={busy || phase === "enterFailed"}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
                if (submitError) setSubmitError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void submit();
              }}
            />
            <span className="qpm-count">{name.length}/{NAME_MAX}</span>
            {nameError && <p className="qpm-field-error" id="qpm-create-name-error" role="alert">{nameError}</p>}
          </label>
          <div className="qpm-form-row">
            <SemanticIdField
              projectId={currentProject?.projectId ?? projects[0]?.projectId ?? null}
              kind="project"
              label={S.project.id}
              hint={prefix ? S.project.idPrefixHint : S.project.idHint}
              value={idInput}
              source={name}
              taken={projects.map(project => project.projectId)}
              error={idError ?? (suffix && !idValid ? (prefix ? S.project.idPrefixHint : S.project.idHint) : undefined)}
              lockedPrefix={prefix || undefined}
              disabled={busy || phase === "enterFailed"}
              onChange={(value) => { setIdInput(value); setIdError(null); setSubmitError(null); }}
            />
          </div>
          <label className="qpm-form-row">
            <span>项目简介</span>
            <textarea
              value={description}
              maxLength={DESCRIPTION_MAX}
              rows={3}
              placeholder="一句话说明项目背景（可选）"
              aria-label="项目简介"
              disabled={busy || phase === "enterFailed"}
              onChange={(e) => { setDescription(e.target.value); if (submitError) setSubmitError(null); }}
            />
            <span className="qpm-count">{description.length}/{DESCRIPTION_MAX}</span>
          </label>
          <div className="qpm-form-row">
            <span>来源</span>
            <span className="qpm-tag qpm-tag-manual">手动创建</span>
          </div>
          {submitError && (
            <div className="qpm-error" role="alert">
              <p>{submitError}</p>
            </div>
          )}
          {phase === "enterFailed" && (
            <div className="qpm-error" role="alert">
              <p>项目已创建，暂时无法进入。</p>
              <div className="qpm-edit-actions">
                <button type="button" className="qpm-btn-ghost" onClick={onClose}>留在项目管理</button>
                <button type="button" className="qpm-btn-main" onClick={() => void retry()}>重试进入</button>
              </div>
            </div>
          )}
        </div>
        <footer className="qpm-modal-foot">
          <button type="button" className="qpm-btn-ghost" onClick={requestClose} disabled={busy}>取消</button>
          <button type="button" className="qpm-btn-main" onClick={() => void submit()} disabled={busy || phase === "enterFailed" || !idValid}>
            {busy ? "正在创建…" : "创建并进入"}
          </button>
        </footer>
      </div>

      {confirmDiscard && (
        <ConfirmModal
          open
          title="放弃新建项目？"
          confirmLabel="放弃"
          cancelLabel="继续编辑"
          onClose={() => {
            setConfirmDiscard(false);
            confirmDiscardRef.current = false;
          }}
          onConfirm={() => {
            setConfirmDiscard(false);
            confirmDiscardRef.current = true;
            onClose();
          }}
        >
          <p className="text-sm">关闭后已填写的内容不会保留。</p>
        </ConfirmModal>
      )}
    </div>,
    document.body,
  );
}
