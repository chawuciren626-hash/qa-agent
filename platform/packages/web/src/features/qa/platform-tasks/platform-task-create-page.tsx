/**
 * 新建本地任务（整页表单，替代原 EditModal 的 create 弹窗）。
 *
 * 为什么是整页而不是弹窗：需求描述是 AI 分析的主输入，值得一整页的书写空间；
 * 字段按"AI 会消费什么"组织——名称/环境/账号是上下文，描述与测试重点是主输入。
 * 测试重点在前端拼装为描述的结构化小节（【测试重点】），不引入新的服务端字段。
 * 附件上传（B1-3b）将复用项目知识上传设施接入本页，当前未包含。
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { projectDisplayName, useProject } from "../../../state/project";
import { ENV_END_LABELS, ENV_END_TYPES } from "../project-management/types";
import { listEnvironments } from "../project-management/api";
import { analyzeTask, createLocalTask, uploadTaskAttachment } from "./api";
import "./platform-tasks.css";

/** 与服务端上限对齐：单件 60KB、单任务 10 件（api/qa-platform-tasks 附件端点同口径）。 */
const ATTACHMENT_MAX_BYTES = 60 * 1024;
const ATTACHMENT_MAX_COUNT = 10;
const TEXT_ACCEPT = ".md,.txt,.json,.csv,.tsv,.html,.htm,.xml,.yaml,.yml,.log,.ini,.conf,.diff,.patch,.text";

type PendingAttachment = { filename: string; mime: string; contentText: string; sizeBytes: number };

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function isTextFile(file: File): boolean {
  return file.type.startsWith("text/") || /\.(md|txt|json|csv|tsv|html?|xml|ya?ml|log|ini|conf)$/i.test(file.name);
}

export function PlatformTaskCreatePage() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;

  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [focusNote, setFocusNote] = useState("");
  const [envBaseUrl, setEnvBaseUrl] = useState("");
  const [account, setAccount] = useState("");
  const [changeSource, setChangeSource] = useState("");
  const [ends, setEnds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= ATTACHMENT_MAX_COUNT) {
        toastError(`附件最多 ${ATTACHMENT_MAX_COUNT} 件，${file.name} 未加入`);
        break;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        toastError(`「${file.name}」超过 60KB 上限，未加入`);
        continue;
      }
      if (!isTextFile(file)) {
        toastError(`「${file.name}」不是文本类文件，未加入（图片/压缩包暂不支持）`);
        continue;
      }
      const contentText = await file.text();
      if (!contentText.trim()) {
        toastError(`「${file.name}」内容为空，未加入`);
        continue;
      }
      next.push({ filename: file.name, mime: file.type || "text/plain", contentText, sizeBytes: file.size });
    }
    setAttachments(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 新建时预填项目默认环境的地址（选填，可改可清空）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void listEnvironments(projectId)
      .then((r) => {
        if (cancelled) return;
        const def =
          r.environments.find((e) => e.isDefault) ??
          (r.defaultEnv ? r.environments.find((e) => e.env === r.defaultEnv) : undefined);
        if (def?.baseUrl) setEnvBaseUrl((prev) => prev || def.baseUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <main className="qpm-page">
        <div className="qpm-scroll">
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">还没有选择项目</p>
            <p className="qpm-empty-sub">任务按项目隔离，先在顶部项目切换器中选择项目，或去项目管理新建。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/projects")}>去项目管理</button>
          </div>
        </div>
      </main>
    );
  }

  const composedDescription = focusNote.trim()
    ? `${description.trim()}\n\n【测试重点】\n${focusNote.trim()}`
    : description.trim();

  const submit = async () => {
    if (!title.trim()) {
      toastError("任务名称必填");
      return;
    }
    if (!description.trim()) {
      toastError("需求描述必填：它是 AI 分析的主输入");
      return;
    }
    setBusy(true);
    try {
      const created = await createLocalTask(projectId, {
        title: title.trim(),
        description: composedDescription,
        envBaseUrl: envBaseUrl.trim(),
        account: account.trim(),
        changeSource: changeSource.trim(),
        ends,
      });
      // 附件先落库再分析：分析上下文由服务端从附件表装配（taskInfo），失败逐件提示不阻断。
      let attachFailures = 0;
      for (const item of attachments) {
        try {
          await uploadTaskAttachment(projectId, created.task.id, {
            filename: item.filename,
            mime: item.mime,
            dataBase64: utf8Base64(item.contentText),
          });
        } catch {
          attachFailures += 1;
        }
      }
      // 分析是同步模型通道：失败/降级不阻断——任务已落库（可开始），结论可稍后重试补。
      let analysisNote = "";
      try {
        const analysis = await analyzeTask(projectId, created.task.id);
        if (analysis.degraded) {
          analysisNote = `，但 AI 分析未走模型（${analysis.degraded.reason}），已回填演示结论；可稍后点「AI 分析」重试`;
        }
      } catch {
        analysisNote = "，但 AI 分析失败；可稍后在列表点「AI 分析」重试";
      }
      const attachNote = attachFailures ? `；${attachFailures} 个附件上传失败，可在任务详情中重传` : "";
      if (analysisNote || attachFailures) {
        toastError(`任务「${created.task.title}」已创建${attachNote}${analysisNote}`);
      } else {
        toastSuccess(`任务「${created.task.title}」已创建，AI 分析完成；可直接开始测试`);
      }
      navigate("/qa/project/platform-tasks");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "创建任务失败，请重试");
      setBusy(false);
    }
  };

  return (
    <main className="qpm-page qpt-page" aria-label="新建测试任务">
      <div className="qpm-scroll">
        <header className="qpm-head">
          <div>
            <h1>新建测试任务</h1>
            <p>
              {currentProject ? projectDisplayName(currentProject) : "—"} · 保存后立即进入「可开始」，并由总控 AI 基于需求描述自动产出结构化测试建议
            </p>
          </div>
          <div className="qpm-head-actions">
            <button type="button" className="qpm-btn-ghost" onClick={() => navigate("/qa/project/platform-tasks")} disabled={busy}>
              返回任务列表
            </button>
          </div>
        </header>
        <div className="qpt-create-form">
          <label className="qpt-field">
            <span>任务名称 *</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：导入模板边界值回归"
              disabled={busy}
            />
          </label>
          <label className="qpt-field">
            <span>
              测试环境 URL <small>选填；默认取项目环境，开始测试时自动绑定</small>
            </span>
            <input
              type="text"
              value={envBaseUrl}
              onChange={(e) => setEnvBaseUrl(e.target.value)}
              placeholder="例如 http://gateway.example.com"
              disabled={busy}
            />
          </label>
          <label className="qpt-field">
            <span>
              登录账号 <small>选填；作为 AI 分析上下文，密码请在会话内输入，不要写在这里</small>
            </span>
            <input
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="例如 qa_tester"
              disabled={busy}
            />
          </label>
          <label className="qpt-field">
            <span>
              变更关联 <small>选填；实现分支或 MR 标识，作为变更分析的证据指针</small>
            </span>
            <input
              type="text"
              value={changeSource}
              onChange={(e) => setChangeSource(e.target.value)}
              placeholder="例如 feature/import-template 或 MR !482"
              disabled={busy}
            />
          </label>
          <div className="qpt-field">
            <span>
              涉及端 <small>选填；本次变更涉及哪些端（多选），AI 分析与测试点将按端组织</small>
            </span>
            <div className="qpt-end-chips">
              {ENV_END_TYPES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`qpt-end-chip${ends.includes(option) ? " is-on" : ""}`}
                  aria-pressed={ends.includes(option)}
                  onClick={() => setEnds(ends.includes(option) ? ends.filter((e) => e !== option) : [...ends, option])}
                  disabled={busy}
                >
                  {ENV_END_LABELS[option]}
                </button>
              ))}
            </div>
          </div>
          <div className="qpt-field">
            <span>
              需求描述 / 测试背景 * <small>AI 分析主输入——写清要测什么、背景与预期，篇幅不限</small>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={14}
              placeholder={"描述要测什么、业务背景、预期结果。\n示例：管理后台新增了批量导入模板功能，需要验证：\n1. 正常模板导入的成功路径；\n2. 字段缺失/格式错误的失败提示；\n3. 超大文件的边界行为。"}
              disabled={busy}
            />
          </div>
          <label className="qpt-field">
            <span>
              测试重点 <small>选填；会作为「测试重点」小节并入需求描述，供 AI 分析优先关注</small>
            </span>
            <textarea
              value={focusNote}
              onChange={(e) => setFocusNote(e.target.value)}
              rows={4}
              placeholder="例如：优先验证导入失败的回滚是否完整；权限边界本次不测。"
              disabled={busy}
            />
          </label>
          <div className="qpt-field">
            <span>
              附件 <small>选填；文本类文件（md/txt/json/csv/html 等）作为 AI 分析补充输入，单件 ≤60KB、最多 10 件</small>
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={TEXT_ACCEPT}
              disabled={busy || attachments.length >= ATTACHMENT_MAX_COUNT}
              onChange={(e) => void addFiles(e.target.files)}
            />
            {attachments.length > 0 && (
              <ul className="qpt-att-list">
                {attachments.map((item, index) => (
                  <li key={`${item.filename}-${index}`} className="qpt-att-item">
                    <span className="qpt-att-name">{item.filename}</span>
                    <small>{Math.ceil(item.sizeBytes / 1024)}KB</small>
                    <button
                      type="button"
                      aria-label={`移除附件 ${item.filename}`}
                      onClick={() => setAttachments(attachments.filter((_, i) => i !== index))}
                      disabled={busy}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="qpt-create-actions">
            <button type="button" className="qpm-btn-ghost" onClick={() => navigate("/qa/project/platform-tasks")} disabled={busy}>
              取消
            </button>
            <button type="button" className="qpm-btn-main" disabled={busy} onClick={() => void submit()}>
              {busy ? "AI 分析中…" : "保存并发起 AI 分析"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
