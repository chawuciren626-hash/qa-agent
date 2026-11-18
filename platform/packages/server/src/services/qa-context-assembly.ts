/**
 * A5：把"每轮把资料库全量灌给模型"换成按预算装配 + 记账。
 *
 * 现状（改造前）：按标题相似度挑 3 篇整篇塞进去（每篇截到 12000 字符），规则最多 100 条
 * （每条截 1000 字符），既没有总预算，也不记录到底装了什么、裁了什么。代价是三重的：
 * token 随资料库线性增长、长上下文中段被忽略、事后无法解释"这次为什么这么判"。
 *
 * 现在：知识项与资料都交给 `context.assemble` 统一装配——按 scope 切片、按优先级裁剪、
 * 额度用尽就停，并把 loaded/dropped/budget 记账。**被裁掉的项一定出现在 dropped 里**，
 * 不允许静默消失；账目落到 `qa_context_ledger`，可在页面上对账。
 */
import { createHash, randomUUID } from "node:crypto";
import { qaEnabled } from "./qa-engine.js";
import { knowledgeToolRunner, type ToolRunner } from "./qa-knowledge-tool.js";
import type { KnowledgeDb, QaProjectKnowledgeStore, SnapshotDocumentPin, SnapshotRulePin } from "./qa-project-knowledge.js";
import { renderUntrustedMaterial } from "./qa-knowledge-untrusted.js";

/** 单次装配默认预算。中文按 1 字 ≈ 1 token 保守估。 */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 8000;
/** 单篇资料进入装配的上限：整篇灌进去会把预算一次吃光。 */
const DOCUMENT_CHAR_CAP = 6000;
/** 资料最多进几篇（装配器的预算裁剪在它们之间再二次分配）。 */
const DOCUMENT_CANDIDATES = 3;

export interface ContextLedger {
  version: 1;
  ledgerId: string;
  budgetTokens: number;
  tokensEst: number;
  /** 账目主体：装了什么、裁了什么、来自哪个装配器。 */
  loaded: { knowledge: { loaded: number; total: number; version: number | null }; documents: number; rules: number };
  dropped: { kind: string; ref: unknown; tokens: number; reason: string }[];
  assembler: string;
  statement: string;
}

export interface AssembledContext {
  lines: string[];
  ledger: ContextLedger;
}

export interface AssembleInput {
  db: KnowledgeDb;
  store: QaProjectKnowledgeStore;
  projectId: string;
  sessionId: string;
  agentId: string;
  snapshotId: string;
  snapshot: { documents: SnapshotDocumentPin[]; rules: SnapshotRulePin[] };
  requestText: string;
  /** 注入执行器（测试用）。不给则按 engineRoot 起 python 子进程。 */
  run?: ToolRunner;
  engineRoot?: string;
  budgetTokens?: number;
  /**
   * 知识构建版本（`knowledge.extract` 产出的 `_build_meta.version`）。
   * 没有就是 null——装配器据此在 lineage 里记"这轮基于哪版知识"；不许拿快照版本冒充。
   */
  knowledgeVersion?: number | null;
}

function matchScore(title: string, request: string): number {
  const lowered = title.toLowerCase();
  const query = request.toLowerCase();
  if (lowered && query.includes(lowered)) return 100;
  return lowered.split(/[\s\-_、，。]+/).filter(part => part.length > 1 && query.includes(part)).length;
}

/** 与 Python 侧 `est_tokens` 同口径：中文 1 字 1 token，其余按 4 字符 1 token 向上取整。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
  }
  const other = [...text].length - cjk;
  return cjk + Math.ceil(other / 4);
}

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * 装配一次上下文。返回可直接拼进 prompt 的分节文本 + 账目。
 *
 * 没有 engine 时**不装配**：宁可让调用方看到明确错误，也不退回"全量灌"——
 * 那会让人以为预算机制在工作，其实一切照旧。
 */
export async function assemblePromptContext(input: AssembleInput): Promise<AssembledContext> {
  const budget = Math.max(200, input.budgetTokens ?? (Number(process.env.QA_CONTEXT_BUDGET_TOKENS) || DEFAULT_CONTEXT_BUDGET_TOKENS));
  const rules: { id: string; type: string; name: string; statement: string; tags: string[]; fingerprint: string }[] = [];
  for (const pin of input.snapshot.rules) {
    const version = input.store.listRuleVersions(input.projectId, pin.ruleId).find(item => item.version === pin.version);
    if (!version) continue;   // 版本对不上就不装：装错的规则比不装更危险
    rules.push({
      id: pin.ruleId,
      type: "rule",
      name: pin.title,
      statement: version.statement,
      tags: [],
      fingerprint: fingerprint(`${pin.ruleId}|${pin.version}|${version.statement}`),
    });
  }

  // 相关资料按标题相关度排序后进入装配；正文仍按不可信材料渲染，指令边界不变。
  const relevant = [...input.snapshot.documents]
    .sort((a, b) => matchScore(b.title, input.requestText) - matchScore(a.title, input.requestText))
    .slice(0, DOCUMENT_CANDIDATES);
  const extras = relevant.flatMap(pin => {
    const revision = input.store.getRevision(input.projectId, pin.documentId, pin.revision);
    if (!revision) return [];
    const text = renderUntrustedMaterial({
      documentId: pin.documentId,
      revision: pin.revision,
      contentHash: pin.contentHash,
      title: pin.title,
      content: revision.content.slice(0, DOCUMENT_CHAR_CAP),
    });
    return [{ kind: "doc", priority: 50, text, ref: { documentId: pin.documentId, revision: pin.revision } }];
  });

  const run = input.run ?? ((): ToolRunner => {
    if (!input.engineRoot || !qaEnabled) {
      throw new Error("上下文装配需要 AITEST_ENGINE_ROOT（否则只能退回全量注入，已拒绝）");
    }
    return knowledgeToolRunner({ engineRoot: input.engineRoot });
  })();

  const assembled = (await run("context.assemble", {
    scope: { pages: [], apis: [], modules: [], keywords: [] },
    // 装配器从 `_build_meta.version` 读知识版本（写进 context_refs），字段名不能改。
    knowledge: { _build_meta: { version: input.knowledgeVersion ?? null }, content_hash: null, items: rules },
    maps: {},
    budget_tokens: budget,
    extra: extras,
  })) as {
    context: Record<string, string[]>;
    context_refs: { knowledge: { loaded: number; total: number; version: number | null }; tokens_est: number };
    dropped: { kind: string; ref: unknown; tokens: number; reason: string }[];
    tokens_est: number;
    budget: number;
    statement: string;
  };

  const lines: string[] = [];
  if (input.snapshot.documents.length) {
    lines.push(`项目资料索引（${input.snapshot.documents.length} 项）：`);
    lines.push(...input.snapshot.documents.map(doc => `- ${doc.title}；资料 ${doc.documentId} 修订 ${doc.revision}`));
  }
  if (assembled.context.knowledge?.length) {
    lines.push(`已确认规则（装配 ${assembled.context_refs.knowledge.loaded}/${assembled.context_refs.knowledge.total} 条）：`);
    lines.push(...assembled.context.knowledge);
  }
  if (assembled.context.extra?.length) lines.push(...assembled.context.extra);
  if (assembled.dropped.length) {
    // 裁掉什么要让人看见：否则"预算在生效"这件事永远无法被验证。
    lines.push(`本次因预算裁剪 ${assembled.dropped.length} 项（${assembled.dropped.map(item => item.kind).join("、")}）：其余资料与规则请在项目资料中按需查看，不要把未读取的内容写成已核实依据。`);
  }

  const ledger: ContextLedger = {
    version: 1,
    ledgerId: randomUUID(),
    budgetTokens: assembled.budget,
    tokensEst: assembled.tokens_est,
    loaded: {
      knowledge: assembled.context_refs.knowledge,
      documents: assembled.context.extra?.length ?? 0,
      rules: rules.length,
    },
    dropped: assembled.dropped,
    assembler: "python:context.assemble",
    statement: assembled.statement,
  };
  return { lines, ledger };
}

/** 账目落库：append-only，一次装配一条，供页面与事后复盘对账。 */
export function recordContextLedger(db: KnowledgeDb, projectId: string, sessionId: string, snapshotId: string, ledger: ContextLedger): void {
  db.prepare(
    `INSERT INTO qa_context_ledger (ledger_id, snapshot_id, project_id, session_id, budget_tokens, tokens_est, loaded_json, dropped_json, assembler, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ledger.ledgerId, snapshotId, projectId, sessionId, ledger.budgetTokens, ledger.tokensEst,
    JSON.stringify(ledger.loaded), JSON.stringify(ledger.dropped), ledger.assembler, new Date().toISOString(),
  );
}

/** 读某个会话最近一次装配账目（页面用）。 */
export function latestContextLedger(db: KnowledgeDb, projectId: string, sessionId: string): ContextLedger | null {
  const row = db.prepare(
    "SELECT * FROM qa_context_ledger WHERE project_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1",
  ).get(projectId, sessionId) as { ledger_id: string; snapshot_id: string; budget_tokens: number; tokens_est: number; loaded_json: string; dropped_json: string; assembler: string } | undefined;
  if (!row) return null;
  const loaded = JSON.parse(row.loaded_json) as ContextLedger["loaded"];
  return {
    version: 1,
    ledgerId: row.ledger_id,
    budgetTokens: row.budget_tokens,
    tokensEst: row.tokens_est,
    loaded,
    dropped: JSON.parse(row.dropped_json) as ContextLedger["dropped"],
    assembler: row.assembler,
    statement: `装载知识 ${loaded.knowledge.loaded}/${loaded.knowledge.total} 条、资料 ${loaded.documents} 篇，${row.tokens_est}/${row.budget_tokens} tokens`,
  };
}

/**
 * 装配失败时**只给索引**，不给正文。
 *
 * 为什么不直接让整次派单失败：资料库坏了不该连带把"发一句话"也堵死；
 * 为什么不退回全量注入：那会让"预算在生效"变成一句没人能验证的话，
 * 而且恰恰在装配器不可用时把最贵的路径打开。
 *
 * 所以退化路径必须同时满足三点：正文一个字都不进、每一条被裁项都进 `dropped`、
 * 账目里 `assembler` 明确写成 fallback。模型看得到"本次只有索引，别把没读到的写成已核实"。
 */
export function indexOnlyContext(input: AssembleInput, error: unknown): AssembledContext {
  const reason = `assembler_unavailable: ${error instanceof Error ? error.message : String(error)}`;
  const dropped: ContextLedger["dropped"] = [
    ...input.snapshot.rules.map(pin => ({
      kind: "kb:rule", ref: { id: pin.ruleId, version: pin.version }, tokens: 0, reason,
    })),
    ...input.snapshot.documents.map(pin => ({
      kind: "doc", ref: { documentId: pin.documentId, revision: pin.revision }, tokens: 0, reason,
    })),
  ];
  const lines: string[] = [];
  if (input.snapshot.documents.length) {
    lines.push(`项目资料索引（${input.snapshot.documents.length} 项，本次未装载正文）：`);
    lines.push(...input.snapshot.documents.map(doc => `- ${doc.title}；资料 ${doc.documentId} 修订 ${doc.revision}`));
  }
  if (input.snapshot.rules.length) {
    lines.push(`已确认规则 ${input.snapshot.rules.length} 条（本次未装载条文）：`);
    lines.push(...input.snapshot.rules.map(pin => `- ${pin.title}（v${pin.version}）`));
  }
  lines.push("本次上下文装配不可用，以上仅为索引：不要把未读取的条文与正文写成已核实依据；需要依据时先在项目资料中查证。");
  const ledger: ContextLedger = {
    version: 1,
    ledgerId: randomUUID(),
    budgetTokens: 0,
    tokensEst: estimateTokens(lines.join("\n")),
    loaded: { knowledge: { loaded: 0, total: input.snapshot.rules.length, version: null }, documents: 0, rules: 0 },
    dropped,
    assembler: "fallback:index_only",
    statement: `装配不可用，仅装载索引；${dropped.length} 项因装配器不可用未装载。`,
  };
  return { lines, ledger };
}

/** 装配失败也照常派单：退化路径的账目与正文一样要能被对账。 */
export async function assembleOrIndexOnly(input: AssembleInput): Promise<AssembledContext> {
  try {
    return await assemblePromptContext(input);
  } catch (error) {
    console.error("QA context assembly failed; continuing with index-only context", error);
    return indexOnlyContext(input, error);
  }
}
