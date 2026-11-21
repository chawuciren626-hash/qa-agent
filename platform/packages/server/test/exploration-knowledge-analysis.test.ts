import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { UtilityCompletion } from "../src/mechanisms/projects.js";
import {
  buildKnowledgeAnalysisPrompt,
  explorationKnowledgeAnalysis,
  type KnowledgeAnalysisInput,
} from "../src/services/exploration-knowledge-analysis.js";

const baseInput: KnowledgeAnalysisInput = {
  projectId: "p1",
  env: "test",
  round: 5,
  targetUrl: "https://www.saucedemo.com/",
  layers: [
    { layer: "module", entries: [{ key: "/inventory.html", summary: "已渲染 · 24 控件" }] },
    { layer: "wall", entries: [{ key: "login-required", summary: "业务页需登录" }] },
  ],
  evidence: {
    observations: [
      { page: "/inventory.html", kind: "price", verbatim: "$29.99", context: "Sauce Labs Backpack" },
      { page: "/", kind: "field_label", verbatim: "Username" },
    ],
    rules: [{ statement: "「Sauce Labs Backpack」定价 $29.99（当前版本实测）", verification: "verified" }],
  },
  openHypotheses: [{ statement: "登录会话可访问的页面与可执行操作范围未确认", expectation: null }],
  limitations: ["登录成功只证明本次凭据被接受，不证明权限范围或业务可用。"],
};

type Row = { current_revision: number; content_hash: string; status: string };
function fakeDb(row: Row | undefined) {
  return { prepare: () => ({ get: () => row }) } as never;
}
function makeStore() {
  return {
    createDocument: vi.fn(() => ({ document: { currentRevision: 1 } })),
    updateDocument: vi.fn(() => ({ document: { currentRevision: 7 } })),
  };
}

describe("buildKnowledgeAnalysisPrompt", () => {
  it("包含事实、纪律与封顶——不得编造、推断单列、未见证据", () => {
    const prompt = buildKnowledgeAnalysisPrompt(baseInput, "test");
    expect(prompt).toContain("# 项目知识文档（环境 test）");
    expect(prompt).toContain("/inventory.html：已渲染 · 24 控件");
    expect(prompt).toContain("[/inventory.html] price: $29.99（Sauce Labs Backpack）");
    expect(prompt).toContain("不得编造或补全");
    expect(prompt).toContain("[推断]");
    expect(prompt).toContain("未见证据");
    expect(prompt).toContain("「Sauce Labs Backpack」定价 $29.99");
    expect(prompt).toContain("待确认未知");
    expect(prompt).toContain("采集局限");
  });
});

describe("explorationKnowledgeAnalysis", () => {
  it("补全成功时以固定 documentId 落文档，正文带诚实头与模型输出", async () => {
    const store = makeStore();
    const analysis = explorationKnowledgeAnalysis({
      db: fakeDb(undefined),
      completeOnce: vi.fn(async (): Promise<UtilityCompletion> => ({ ok: true, text: "# 项目知识文档（环境 test）\n\n## 一、系统概览\n\n演示站点。" })),
      store: store as never,
    });
    const result = await analysis(baseInput);
    expect(result.skipped).toBeUndefined();
    expect(result.revision).toBe(1);
    expect(store.createDocument).toHaveBeenCalled();
    const arg = (store.createDocument.mock.calls[0] as unknown[])[0] as { internalDocumentId: string; content: string; changeNote: string };
    // 确定性 id 按项目隔离：base + 项目指纹 8 位（同环境名的两个项目不再撞全局主键）。
    expect(arg.internalDocumentId).toBe(`doc-project-knowledge-test-${createHash("sha256").update("p1").digest("hex").slice(0, 8)}`);
    expect(arg.content).toContain("[verified]=探索直接证实");
    expect(arg.content).toContain("## 一、系统概览");
    expect(arg.changeNote).toContain("探索第 5 轮");
  });

  it("内容未变时不制造修订；已归档时跳过并如实标注", async () => {
    const store = makeStore();
    const row: Row = { current_revision: 6, content_hash: "", status: "active" };
    const analysis = explorationKnowledgeAnalysis({
      db: fakeDb(row),
      completeOnce: vi.fn(async (): Promise<UtilityCompletion> => ({ ok: true, text: "同样的输出" })),
      store: store as never,
    });
    // 行已存在且 hash 为空 → 第一次走修订，捕获落盘内容反算 hash
    const first = await analysis(baseInput);
    expect(first.revision).toBe(7);
    expect(store.updateDocument).toHaveBeenCalled();
    const landed = (store.updateDocument.mock.calls[0] as unknown[])[0] as { content: string };
    row.content_hash = `sha256:${createHash("sha256").update(landed.content).digest("hex")}`;
    const unchanged = await analysis(baseInput);
    expect(unchanged.revision).toBe(6);
    expect(store.updateDocument).toHaveBeenCalledTimes(1);

    row.status = "archived";
    const archived = await analysis(baseInput);
    expect(archived.skipped).toBe("archived");
    expect(store.updateDocument).toHaveBeenCalledTimes(1);
  });

  it("项目未配置默认模型 → skipped=no_model，不落文档；模型失败 → error 不抛", async () => {
    const store = makeStore();
    const analysis = explorationKnowledgeAnalysis({
      db: fakeDb(undefined),
      completeOnce: vi.fn(async (): Promise<UtilityCompletion> => ({ ok: false, cause: "no_model", error: "the Project names no default model" })),
      store: store as never,
    });
    const result = await analysis(baseInput);
    expect(result.skipped).toBe("no_model");
    expect(store.createDocument).not.toHaveBeenCalled();

    const failing = explorationKnowledgeAnalysis({
      db: fakeDb(undefined),
      completeOnce: vi.fn(async (): Promise<UtilityCompletion> => ({ ok: false, cause: "failed", error: "upstream 500" })),
      store: store as never,
    });
    const failed = await failing(baseInput);
    expect(failed.skipped).toBe("failed");
    expect(failed.error).toContain("upstream 500");
    expect(store.createDocument).not.toHaveBeenCalled();
  });

  it("completeOnce 抛异常不外溢：error 结果，探索不受影响", async () => {
    const analysis = explorationKnowledgeAnalysis({
      db: fakeDb(undefined),
      completeOnce: vi.fn(async () => { throw new Error("channel boom"); }),
      store: makeStore() as never,
    });
    const result = await analysis(baseInput);
    expect(result.revision).toBeNull();
    expect(result.error).toContain("channel boom");
  });
});
