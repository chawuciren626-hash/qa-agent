/**
 * 新建项目弹窗：名称必填 1–80 字，简介选填 ≤500 字带计数；Project id 不再收集——
 * 由后台自动生成（名称 ASCII 片段 + 随机尾巴，非管理员自动带账号命名空间）。
 * 提交中禁用重复提交；创建成功后自动进入新项目；创建成功但进入失败时提示
 * 「项目已创建，暂时无法进入」并提供重试进入（不重复创建）；关闭有修改的表单时先确认放弃。
 * 不提供 Agent / Skill / 插件包的选择或上传入口（§2.3 / §5）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmModal } from "@prismshadow/penguin-ui";
import { S } from "../../../lib/strings";
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** 项目环境（选填）：填了地址就创建后立刻建档，留空则先建项目、之后在环境页补。 */
  const [envUrl, setEnvUrl] = useState("");
  const [envName, setEnvName] = useState("test");
  const [envError, setEnvError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** idle：填写中 | creating：创建中 | enterFailed：项目已创建但进入失败。 */
  const [phase, setPhase] = useState<"idle" | "creating" | "enterFailed">("idle");
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmDiscardRef = useRef(false);

  const dirty = name.trim() !== "" || description.trim() !== "" || envUrl.trim() !== "";
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
    // 环境地址选填；填了就先在本地做形状校验，别等创建完才在服务端报错——那样会留下
    // 「项目建好了但环境没建」的中间态。协议与内嵌凭据由服务端兜底再判一次。
    const url = envUrl.trim();
    if (url !== "" && !/^https?:\/\/[^\s]+$/i.test(url)) {
      setEnvError("地址需以 http:// 或 https:// 开头");
      return;
    }
    const envLabel = envName.trim();
    if (url !== "" && envLabel !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(envLabel)) {
      setEnvError("环境名需以小写字母开头，只含小写字母、数字、下划线或连字符");
      return;
    }
    setNameError(null);
    setEnvError(null);
    setSubmitError(null);
    setPhase("creating");
    try {
      // Project id 由后台自动生成；创建返回里带回生成的编号。
      const created = await onCreate({
        name: trimmed,
        description: description.trim(),
        ...(url === "" ? {} : { environment: { env: envLabel || "test", baseUrl: url } }),
      });
      const entered = await onEnterAfterCreate(created.projectId);
      if (!entered) {
        setPhase("enterFailed");
        return;
      }
      onClose();
    } catch (e) {
      setPhase("idle");
      setSubmitError(e instanceof Error ? e.message : "项目创建失败，请稍后重试");
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

          <div className="qpm-form-sep" role="separator" />
          <div className="qpm-form-subhead">
            <span>项目环境</span>
            <span className="qpm-tag qpm-tag-manual">选填</span>
          </div>
          <label className="qpm-form-row">
            <span>环境地址</span>
            <input
              value={envUrl}
              placeholder="http://10.20.31.14:8080"
              aria-label="环境地址"
              aria-invalid={envError !== null}
              aria-describedby={envError ? "qpm-create-env-error" : undefined}
              disabled={busy || phase === "enterFailed"}
              onChange={(e) => { setEnvUrl(e.target.value); if (envError) setEnvError(null); if (submitError) setSubmitError(null); }}
            />
            <p className="qpm-field-hint">
              填了就在创建后立刻建档（约 3–10 秒）：只发 GET，抓页面与接口，不改动被测系统。留空则先建项目，之后在项目环境里补。
            </p>
            {envError && <p className="qpm-field-error" id="qpm-create-env-error" role="alert">{envError}</p>}
          </label>
          <label className="qpm-form-row">
            <span>环境名</span>
            <input
              value={envName}
              placeholder="test"
              aria-label="环境名"
              disabled={busy || phase === "enterFailed" || envUrl.trim() === ""}
              onChange={(e) => { setEnvName(e.target.value); if (envError) setEnvError(null); }}
            />
            <p className="qpm-field-hint">默认 <b>test</b>，地图落在 maps/test/</p>
          </label>
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
          <button type="button" className="qpm-btn-main" onClick={() => void submit()} disabled={busy || phase === "enterFailed"}>
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
