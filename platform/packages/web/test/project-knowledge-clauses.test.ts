/**
 * A6 的读侧词汇：原文位置怎么落到具体条款、四分类对账怎么变成人看的一行、以及
 * 装配降级为什么必须一眼认出来。
 *
 * 这些函数决定"证据看起来是否可信"，所以边界（找不到条款、没有版本、降级装配器）
 * 都要有确定的答案，而不是回退成某种看起来正常的展示。
 */
import { describe, expect, it } from "vitest";
import {
  assemblerLabel,
  buildSummaryLine,
  clauseAt,
  diffEntries,
  diffVerdictLine,
  dropReasonLabel,
  knowledgeErrorHint,
  knowledgeTypeLabel,
  type ClauseView,
  type KnowledgeBuildView,
  type KnowledgeDiffView,
} from "../src/features/qa/project-knowledge-model";

const clauses: ClauseView[] = [
  {
    clause_id: "s01-c0001",
    section_path: "登录 > 锁定",
    text: "## 登录\n连续五次失败后账户锁定十五分钟。",
    location: { file: "doc-a", line: 1 },
  },
  {
    clause_id: "s01-c0002",
    section_path: "登录 > 解锁",
    text: "锁定期内不允许自助解锁。",
    location: { file: "doc-a", line: 4 },
  },
  {
    clause_id: "s02-c0001",
    section_path: "退款",
    text: "单笔退款不超过 500 元。",
    location: { file: "doc-b", line: 1 },
  },
];

describe("clauseAt", () => {
  it("finds the clause that contains the line and says which line inside it", () => {
    const found = clauseAt(clauses, "doc-a", 2);
    expect(found?.clause.clause_id).toBe("s01-c0001");
    expect(found?.relativeLine).toBe(1);
    expect(found?.lines[found.relativeLine]).toBe("连续五次失败后账户锁定十五分钟。");
  });

  it("does not confuse the same line number in another document", () => {
    // 两份资料都从第 1 行起：只按行号匹配会把 doc-b 的规则指到 doc-a 的条款上。
    expect(clauseAt(clauses, "doc-b", 1)?.clause.clause_id).toBe("s02-c0001");
    expect(clauseAt(clauses, "doc-a", 1)?.clause.clause_id).toBe("s01-c0001");
  });

  it("returns null rather than the nearest clause when the line is not covered", () => {
    // 空行不属于任何条款；位置落在空行上时也算"对不上"，不许回退到上一段。
    expect(clauseAt(clauses, "doc-a", 3)).toBeNull();
    expect(clauseAt(clauses, "doc-a", 9)).toBeNull();
    expect(clauseAt(clauses, "doc-c", 1)).toBeNull();
  });
});

describe("buildSummaryLine", () => {
  it("mentions dropped and merged counts only when they are non-zero", () => {
    const base = { sources: [{ documentId: "d1", revision: 1, title: "资料", file: "d1" }] };
    expect(buildSummaryLine({ ...base, stats: { items: 3, by_type: {}, dropped: 0, duplicates: 0 } })).toBe(
      "3 条知识 · 1 份资料",
    );
    expect(buildSummaryLine({ ...base, stats: { items: 3, by_type: {}, dropped: 2, duplicates: 1 } })).toBe(
      "3 条知识 · 1 份资料 · 丢弃 2 条（无原文位置） · 合并重复 1 条",
    );
  });
});

describe("diffVerdictLine", () => {
  const empty: KnowledgeDiffView = {
    stats: {},
    triggersRecompute: false,
    semanticChanged: [],
    wordingOnly: [],
    renamed: [],
    added: [],
    removed: [],
  };

  it("says wording-only changes do not trigger a recompute", () => {
    const diff = { ...empty, wordingOnly: [{ id: "k1" }] };
    expect(diffVerdictLine(diff)).toContain("仅措辞 1");
    expect(diffVerdictLine(diff)).toContain("不触发重算");
  });

  it("says a semantic change does", () => {
    const diff = { ...empty, semanticChanged: [{ id: "k1" }, { id: "k2" }], triggersRecompute: true };
    expect(diffVerdictLine(diff)).toContain("语义变更 2");
    expect(diffVerdictLine(diff)).toContain("需要重算");
  });
});

describe("diffEntries", () => {
  const diff: KnowledgeDiffView = {
    stats: {},
    triggersRecompute: true,
    semanticChanged: [
      { id: "k1", type: "rule", old_statement: "锁定十分钟。", new_statement: "锁定十五分钟。", change_ratio: 0.82 },
    ],
    wordingOnly: [{ id: "k2", fingerprint: "fp", old_statement: "不超过 500 元", new_statement: "不超过500元。" }],
    renamed: [{ old_id: "k3", new_id: "k33", similarity: 0.94, note: "内容基本一致" }],
    added: [{ id: "k4", name: "退款上限", statement: "单笔退款不超过 500 元。" }],
    removed: [{ id: "k5", name: "旧规则", statement: "退款一律人工审核。" }],
  };

  it("normalizes each class's own field names into before/after", () => {
    expect(diffEntries(diff, "semanticChanged")[0]).toEqual({
      id: "k1",
      before: "锁定十分钟。",
      after: "锁定十五分钟。",
      note: "相似度 82%",
    });
    expect(diffEntries(diff, "removed")[0]).toEqual({
      id: "k5",
      before: "退款一律人工审核。",
      after: undefined,
      note: "旧规则",
    });
  });

  it("shows a rename as old → new instead of two unrelated ids", () => {
    expect(diffEntries(diff, "renamed")[0]?.id).toBe("k3 → k33");
    expect(diffEntries(diff, "renamed")[0]?.note).toBe("内容基本一致");
  });

  it("keeps a missing class empty rather than throwing", () => {
    expect(diffEntries({ ...diff, added: undefined as unknown as unknown[] }, "added")).toEqual([]);
  });
});

describe("装配账目与降级", () => {
  it("labels the degraded assembler so it cannot pass for a normal assembly", () => {
    expect(assemblerLabel("python:context.assemble")).toBe("python:context.assemble");
    expect(assemblerLabel("fallback:index_only")).toBe("降级：index_only");
    expect(assemblerLabel(undefined)).toBe("未知装配器");
  });

  it("translates the drop reasons a person has to act on", () => {
    expect(dropReasonLabel("over_budget")).toBe("超出 token 预算");
    expect(dropReasonLabel("duplicate_fingerprint")).toBe("与已装项语义重复");
    expect(dropReasonLabel("assembler_unavailable: boom")).toBe("装配器不可用：boom");
  });

  it("shows an unknown reason verbatim instead of guessing a nicer one", () => {
    expect(dropReasonLabel("quota_exhausted: tier-2")).toBe("quota_exhausted: tier-2");
  });
});

describe("knowledgeTypeLabel / knowledgeErrorHint", () => {
  it("names the closed knowledge types and passes unknown ones through", () => {
    expect(knowledgeTypeLabel("rule")).toBe("业务规则");
    expect(knowledgeTypeLabel("constraint")).toBe("约束");
    expect(knowledgeTypeLabel("custom")).toBe("custom");
  });

  it("explains the build refusals without hiding them behind a generic failure", () => {
    expect(knowledgeErrorHint("knowledge_engine_unavailable")).toContain("引擎未就绪");
    expect(knowledgeErrorHint("knowledge_diff_same_version")).toContain("两个不同版本");
    expect(knowledgeErrorHint("knowledge_build_not_found")).toContain("刷新版本列表");
    expect(knowledgeErrorHint("knowledge_too_large")).toContain("200");
  });
});
