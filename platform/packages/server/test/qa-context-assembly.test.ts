/**
 * A5 上下文装配：把"每轮全量灌资料库"换成"按预算裁剪 + 记账"。
 *
 * 这里钉的是三件事，都是"看起来在省 token、其实没有"的典型失败形态：
 *   1. 送进装配器的知识项必须带 `id` 与 `_build_meta.version`——字段名一错，
 *      装配器照跑不误，只是 lineage 里的版本永远是 null，事后说不清基于哪版知识判的；
 *   2. 超预算的项必须出现在 dropped 里并带原因——静默丢弃等于假装预算生效；
 *   3. 装配器不可用时只给索引，正文一个字都不进，且账目标成 fallback。
 */
import { describe, expect, it } from "vitest";
import {
  assemblePromptContext, indexOnlyContext,
  type AssembleInput,
} from "../src/services/qa-context-assembly.js";
import type { QaProjectKnowledgeStore, SnapshotDocumentPin, SnapshotRulePin } from "../src/services/qa-project-knowledge.js";

const rulePin: SnapshotRulePin = { ruleId: "rule-1", version: 3, title: "锁定时长", contentHash: "h-rule" };
const docPin: SnapshotDocumentPin = {
  documentId: "doc-1", revision: 2, revisionId: "rev-1", title: "登录要求", contentHash: "h-doc",
};

function fakeStore(statements: Record<string, string> = { "rule-1": "锁定三十分钟。" }) {
  return {
    listRuleVersions: (_projectId: string, ruleId: string) => Object.entries(statements)
      .filter(([id]) => id === ruleId)
      .map(([, statement], index) => ({ ruleId, version: index + 3, statement })),
    getRevision: () => ({ content: "原文：连续五次失败锁定十五分钟。", title: "登录要求" }),
  } as unknown as QaProjectKnowledgeStore;
}

const baseInput = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  db: {} as AssembleInput["db"],
  store: fakeStore(),
  projectId: "p", sessionId: "s", agentId: "a", snapshotId: "snap-1",
  snapshot: { documents: [docPin], rules: [rulePin] },
  requestText: "检查登录要求",
  knowledgeVersion: 7,
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  context: { knowledge: ["[rule]锁定时长：锁定三十分钟。"], extra: ["<project_material trust=\"untrusted_data\">"] },
  context_refs: { knowledge: { loaded: 1, total: 1, version: 7 }, tokens_est: 40 },
  dropped: [] as unknown[],
  tokens_est: 40,
  budget: 8000,
  statement: "装载知识 1/1 条",
  ...over,
});

describe("A5 context assembly", () => {
  it("feeds the assembler with addressable knowledge items and untrusted document bodies", async () => {
    let payload: Record<string, any> | null = null;
    const result = await assemblePromptContext(baseInput({
      run: async (_tool, body) => { payload = body as Record<string, any>; return envelope(); },
    }));

    const body = payload! as Record<string, any>;
    const items = body.knowledge.items as { id: string; type: string; fingerprint: string }[];
    expect(items).toHaveLength(1);
    const [rule] = items;
    expect(rule!.id).toBe("rule-1");
    expect(rule!.type).toBe("rule");
    expect(rule!.fingerprint).toHaveLength(16);
    // 版本写在 `_build_meta` 里：装配器只认这个位置，写在顶层等于没写。
    expect((body.knowledge as { _build_meta: { version: number } })._build_meta.version).toBe(7);
    expect(body.budget_tokens).toBe(8000);
    // 资料正文必须仍以不可信材料的形式进入，指令边界不能被"改成纯文本"省掉。
    const extra = body.extra as { kind: string; text: string; priority: number }[];
    expect(extra).toHaveLength(1);
    const [document] = extra;
    expect(document!.kind).toBe("doc");
    expect(document!.priority).toBe(50);
    expect(document!.text).toContain("BEGIN UNTRUSTED MATERIAL");
    expect(document!.text).toContain("连续五次失败锁定十五分钟");

    expect(result.ledger.assembler).toBe("python:context.assemble");
    expect(result.ledger.budgetTokens).toBe(8000);
    expect(result.ledger.loaded).toEqual({ knowledge: { loaded: 1, total: 1, version: 7 }, documents: 1, rules: 1 });
    expect(result.lines.join("\n")).toContain("已确认规则（装配 1/1 条）");

    // 预算地板价：200 以下等于没给上下文，别让人以为"预算真的生效了"。
    let floored = 0;
    await assemblePromptContext(baseInput({
      budgetTokens: 50,
      run: async (_tool, body) => { floored = (body as { budget_tokens: number }).budget_tokens; return envelope({ budget: 200 }); },
    }));
    expect(floored).toBe(200);
  });

  it("surfaces every cut item with a reason instead of dropping it silently", async () => {
    const dropped = [
      { kind: "kb:rule", ref: { id: "rule-9" }, tokens: 120, reason: "budget_exceeded" },
      { kind: "doc", ref: { documentId: "doc-1" }, tokens: 900, reason: "budget_exceeded" },
    ];
    const result = await assemblePromptContext(baseInput({
      run: async () => envelope({ dropped, tokens_est: 8000 }),
    }));
    expect(result.ledger.dropped).toHaveLength(2);
    expect(result.ledger.dropped.every(item => item.reason === "budget_exceeded")).toBe(true);
    expect(result.lines.join("\n")).toContain("本次因预算裁剪 2 项");
  });

  it("degrades to an index-only context, never to an unbudgeted full dump", () => {
    const input = baseInput();
    const fallback = indexOnlyContext(input, new Error("python not found"));
    const text = fallback.lines.join("\n");

    expect(fallback.ledger.assembler).toBe("fallback:index_only");
    expect(text).toContain("登录要求");                    // 索引还在，模型知道有这么份资料
    expect(text).not.toContain("连续五次失败锁定十五分钟");  // 正文一个字都不进
    expect(text).not.toContain("锁定三十分钟。");           // 规则条文也不进
    expect(text).toContain("不要把未读取的条文与正文写成已核实依据");
    // 整批都要在账上：装配不可用不是"什么都没发生"。
    expect(fallback.ledger.dropped).toHaveLength(2);
    for (const item of fallback.ledger.dropped) expect(item.reason).toContain("assembler_unavailable");
    expect(fallback.ledger.loaded.knowledge.loaded).toBe(0);
    expect(fallback.ledger.loaded.knowledge.total).toBe(1);
  });
});

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("A5 context assembly against the real engine", () => {
  it("cuts by budget and keeps the accounting closed", async () => {
    // 预算 200（装配器的地板价：再小就什么都装不下，等于没给上下文）。
    // 规则每条约 80 token，5 条加一份文档一定超，只为验证裁剪账目闭合。
    const statements = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`rule-${index}`, `${"锁定".repeat(40)}第${index}条。`]),
    );
    const pins = Object.keys(statements).map((ruleId): SnapshotRulePin => ({ ruleId, version: 3, title: ruleId, contentHash: `h-${ruleId}` }));
    const result = await assemblePromptContext(baseInput({
      store: fakeStore(statements),
      snapshot: { documents: [docPin], rules: pins },
      budgetTokens: 200,
      knowledgeVersion: 7,
      engineRoot: process.env.AITEST_ENGINE_ROOT,
    }));

    expect(result.ledger.budgetTokens).toBe(200);
    expect(result.ledger.tokensEst).toBeLessThanOrEqual(200);
    expect(result.ledger.dropped.length).toBeGreaterThan(0);
    for (const item of result.ledger.dropped) {
      expect(item.reason).toBe("budget_exceeded");
      expect(item.kind).toBeTruthy();
      expect(item.tokens).toBeGreaterThan(0);
    }
    // 装载 + 裁剪 = 全部候选：不许有项在两边都不出现。
    const cutKnowledge = result.ledger.dropped.filter(item => item.kind.startsWith("kb:")).length;
    expect(result.ledger.loaded.knowledge.loaded + cutKnowledge).toBe(pins.length);
  });
});
