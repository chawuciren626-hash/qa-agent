/**
 * 探索回写 → 项目资料知识构建（B1 联动）。
 *
 * 为什么需要：探索成功后资产只落在环境域的四层知识里（qa_environment_knowledge），
 * 项目域的项目资料（qa_knowledge_builds）对它一无所知——项目资料页永远空白，
 * 下游会话装配的 knowledge.loaded 也一直是 0。探索的事实值得进项目知识库：
 * 接口必填参数、访问墙这些是测试点设计的直接输入。
 *
 * 联动方式（全部确定性，零 LLM）：
 *   1. 把探索资产渲染成一份 markdown 资料：每个事实一条列表项，行号全程可算；
 *   2. 以固定 documentId（doc-explore-<env>）落资料：不存在就建，存在就修订；
 *      内容与当前版本逐字节一致时跳过——同样的探索结果不制造修订与构建噪音；
 *   3. 以「直接原文位置」（source:{file,line}）生成知识项交给 knowledge.build：
 *      Python 侧 normalize_item 接受无 clause_id 的直接位置（file 必须等于
 *      documentId，与构建管线给条款标注的 file 一致，否则原文位置是假证据）；
 *      无事实 → 不建资料也不构建（空快照是噪音不是资产）。
 *   4. 证据层（第二批）：待验证假设追加进快照文档的独立章节（只读展示，不进知识
 *      构建——question 不是事实，不能冒充）；逆向需求文档（doc-reverse-prd-<env>）
 *      从地图 + 语义证据 + 假设渲染，人读交付物，每条标注验证等级。
 *
 * 诚实边界：联动失败不改探索结论——探索本身的契约（合并 + 四层回写）已经完成，
 * 失败原因如实写进轮次摘要（summary.knowledgeBuild.error），不吞掉也不冒充成功。
 */
import { createHash } from "node:crypto";
import type { Db } from "../hmr/capabilities.js";
import {
  QaProjectKnowledgeStore,
  type KnowledgeDb,
} from "./qa-project-knowledge.js";
import { QaKnowledgeBuildStore } from "./qa-knowledge-build.js";
import type { ToolRunner } from "./qa-knowledge-tool.js";
import type { KnowledgeEntryInput, KnowledgeLayer } from "./environment-knowledge-service.js";

/** 系统动作人：探索联动不冒充任何用户。 */
const SYNC_ACTOR = "system:exploration";

/** 语义证据的最小消费契约（来自探索产物 observations.json，只声明用到的字段）。 */
export interface EvidenceObservationDigest {
  id?: unknown;
  page?: unknown;
  kind?: unknown;
  verbatim?: unknown;
  context?: unknown;
  verification?: unknown;
}

export interface EvidenceRuleDigest {
  id?: unknown;
  statement?: unknown;
  verification?: unknown;
  evidence_ids?: unknown;
}

export interface EvidenceDigest {
  observations: EvidenceObservationDigest[];
  rules: EvidenceRuleDigest[];
}

export interface ExplorationKnowledgeSyncInput {
  projectId: string;
  env: string;
  /** 触发本轮同步的探索轮次（只进修订说明，不进快照正文——正文必须逐轮可复现）。 */
  round: number;
  targetUrl: string;
  layers: { layer: KnowledgeLayer; entries: KnowledgeEntryInput[] }[];
  /** 证据层（第二批）：语义观察与固定事实，供逆向需求文档渲染；缺省按"无证据"渲染。 */
  evidence?: EvidenceDigest | null;
  /** open 状态的待验证假设（statement 必为可判定句子），展示在快照与 PRD 的未知节。 */
  openHypotheses?: { statement: string; expectation: string | null }[];
  /** 探索回执的局限声明，PRD 原样收录——结论边界是文档的一部分。 */
  limitations?: string[];
}

export interface ExplorationKnowledgeBuildInfo {
  documentId: string;
  revision: number;
  /** null = 本轮没有可构建的事实（未建资料、未构建）。 */
  buildVersion: number | null;
  /** true = 事实没变，构建返回既有版本（不升版本）。 */
  unchanged: boolean;
  itemCount: number;
  /** 逆向需求文档（第二批）：null = 无证据与假设，未建。 */
  prdDocumentId?: string | null;
  prdRevision?: number | null;
  /** true = PRD 已被所有者归档，本轮跳过自动重写（不报错；恢复自动重写请取消归档）。 */
  prdArchived?: boolean;
}

export type ExplorationKnowledgeSync = (
  input: ExplorationKnowledgeSyncInput,
) => Promise<ExplorationKnowledgeBuildInfo>;

/** 联动工厂：路由装配一次，每轮探索调用。run 仅测试注入。 */
export function explorationKnowledgeSync(deps: {
  db: Db;
  engineRoot: string | undefined;
  run?: ToolRunner;
}): ExplorationKnowledgeSync {
  return async (input) => {
    const store = new QaProjectKnowledgeStore(deps.db as unknown as KnowledgeDb);
    const builds = new QaKnowledgeBuildStore(deps.db as unknown as KnowledgeDb, store, deps.engineRoot);
    const documentId = `doc-explore-${input.env}`;
    const title = `环境探索快照（${input.env}）`;
    const { content, items } = renderSnapshot(input, documentId);
    if (items.length === 0) {
      // 快照为空时快照文档不动，但证据/假设仍可独立成 PRD（事实为零的站点也有未知）。
      const prd = await writeReversePrd(deps.db as unknown as KnowledgeDb, store, input);
      return {
        documentId, revision: prd?.revision ?? 0, buildVersion: null,
        unchanged: true, itemCount: 0,
        prdDocumentId: prd?.documentId ?? null, prdRevision: prd?.revision ?? null,
        prdArchived: prd?.archived === true,
      };
    }

    // store 的 content_hash 带 sha256: 前缀，比对必须同口径，否则每轮都会误判
    // 「内容变了」制造修订噪音。
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const row = deps.db
      .prepare("SELECT current_revision, content_hash, status FROM qa_documents WHERE project_id=? AND document_id=?")
      .get(input.projectId, documentId) as
      { current_revision: number; content_hash: string; status: string } | undefined;

    let revision: number;
    if (!row) {
      const created = store.createDocument({
        projectId: input.projectId,
        userId: SYNC_ACTOR,
        internalDocumentId: documentId,
        title,
        format: "markdown",
        content,
        source: { type: "agent", ref: `env-explore:${input.env}` },
        changeNote: `探索第 ${input.round} 轮快照`,
      });
      revision = created.document.currentRevision;
    } else if (row.status !== "active") {
      throw new Error(`探索快照资料已被归档（${documentId}），无法继续修订`);
    } else if (row.content_hash !== contentHash) {
      const updated = store.updateDocument({
        projectId: input.projectId,
        documentId,
        userId: SYNC_ACTOR,
        expectedRevision: Number(row.current_revision),
        content,
        changeNote: `探索第 ${input.round} 轮快照更新`,
      });
      revision = updated.document.currentRevision;
    } else {
      revision = Number(row.current_revision);
    }

    const result = await builds.build({
      db: deps.db as unknown as KnowledgeDb,
      store,
      projectId: input.projectId,
      userId: SYNC_ACTOR,
      items,
      actor: `exploration:round-${input.round}`,
      run: deps.run,
    });
    const prd = await writeReversePrd(deps.db as unknown as KnowledgeDb, store, input);
    return {
      documentId,
      revision,
      buildVersion: result.build.version,
      unchanged: result.unchanged,
      itemCount: result.build.items.length,
      prdDocumentId: prd?.documentId ?? null,
      prdRevision: prd?.revision ?? null,
      prdArchived: prd?.archived === true,
    };
  };
}

/** 渲染探索快照：每个事实一条列表项；行号即知识项的原文位置，必须严格对齐。 */
export function renderSnapshot(
  input: ExplorationKnowledgeSyncInput,
  documentId: string,
): { content: string; items: Record<string, unknown>[] } {
  // 行号按「最终文件的物理行」计：header 先落位，事实条目追加在其后。
  const lines: string[] = [
    `# 环境探索快照（${input.env}）`,
    "",
    `本快照由环境探索自动生成（探索目标：${input.targetUrl}）。`,
    "内容只含探索实际证实的事实；每次探索成功后整份重写，知识项的原文位置即本文件行号。",
  ];
  const items: Record<string, unknown>[] = [];
  /** 落一条事实：列表项自成条款（Python 条款化按列表项切分），行号即位置。 */
  const emit = (fact: { type: string; name: string; statement: string }, summary: string, section: string): void => {
    lines.push(`- ${fact.name}：${summary}`);
    items.push({
      type: fact.type,
      name: fact.name,
      statement: fact.statement,
      section,
      source: { file: documentId, line: lines.length },
      tags: ["exploration", input.env],
    });
  };
  const sectionOf = (layer: KnowledgeLayer): string | null => {
    if (layer === "module") return "模块（页面路由）";
    if (layer === "interface") return "接口";
    if (layer === "wall") return "访问墙";
    return null; // flow 等其余层单页探索不产出，防御性忽略。
  };

  const seen = new Set<KnowledgeLayer>();
  for (const layer of input.layers) {
    const heading = sectionOf(layer.layer);
    if (!heading || seen.has(layer.layer) || layer.entries.length === 0) continue;
    seen.add(layer.layer);
    lines.push("", `## ${heading}`, "");
    for (const entry of layer.entries.slice(0, 500)) {
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (!key) continue;
      if (layer.layer === "module") {
        emit(
          { type: "entity", name: key, statement: `页面模块 ${key}：${summary}（环境 ${input.env} 探索证实）` },
          summary,
          heading,
        );
      } else if (layer.layer === "interface") {
        emit(
          { type: "constraint", name: key, statement: `接口 ${key}：${summary}（环境 ${input.env} 采集）` },
          summary,
          heading,
        );
      } else {
        emit(
          { type: "rule", name: key, statement: `访问墙 ${key}：${summary}` },
          summary,
          heading,
        );
      }
    }
  }
  // 待验证假设追加在所有事实之后：只读展示，不产生知识项——question 不是事实，
  // 混进知识构建会让"探索证实"和"尚未证实"在下游装配里长得一样。
  const hypotheses = input.openHypotheses ?? [];
  if (hypotheses.length > 0) {
    lines.push("", "## 待验证假设（未证实，勿当事实引用）", "");
    for (const hypothesis of hypotheses.slice(0, 30)) {
      lines.push(`- [tbd] ${hypothesis.statement}` +
        (hypothesis.expectation ? `（验证线索：${hypothesis.expectation}）` : ""));
    }
  }
  if (items.length === 0) return { content: "", items };

  return { content: [...lines].join("\n") + "\n", items };
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const isVerified = (value: unknown): boolean => value === "verified";

/**
 * 渲染逆向需求文档（第二批）：从探索事实 + 语义证据 + 待验证假设生成人读交付物。
 * 每条标注验证等级（verified/tbd），实测与推断永不混排；局限声明原样收录。
 * 与快照文档的分工：快照行号喂知识构建（机器引用），PRD 只为人读，不进知识构建。
 */
export function renderReversePrd(input: ExplorationKnowledgeSyncInput, documentId: string): string {
  const lines: string[] = [
    `# 逆向需求文档（环境 ${input.env}）`,
    "",
    `- 数据来源：环境探索取证（round-${input.round}，${input.targetUrl}）`,
    "- 验证等级标注：[verified]=直接观察逐字取证；[tbd]=未确认未知。推断不进本文档。",
    "- 本文档由探索自动重写；人工结论请走规则候选确认或假设判录，不要直接编辑。",
    "",
    "## 一、页面与功能",
    "",
  ];
  const moduleLayer = input.layers.find((layer) => layer.layer === "module");
  const moduleEntries = (moduleLayer?.entries ?? []).slice(0, 300);
  if (moduleEntries.length === 0) {
    lines.push("- （本轮没有采集到页面事实）", "");
  } else {
    for (const entry of moduleEntries) {
      const key = text(entry.key);
      const summary = text(entry.summary, "仅路由");
      const rendered = /\[verified\]|\[tbd\]/.test(summary) ? summary : `${summary} [verified]`;
      lines.push(`- \`${key}\`：${rendered}`);
    }
    lines.push("");
  }

  lines.push("## 二、接口", "");
  const interfaceLayer = input.layers.find((layer) => layer.layer === "interface");
  const interfaceEntries = (interfaceLayer?.entries ?? []).slice(0, 300);
  if (interfaceEntries.length === 0) {
    lines.push("- （未发现接口清单；可通过读流量或 OpenAPI 导入补充）", "");
  } else {
    for (const entry of interfaceEntries) {
      lines.push(`- ${text(entry.key)}：${text(entry.summary, "")} [verified]`);
    }
    lines.push("");
  }

  lines.push("## 三、访问墙", "");
  const wallLayer = input.layers.find((layer) => layer.layer === "wall");
  const wallEntries = (wallLayer?.entries ?? []).slice(0, 50);
  if (wallEntries.length === 0) {
    lines.push("- （未观察到访问墙）", "");
  } else {
    for (const entry of wallEntries) {
      lines.push(`- ${text(entry.key)}：${text(entry.summary, "")} [verified]`);
    }
    lines.push("");
  }

  lines.push("## 四、业务规则（可直接断言的固定事实）", "");
  const rules = (input.evidence?.rules ?? []).filter((rule) => isVerified(rule.verification) && text(rule.statement));
  if (rules.length === 0) {
    lines.push("- （暂无；规则需绑定业务对象上下文且经所有者确认，见知识候选）", "");
  } else {
    for (const rule of rules.slice(0, 100)) {
      lines.push(`- ${text(rule.statement)} [verified]（证据：${(Array.isArray(rule.evidence_ids) ? rule.evidence_ids.filter((x): x is string => typeof x === "string") : []).join("、") || "—"}）`);
    }
    lines.push("");
  }

  lines.push("## 五、数据字段与选项", "");
  const observations = input.evidence?.observations ?? [];
  const labels = observations.filter((obs) => obs.kind === "field_label" && text(obs.verbatim));
  const options = observations.filter((obs) => obs.kind === "option_list" && text(obs.verbatim));
  const prices = observations.filter((obs) => obs.kind === "price" && text(obs.verbatim));
  if (labels.length === 0 && options.length === 0 && prices.length === 0) {
    lines.push("- （本轮未提取到语义字段）", "");
  } else {
    for (const obs of labels.slice(0, 60)) {
      lines.push(`- \`${text(obs.page) || "?"}\` 字段：${text(obs.verbatim)} [verified]`);
    }
    for (const obs of options.slice(0, 30)) {
      lines.push(`- \`${text(obs.page) || "?"}\` 选项：${text(obs.verbatim)} [verified]`);
    }
    for (const obs of prices.slice(0, 60)) {
      lines.push(`- 价格 ${text(obs.verbatim)}${obs.context ? `（${text(obs.context)}）` : ""} [verified]`);
    }
    lines.push("");
  }

  lines.push("## 六、待确认未知", "");
  const hypotheses = input.openHypotheses ?? [];
  if (hypotheses.length === 0) {
    lines.push("- （当前无 open 假设）", "");
  } else {
    for (const hypothesis of hypotheses.slice(0, 30)) {
      lines.push(`- [tbd] ${hypothesis.statement}` +
        (hypothesis.expectation ? `（验证线索：${hypothesis.expectation}）` : ""));
    }
    lines.push("");
  }

  lines.push("## 七、来源与局限", "");
  const limitations = input.limitations ?? [];
  if (limitations.length === 0) {
    lines.push("- （探索回执未声明局限）", "");
  } else {
    for (const limitation of limitations) {
      lines.push(`- ${limitation}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** 逆向需求文档落库：与快照同一套「不存在就建 / 内容变了才修订」口径；失败上抛由调用方并入联动错误。 */
async function writeReversePrd(
  db: KnowledgeDb,
  store: QaProjectKnowledgeStore,
  input: ExplorationKnowledgeSyncInput,
): Promise<{ documentId: string; revision: number; archived?: boolean } | null> {
  const hasEvidence = (input.evidence?.observations?.length ?? 0) > 0 || (input.evidence?.rules?.length ?? 0) > 0;
  const hasHypotheses = (input.openHypotheses?.length ?? 0) > 0;
  if (!hasEvidence && !hasHypotheses) return null;
  const documentId = `doc-reverse-prd-${input.env}`;
  const content = renderReversePrd(input, documentId);
  const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const row = db
    .prepare("SELECT current_revision, content_hash, status FROM qa_documents WHERE project_id=? AND document_id=?")
    .get(input.projectId, documentId) as
    { current_revision: number; content_hash: string; status: string } | undefined;
  if (!row) {
    const created = store.createDocument({
      projectId: input.projectId,
      userId: SYNC_ACTOR,
      internalDocumentId: documentId,
      title: `逆向需求文档（${input.env}）`,
      format: "markdown",
      content,
      source: { type: "agent", ref: `env-explore:${input.env}` },
      changeNote: `探索第 ${input.round} 轮逆向需求文档`,
    });
    return { documentId, revision: created.document.currentRevision };
  }
  // 归档是所有者的决定：PRD 不再自动重建，也不把每轮探索变成一条报错——跳过并在
  // 摘要里如实说明（想恢复自动重写就取消归档）。快照文档的归档仍视为错误：它是
  // 知识构建的原文来源，缺了会把整条联动静默掏空。
  if (row.status !== "active") {
    return { documentId, revision: Number(row.current_revision), archived: true };
  }
  if (row.status !== "active") throw new Error(`逆向需求文档已被归档（${documentId}），无法继续修订`);
  if (row.content_hash !== contentHash) {
    const updated = store.updateDocument({
      projectId: input.projectId,
      documentId,
      userId: SYNC_ACTOR,
      expectedRevision: Number(row.current_revision),
      content,
      changeNote: `探索第 ${input.round} 轮逆向需求文档更新`,
    });
    return { documentId, revision: updated.document.currentRevision };
  }
  return { documentId, revision: Number(row.current_revision) };
}
