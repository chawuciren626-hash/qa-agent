/**
 * Project knowledge (T3): documents and their revisions, knowledge candidates, and confirmed
 * rules, read straight from the Q2 routes.
 *
 * The project is personal in the current product: the owner edits and confirms, every other
 * account — including a QA admin who does not own it — reads only. The page therefore hides
 * write controls unless `ownerUserId` names the signed-in user, and every refusal from the
 * server is shown with its own reason (never as a generic failure).
 *
 * Only UTF-8 text import is offered (Markdown/text/JSON/CSV/HTML); PDF, images and Office
 * conversion are outside this package's promise.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@prismshadow/penguin-ui";
import { apiFetch, ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { useAuth } from "../../state/auth";
import { projectDisplayName, useProject } from "../../state/project";
import {
  candidateOriginLabel,
  candidateStatusLabel,
  canEditKnowledge,
  documentFormatLabel,
  documentSourceLabel,
  documentStatusLabel,
  evidenceLine,
  knowledgeErrorHint,
  ruleStatusLabel,
  shortHash,
  timeLabel,
  type CandidateStatus,
  type CandidateView,
  type DocumentDetailView,
  type DocumentFormat,
  type DocumentStatus,
  type DocumentView,
  type RevisionView,
  type RuleStatus,
  type RuleView,
  type RuleVersionView,
} from "./project-knowledge-model";

type Tab = "documents" | "candidates" | "rules";

const TABS: { id: Tab; label: string }[] = [
  { id: "documents", label: "资料" },
  { id: "candidates", label: "知识候选" },
  { id: "rules", label: "正式规则" },
];

const FORMATS: DocumentFormat[] = ["markdown", "text", "json", "csv", "html"];

function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return knowledgeErrorHint(code) ?? apiErrorText(error);
}

/** A text document's bytes as base64, without going through a non-UTF-8 code path. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The same digest the server records for a UTF-8 body. */
async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

interface UploadPreviewView {
  previewId: string;
  filename: string;
  title: string;
  byteSize: number;
  contentHash: string;
  recipient: "local_project" | "remote_knowledge_service";
  purpose: string;
  dataScope: string;
  sensitiveHints: string[];
  sensitiveNotice: string;
  status: string;
  expiresAt: string;
}

interface UploadConfirmView {
  idempotent: boolean;
  document: DocumentDetailView;
  upload: { uploadId: string | null; serverCopy: { status: string } | null };
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block opacity-70">{label}</span>
      {children}
    </label>
  );
}

export function ProjectKnowledgePage({ initialTab = "documents", embedded = false, initialDocumentId }: { initialTab?: Tab; embedded?: boolean; initialDocumentId?: string } = {}) {
  const { currentProject } = useProject();
  return <ProjectKnowledgePageContent key={`${currentProject?.projectId ?? "no-project"}:${initialTab}:${initialDocumentId ?? ""}`} initialTab={initialTab} embedded={embedded} initialDocumentId={initialDocumentId} />;
}

function ProjectKnowledgePageContent({ initialTab, embedded, initialDocumentId }: { initialTab: Tab; embedded: boolean; initialDocumentId?: string }) {
  const { user } = useAuth();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;
  const base = `/api/projects/${encodeURIComponent(projectId ?? "")}/agents/qa`;
  const owner = canEditKnowledge(currentProject, user?.userId);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  // Documents
  const [documents, setDocuments] = useState<DocumentView[] | null>(null);
  const [docQuery, setDocQuery] = useState("");
  const [docStatus, setDocStatus] = useState<"all" | DocumentStatus>("all");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(initialDocumentId ?? null);
  const [candidateDraft, setCandidateDraft] = useState<{title:string; statement:string; rationale:string; documentId:string; revision:number} | null>(null);
  const [detail, setDetail] = useState<DocumentDetailView | null>(null);
  const [revisions, setRevisions] = useState<RevisionView[] | null>(null);
  const [docEditor, setDocEditor] = useState<
    | { mode: "create" }
    | { mode: "edit"; documentId: string; expectedRevision: number }
    | null
  >(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftFormat, setDraftFormat] = useState<DocumentFormat>("markdown");
  const [draftNote, setDraftNote] = useState("");
  const [pendingUpload, setPendingUpload] = useState<{ preview: UploadPreviewView; file: File } | null>(null);

  // Candidates
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidateStatus, setCandidateStatus] = useState<"all" | CandidateStatus>(embedded ? "pending" : "all");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  // Rules
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [ruleStatus, setRuleStatus] = useState<"all" | RuleStatus>("all");
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [ruleDetail, setRuleDetail] = useState<(RuleView & { versions: RuleVersionView[] }) | null>(
    null,
  );
  const [ruleEditor, setRuleEditor] = useState<
    { ruleId: string; expectedVersion: number; statement: string } | null
  >(null);
  const [ruleDraftStatement, setRuleDraftStatement] = useState("");
  const [ruleDraftNote, setRuleDraftNote] = useState("");

  const fail = useCallback((failure: unknown) => {
    setError(errorText(failure));
    setNotice(null);
  }, []);

  useEffect(() => {
    setError(null);
    if (!projectId) return;
    let alive = true;
    if (tab === "documents") {
      setDocuments(null);
      apiFetch<{ documents: DocumentView[] }>(`${base}/documents`, {
        query: { ...(docQuery ? { q: docQuery } : {}), ...(docStatus !== "all" ? { status: docStatus } : {}) },
      })
        .then((answer) => {
          if (alive) setDocuments(answer.documents);
        })
        .catch((failure: unknown) => {
          if (alive) fail(failure);
        });
    } else if (tab === "candidates") {
      setCandidates(null);
      apiFetch<{ candidates: CandidateView[] }>(`${base}/knowledge/candidates`, {
        query: candidateStatus === "all" ? {} : { status: candidateStatus },
      })
        .then((answer) => {
          if (alive) setCandidates(answer.candidates);
        })
        .catch((failure: unknown) => {
          if (alive) fail(failure);
        });
    } else {
      setRules(null);
      apiFetch<{ rules: RuleView[] }>(`${base}/knowledge/rules`, {
        query: ruleStatus === "all" ? {} : { status: ruleStatus },
      })
        .then((answer) => {
          if (alive) setRules(answer.rules);
        })
        .catch((failure: unknown) => {
          if (alive) fail(failure);
        });
    }
    return () => {
      alive = false;
    };
  }, [tab, projectId, base, docQuery, docStatus, candidateStatus, ruleStatus, reload, fail]);

  useEffect(() => {
    if (!selectedDocId) {
      setDetail(null);
      setRevisions(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setRevisions(null);
    apiFetch<DocumentDetailView>(`${base}/documents/${encodeURIComponent(selectedDocId)}`)
      .then((answer) => {
        if (alive) setDetail(answer);
      })
      .catch((failure: unknown) => {
        if (alive) fail(failure);
      });
    return () => {
      alive = false;
    };
  }, [selectedDocId, base, reload, fail]);

  useEffect(() => {
    if (!selectedRuleId) {
      setRuleDetail(null);
      return;
    }
    let alive = true;
    setRuleDetail(null);
    apiFetch<RuleView & { versions: RuleVersionView[] }>(
      `${base}/knowledge/rules/${encodeURIComponent(selectedRuleId)}`,
    )
      .then((answer) => {
        if (alive) setRuleDetail(answer);
      })
      .catch((failure: unknown) => {
        if (alive) fail(failure);
      });
    return () => {
      alive = false;
    };
  }, [selectedRuleId, base, reload, fail]);

  const selectedCandidate = useMemo(
    () => candidates?.find((candidate) => candidate.candidateId === selectedCandidateId) ?? null,
    [candidates, selectedCandidateId],
  );

  const openCreate = () => {
    setDraftTitle("");
    setDraftContent("");
    setDraftFormat("markdown");
    setDraftNote("");
    setError(null);
    setDocEditor({ mode: "create" });
  };

  const openEdit = () => {
    if (!detail) return;
    setDraftTitle(detail.document.title);
    setDraftContent(detail.content);
    setDraftNote("");
    setError(null);
    setDocEditor({
      mode: "edit",
      documentId: detail.document.documentId,
      expectedRevision: detail.document.revision,
    });
  };

  async function saveDocument() {
    if (!docEditor || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (docEditor.mode === "create") {
        const created = await apiFetch<DocumentDetailView>(`${base}/documents`, {
          method: "POST",
          body: {
            title: draftTitle,
            format: draftFormat,
            content: draftContent,
            ...(draftNote ? { changeNote: draftNote } : {}),
          },
        });
        setSelectedDocId(created.document.documentId);
        setNotice(`已创建资料「${created.document.title}」，当前修订 ${created.document.revision}。`);
      } else {
        const updated = await apiFetch<DocumentDetailView>(
          `${base}/documents/${encodeURIComponent(docEditor.documentId)}`,
          {
            method: "PUT",
            body: {
              expectedRevision: docEditor.expectedRevision,
              title: draftTitle,
              content: draftContent,
              ...(draftNote ? { changeNote: draftNote } : {}),
            },
          },
        );
        setNotice(`已保存修订 ${updated.document.revision}，旧修订仍保留在历史中。`);
      }
      setDocEditor(null);
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function submitCandidate() {
    if (!candidateDraft || busy) return;
    setBusy(true); setError(null);
    try {
      await apiFetch(`${base}/knowledge/candidates`, {method:'POST', body:{
        title:candidateDraft.title, statement:candidateDraft.statement, rationale:candidateDraft.rationale,
        sourceRefs:[{type:'document', documentId:candidateDraft.documentId, revision:candidateDraft.revision}],
      }});
      setCandidateDraft(null); setNotice('已提交待确认知识，尚未成为正式规则。'); refresh();
    } catch(failure) { fail(failure); } finally { setBusy(false); }
  }

  async function previewFile(file: File): Promise<UploadPreviewView> {
    const text = await file.text();
    return apiFetch<UploadPreviewView>(`${base}/uploads/preview`, {
      method: "POST",
      body: {
        filename: file.name,
        dataBase64: bytesToBase64(new TextEncoder().encode(text)),
        recipient: "local_project",
        purpose: "项目资料库",
        dataScope: "project_only",
      },
    });
  }

  async function importFile(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await previewFile(file);
      setPendingUpload({ preview, file });
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function confirmUpload() {
    if (!pendingUpload || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The preview binds one content version: if the file changed on disk, re-preview and make
      // the user confirm the new hash instead of uploading silently.
      const current = await pendingUpload.file.text();
      const currentHash = await hashText(current);
      if (currentHash !== pendingUpload.preview.contentHash) {
        const preview = await previewFile(pendingUpload.file);
        setPendingUpload({ preview, file: pendingUpload.file });
        setNotice("文件内容已变化，已重新生成预览，请核对后再次确认。");
        return;
      }
      const result = await apiFetch<UploadConfirmView>(
        `${base}/uploads/${encodeURIComponent(pendingUpload.preview.previewId)}/confirm`,
        {
          method: "POST",
          body: {
            contentHash: pendingUpload.preview.contentHash,
            confirmed: true,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      );
      setPendingUpload(null);
      setSelectedDocId(result.document.document.documentId);
      setNotice(
        `已确认导入「${result.document.document.title}」（UTF-8 文本），当前修订 ${result.document.document.revision}。`,
      );
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function archiveDocument() {
    if (!detail || busy || !owner) return;
    if (!window.confirm(`归档资料「${detail.document.title}」？归档后不能再修订，历史仍可查看。`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `${base}/documents/${encodeURIComponent(detail.document.documentId)}?expectedRevision=${detail.document.revision}`,
        { method: "DELETE" },
      );
      setNotice("资料已归档，历史修订仍可查看。");
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function loadRevisions() {
    if (!detail) return;
    setError(null);
    try {
      const answer = await apiFetch<{ revisions: RevisionView[] }>(
        `${base}/documents/${encodeURIComponent(detail.document.documentId)}/revisions`,
      );
      setRevisions(answer.revisions);
    } catch (failure) {
      fail(failure);
    }
  }

  async function confirmCandidate(candidate: CandidateView) {
    if (busy || !owner) return;
    if (
      !window.confirm(
        `确认「${candidate.title}」为正式业务规则？确认后将生成规则 v1，并记录你为确认人；此后版本修订单独留痕。`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const answer = await apiFetch<{ rule: RuleView }>(
        `${base}/knowledge/candidates/${encodeURIComponent(candidate.candidateId)}/confirm`,
        { method: "POST", body: { expectedRevision: candidate.revision } },
      );
      setNotice(`候选已确认，生成规则「${answer.rule.title}」v${answer.rule.version}。`);
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function rejectCandidate(candidate: CandidateView) {
    if (busy || !owner) return;
    const reason = window.prompt(`拒绝「${candidate.title}」的原因（会记录在候选上）：`, "");
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `${base}/knowledge/candidates/${encodeURIComponent(candidate.candidateId)}/reject`,
        { method: "POST", body: { expectedRevision: candidate.revision, reason } },
      );
      setNotice("候选已拒绝；拒绝原因和确认人记录在候选上，不会生成规则。");
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  function openRuleEditor(rule: RuleView) {
    setRuleDraftStatement(rule.statement);
    setRuleDraftNote("");
    setError(null);
    setRuleEditor({ ruleId: rule.ruleId, expectedVersion: rule.version, statement: rule.statement });
  }

  async function reviseRule() {
    if (!ruleEditor || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/knowledge/rules/${encodeURIComponent(ruleEditor.ruleId)}/revise`, {
        method: "POST",
        body: {
          expectedVersion: ruleEditor.expectedVersion,
          statement: ruleDraftStatement,
          ...(ruleDraftNote ? { changeNote: ruleDraftNote } : {}),
        },
      });
      setNotice("规则已修订，旧版本仍保留在版本历史中。");
      setRuleEditor(null);
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function retireRule(rule: RuleView) {
    if (busy || !owner) return;
    const reason = window.prompt(`停用规则「${rule.title}」的原因：`, "");
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/knowledge/rules/${encodeURIComponent(rule.ruleId)}/retire`, {
        method: "POST",
        body: { expectedVersion: rule.version, reason },
      });
      setNotice("规则已停用，旧版本和停用原因仍可追溯。");
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Client-side export of the rule the page has already loaded: a Markdown copy for reading and
   * archiving. No server route is involved, so this never bypasses any authorization.
   */
  function exportRuleMarkdown() {
    if (!ruleDetail) return;
    const lines = [
      `# ${ruleDetail.title}`,
      "",
      `- 规则 ID：${ruleDetail.ruleId}`,
      `- 版本：v${ruleDetail.version}`,
      `- 状态：${ruleStatusLabel(ruleDetail.status)}`,
      `- 确认人：${ruleDetail.confirmedBy}`,
      `- 创建：${timeLabel(ruleDetail.createdAt)}`,
      `- 更新：${timeLabel(ruleDetail.updatedAt)}`,
      ...(ruleDetail.sourceCandidateId ? [`- 来源候选：${ruleDetail.sourceCandidateId}`] : []),
      "",
      "## 规则正文",
      "",
      ruleDetail.statement,
    ];
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ruleDetail.ruleId}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const statusLine = useMemo(() => {
    if (!currentProject) return "尚未选择项目";
    return owner
      ? "你是本项目所有者：可以编辑资料、确认候选和维护规则。"
      : "只读：仅项目所有者可以编辑资料和确认规则；你仍可以查看全部资料、候选与规则。";
  }, [currentProject, owner]);

  if (!projectId) {
    return (
      <main className="p-6">
        <p className="text-sm opacity-70">请先在左上角选择一个项目。</p>
      </main>
    );
  }

  return (
    <main className={`flex h-full flex-col gap-4 overflow-hidden p-6 ${embedded ? "qa-knowledge-embedded" : ""}`}>
      <header className="shrink-0">
        <h1 className="text-xl font-semibold">{embedded ? { documents: "项目参考资料", candidates: "待确认知识", rules: "正式规则" }[tab] : "项目资料与知识"}</h1>
        <p className="mt-1 text-sm opacity-70">
          {projectDisplayName(currentProject!)} · {embedded ? {
            documents: "管理当前项目的参考文本及历史版本。可在我的资料中选择“用于项目任务”，确认后纳入。",
            candidates: "查看候选结论及来源依据，由项目所有者确认后生成正式规则。",
            rules: "查看已确认的业务规则，支持版本追溯、修订和停用。",
          }[tab] : "资料按修订保存；候选必须由项目所有者明确确认才会成为正式规则。"}
        </p>
        <p className="mt-2 text-xs opacity-70" role="status">
          {statusLine}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!embedded && <div className="flex rounded border border-[var(--border)]" role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                className={`px-3 py-1.5 text-sm ${tab === entry.id ? "bg-[var(--accent)] text-white" : ""}`}
                onClick={() => {
                  setTab(entry.id);
                  setError(null);
                  setNotice(null);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>}
          <Button size="sm" variant="ghost" onClick={refresh}>
            刷新
          </Button>
        </div>
      </header>

      {error && (
        <p role="alert" className="shrink-0 rounded border border-red-300 p-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="shrink-0 rounded border border-[var(--border)] p-2 text-sm">
          {notice}
        </p>
      )}

      <div className="qa-k-toolbar">
        {tab === "documents" && (
          <>
            <input
              className="qa-k-search"
              aria-label="搜索资料"
              placeholder="搜索标题或正文"
              value={docQuery}
              onChange={(event) => setDocQuery(event.target.value)}
            />
            <select
              className="qa-k-select"
              aria-label="资料状态"
              value={docStatus}
              onChange={(event) => setDocStatus(event.target.value as "all" | DocumentStatus)}
            >
              <option value="all">全部状态</option>
              <option value="active">生效</option>
              <option value="archived">已归档</option>
            </select>
            <span className="qa-k-total">{documents === null ? "" : `共 ${documents.length} 份资料`}</span>
            <span className="qa-k-spacer" />
            {owner && (
              <>
                <Button size="sm" onClick={openCreate} disabled={busy}>
                  新建资料
                </Button>
                <label className="cursor-pointer rounded border px-3 py-1.5 text-sm">
                  {embedded ? "导入文本文件" : "导入 UTF-8 文件"}
                  <input
                    type="file"
                    className="hidden"
                    aria-label="导入资料文件"
                    accept=".md,.markdown,.txt,.yaml,.yml,.json,.csv,.html,.htm"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void importFile(file);
                    }}
                  />
                </label>
              </>
            )}
          </>
        )}
        {tab === "candidates" && (
          <>
            <select
              className="qa-k-select"
              aria-label="候选状态"
              value={candidateStatus}
              onChange={(event) =>
                setCandidateStatus(event.target.value as "all" | CandidateStatus)
              }
            >
              <option value="all">全部状态</option>
              <option value="pending">待确认</option>
              <option value="accepted">已确认</option>
              <option value="rejected">已拒绝</option>
            </select>
            <span className="qa-k-total">{candidates === null ? "" : `共 ${candidates.length} 条候选`}</span>
            <span className="qa-k-spacer" />
            <span className="qa-k-total">候选不会自动成为规则；确认动作由项目所有者显式完成。</span>
          </>
        )}
        {tab === "rules" && (
          <>
            <select
              className="qa-k-select"
              aria-label="规则状态"
              value={ruleStatus}
              onChange={(event) => setRuleStatus(event.target.value as "all" | RuleStatus)}
            >
              <option value="all">全部状态</option>
              <option value="active">生效</option>
              <option value="retired">已停用</option>
            </select>
            <span className="qa-k-total">{rules === null ? "" : `共 ${rules.length} 条规则`}</span>
          </>
        )}
      </div>

      <div className="qa-k-split">
        <section className="qa-k-list-card">
          {tab === "documents" && (
            <div className="qa-k-list-scroll">
              {documents === null ? (
                <p className="qa-k-empty-list">正在读取资料…</p>
              ) : documents.length === 0 ? (
                <p className="qa-k-empty-list">
                  还没有资料。{owner ? "新建文本资料或导入 UTF-8 文件后，任务会按快照引用。" : ""}
                </p>
              ) : (
                documents.map((document) => (
                  <button
                    key={document.documentId}
                    className={`pk-doc qa-k-li${selectedDocId === document.documentId ? " sel" : ""}`}
                    onClick={() => setSelectedDocId(document.documentId)}
                  >
                    <span className="qa-k-li-top">
                      <span className="qa-k-li-name">{document.title}</span>
                      <span className="qa-k-right">修订 {document.revision}</span>
                    </span>
                    <span className="qa-k-li-tags">
                      <span className="qa-k-tag blue">{documentFormatLabel(document.format)}</span>
                      <span className={`qa-k-tag ${document.status === "active" ? "green" : "grey"}`}>
                        {documentStatusLabel(document.status)}
                      </span>
                    </span>
                    <span className="qa-k-li-excerpt">
                      {documentSourceLabel(document.source)} · 更新 {timeLabel(document.updatedAt)} ·{" "}
                      {document.byteSize} 字节 · 内容 {shortHash(document.contentHash)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {tab === "candidates" && (
            <div className="qa-k-list-scroll">
              {candidates === null ? (
                <p className="qa-k-empty-list">正在读取候选…</p>
              ) : candidates.length === 0 ? (
                <p className="qa-k-empty-list">当前筛选下没有知识候选。</p>
              ) : (
                candidates.map((candidate) => (
                  <button
                    key={candidate.candidateId}
                    className={`pk-candidate qa-k-li${selectedCandidateId === candidate.candidateId ? " sel" : ""}`}
                    onClick={() => setSelectedCandidateId(candidate.candidateId)}
                  >
                    <span className="qa-k-li-top">
                      <span className="qa-k-li-name">{candidate.title}</span>
                    </span>
                    <span className="qa-k-li-tags">
                      <span
                        className={`qa-k-tag ${candidate.status === "pending" ? "amber" : candidate.status === "accepted" ? "green" : "red"}`}
                      >
                        {candidateStatusLabel(candidate.status)}
                      </span>
                      <span className="qa-k-tag grey">第 {candidate.revision} 版</span>
                    </span>
                    <span className="qa-k-li-excerpt">{candidate.statement}</span>
                    <span className="qa-k-li-sub">
                      {candidateOriginLabel(candidate.createdBy)} · 提交 {timeLabel(candidate.createdAt)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {tab === "rules" && (
            <div className="qa-k-list-scroll">
              {rules === null ? (
                <p className="qa-k-empty-list">正在读取规则…</p>
              ) : rules.length === 0 ? (
                <p className="qa-k-empty-list">还没有正式规则。知识候选需由项目所有者确认后才会生成规则。</p>
              ) : (
                rules.map((rule) => (
                  <button
                    key={rule.ruleId}
                    className={`qa-k-li${selectedRuleId === rule.ruleId ? " sel" : ""}`}
                    onClick={() => setSelectedRuleId(rule.ruleId)}
                  >
                    <span className="qa-k-li-top">
                      <span className={`qa-k-tag ${rule.status === "active" ? "green" : "grey"}`}>
                        {ruleStatusLabel(rule.status)}
                      </span>
                      <span className="qa-k-li-name">{rule.title}</span>
                      <span className="qa-k-right">v{rule.version}</span>
                    </span>
                    <span className="qa-k-li-sub">
                      确认人 {rule.confirmedBy} · 内容 {shortHash(rule.contentHash)}
                      {rule.sourceCandidateId ? ` · 来源候选 ${rule.sourceCandidateId}` : ""}
                    </span>
                    <span className="qa-k-li-excerpt">{rule.statement}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </section>

        <div className="qa-k-detail-col">
          {tab === "candidates" && (
            <details className="qa-k-info-card">
              <summary>候选如何成为规则</summary>
              <p>
                Agent 或个人提交的候选只是证据整理，必须由项目所有者明确确认；确认时服务端记录确认人、确认时间与候选版本号，
                并生成规则 v1。拒绝会保留原因，且不会生成规则。
              </p>
            </details>
          )}
          <section className="qa-k-detail-card">
            {tab === "documents" && (
              detail === null ? (
                <div className="qa-k-empty">
                  <span>📄</span>
                  <p>{selectedDocId ? "正在读取资料详情…" : "从左侧选择一份资料查看正文和修订历史。"}</p>
                </div>
              ) : (
                <>
                  <div className="qa-k-detail-head">
                    <div className="qa-k-detail-headmain">
                      <h2 className="qa-k-detail-title">{detail.document.title}</h2>
                      <p className="qa-k-detail-id">
                        {documentFormatLabel(detail.document.format)} · {documentStatusLabel(detail.document.status)} ·
                        当前修订 {detail.document.revision} · {detail.document.byteSize} 字节 · 内容{" "}
                        {shortHash(detail.document.contentHash)}
                      </p>
                      <p className="qa-k-detail-id">
                        {documentSourceLabel(detail.document.source)} · 创建 {detail.document.createdBy} · 更新{" "}
                        {detail.document.updatedBy} {timeLabel(detail.document.updatedAt)}
                      </p>
                      <p className="qa-k-detail-id">
                        本次修订 {detail.revision.revision} · {detail.revision.authorUserId} ·{" "}
                        {timeLabel(detail.revision.createdAt)}
                        {detail.revision.changeNote ? ` · ${detail.revision.changeNote}` : ""}
                      </p>
                    </div>
                    <div className="qa-k-acts">
                      {owner && detail.document.status === "active" && (
                        <Button size="sm" onClick={openEdit} disabled={busy}>
                          编辑并生成新修订
                        </Button>
                      )}
                      {owner && detail.document.status === "active" && (
                        <Button size="sm" disabled={busy} onClick={() => void archiveDocument()}>
                          归档资料
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={busy || detail.document.status !== "active"}
                        onClick={() =>
                          setCandidateDraft({
                            title: detail.document.title,
                            statement: "",
                            rationale: "",
                            documentId: detail.document.documentId,
                            revision: detail.document.currentRevision,
                          })
                        }
                      >
                        整理为待确认知识
                      </Button>
                    </div>
                  </div>
                  <div className="qa-k-detail-body">
                    {detail.document.source.ref?.startsWith("local-library:") && (
                      <p className="qa-k-meta-lines">
                        来源：我的资料「{detail.document.source.filename}」。此处保留已确认的文本版本；原资料修改后需重新确认更新，删除原资料不会删除本记录。
                      </p>
                    )}
                    <div className="qa-k-sec-title">正文预览（当前修订 {detail.revision.revision}）</div>
                    <pre className="qa-k-prov">{detail.content}</pre>
                    <div className="qa-k-sec-title" style={{ marginTop: 18 }}>
                      修订历史
                      <span className="qa-k-cnt">每版留痕，可追溯</span>
                      <Button size="sm" variant="ghost" onClick={() => void loadRevisions()}>
                        查看修订历史
                      </Button>
                    </div>
                    {revisions !== null && (
                      <div>
                        {revisions.map((revision) => (
                          <div key={revision.revisionId} className="qa-k-ver-line">
                            <div className="qa-k-ver-top">
                              <span className="qa-k-vno">修订 {revision.revision}</span>
                              <span className="qa-k-ver-log">
                                {revision.authorUserId} · 内容 {shortHash(revision.contentHash)}
                                {revision.changeNote ? ` · ${revision.changeNote}` : ""}
                              </span>
                              <span className="qa-k-when">{timeLabel(revision.createdAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )
            )}

            {tab === "candidates" && (
              selectedCandidate === null ? (
                <div className="qa-k-empty">
                  <span>🗳️</span>
                  <p>从左侧选择一条候选，查看结论、来源依据和处理操作。</p>
                </div>
              ) : (
                <>
                  <div className="qa-k-detail-head">
                    <div className="qa-k-detail-headmain">
                      <h2 className="qa-k-detail-title">{selectedCandidate.title}</h2>
                      <p className="qa-k-detail-id">
                        候选 {selectedCandidate.candidateId} · 第 {selectedCandidate.revision} 版 ·{" "}
                        {candidateOriginLabel(selectedCandidate.createdBy)} · 提交{" "}
                        {timeLabel(selectedCandidate.createdAt)}
                      </p>
                    </div>
                    <div className="qa-k-acts">
                      <span
                        className={`qa-k-tag ${selectedCandidate.status === "pending" ? "amber" : selectedCandidate.status === "accepted" ? "green" : "red"}`}
                        style={{ fontSize: 12, padding: "3px 10px" }}
                      >
                        {candidateStatusLabel(selectedCandidate.status)}
                      </span>
                    </div>
                  </div>
                  <div className="qa-k-detail-body">
                    <div className="qa-k-sec-title">候选结论</div>
                    <pre className="qa-k-prov">{selectedCandidate.statement}</pre>
                    {selectedCandidate.rationale && (
                      <>
                        <div className="qa-k-sec-title" style={{ marginTop: 16 }}>
                          依据说明
                        </div>
                        <div className="qa-k-cite">
                          <div className="qa-k-cite-who">提交理由</div>
                          {selectedCandidate.rationale}
                        </div>
                      </>
                    )}
                    {selectedCandidate.sourceRefs.length > 0 && (
                      <>
                        <div className="qa-k-sec-title">来源依据</div>
                        <ul className="qa-k-cite-list">
                          {selectedCandidate.sourceRefs.map((ref, index) => (
                            <li key={index} className="qa-k-cite">
                              {evidenceLine(ref)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {selectedCandidate.status !== "pending" && (
                      <p className="qa-k-meta-lines">
                        处理：{selectedCandidate.reviewedBy ?? "—"} · {timeLabel(selectedCandidate.reviewedAt)}
                        {selectedCandidate.reviewNote ? ` · ${selectedCandidate.reviewNote}` : ""}
                        {selectedCandidate.confirmedRuleId ? ` · 规则 ${selectedCandidate.confirmedRuleId}` : ""}
                      </p>
                    )}
                    {selectedCandidate.status === "pending" && (
                      <div className="qa-k-confirm-bar">
                        <span className="qa-k-confirm-txt">
                          确认后由服务端记录<b>确认人 / 时间 / 候选版本</b>，生成<b>规则 v1</b>
                          并进入「正式规则」；拒绝会保留原因，不会生成规则。
                        </span>
                        <span className="qa-k-confirm-acts">
                          {owner ? (
                            <>
                              <Button size="sm" disabled={busy} onClick={() => void rejectCandidate(selectedCandidate)}>
                                拒绝
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => void confirmCandidate(selectedCandidate)}
                              >
                                确认并生成规则
                              </Button>
                            </>
                          ) : (
                            <span className="qa-k-total">确认动作由项目所有者完成。</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )
            )}

            {tab === "rules" && (
              ruleDetail === null ? (
                <div className="qa-k-empty">
                  <span>📜</span>
                  <p>{selectedRuleId ? "正在读取规则详情…" : "从左侧选择一条规则查看正文与版本历史。"}</p>
                </div>
              ) : (
                <>
                  <div className="qa-k-detail-head">
                    <div className="qa-k-detail-headmain">
                      <h2 className="qa-k-detail-title">{ruleDetail.title}</h2>
                      <p className="qa-k-detail-id">
                        {ruleDetail.ruleId} · v{ruleDetail.version} · {ruleStatusLabel(ruleDetail.status)} · 确认人{" "}
                        {ruleDetail.confirmedBy} · 内容 {shortHash(ruleDetail.contentHash)}
                      </p>
                      <p className="qa-k-detail-id">
                        创建 {timeLabel(ruleDetail.createdAt)} · 更新 {timeLabel(ruleDetail.updatedAt)}
                        {ruleDetail.sourceCandidateId ? ` · 来源候选 ${ruleDetail.sourceCandidateId}` : ""}
                      </p>
                    </div>
                    <div className="qa-k-acts">
                      {owner && ruleDetail.status === "active" && (
                        <>
                          <Button size="sm" disabled={busy} onClick={() => openRuleEditor(ruleDetail)}>
                            修订规则
                          </Button>
                          <Button size="sm" disabled={busy} onClick={() => void retireRule(ruleDetail)}>
                            停用规则
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" onClick={exportRuleMarkdown}>
                        导出 Markdown
                      </Button>
                    </div>
                  </div>
                  <div className="qa-k-detail-body">
                    <div className="qa-k-sec-title">
                      规则正文
                      {ruleDetail.status === "retired" && <span className="qa-k-tag grey">已停用 · 不进入新任务</span>}
                    </div>
                    <pre className="qa-k-prov">{ruleDetail.statement}</pre>
                    {ruleDetail.sourceRefs.length > 0 && (
                      <>
                        <div className="qa-k-sec-title" style={{ marginTop: 16 }}>
                          来源依据
                        </div>
                        <ul className="qa-k-cite-list">
                          {ruleDetail.sourceRefs.map((ref, index) => (
                            <li key={index} className="qa-k-cite">
                              {evidenceLine(ref)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <div className="qa-k-sec-title" style={{ marginTop: 16 }}>
                      版本追溯
                      <span className="qa-k-cnt">共 {ruleDetail.versions.length} 版</span>
                    </div>
                    <div>
                      {ruleDetail.versions.map((version) => (
                        <div key={`${version.ruleId}-${version.version}`} className="qa-k-ver-line">
                          <div className="qa-k-ver-top">
                            <span className="qa-k-ver-no">v{version.version}</span>
                            <span className="qa-k-ver-log">
                              {ruleStatusLabel(version.status)} · {version.actorUserId} · 内容{" "}
                              {shortHash(version.contentHash)}
                              {version.changeNote ? ` · ${version.changeNote}` : ""}
                            </span>
                            <span className="qa-k-when">{timeLabel(version.createdAt)}</span>
                          </div>
                          <p className="qa-k-ver-statement">{version.statement}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )
            )}
          </section>
        </div>
      </div>

      <Modal open={candidateDraft !== null} title="整理为待确认知识" onClose={() => {if(!busy)setCandidateDraft(null);}}
        footer={<><Button disabled={busy} onClick={()=>setCandidateDraft(null)}>取消</Button><Button variant="primary" disabled={busy || !candidateDraft?.title.trim() || !candidateDraft?.statement.trim()} onClick={()=>void submitCandidate()}>提交待确认知识</Button></>}>
        {candidateDraft && <div className="space-y-3">
          <p className="text-sm opacity-70">关联当前资料第 {candidateDraft.revision} 个内容版本。提交后由项目所有者审核，不会自动成为规则。</p>
          <Field label="知识标题"><input aria-label="知识标题" className="w-full rounded border p-2" value={candidateDraft.title} onChange={e=>setCandidateDraft({...candidateDraft,title:e.target.value})}/></Field>
          <Field label="待确认结论"><textarea aria-label="待确认结论" className="w-full rounded border p-2" rows={5} value={candidateDraft.statement} onChange={e=>setCandidateDraft({...candidateDraft,statement:e.target.value})}/></Field>
          <Field label="依据说明"><textarea aria-label="依据说明" className="w-full rounded border p-2" rows={3} value={candidateDraft.rationale} onChange={e=>setCandidateDraft({...candidateDraft,rationale:e.target.value})}/></Field>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>}
      </Modal>
      <Modal
        open={docEditor !== null}
        title={docEditor?.mode === "edit" ? "编辑资料（生成新修订）" : "新建文本资料"}
        onClose={() => {
          if (!busy) setDocEditor(null);
        }}
        footer={
          <>
            <Button size="sm" disabled={busy} onClick={() => setDocEditor(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || draftTitle.trim() === "" || draftContent.trim() === ""}
              onClick={() => void saveDocument()}
            >
              {busy ? "正在保存…" : docEditor?.mode === "edit" ? "保存修订" : "创建资料"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="标题">
            <input
              className="w-full rounded border bg-transparent p-2 text-sm"
              aria-label="资料标题"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </Field>
          {docEditor?.mode === "create" && (
            <Field label="格式">
              <select
                className="w-full rounded border bg-transparent p-2 text-sm"
                aria-label="资料格式"
                value={draftFormat}
                onChange={(event) => setDraftFormat(event.target.value as DocumentFormat)}
              >
                {FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {documentFormatLabel(format)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="正文（UTF-8 文本）">
            <textarea
              className="min-h-48 w-full rounded border bg-transparent p-2 font-mono text-xs"
              aria-label="资料正文"
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
            />
          </Field>
          <Field label="修订说明（可选）">
            <input
              className="w-full rounded border bg-transparent p-2 text-sm"
              aria-label="修订说明"
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
            />
          </Field>
          {docEditor?.mode === "edit" && (
            <p className="text-xs opacity-70">
              提交时按修订 {docEditor.expectedRevision} 校验：资料已被他人更新时不会覆盖，会提示刷新后重试。
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={ruleEditor !== null}
        title="修订规则"
        onClose={() => {
          if (!busy) setRuleEditor(null);
        }}
        footer={
          <>
            <Button size="sm" disabled={busy} onClick={() => setRuleEditor(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || ruleDraftStatement.trim() === ""}
              onClick={() => void reviseRule()}
            >
              {busy ? "正在保存…" : "保存新版本"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="规则陈述">
            <textarea
              className="min-h-32 w-full rounded border bg-transparent p-2 text-sm"
              aria-label="规则陈述"
              value={ruleDraftStatement}
              onChange={(event) => setRuleDraftStatement(event.target.value)}
            />
          </Field>
          <Field label="修订说明（可选）">
            <input
              className="w-full rounded border bg-transparent p-2 text-sm"
              aria-label="规则修订说明"
              value={ruleDraftNote}
              onChange={(event) => setRuleDraftNote(event.target.value)}
            />
          </Field>
          <p className="text-xs opacity-70">
            按版本 {ruleEditor?.expectedVersion ?? "—"} 校验；旧版本会保留在版本历史中，确认人仍记录在原版本。
          </p>
        </div>
      </Modal>

      <Modal
        open={pendingUpload !== null}
        title="确认上传资料"
        onClose={() => {
          if (!busy) setPendingUpload(null);
        }}
        footer={
          <>
            <Button size="sm" disabled={busy} onClick={() => setPendingUpload(null)}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirmUpload()}>
              {busy ? "正在导入…" : "确认导入"}
            </Button>
          </>
        }
      >
        {pendingUpload && (
          <div className="space-y-3 text-xs">
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
              <dt className="opacity-70">文件</dt>
              <dd>{pendingUpload.preview.filename}</dd>
              <dt className="opacity-70">大小</dt>
              <dd>{pendingUpload.preview.byteSize} 字节</dd>
              <dt className="opacity-70">内容哈希</dt>
              <dd className="break-all font-mono">{pendingUpload.preview.contentHash}</dd>
              <dt className="opacity-70">接收方</dt>
              <dd>
                {pendingUpload.preview.recipient === "local_project"
                  ? "本项目本地资料库（不离开服务器）"
                  : "远端知识服务（需单独授权）"}
              </dd>
              <dt className="opacity-70">用途</dt>
              <dd>{pendingUpload.preview.purpose}</dd>
              <dt className="opacity-70">数据范围</dt>
              <dd>
                {pendingUpload.preview.dataScope === "project_only"
                  ? "仅当前项目"
                  : pendingUpload.preview.dataScope}
              </dd>
              <dt className="opacity-70">预览有效期至</dt>
              <dd>{timeLabel(pendingUpload.preview.expiresAt)}</dd>
            </dl>
            {pendingUpload.preview.sensitiveHints.length > 0 && (
              <p className="rounded border border-[var(--border)] p-2">
                可能含敏感内容：{pendingUpload.preview.sensitiveHints.join("、")}
              </p>
            )}
            <p className="opacity-70">{pendingUpload.preview.sensitiveNotice}</p>
            <p className="opacity-70">
              确认时绑定上面的内容哈希；确认前文件若被修改，会重新生成预览并要求再次确认。
            </p>
          </div>
        )}
      </Modal>
    </main>
  );
}
