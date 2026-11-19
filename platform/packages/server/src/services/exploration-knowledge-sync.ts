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

export interface ExplorationKnowledgeSyncInput {
  projectId: string;
  env: string;
  /** 触发本轮同步的探索轮次（只进修订说明，不进快照正文——正文必须逐轮可复现）。 */
  round: number;
  targetUrl: string;
  layers: { layer: KnowledgeLayer; entries: KnowledgeEntryInput[] }[];
}

export interface ExplorationKnowledgeBuildInfo {
  documentId: string;
  revision: number;
  /** null = 本轮没有可构建的事实（未建资料、未构建）。 */
  buildVersion: number | null;
  /** true = 事实没变，构建返回既有版本（不升版本）。 */
  unchanged: boolean;
  itemCount: number;
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
      return { documentId, revision: 0, buildVersion: null, unchanged: true, itemCount: 0 };
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
    return {
      documentId,
      revision,
      buildVersion: result.build.version,
      unchanged: result.unchanged,
      itemCount: result.build.items.length,
    };
  };
}

/** 渲染探索快照：每个事实一条列表项；行号即知识项的原文位置，必须严格对齐。 */
function renderSnapshot(
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
  if (items.length === 0) return { content: "", items };

  return { content: [...lines].join("\n") + "\n", items };
}
