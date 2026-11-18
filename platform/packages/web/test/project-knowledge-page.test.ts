// @vitest-environment jsdom
/**
 * The project knowledge page (T3): owner-only writing, the specific reason for a refusal, and
 * the candidate → rule confirmation record. The Q2 service itself is covered by
 * qa-project-knowledge.test.ts; here the page is driven as a person drives it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { createHash, webcrypto } from "node:crypto";
import { button, click, field, hasButton, mount, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { ApiError } from "../src/api/client";

const state = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; body?: any; query?: Record<string, unknown> }[],
  userId: "owner-1",
  ownerUserId: "owner-1",
  documents: [] as any[],
  detail: null as any,
  revisions: [] as any[],
  candidates: [] as any[],
  rules: [] as any[],
  ruleDetail: null as any,
  builds: [] as any[],
  build: null as any,
  buildDiff: null as any,
  references: null as any,
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
    apiFetch: async (url: string, init?: { method?: string; body?: any; query?: Record<string, unknown> }) => {
      state.calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.body ? { body: init.body } : {}), ...(init?.query ? { query: init.query } : {}) });
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
      // 带 query 的 URL 不以 /diff 结尾，这里按路径段判断。
      if (url.includes("/knowledge/builds/") && url.includes("/diff")) return state.buildDiff;
      if (url.endsWith("/knowledge/builds")) return { builds: state.builds };
      if (url.includes("/knowledge/builds/")) return { build: state.build };
      if (url.endsWith("/knowledge/references")) return state.references;
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
  state.builds = [];
  state.build = null;
  state.buildDiff = null;
  state.references = null;
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

// ---------------------------------------------------------------- 知识条款（A6）

/** 一版知识：两条款、两条知识项，其中第二条的原文位置落在空行上（故意留个对不上的）。 */
const buildFixture = (over: Record<string, unknown> = {}) => ({
  buildId: "kb_1",
  version: 2,
  contentHash: "sha256:ffff0000aaaa1111",
  items: [
    {
      id: "s01-c0002",
      type: "rule",
      name: "登录锁定",
      statement: "连续五次失败后账户锁定十五分钟。",
      source: { file: "doc-1", line: 2 },
      section: "登录 > 锁定",
      tags: ["安全"],
      fingerprint: "fp-0001",
    },
    {
      id: "s01-c0004",
      type: "constraint",
      name: "锁定期内不可自助解锁",
      statement: "锁定期内不允许自助解锁。",
      source: { file: "doc-1", line: 3 },
      section: "登录 > 解锁",
      tags: [],
      fingerprint: "fp-0002",
    },
  ],
  clauses: [
    {
      clause_id: "s01-c0001",
      section_path: "登录 > 锁定",
      text: "## 登录\n连续五次失败后账户锁定十五分钟。",
      location: { file: "doc-1", line: 1 },
    },
  ],
  stats: { items: 2, by_type: { rule: 1, constraint: 1 }, dropped: 1, duplicates: 0 },
  sources: [{ documentId: "doc-1", revision: 2, title: "登录要求", file: "doc-1" }],
  meta: {
    actor: "user:owner-1",
    semanticHash: "sha256:99998888",
    dropped: [{ reason: "no_location" }],
    duplicates: [],
  },
  createdAt: "2026-11-03T00:00:00Z",
  createdBy: "owner-1",
  ...over,
});

/** 列表接口只回摘要：正文不随列表下发。 */
const summaryOf = (view: ReturnType<typeof buildFixture>) => {
  const { items: _items, clauses: _clauses, meta: _meta, ...rest } = view;
  return rest;
};

async function openClauses() {
  await mount(h(ProjectKnowledgePage));
  await click(button("知识条款"));
}

it("shows each knowledge item with the clause lines it came from, and says when a line does not line up", async () => {
  state.builds = [summaryOf(buildFixture()), summaryOf(buildFixture({ version: 1, buildId: "kb_0" }))];
  state.build = buildFixture();
  await openClauses();

  // 默认停在最新版，并且只为它拉一次详情。
  await waitFor(() => (document.body.textContent ?? "").includes("知识版本 v2"));
  await waitFor(() => (document.body.textContent ?? "").includes("连续五次失败后账户锁定十五分钟。"));
  expect(state.calls.some((call) => call.url.endsWith("/knowledge/builds/2"))).toBe(true);
  expect(state.calls.some((call) => call.url.endsWith("/knowledge/builds/1"))).toBe(false);

  // 被丢弃的知识项要计数，且说清为什么丢。
  expect(document.body.textContent).toContain("1 条知识项没有原文位置，已丢弃");

  const clauseButtons = [...document.querySelectorAll("button")].filter(
    (entry) => entry.textContent?.trim() === "看原文",
  ) as HTMLButtonElement[];
  expect(clauseButtons).toHaveLength(2);

  await click(clauseButtons[0]!);
  await waitFor(() => (document.body.textContent ?? "").includes("所属章节"));
  // 展开后是整段条款原文，行号与高亮行都来自条款自己，而不是知识项自报的行号。
  expect(document.body.textContent).toContain("## 登录");
  expect(document.body.textContent).toContain("登录 > 锁定");

  await click(clauseButtons[1]!);
  await waitFor(() => (document.body.textContent ?? "").includes("原文位置待核"));
  expect(document.body.textContent).toContain("未核实");
});

it("compares two versions and reports a wording-only change as not triggering a recompute", async () => {
  state.builds = [summaryOf(buildFixture()), summaryOf(buildFixture({ version: 1, buildId: "kb_0" }))];
  state.build = buildFixture();
  state.buildDiff = {
    from: 1,
    to: 2,
    diff: {
      stats: { semanticChanged: 1, wordingOnly: 1, renamed: 0, added: 0, removed: 0 },
      triggersRecompute: true,
      semanticChanged: [
        {
          id: "s01-c0002",
          type: "rule",
          old_statement: "连续五次失败后账户锁定十分钟。",
          new_statement: "连续五次失败后账户锁定十五分钟。",
          change_ratio: 0.82,
        },
      ],
      wordingOnly: [
        {
          id: "s01-c0004",
          fingerprint: "fp-0002",
          old_statement: "锁定期内不允许自助解锁",
          new_statement: "锁定期内不允许自助解锁。",
        },
      ],
      renamed: [],
      added: [],
      removed: [],
    },
  };
  await openClauses();
  await waitFor(() => hasButton("与 v1 对比"));
  await click(button("与 v1 对比"));

  await waitFor(() => (document.body.textContent ?? "").includes("知识版本对比 v1 → v2"));
  // 对比是打开弹窗后才去算的：标题先出来，四类结果随后到。
  await waitFor(() => (document.body.textContent ?? "").includes("语义变更 1"));
  expect(document.body.textContent).toContain("需要重算");
  expect(document.body.textContent).toContain("锁定十分钟。");
  expect(document.body.textContent).toContain("指纹未变，不触发重算");
  expect(document.body.textContent).toContain("需要重算");

  // 对比的基线走 query 参数：默认就是"上一版"。
  const call = state.calls.find((entry) => entry.url.includes("/knowledge/builds/2/diff"));
  expect(call?.query).toEqual({ from: "1" });
});

it("does not offer a comparison for the first version", async () => {
  state.builds = [summaryOf(buildFixture({ version: 1, buildId: "kb_0" }))];
  state.build = buildFixture({ version: 1, buildId: "kb_0" });
  await openClauses();
  await waitFor(() => hasButton("与 v0 对比"));
  const compare = button("与 v0 对比");
  expect(compare.disabled).toBe(true);
});

it("looks up which knowledge a pasted text refers to", async () => {
  state.builds = [summaryOf(buildFixture())];
  state.build = buildFixture();
  state.references = {
    version: 2,
    hits: [
      {
        knowledgeId: "s01-c0002",
        type: "rule",
        name: "登录锁定",
        priority: 5,
        source: { file: "doc-1", line: 2 },
      },
    ],
  };
  await openClauses();
  await waitFor(() => hasButton("引用反查"));
  await click(button("引用反查"));
  await waitFor(() => hasButton("开始反查"));
  await type(field("反查文本"), "连续五次登录失败后账户锁定多久？");
  await click(button("开始反查"));

  await waitFor(() => (document.body.textContent ?? "").includes("命中 1 条"));
  const post = state.calls.find((call) => call.url.endsWith("/knowledge/references"));
  expect(post?.method).toBe("POST");
  expect(post?.body).toEqual({ text: "连续五次登录失败后账户锁定多久？" });
  expect(document.body.textContent).toContain("登录锁定");
  expect(document.body.textContent).toContain("原文第 2 行");
});

it("says a project without any knowledge version cannot be looked up, instead of reporting no hits", async () => {
  state.builds = [];
  state.build = null;
  state.references = { version: 0, hits: [] };
  // 空版本时工具条上的反查按钮是禁用的：没有版本就没有可反查的对象。
  await openClauses();
  await waitFor(() => (document.body.textContent ?? "").includes("还没有知识版本"));
  const lookup = button("引用反查");
  expect(lookup.disabled).toBe(true);
  expect(document.body.textContent).toContain("只会产出一版空知识");
});
