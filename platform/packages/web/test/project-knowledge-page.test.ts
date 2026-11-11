// @vitest-environment jsdom
/**
 * The project knowledge page (T3): owner-only writing, the specific reason for a refusal, and
 * the candidate → rule confirmation record. The Q2 service itself is covered by
 * qa-project-knowledge.test.ts; here the page is driven as a person drives it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { createHash, webcrypto } from "node:crypto";
import { button, click, hasButton, mount, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { ApiError } from "../src/api/client";

const state = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; body?: any }[],
  userId: "owner-1",
  ownerUserId: "owner-1",
  documents: [] as any[],
  detail: null as any,
  revisions: [] as any[],
  candidates: [] as any[],
  rules: [] as any[],
  ruleDetail: null as any,
  detailError: null as Error | null,
  uploadText: "来自文件的资料：失败五次锁定三十分钟。",
  uploadHash: "",
}));

vi.mock("../src/state/auth", () => ({
  useAuth: () => ({ user: { userId: state.userId } }),
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({
    currentProject: { projectId: "demo", ownerUserId: state.ownerUserId, role: "owner" },
  }),
  projectDisplayName: () => "演示项目",
}));

vi.mock("../src/api/client", async () => {
  const actual = await vi.importActual<typeof import("../src/api/client")>("../src/api/client");
  return {
    ...actual,
    apiFetch: async (url: string, init?: { method?: string; body?: any }) => {
      state.calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.body ? { body: init.body } : {}) });
      if (url.endsWith("/documents") && (init?.method ?? "GET") === "GET") {
        return { documents: state.documents, nextCursor: null };
      }
      if (url.endsWith("/documents") && init?.method === "POST") {
        const created = {
          document: {
            ...state.documents[0],
            documentId: "doc-new",
            title: init.body.title,
            revision: 1,
          },
          content: init.body.content,
          revision: {
            revisionId: "rev-new",
            revision: 1,
            contentHash: "sha256:11112222",
            authorUserId: state.userId,
            changeNote: "",
            createdAt: "2026-11-03T00:00:00Z",
          },
        };
        state.documents = [...state.documents, created.document];
        return created;
      }
      if (url.includes("/documents/doc-1/revisions")) {
        return { revisions: state.revisions, nextCursor: null };
      }
      if (url.includes("/documents/") && init?.method === "PUT") {
        const next = {
          document: { ...state.detail.document, revision: state.detail.document.revision + 1 },
          content: init.body.content,
          revision: {
            revisionId: "rev-next",
            revision: state.detail.document.revision + 1,
            contentHash: "sha256:33334444",
            authorUserId: state.userId,
            changeNote: init.body.changeNote ?? "",
            createdAt: "2026-11-03T01:00:00Z",
          },
        };
        state.detail = next;
        return next;
      }
      if (url.includes("/documents/") && (init?.method ?? "GET") === "GET") {
        if (state.detailError) throw state.detailError;
        return state.detail;
      }
      if (url.endsWith("/uploads/preview")) {
        return {
          previewId: "preview-1",
          filename: init?.body?.filename,
          title: "导入资料",
          byteSize: 12,
          contentHash: state.uploadHash,
          recipient: init?.body?.recipient,
          purpose: init?.body?.purpose,
          dataScope: init?.body?.dataScope,
          sensitiveHints: ["令牌或密钥"],
          sensitiveNotice:
            "敏感内容提示按常见关键词做启发式检查，不能保证识别所有敏感内容；上传前请自行核对文件。",
          status: "pending",
          expiresAt: "2026-11-03T00:30:00Z",
        };
      }
      if (url.includes("/uploads/") && url.endsWith("/confirm")) {
        const imported = {
          document: {
            ...doc(),
            documentId: "doc-imported",
            title: "导入资料",
            revision: 1,
            contentHash: state.uploadHash,
          },
          content: state.uploadText,
          revision: {
            revisionId: "rev-imported",
            revision: 1,
            contentHash: state.uploadHash,
            authorUserId: state.userId,
            changeNote: "通过上传预览确认导入",
            createdAt: "2026-11-03T00:00:00Z",
          },
        };
        state.documents = [...state.documents, imported.document];
        return {
          idempotent: false,
          document: imported,
          upload: { uploadId: "upl-1", serverCopy: { status: "not_required" } },
        };
      }
      if (url.endsWith("/knowledge/candidates")) {
        return { candidates: state.candidates, nextCursor: null };
      }      if (url.includes("/knowledge/candidates/") && url.endsWith("/confirm")) {
        return {
          rule: {
            ruleId: "rule-1",
            projectId: "demo",
            status: "active",
            version: 1,
            title: "锁定时长",
            statement: "失败五次锁定三十分钟。",
            scope: { level: "project" },
            sourceRefs: [],
            confirmedBy: state.userId,
            contentHash: "sha256:aaaabbbb",
            createdAt: "2026-11-03T00:00:00Z",
            updatedAt: "2026-11-03T00:00:00Z",
          },
        };
      }
      if (url.endsWith("/knowledge/rules")) return { rules: state.rules, nextCursor: null };
      if (url.includes("/knowledge/rules/")) return state.ruleDetail;
      return {};
    },
  };
});

import { ProjectKnowledgePage } from "../src/features/qa/project-knowledge-page";

// jsdom's crypto has no subtle digest; the page hashes the file body before confirmation.
if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
state.uploadHash = `sha256:${createHash("sha256").update(state.uploadText, "utf8").digest("hex")}`;

const doc = (over: Record<string, unknown> = {}) => ({
  documentId: "doc-1",
  projectId: "demo",
  title: "登录要求",
  format: "markdown",
  status: "active",
  source: { type: "manual" },
  revision: 2,
  currentRevision: 2,
  currentRevisionId: "rev-2",
  contentHash: "sha256:abcdef1234567890",
  byteSize: 42,
  createdAt: "2026-11-01T00:00:00Z",
  createdBy: "owner-1",
  updatedAt: "2026-11-02T00:00:00Z",
  updatedBy: "owner-1",
  ...over,
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  state.calls = [];
  state.userId = "owner-1";
  state.ownerUserId = "owner-1";
  state.documents = [];
  state.detail = null;
  state.revisions = [];
  state.candidates = [];
  state.rules = [];
  state.ruleDetail = null;
  state.detailError = null;
});

async function openDocuments() {
  await mount(h(ProjectKnowledgePage));
  await waitFor(() => document.querySelectorAll(".pk-doc").length > 0);
}

it("edits a document into a new revision and shows the revision history", async () => {
  state.documents = [doc()];
  state.detail = {
    document: doc(),
    content: "旧版：五次失败锁定十五分钟。",
    revision: {
      revisionId: "rev-2",
      revision: 2,
      contentHash: "sha256:abcdef1234567890",
      authorUserId: "owner-1",
      changeNote: "初稿",
      createdAt: "2026-11-02T00:00:00Z",
    },
  };
  state.revisions = [
    {
      revisionId: "rev-1",
      revision: 1,
      contentHash: "sha256:99990000",
      authorUserId: "owner-1",
      changeNote: "初稿",
      createdAt: "2026-11-01T00:00:00Z",
    },
  ];
  await openDocuments();
  await click(document.querySelector(".pk-doc")!);
  await waitFor(() => (document.body.textContent ?? "").includes("旧版：五次失败锁定十五分钟。"));
  expect(state.calls[0]!.url).toBe("/api/projects/demo/agents/qa/documents");

  await click(button("编辑并生成新修订"));
  await type(document.querySelector('[aria-label="资料正文"]')!, "新版：锁定三十分钟。");
  await type(document.querySelector('[aria-label="修订说明"]')!, "按评审意见调整");
  await click(button("保存修订"));
  await settle();
  const put = state.calls.find((call) => call.method === "PUT");
  expect(put?.url).toBe("/api/projects/demo/agents/qa/documents/doc-1");
  expect(put?.body).toMatchObject({
    expectedRevision: 2,
    content: "新版：锁定三十分钟。",
    changeNote: "按评审意见调整",
  });
  expect(document.body.textContent).toContain("已保存修订 3");

  await click(button("查看修订历史"));
  await waitFor(() => (document.body.textContent ?? "").includes("修订 1"));
  expect(document.body.textContent).toContain("初稿");
  expect(document.body.textContent).toContain("abcdef12");
});

it("previews a file's hash and metadata, and imports only after explicit confirmation", async () => {
  await mount(h(ProjectKnowledgePage));
  await waitFor(() => document.querySelector('[aria-label="导入资料文件"]') !== null);
  const input = document.querySelector('[aria-label="导入资料文件"]') as HTMLInputElement;
  const file = {
    name: "规则.md",
    text: async () => state.uploadText,
  } as unknown as File;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() => (document.body.textContent ?? "").includes("确认上传资料"));
  expect(document.body.textContent).toContain("规则.md");
  expect(document.body.textContent).toContain(state.uploadHash);
  expect(document.body.textContent).toContain("令牌或密钥");
  expect(document.body.textContent).toContain("不能保证识别所有敏感内容");
  const preview = state.calls.find((call) => call.url.endsWith("/uploads/preview"));
  expect(preview?.body).toMatchObject({
    filename: "规则.md",
    recipient: "local_project",
    dataScope: "project_only",
  });
  // Nothing is created before the confirmation.
  expect(state.calls.some((call) => call.url.endsWith("/confirm"))).toBe(false);

  await click(button("确认导入"));
  await settle();
  const confirm = state.calls.find((call) => call.url.endsWith("/preview-1/confirm"));
  expect(confirm?.body).toMatchObject({ contentHash: state.uploadHash, confirmed: true });
  expect(document.body.textContent).toContain("已确认导入「导入资料」");
});

it("confirms a candidate explicitly and records that confirmation created the rule", async () => {
  state.userId = "owner-1";
  state.candidates = [
    {
      candidateId: "candidate-1",
      projectId: "demo",
      title: "锁定时长",
      statement: "失败五次锁定三十分钟。",
      rationale: "来自资料修订 3",
      scope: { level: "project" },
      sourceRefs: [{ type: "document", documentId: "doc-1", revision: 3 }],
      status: "pending",
      revision: 2,
      createdBy: { type: "agent", userId: "owner-1", agentId: "test_agent", sessionId: "s-1" },
      createdAt: "2026-11-03T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
    },
  ];
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await mount(h(ProjectKnowledgePage));
  await click(button("知识候选"));
  await waitFor(() => document.querySelectorAll(".pk-candidate").length === 1);
  expect(document.body.textContent).toContain("候选不会自动成为规则");
  // The new layout confirms from the detail card: the candidate must be opened first.
  await click(document.querySelector(".pk-candidate")!);
  await waitFor(() => hasButton("确认并生成规则"));
  await click(button("确认并生成规则"));
  await settle();
  expect(confirm).toHaveBeenCalled();
  const post = state.calls.find((call) => call.url.endsWith("/candidate-1/confirm"));
  expect(post?.method).toBe("POST");
  expect(post?.body).toEqual({ expectedRevision: 2 });
  expect(document.body.textContent).toContain("生成规则「锁定时长」v1");
});

it("offers no write controls to an account that does not own the project", async () => {
  state.userId = "member-1";
  state.ownerUserId = "owner-1";
  state.documents = [doc()];
  state.detail = {
    document: doc(),
    content: "只读内容",
    revision: {
      revisionId: "rev-2",
      revision: 2,
      contentHash: "sha256:abcdef1234567890",
      authorUserId: "owner-1",
      changeNote: "",
      createdAt: "2026-11-02T00:00:00Z",
    },
  };
  state.candidates = [
    {
      candidateId: "candidate-1",
      projectId: "demo",
      title: "锁定时长",
      statement: "失败五次锁定三十分钟。",
      rationale: "",
      scope: { level: "project" },
      sourceRefs: [],
      status: "pending",
      revision: 1,
      createdBy: { type: "user", userId: "member-1" },
      createdAt: "2026-11-03T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
    },
  ];
  await openDocuments();
  expect(hasButton("新建资料")).toBe(false);
  await click(document.querySelector(".pk-doc")!);
  await waitFor(() => (document.body.textContent ?? "").includes("只读内容"));
  expect(hasButton("编辑并生成新修订")).toBe(false);
  expect(hasButton("归档资料")).toBe(false);
  expect(document.body.textContent).toContain("只读：仅项目所有者");

  await click(button("知识候选"));
  await waitFor(() => document.querySelectorAll(".pk-candidate").length === 1);
  expect(hasButton("确认并生成规则")).toBe(false);
  expect(hasButton("拒绝")).toBe(false);
});

it("states why a document is unreadable instead of showing another project's content", async () => {
  state.documents = [doc()];
  state.detailError = new ApiError(404, "document_not_found", "not found");
  await openDocuments();
  await click(document.querySelector(".pk-doc")!);
  await waitFor(() =>
    (document.querySelector('[role="alert"]')?.textContent ?? "").includes(
      "资料不存在，或不属于当前项目",
    ),
  );
});
