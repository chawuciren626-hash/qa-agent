/**
 * 探索后 LLM 项目知识文档（doc-project-knowledge-<env>）。
 *
 * 为什么需要这一层：结构探索（零 LLM）只有"页面/控件/价格/字段"这类确定性事实，
 * 业务流程、模块语义、页面之间的推断关系这些 Trae 式知识文档的内容，需要一次
 * LLM 分析——但 LLM 的产出没有资格冒充探索事实，所以本文档两级标注：
 *   - 探索事实引用 = [verified]（零 LLM 采集）；
 *   - 模型分析/推断 = [推断]（单独章节，未经交互验证）。
 *
 * 通道：项目默认模型的一次性补全（completeOnce，与 QA 平台任务 AI 分析同一条缝）。
 * 纪律与 B1 联动一致：失败/跳过不改探索结论，原因如实进轮次摘要；所有者归档后跳过
 * 自动重写（与逆向需求文档同一处理）。
 */
import { createHash } from "node:crypto";
import type { Db } from "../hmr/capabilities.js";
import type { UtilityCompletion } from "../mechanisms/projects.js";
import {
  QaProjectKnowledgeStore,
  type KnowledgeDb,
} from "./qa-project-knowledge.js";
import type { KnowledgeEntryInput, KnowledgeLayer } from "./environment-knowledge-service.js";

const SYNC_ACTOR = "system:exploration";

export interface EvidenceDigest {
  observations: { page?: unknown; kind?: unknown; verbatim?: unknown; context?: unknown }[];
  rules?: { statement?: unknown; verification?: unknown; evidence_ids?: unknown }[];
}

export interface KnowledgeAnalysisInput {
  projectId: string;
  env: string;
  round: number;
  targetUrl: string;
  layers: { layer: KnowledgeLayer; entries: KnowledgeEntryInput[] }[];
  evidence: EvidenceDigest | null;
  openHypotheses?: { statement: string; expectation: string | null }[];
  limitations?: string[];
}

export interface KnowledgeAnalysisResult {
  model: "project-default";
  documentId: string;
  revision: number | null;
  skipped?: "no_model" | "failed" | "archived" | "disabled";
  tokens?: number;
  error?: string;
}

export type ExplorationKnowledgeAnalysis = (input: KnowledgeAnalysisInput) => Promise<KnowledgeAnalysisResult>;

/** 提示词与事实摘要的封顶：长上下文阶段没有预算就是成本失控（§6.2）。 */
const MAX_CONTROLS_PER_PAGE = 25;
const MAX_OBSERVATIONS = 80;
const MAX_PAGE_SECTIONS = 20;

/** 纯函数：探索事实 → 知识分析提示词。测试锁定纪律条目与封顶，调用方不参与拼装。 */
export function buildKnowledgeAnalysisPrompt(input: KnowledgeAnalysisInput, env: string): string {
  const lines: string[] = [
    "你是软件测试知识整理员。下面是自动化探索采集的[verified]事实，请整理成一份《项目知识文档》markdown。",
    "",
    "纪律（违反任何一条即不合格）：",
    "1. 只引用「探索事实」中出现过的页面、控件、文案、价格、接口；不得编造或补全。",
    "2. 业务流程、模块语义的推断放进「业务流程推断」一节，每条单独以 [推断] 结尾。",
    "3. 逐字文案只有探索事实里出现的才能引用；没出现写「未见证据」。",
    "4. 输出中文 markdown，第一行必须是 `# 项目知识文档（环境 " + env + "）`。",
    "5. 固定章节：## 一、系统概览 / ## 二、页面与功能 / ## 三、业务流程推断 / ## 四、字段与选项 / ## 五、待确认未知。",
    "",
    "—— 探索事实 ——",
    `目标：${input.targetUrl}`,
    "",
  ];

  const moduleLayer = input.layers.find((layer) => layer.layer === "module");
  const pages = (moduleLayer?.entries ?? []).slice(0, MAX_PAGE_SECTIONS);
  if (pages.length) {
    lines.push("页面：");
    for (const entry of pages) {
      const key = typeof entry.key === "string" ? entry.key : "?";
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      lines.push(`- ${key}：${summary}`);
    }
    lines.push("");
  }

  const interfaceLayer = input.layers.find((layer) => layer.layer === "interface");
  const apis = (interfaceLayer?.entries ?? []).slice(0, 30);
  if (apis.length) {
    lines.push("接口：");
    for (const entry of apis) {
      lines.push(`- ${typeof entry.key === "string" ? entry.key : "?"}：${typeof entry.summary === "string" ? entry.summary : ""}`);
    }
    lines.push("");
  }

  const wallLayer = input.layers.find((layer) => layer.layer === "wall");
  const walls = (wallLayer?.entries ?? []).slice(0, 20);
  for (const entry of walls) {
    lines.push(`访问墙：${typeof entry.key === "string" ? entry.key : "?"}：${typeof entry.summary === "string" ? entry.summary : ""}`);
  }
  if (walls.length) lines.push("");

  const observations = (input.evidence?.observations ?? []).slice(0, MAX_OBSERVATIONS);
  if (observations.length) {
    lines.push("语义观察（逐字）：");
    for (const obs of observations) {
      const page = typeof obs.page === "string" ? obs.page : "?";
      const kind = typeof obs.kind === "string" ? obs.kind : "?";
      const verbatim = typeof obs.verbatim === "string" ? obs.verbatim : "";
      const context = typeof obs.context === "string" && obs.context ? `（${obs.context}）` : "";
      lines.push(`- [${page}] ${kind}: ${verbatim}${context}`);
    }
    lines.push("");
  }

  const rules = (input.evidence?.rules ?? []).filter((rule) => rule.verification === "verified").slice(0, 30);
  if (rules.length) {
    lines.push("已确认规则：");
    for (const rule of rules) {
      lines.push(`- ${typeof rule.statement === "string" ? rule.statement : ""}`);
    }
    lines.push("");
  }

  const hypotheses = (input.openHypotheses ?? []).slice(0, 15);
  if (hypotheses.length) {
    lines.push("待确认未知：");
    for (const hypothesis of hypotheses) {
      lines.push(`- ${hypothesis.statement}`);
    }
    lines.push("");
  }

  const limitations = (input.limitations ?? []).slice(0, 10);
  if (limitations.length) {
    lines.push("采集局限（必须原样写进文档末尾的「来源与局限」节）：");
    for (const limitation of limitations) {
      lines.push(`- ${limitation}`);
    }
  }
  return lines.join("\n");
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

export function explorationKnowledgeAnalysis(deps: {
  db: Db;
  completeOnce: (projectId: string, prompt: string, opts?: { maxTokens?: number; requestTimeoutMs?: number }) => Promise<UtilityCompletion>;
  /** 测试注入；缺省用真实知识库存储。 */
  store?: QaProjectKnowledgeStore;
}): ExplorationKnowledgeAnalysis {
  return async (input) => {
    const result: KnowledgeAnalysisResult = { model: "project-default", documentId: `doc-project-knowledge-${input.env}`, revision: null };
    const store = deps.store ?? new QaProjectKnowledgeStore(deps.db as unknown as KnowledgeDb);

    let completion: UtilityCompletion;
    try {
      const prompt = buildKnowledgeAnalysisPrompt(input, input.env);
      completion = await deps.completeOnce(input.projectId, prompt, { maxTokens: 4096, requestTimeoutMs: 120_000 });
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
    if (!completion.ok) {
      return { ...result, skipped: completion.cause, error: completion.error };
    }

    const documentId = result.documentId;
    const header = [
      `> 本文档由探索证据 + 项目默认模型分析自动生成（探索 round-${input.round}）。`,
      "> 标注口径：[verified]=探索直接证实；[推断]=模型分析，未经交互验证，不得当事实引用。",
      "> 模型可能遗漏或误读，以探索产物与人工确认（规则候选/假设判录）为准。内容可能不完整。",
      "",
    ].join("\n");
    const content = header + completion.text.trim() + "\n";
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const row = deps.db
      .prepare("SELECT current_revision, content_hash, status FROM qa_documents WHERE project_id=? AND document_id=?")
      .get(input.projectId, documentId) as
      { current_revision: number; content_hash: string; status: string } | undefined;

    if (!row) {
      const created = store.createDocument({
        projectId: input.projectId,
        userId: SYNC_ACTOR,
        internalDocumentId: documentId,
        title: `项目知识文档（${input.env}）`,
        format: "markdown",
        content,
        source: { type: "agent", ref: `env-explore:${input.env}` },
        changeNote: `探索第 ${input.round} 轮 LLM 知识分析`,
      });
      return { ...result, revision: created.document.currentRevision };
    }
    // 归档是所有者的决定：跳过自动重写，不把每轮探索变成报错（与逆向需求文档同一处理）。
    if (row.status !== "active") return { ...result, revision: Number(row.current_revision), skipped: "archived" };
    if (row.content_hash !== contentHash) {
      const updated = store.updateDocument({
        projectId: input.projectId,
        documentId,
        userId: SYNC_ACTOR,
        expectedRevision: Number(row.current_revision),
        content,
        changeNote: `探索第 ${input.round} 轮 LLM 知识分析更新`,
      });
      return { ...result, revision: updated.document.currentRevision };
    }
    return { ...result, revision: Number(row.current_revision) };
  };
}
