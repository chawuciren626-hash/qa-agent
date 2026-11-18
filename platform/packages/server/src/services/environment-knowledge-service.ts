/**
 * 项目环境的探索资产（kb/<env>/）与假设闭环。
 *
 * 三层关系，别混：
 *   建档 maps/<env>/   —— 有哪些地址（程序探，只读）
 *   探索 kb/<env>/     —— 地址怎么走通（程序探，每轮覆盖）
 *   假设               —— 人判断"探不到的为什么"，等下一轮程序验证
 *
 * 为什么假设不写进 kb：kb 里必须是程序验证过的结论，否则下游生成用例时分不清
 * "看到过"和"猜的"。人只提交可判定的假设，由 appendVerdict 判定后，验证通过的
 * 才由探索程序写回 knowledge。
 *
 * 为什么判定要 append：假设表上的 status 只是最新快照，全过程在 verdicts 里。
 * 被推翻的旧结论决定了断言放哪（退款超额是提交时才校验，断言放输入框会误报），
 * 只存最新状态就把这个信息永久丢了。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../hmr/capabilities.js";
import { HttpError } from "../http/errors.js";

export const KNOWLEDGE_LAYERS = ["module", "flow", "wall", "interface"] as const;
export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

/** 探不到的五类原因：决定了下一轮是自补（async）、还是等人补账号/补假设。 */
export const WHY_UNKNOWN = ["business", "data", "role", "async", "external"] as const;
export type WhyUnknown = (typeof WHY_UNKNOWN)[number];

export const VERDICTS = ["verified", "refuted", "unreachable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const HYPOTHESIS_STATUSES = ["open", "verified", "refuted", "unreachable"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export interface KnowledgeEntryView {
  layer: KnowledgeLayer;
  key: string;
  summary: string | null;
  relPath: string | null;
  round: number;
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface KnowledgeView {
  env: string;
  layers: Record<KnowledgeLayer, KnowledgeEntryView[]>;
  counts: Record<KnowledgeLayer, number>;
  /** 最近写入的轮次；0 表示这个环境从没探索过（不是"探索过但没有模块"）。 */
  lastRound: number;
}

export interface VerdictView {
  verdictId: string;
  round: number;
  verdict: Verdict;
  evidence: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface HypothesisView {
  hypothesisId: string;
  moduleKey: string | null;
  statement: string;
  whyUnknown: WhyUnknown;
  expectation: string | null;
  dataSetup: string | null;
  allowSeed: boolean;
  status: HypothesisStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 从旧到新；空数组表示还没验过。 */
  verdicts: VerdictView[];
}

export interface HypothesisSummary {
  open: number;
  verified: number;
  refuted: number;
  unreachable: number;
  total: number;
}

interface KnowledgeRow {
  layer: KnowledgeLayer;
  entry_key: string;
  summary: string | null;
  rel_path: string | null;
  round: number;
  source_session_id: string | null;
  updated_at: string;
}

interface HypothesisRow {
  hypothesis_id: string;
  module_key: string | null;
  statement: string;
  why_unknown: WhyUnknown;
  expectation: string | null;
  data_setup: string | null;
  allow_seed: number;
  status: HypothesisStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface VerdictRow {
  verdict_id: string;
  round: number;
  verdict: Verdict;
  evidence: string | null;
  session_id: string | null;
  created_at: string;
}

function emptyLayers(): Record<KnowledgeLayer, KnowledgeEntryView[]> {
  return { module: [], flow: [], wall: [], interface: [] };
}

/** 列出某个环境的全部探索资产，按层分组。没有记录时返回空分组 + lastRound=0。 */
export function listKnowledge(db: Db, projectId: string, env: string): KnowledgeView {
  const rows = db
    .prepare(
      `SELECT layer, entry_key, summary, rel_path, round, source_session_id, updated_at
         FROM qa_environment_knowledge WHERE project_id=? AND env=?
         ORDER BY layer, entry_key`,
    )
    .all(projectId, env) as unknown as KnowledgeRow[];
  const layers = emptyLayers();
  let lastRound = 0;
  for (const row of rows) {
    layers[row.layer].push({
      layer: row.layer,
      key: row.entry_key,
      summary: row.summary,
      relPath: row.rel_path,
      round: row.round,
      sourceSessionId: row.source_session_id,
      updatedAt: row.updated_at,
    });
    if (row.round > lastRound) lastRound = row.round;
  }
  const counts = {
    module: layers.module.length,
    flow: layers.flow.length,
    wall: layers.wall.length,
    interface: layers.interface.length,
  };
  return { env, layers, counts, lastRound };
}

export interface KnowledgeEntryInput {
  key: unknown;
  summary?: unknown;
  relPath?: unknown;
}

/**
 * 用一轮探索的结果覆盖某一层。
 *
 * 覆盖而非合并：探索是"这一轮看到的就是全部"，旧条目如果不再出现，说明它已经不成立
 * （页面改了、模块下线了），留着会让下游跑到不存在的页面。要保留历史的是假设判定，
 * 不是地图。
 */
export function replaceKnowledgeLayer(
  db: Db,
  projectId: string,
  env: string,
  layer: KnowledgeLayer,
  entries: KnowledgeEntryInput[],
  opts: { round: unknown; sessionId?: string | null },
): KnowledgeView {
  if (!KNOWLEDGE_LAYERS.includes(layer)) {
    throw new HttpError(400, "invalid_knowledge_layer", `未知的知识层：${String(layer)}`);
  }
  const rounded = normalizeRound(opts.round);
  if (!Array.isArray(entries)) throw new HttpError(400, "invalid_knowledge_entries", "条目必须是数组");
  if (entries.length > 500) throw new HttpError(400, "invalid_knowledge_entries", "单层条目上限 500 条");
  const now = new Date().toISOString();
  const normalized = entries.map((entry, index) => ({
    key: requiredText(entry?.key, `第 ${index + 1} 条的 key`, 128),
    summary: optionalText(entry?.summary, `第 ${index + 1} 条的摘要`, 500),
    relPath: optionalText(entry?.relPath, `第 ${index + 1} 条的文件路径`, 500),
  }));
  const seen = new Set<string>();
  for (const entry of normalized) {
    if (seen.has(entry.key)) {
      throw new HttpError(400, "duplicate_knowledge_key", `同一层内 key 重复：${entry.key}`);
    }
    seen.add(entry.key);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM qa_environment_knowledge WHERE project_id=? AND env=? AND layer=?").run(
      projectId,
      env,
      layer,
    );
    const insert = db.prepare(
      `INSERT INTO qa_environment_knowledge
         (project_id, env, layer, entry_key, summary, rel_path, round, source_session_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const entry of normalized) {
      insert.run(
        projectId,
        env,
        layer,
        entry.key,
        entry.summary,
        entry.relPath,
        rounded,
        opts.sessionId ?? null,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listKnowledge(db, projectId, env);
}

/** 项目的假设列表；status 过滤可选。每条带完整判定历史（从旧到新）。 */
export function listHypotheses(db: Db, projectId: string, env: string, status?: HypothesisStatus): HypothesisView[] {
  const rows = (
    status
      ? db
          .prepare(
            `SELECT * FROM qa_exploration_hypotheses WHERE project_id=? AND env=? AND status=? ORDER BY created_at`,
          )
          .all(projectId, env, status)
      : db
          .prepare(`SELECT * FROM qa_exploration_hypotheses WHERE project_id=? AND env=? ORDER BY created_at`)
          .all(projectId, env)
  ) as unknown as HypothesisRow[];
  if (rows.length === 0) return [];
  const verdicts = db
    .prepare(
      `SELECT v.* FROM qa_hypothesis_verdicts v
         JOIN qa_exploration_hypotheses h ON h.hypothesis_id = v.hypothesis_id
        WHERE h.project_id=? AND h.env=?
        ORDER BY v.round, v.created_at`,
    )
    .all(projectId, env) as unknown as (VerdictRow & { hypothesis_id: string })[];
  const grouped = new Map<string, VerdictView[]>();
  for (const row of verdicts) {
    const list = grouped.get(row.hypothesis_id) ?? [];
    list.push({
      verdictId: row.verdict_id,
      round: row.round,
      verdict: row.verdict,
      evidence: row.evidence,
      sessionId: row.session_id,
      createdAt: row.created_at,
    });
    grouped.set(row.hypothesis_id, list);
  }
  return rows.map((row) => ({
    hypothesisId: row.hypothesis_id,
    moduleKey: row.module_key,
    statement: row.statement,
    whyUnknown: row.why_unknown,
    expectation: row.expectation,
    dataSetup: row.data_setup,
    allowSeed: row.allow_seed === 1,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verdicts: grouped.get(row.hypothesis_id) ?? [],
  }));
}

export function summarizeHypotheses(db: Db, projectId: string, env: string): HypothesisSummary {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM qa_exploration_hypotheses WHERE project_id=? AND env=? GROUP BY status")
    .all(projectId, env) as unknown as { status: HypothesisStatus; n: number }[];
  const summary: HypothesisSummary = { open: 0, verified: 0, refuted: 0, unreachable: 0, total: 0 };
  for (const row of rows) {
    summary[row.status] = Number(row.n);
    summary.total += Number(row.n);
  }
  return summary;
}

export interface CreateHypothesisInput {
  moduleKey?: unknown;
  /** 未校验的外部输入：由本函数内的 requiredText 校验，不信任调用方类型。 */
  statement?: unknown;
  whyUnknown?: unknown;
  expectation?: unknown;
  dataSetup?: unknown;
  allowSeed?: unknown;
}

/**
 * 人提交一条待验证假设。
 *
 * statement 必须是可判定的句子——"退款流程很复杂"判不了。这里只做长度与形状校验，
 * 判不判定得了由提交人负责；探索回来判不出来，会在 verdict 里体现为 unreachable。
 */
export function createHypothesis(
  db: Db,
  projectId: string,
  env: string,
  input: CreateHypothesisInput,
  userId: string,
): HypothesisView {
  const statement = requiredText(input.statement, "假设内容", 500);
  const whyUnknown = normalizeWhyUnknown(input.whyUnknown);
  const moduleKey = optionalText(input.moduleKey, "模块标识", 64);
  const expectation = optionalText(input.expectation, "期望看到什么", 1000);
  const dataSetup = optionalText(input.dataSetup, "前置数据", 500);
  // 造数授权默认关：这是会真写被测系统的动作，必须逐条显式放开。
  const allowSeed = input.allowSeed === true ? 1 : 0;
  const now = new Date().toISOString();
  const hypothesisId = `hyp-${randomUUID()}`;
  db.prepare(
    `INSERT INTO qa_exploration_hypotheses
       (hypothesis_id, project_id, env, module_key, statement, why_unknown, expectation,
        data_setup, allow_seed, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
  ).run(
    hypothesisId,
    projectId,
    env,
    moduleKey,
    statement,
    whyUnknown,
    expectation,
    dataSetup,
    allowSeed,
    userId,
    now,
    now,
  );
  return findHypothesis(db, projectId, env, hypothesisId) as HypothesisView;
}

function findHypothesis(db: Db, projectId: string, env: string, hypothesisId: string): HypothesisView | null {
  return listHypotheses(db, projectId, env).find((item) => item.hypothesisId === hypothesisId) ?? null;
}

export interface AppendVerdictInput {
  round?: unknown;
  verdict?: unknown;
  evidence?: unknown;
  sessionId?: unknown;
}

/**
 * 追加一条判定。同一假设可以有多条：第 2 轮推翻、第 3 轮重新验证通过，都保留。
 * status 同步成最新一版，方便列表过滤；历史一律不动。
 */
export function appendVerdict(
  db: Db,
  projectId: string,
  env: string,
  hypothesisId: string,
  input: AppendVerdictInput,
): HypothesisView {
  const current = findHypothesis(db, projectId, env, hypothesisId);
  if (!current) throw new HttpError(404, "hypothesis_not_found", "假设不存在");
  const verdict = normalizeVerdict(input.verdict);
  const round = normalizeRound(input.round ?? current.verdicts.length + 1);
  const evidence = optionalText(input.evidence, "判定依据", 2000);
  const sessionId = optionalText(input.sessionId, "会话标识", 128);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO qa_hypothesis_verdicts (verdict_id, hypothesis_id, round, verdict, evidence, session_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`vd-${randomUUID()}`, hypothesisId, round, verdict, evidence, sessionId, now);
    db.prepare("UPDATE qa_exploration_hypotheses SET status=?, updated_at=? WHERE hypothesis_id=?").run(
      verdict,
      now,
      hypothesisId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return findHypothesis(db, projectId, env, hypothesisId) as HypothesisView;
}

/** 只有验证通过的假设才允许写回模块前置条件，这条在调用侧强制。 */
export function isVerified(view: HypothesisView): boolean {
  return view.verdicts.some((item) => item.verdict === "verified");
}

function normalizeWhyUnknown(value: unknown): WhyUnknown {
  if (value === undefined || value === null || value === "") return "business";
  if (typeof value !== "string" || !(WHY_UNKNOWN as readonly string[]).includes(value)) {
    throw new HttpError(400, "invalid_why_unknown", `探不到的原因只能是：${WHY_UNKNOWN.join(" / ")}`);
  }
  return value as WhyUnknown;
}

function normalizeVerdict(value: unknown): Verdict {
  if (typeof value !== "string" || !(VERDICTS as readonly string[]).includes(value)) {
    throw new HttpError(400, "invalid_verdict", `判定只能是：${VERDICTS.join(" / ")}`);
  }
  return value as Verdict;
}

function normalizeRound(value: unknown): number {
  const round = typeof value === "string" ? Number(value) : value;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > 10_000) {
    throw new HttpError(400, "invalid_round", "轮次必须是 1 以上的整数");
  }
  return round;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${field}必填`);
  const text = value.trim();
  if (!text) throw new HttpError(400, "invalid_field", `${field}必填`);
  if (text.length > max) throw new HttpError(400, "invalid_field", `${field}不能超过 ${max} 字`);
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${field}格式无效`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, "invalid_field", `${field}不能超过 ${max} 字`);
  return text;
}
