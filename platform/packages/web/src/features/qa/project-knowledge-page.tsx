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

export function ProjectKnowledgePage() {
  const { currentProject } = useProject();
  return <ProjectKnowledgePageContent key={currentProject?.projectId ?? "no-project"} />;
}

function ProjectKnowledgePageContent() {
  const { user } = useAuth();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;
  const base = `/api/projects/${encodeURIComponent(projectId ?? "")}/agents/qa`;
  const owner = canEditKnowledge(currentProject, user?.userId);

  const [tab, setTab] = useState<Tab>("documents");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  // Documents
  const [documents, setDocuments] = useState<DocumentView[] | null>(null);
  const [docQuery, setDocQuery] = useState("");
  const [docStatus, setDocStatus] = useState<"all" | DocumentStatus>("all");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
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

  // Candidates
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidateStatus, setCandidateStatus] = useState<"all" | CandidateStatus>("all");

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

  async function importFile(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const created = await apiFetch<DocumentDetailView>(`${base}/documents/import`, {
        method: "POST",
        body: { filename: file.name, dataBase64 },
      });
      setSelectedDocId(created.document.documentId);
      setNotice(`已导入「${created.document.title}」（UTF-8 文本），当前修订 ${created.document.revision}。`);
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
    <main className="flex h-full flex-col gap-4 overflow-hidden p-6">
      <header className="shrink-0">
        <h1 className="text-xl font-semibold">项目资料与知识</h1>
        <p className="mt-1 text-sm opacity-70">
          {projectDisplayName(currentProject!)} · 资料按修订保存；候选必须由项目所有者明确确认才会成为正式规则。
        </p>
        <p className="mt-2 text-xs opacity-70" role="status">
          {statusLine}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded border border-[var(--border)]" role="tablist">
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
          </div>
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

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col rounded border border-[var(--border)]">
          {tab === "documents" && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
                <input
                  className="min-w-40 flex-1 rounded border bg-transparent p-2 text-sm"
                  aria-label="搜索资料"
                  placeholder="搜索标题或正文"
                  value={docQuery}
                  onChange={(event) => setDocQuery(event.target.value)}
                />
                <select
                  className="rounded border bg-transparent p-2 text-sm"
                  aria-label="资料状态"
                  value={docStatus}
                  onChange={(event) => setDocStatus(event.target.value as "all" | DocumentStatus)}
                >
                  <option value="all">全部状态</option>
                  <option value="active">生效</option>
                  <option value="archived">已归档</option>
                </select>
                {owner && (
                  <>
                    <Button size="sm" onClick={openCreate} disabled={busy}>
                      新建资料
                    </Button>
                    <label className="cursor-pointer rounded border px-3 py-1.5 text-sm">
                      导入 UTF-8 文件
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
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {documents === null ? (
                  <p className="p-2 text-sm opacity-70">正在读取资料…</p>
                ) : documents.length === 0 ? (
                  <p className="p-2 text-sm opacity-70">
                    还没有资料。{owner ? "新建文本资料或导入 UTF-8 文件后，任务会按快照引用。" : ""}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {documents.map((document) => (
                      <li key={document.documentId}>
                        <button
                          className={`pk-doc w-full rounded p-2 text-left text-sm ${selectedDocId === document.documentId ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"}`}
                          onClick={() => setSelectedDocId(document.documentId)}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <strong>{document.title}</strong>
                            <span className="text-xs opacity-70">
                              {documentFormatLabel(document.format)} · {documentStatusLabel(document.status)} · 修订{" "}
                              {document.revision}
                            </span>
                          </span>
                          <span className="mt-1 block text-xs opacity-70">
                            {documentSourceLabel(document.source)} · 更新 {timeLabel(document.updatedAt)} · 内容{" "}
                            {shortHash(document.contentHash)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {tab === "candidates" && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
                <select
                  className="rounded border bg-transparent p-2 text-sm"
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
                <p className="text-xs opacity-70">候选不会自动成为规则；确认动作由项目所有者显式完成。</p>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {candidates === null ? (
                  <p className="p-2 text-sm opacity-70">正在读取候选…</p>
                ) : candidates.length === 0 ? (
                  <p className="p-2 text-sm opacity-70">当前筛选下没有知识候选。</p>
                ) : (
                  <ul className="space-y-2">
                    {candidates.map((candidate) => (
                      <li
                        key={candidate.candidateId}
                        className="pk-candidate rounded border border-[var(--border)] p-3 text-sm"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{candidate.title}</strong>
                          <span className="text-xs opacity-70">
                            {candidateStatusLabel(candidate.status)} · 第 {candidate.revision} 版
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap">{candidate.statement}</p>
                        {candidate.rationale && (
                          <p className="mt-1 whitespace-pre-wrap text-xs opacity-70">
                            理由：{candidate.rationale}
                          </p>
                        )}
                        <p className="mt-1 text-xs opacity-70">
                          来源：{candidateOriginLabel(candidate.createdBy)} · 提交 {timeLabel(candidate.createdAt)}
                        </p>
                        <ul className="mt-1 list-disc pl-5 text-xs opacity-70">
                          {candidate.sourceRefs.map((ref, index) => (
                            <li key={index}>{evidenceLine(ref)}</li>
                          ))}
                        </ul>
                        {candidate.status === "pending" && owner && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() => void confirmCandidate(candidate)}
                            >
                              确认并生成规则
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => void rejectCandidate(candidate)}
                            >
                              拒绝
                            </Button>
                          </div>
                        )}
                        {candidate.status !== "pending" && (
                          <p className="mt-2 text-xs opacity-70">
                            处理：{candidate.reviewedBy ?? "—"} · {timeLabel(candidate.reviewedAt)}
                            {candidate.reviewNote ? ` · ${candidate.reviewNote}` : ""}
                            {candidate.confirmedRuleId ? ` · 规则 ${candidate.confirmedRuleId}` : ""}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {tab === "rules" && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
                <select
                  className="rounded border bg-transparent p-2 text-sm"
                  aria-label="规则状态"
                  value={ruleStatus}
                  onChange={(event) => setRuleStatus(event.target.value as "all" | RuleStatus)}
                >
                  <option value="all">全部状态</option>
                  <option value="active">生效</option>
                  <option value="retired">已停用</option>
                </select>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {rules === null ? (
                  <p className="p-2 text-sm opacity-70">正在读取规则…</p>
                ) : rules.length === 0 ? (
                  <p className="p-2 text-sm opacity-70">还没有正式规则。知识候选需由项目所有者确认后才会生成规则。</p>
                ) : (
                  <ul className="space-y-2">
                    {rules.map((rule) => (
                      <li key={rule.ruleId}>
                        <button
                          className={`pk-rule w-full rounded border border-[var(--border)] p-3 text-left text-sm ${selectedRuleId === rule.ruleId ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"}`}
                          onClick={() => setSelectedRuleId(rule.ruleId)}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <strong>{rule.title}</strong>
                            <span className="text-xs opacity-70">
                              v{rule.version} · {ruleStatusLabel(rule.status)}
                            </span>
                          </span>
                          <span className="mt-1 block whitespace-pre-wrap">{rule.statement}</span>
                          <span className="mt-1 block text-xs opacity-70">
                            确认人 {rule.confirmedBy} · 内容 {shortHash(rule.contentHash)}
                            {rule.sourceCandidateId ? ` · 候选 ${rule.sourceCandidateId}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        <section className="min-h-0 overflow-auto rounded border border-[var(--border)] p-3">
          {tab === "documents" && (
            detail === null ? (
              <p className="text-sm opacity-70">
                {selectedDocId ? "正在读取资料详情…" : "从左侧选择一份资料查看正文和修订历史。"}
              </p>
            ) : (
              <article className="space-y-3">
                <header>
                  <h2 className="text-lg font-medium">{detail.document.title}</h2>
                  <p className="mt-1 text-xs opacity-70">
                    {documentFormatLabel(detail.document.format)} · {documentStatusLabel(detail.document.status)} · 当前修订{" "}
                    {detail.document.revision} · {detail.document.byteSize} 字节 · 内容{" "}
                    {shortHash(detail.document.contentHash)}
                  </p>
                  <p className="mt-1 text-xs opacity-70">
                    {documentSourceLabel(detail.document.source)} · 创建 {detail.document.createdBy} · 更新{" "}
                    {detail.document.updatedBy} {timeLabel(detail.document.updatedAt)}
                  </p>
                  <p className="mt-1 text-xs opacity-70">
                    本次修订 {detail.revision.revision} · {detail.revision.authorUserId} ·{" "}
                    {timeLabel(detail.revision.createdAt)}
                    {detail.revision.changeNote ? ` · ${detail.revision.changeNote}` : ""}
                  </p>
                </header>
                {owner && detail.document.status === "active" && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={openEdit} disabled={busy}>
                      编辑并生成新修订
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void archiveDocument()}>
                      归档资料
                    </Button>
                  </div>
                )}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => void loadRevisions()}>
                    查看修订历史
                  </Button>
                  {revisions !== null && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {revisions.map((revision) => (
                        <li key={revision.revisionId} className="rounded border border-[var(--border)] p-2">
                          <strong>修订 {revision.revision}</strong> · {revision.authorUserId} ·{" "}
                          {timeLabel(revision.createdAt)} · 内容 {shortHash(revision.contentHash)}
                          {revision.changeNote ? ` · ${revision.changeNote}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <pre className="whitespace-pre-wrap break-words rounded border border-[var(--border)] p-3 text-xs">
                  {detail.content}
                </pre>
              </article>
            )
          )}

          {tab === "candidates" && (
            <div className="space-y-2 text-sm">
              <h2 className="text-lg font-medium">候选如何成为规则</h2>
              <p className="opacity-70">
                Agent 或个人提交的候选只是证据整理，必须由项目所有者明确确认；确认时服务端记录确认人、确认时间与候选版本号，
                并生成规则 v1。拒绝会保留原因，且不会生成规则。
              </p>
            </div>
          )}

          {tab === "rules" && (
            ruleDetail === null ? (
              <p className="text-sm opacity-70">
                {selectedRuleId ? "正在读取规则详情…" : "从左侧选择一条规则查看版本历史。"}
              </p>
            ) : (
              <article className="space-y-3">
                <header>
                  <h2 className="text-lg font-medium">{ruleDetail.title}</h2>
                  <p className="mt-1 text-xs opacity-70">
                    v{ruleDetail.version} · {ruleStatusLabel(ruleDetail.status)} · 确认人{" "}
                    {ruleDetail.confirmedBy} · 内容 {shortHash(ruleDetail.contentHash)}
                  </p>
                  <p className="mt-1 text-xs opacity-70">
                    创建 {timeLabel(ruleDetail.createdAt)} · 更新 {timeLabel(ruleDetail.updatedAt)}
                    {ruleDetail.sourceCandidateId ? ` · 来源候选 ${ruleDetail.sourceCandidateId}` : ""}
                  </p>
                </header>
                <p className="whitespace-pre-wrap rounded border border-[var(--border)] p-3 text-sm">
                  {ruleDetail.statement}
                </p>
                {ruleDetail.sourceRefs.length > 0 && (
                  <ul className="list-disc pl-5 text-xs opacity-70">
                    {ruleDetail.sourceRefs.map((ref, index) => (
                      <li key={index}>{evidenceLine(ref)}</li>
                    ))}
                  </ul>
                )}
                {owner && ruleDetail.status === "active" && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => openRuleEditor(ruleDetail)}>
                      修订规则
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void retireRule(ruleDetail)}>
                      停用规则
                    </Button>
                  </div>
                )}
                <div>
                  <h3 className="text-sm font-medium">版本历史</h3>
                  <ul className="mt-2 space-y-1 text-xs">
                    {ruleDetail.versions.map((version) => (
                      <li key={`${version.ruleId}-${version.version}`} className="rounded border border-[var(--border)] p-2">
                        <strong>v{version.version}</strong> · {ruleStatusLabel(version.status)} ·{" "}
                        {version.actorUserId} · {timeLabel(version.createdAt)} · 内容{" "}
                        {shortHash(version.contentHash)}
                        {version.changeNote ? ` · ${version.changeNote}` : ""}
                        <p className="mt-1 whitespace-pre-wrap opacity-70">{version.statement}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            )
          )}
        </section>
      </div>

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
    </main>
  );
}
