/**
 * A6：项目资料 → 条款（带原文位置）→ 知识版本，以及版本 diff 与引用反查。
 *
 * 这一层只做确定性的部分，LLM 只负责"从条款里认出知识项"：
 *   - 条款切分、位置校验、语义指纹去重、版本对账全在 Python 侧（`knowledge.build` /
 *     `knowledge.diff` / `knowledge.references`），TS 不再重写一遍——两份实现迟早给出
 *     不同答案，而这类差异不报错，只会静默地把"表述变更"算成"语义变更"。
 *   - **没有原文位置的知识项一律不入库**，并在 `_build_meta.dropped` 里计数。
 *     不可定位的知识会污染所有下游产物，而且事后无法核对。
 *
 * 版本策略：**全文哈希**相同才不升版本（`unchanged: true`）。同一输入反复构建不该造出
 * 一堆"新版本"，否则 diff 里全是噪音；但只改了措辞也要留一个版本——用语义哈希定版本会
 * 让库里永远保留旧措辞，同时 diff 告诉你"什么都没变"。语义哈希只写进 lineage。
 */
import { createHash, randomUUID } from "node:crypto";
import { qaEnabled } from "./qa-engine.js";
import { knowledgeToolRunner, type ToolRunner } from "./qa-knowledge-tool.js";
import type { KnowledgeDb, QaProjectKnowledgeStore } from "./qa-project-knowledge.js";

/** 单次构建最多读多少份资料（与任务快照同一个上限，避免"快照切得下、构建切不下"）。 */
const BUILD_MAX_DOCUMENTS = 200;

export interface KnowledgeSourceRef {
  documentId: string;
  revision: number;
  title: string;
  /** 条款/知识项里 `source.file` 的取值：用 documentId 而不是标题。 */
  file: string;
}

export interface KnowledgeItem {
  id: string;
  type: string;
  name: string;
  statement: string;
  source: { file: string; line: number };
  section?: string | null;
  tags: string[];
  fingerprint: string;
}

export interface KnowledgeBuild {
  buildId: string;
  version: number;
  contentHash: string;
  items: KnowledgeItem[];
  clauses: { clause_id: string; section_path: string; text: string; location: { file: string; line: number } }[];
  stats: { items: number; by_type: Record<string, number>; dropped: number; duplicates: number };
  sources: KnowledgeSourceRef[];
  meta: {
    actor: string;
    /** Python 侧按语义指纹算的内容哈希：lineage 用它，版本号不用它（见 contentHash 注释）。 */
    semanticHash: string;
    dropped: { reason: string; raw?: unknown }[];
    duplicates: Record<string, unknown>[];
  };
  createdAt: string;
  createdBy: string;
}

/** 版本对账结果（四分类）。`wording_only` 不触发重算——它只是改了措辞。 */
export interface KnowledgeDiff {
  stats: Record<string, number>;
  triggersRecompute: boolean;
  semanticChanged: unknown[];
  wordingOnly: unknown[];
  renamed: unknown[];
  added: unknown[];
  removed: unknown[];
}

export interface BuildKnowledgeInput {
  db: KnowledgeDb;
  store: QaProjectKnowledgeStore;
  projectId: string;
  userId: string;
  /** LLM 抽出的知识项；可以只带 `clause_id`，位置由服务端从条款索引回填。 */
  items: unknown[];
  /** 只构建指定资料；不给就是当前全部 active 资料。 */
  documentIds?: string[];
  actor?: string;
  run?: ToolRunner;
}

export interface BuildKnowledgeResult {
  build: KnowledgeBuild;
  unchanged: boolean;
  diff: KnowledgeDiff | null;
}

export class QaKnowledgeBuildStore {
  constructor(
    private readonly db: KnowledgeDb,
    private readonly knowledge: QaProjectKnowledgeStore,
    private readonly engineRoot: string | undefined = process.env.AITEST_ENGINE_ROOT,
  ) {}

  /** 装配的确定性入口：没有 engine 就不干活，绝不在 TS 里另写一份条款化。 */
  private runner(explicit?: ToolRunner): ToolRunner {
    if (explicit) return explicit;
    if (!this.engineRoot || !qaEnabled) throw new Error("knowledge_engine_unavailable");
    return knowledgeToolRunner({ engineRoot: this.engineRoot });
  }

  /** 当前全部 active 资料（分页取满，避免只构建前 100 份却当成全量）。 */
  activeDocuments(projectId: string): { documentId: string; revision: number; title: string }[] {
    const all: { documentId: string; revision: number; title: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = this.knowledge.listDocuments({ projectId, status: "active", limit: 100, cursor });
      all.push(...page.documents.map(doc => ({ documentId: doc.documentId, revision: doc.currentRevision, title: doc.title })));
      cursor = page.nextCursor ?? undefined;
      if (all.length > BUILD_MAX_DOCUMENTS) throw new Error("knowledge_too_large");
    } while (cursor);
    return all;
  }

  private row(projectId: string, version: number): KnowledgeBuildRow | undefined {
    return this.db.prepare("SELECT * FROM qa_knowledge_builds WHERE project_id=? AND version=?")
      .get(projectId, version) as KnowledgeBuildRow | undefined;
  }

  latest(projectId: string): KnowledgeBuild | null {
    const row = this.db.prepare("SELECT * FROM qa_knowledge_builds WHERE project_id=? ORDER BY version DESC LIMIT 1")
      .get(projectId) as KnowledgeBuildRow | undefined;
    return row ? toBuild(row) : null;
  }

  get(projectId: string, version: number): KnowledgeBuild {
    const row = this.row(projectId, version);
    if (!row) throw new Error("knowledge_build_not_found");
    return toBuild(row);
  }

  list(projectId: string, limit = 20): Omit<KnowledgeBuild, "items" | "clauses" | "meta">[] {
    const rows = this.db.prepare("SELECT * FROM qa_knowledge_builds WHERE project_id=? ORDER BY version DESC LIMIT ?")
      .all(projectId, Math.max(1, Math.min(limit, 100))) as KnowledgeBuildRow[];
    return rows.map((row) => {
      const { items: _items, clauses: _clauses, meta: _meta, ...rest } = toBuild(row);
      return rest;
    });
  }

  /** 构建一版知识。同一输入返回同一 `content_hash`，且不升版本。 */
  async build(input: BuildKnowledgeInput): Promise<BuildKnowledgeResult> {
    const available = this.activeDocuments(input.projectId);
    const selected = input.documentIds?.length
      ? available.filter(doc => input.documentIds!.includes(doc.documentId))
      : available;
    if (input.documentIds?.length && selected.length !== input.documentIds.length) {
      throw new Error("knowledge_source_missing");
    }

    const sources = selected.map(doc => ({
      ref: { documentId: doc.documentId, revision: doc.revision, title: doc.title, file: doc.documentId } satisfies KnowledgeSourceRef,
      text: this.knowledge.getRevision(input.projectId, doc.documentId, doc.revision).content,
    }));

    const previous = this.latest(input.projectId);
    const version = (previous?.version ?? 0) + 1;
    const actor = input.actor ?? `user:${input.userId}`;
    const run = this.runner(input.run);
    const built = (await run("knowledge.build", {
      project: input.projectId,
      version,
      actor,
      sources: sources.map(source => ({ name: source.ref.file, text: source.text })),
      items: input.items,
    })) as {
      clauses: KnowledgeBuild["clauses"];
      knowledge: {
        items: KnowledgeItem[];
        stats: KnowledgeBuild["stats"];
        content_hash: string;
        _build_meta: { version: number; actor: string; dropped: { reason: string }[]; duplicates: Record<string, unknown>[] };
      };
    };

    // 版本身份用「全文哈希」：语义指纹相同但条文措辞变了，也必须留下一个可追溯的版本，
    // 否则库里会一直保留旧措辞，而 diff 又告诉你"什么都没变"。
    const textHash = createHash("sha256")
      .update(JSON.stringify({
        items: built.knowledge.items.map(item => [item.id, item.type, item.statement, item.source.file, item.source.line]),
        clauses: built.clauses.map(clause => [clause.clause_id, clause.text]),
      }))
      .digest("hex");
    if (previous && previous.contentHash === textHash) {
      return { build: previous, unchanged: true, diff: null };
    }

    const build: KnowledgeBuild = {
      buildId: `kb_${randomUUID()}`,
      version,
      contentHash: textHash,
      items: built.knowledge.items,
      clauses: built.clauses,
      stats: built.knowledge.stats,
      sources: sources.map(source => source.ref),
      meta: {
        actor: built.knowledge._build_meta.actor,
        semanticHash: built.knowledge.content_hash,
        dropped: built.knowledge._build_meta.dropped,
        duplicates: built.knowledge._build_meta.duplicates,
      },
      createdAt: new Date().toISOString(),
      createdBy: input.userId,
    };
    this.db.prepare(`INSERT INTO qa_knowledge_builds
      (build_id, project_id, version, content_hash, items_json, clauses_json, stats_json, sources_json, build_meta_json, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      build.buildId, input.projectId, build.version, build.contentHash,
      JSON.stringify(build.items), JSON.stringify(build.clauses), JSON.stringify(build.stats),
      JSON.stringify(build.sources), JSON.stringify(build.meta), build.createdAt, build.createdBy,
    );

    const diff = previous
      ? await this.diff(input.projectId, previous.version, version, run)
      : null;
    return { build, unchanged: false, diff };
  }

  async diff(projectId: string, from: number, to: number, run?: ToolRunner): Promise<KnowledgeDiff> {
    if (from === to) throw new Error("knowledge_diff_same_version");
    const older = this.get(projectId, from);
    const newer = this.get(projectId, to);
    const tool = this.runner(run);
    const raw = (await tool("knowledge.diff", {
      old: knowledgeEnvelope(older),
      new: knowledgeEnvelope(newer),
    })) as Record<string, unknown> & {
      stats: Record<string, number>;
      semantic_changed: unknown[];
      wording_only: unknown[];
      renamed: unknown[];
      added: unknown[];
      removed: unknown[];
    };
    return {
      stats: raw.stats,
      triggersRecompute: raw.triggers_recompute === true,
      semanticChanged: raw.semantic_changed ?? [],
      wordingOnly: raw.wording_only ?? [],
      renamed: raw.renamed ?? [],
      added: raw.added ?? [],
      removed: raw.removed ?? [],
    };
  }

  /** 引用反查：这段文本（比如某条用例或某份新需求）用到了哪些知识项。 */
  async references(projectId: string, text: string, version?: number, run?: ToolRunner): Promise<{
    version: number;
    hits: { knowledgeId: string; type: string; name: string; priority: number; source: { file: string; line: number } }[];
  }> {
    const build = version === undefined ? this.latest(projectId) : this.get(projectId, version);
    // 还没构建过：返回空答案而不是报错——"这条文本没引用到知识"与"知识库还没建"是两件事，
    // 用 version: 0 区分开，页面据此提示"先去构建"，不会误报成"没有受到影响"。
    if (!build) return { version: 0, hits: [] };
    const tool = this.runner(run);
    const raw = (await tool("knowledge.references", {
      text,
      knowledge: knowledgeEnvelope(build),
    })) as { hits: { knowledge_id: string; type: string; name: string; priority: number }[]; count: number };
    const byId = new Map(build.items.map(item => [item.id, item]));
    return {
      version: build.version,
      hits: raw.hits.map(hit => ({
        knowledgeId: hit.knowledge_id, type: hit.type, name: hit.name, priority: hit.priority,
        source: byId.get(hit.knowledge_id)?.source ?? { file: "", line: 0 },
      })),
    };
  }
}

interface KnowledgeBuildRow {
  build_id: string;
  project_id: string;
  version: number;
  content_hash: string;
  items_json: string;
  clauses_json: string;
  stats_json: string;
  sources_json: string;
  build_meta_json: string;
  created_at: string;
  created_by: string;
}

function toBuild(row: KnowledgeBuildRow): KnowledgeBuild {
  return {
    buildId: row.build_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    items: JSON.parse(row.items_json) as KnowledgeItem[],
    clauses: JSON.parse(row.clauses_json) as KnowledgeBuild["clauses"],
    stats: JSON.parse(row.stats_json) as KnowledgeBuild["stats"],
    sources: JSON.parse(row.sources_json) as KnowledgeSourceRef[],
    meta: JSON.parse(row.build_meta_json) as KnowledgeBuild["meta"],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** 装配/diff/反查共用同一个信封形状：`_build_meta.version` 是版本对账的唯一来源。 */
function knowledgeEnvelope(build: KnowledgeBuild): Record<string, unknown> {
  return {
    type: "knowledge",
    project: "",
    items: build.items,
    content_hash: build.meta.semanticHash,
    _build_meta: { version: build.version, actor: build.meta.actor },
  };
}
