/**
 * A3 三层确认卡点 + A4 报告审批（批次 5）。
 *
 * 依据 v3 §23.2 第 5 条（评审 P2-2 已定稿）与批次 5 验收口径：
 *   - 卡点太密等于没有卡点——三层做法省时间但绕不过：
 *     ① 差异聚焦：只强制审「与上一版不同」的部分，未变的默认继承；
 *     ② 抽样审核：每批随机 10% 深审，抽样用确定性伪随机（seed + id 哈希），
 *        同一种子抽出的名单可复现、可审计；问题率超阈值该批退回全审；
 *     ③ 风险加权：P0 / 涉资字段 / 权限变更 → 强制全审；未标风险按强制处理——
 *        没标风险的东西不能享受省略待遇。风险强制项不受 ①② 省略。
 *   - 硬闸失败阻止报告批准；报告审批留审计。
 *
 * 与引擎侧的分工：批次 4 重放产物（replay-comparison）的四条硬闸归
 * `source/scripts/report-approval.mjs` 所有；本服务在批准时接受调用方带来的
 * 执行证据（executionEvidence，来自任务报告产物）并按同一口径评估，
 * 没带证据就不批准——不是"先批了再补"。
 *
 * 抽样结论的生命周期：换种子重抽后，不在新名单内的旧「抽样通过」作废（回到待审）；
 * 问题率超阈值时本批退回全审，横幅常驻直到逐条人工审完。
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import type { KnowledgeDb } from "./qa-project-knowledge.js";

export const CONFIRM_STATUSES = ["draft", "reviewing", "approved"] as const;
export type ConfirmStatus = (typeof CONFIRM_STATUSES)[number];

export const RISK_KINDS = ["P0", "P1", "P2", "money", "perm", "unknown"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

export const ITEM_STATUSES = ["todo", "pass", "problem", "inherit"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface ConfirmItem {
  id: string;
  type: string;                 // 需求 / 测试点 / 用例 / 自定义
  text: string;
  risk: RiskKind;
  changed: boolean;             // 与上一版是否有差异
  st: ItemStatus;
}

export interface AuditEntry {
  seq: number;
  at: string;
  action: "created" | "submitted" | "approve_blocked" | "approved" | "rejected" | "resampled";
  actor: string;
  note?: string;
  gateFailures?: { gate: string; detail: string }[];
}

export interface ExecutionEvidence {
  replay: {
    status: string;             // completed / partial
    stop_reason?: string;
    per_case: { case_id: string; verdict: string }[];
  };
}

export interface GateFailure { gate: string; detail: string }

export interface ConfirmBatchDoc {
  kind: "confirm-batch";
  batchId: string;
  projectId: string;
  title: string;
  status: ConfirmStatus;
  seed: string;
  items: ConfirmItem[];
  audit: AuditEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 服务端算好的派生视图（页面直接渲染，不再各自实现规则）。 */
export interface ConfirmBatchView {
  batch: ConfirmBatchDoc;
  sampledIds: string[];
  sampleFingerprint: string;
  smallBatch: boolean;          // 普通项 < 10 条：抽样无统计意义 → 升级全审
  retroToFull: boolean;         // 抽样问题率超阈值，本批退回全审
  mustDone: boolean;            // 必审集全部处置完成（按有效状态算）
  effective: Record<string, ItemStatus>;  // 退回全审期间抽中项的「通过」视为待审
  stats: {
    diffForced: number; inherited: number; forceFull: number; riskUnknown: number;
    sampled: number; sampledDone: number; problems: number; problemRate: string | null;
    mustRemaining: number;
  };
  /** 确认侧闸（执行证据闸在批准时按同一口径另行评估，见 approve）。 */
  gates: GateFailure[];
  /** 批准除确认闸外还必须附执行证据——这条提示随视图下发，页面如实展示。 */
  approvalNote: string;
}

export const SAMPLE_RATE = 0.1;
export const PROBLEM_THRESHOLD = 0.1;
/** 普通项少于这个数时抽样没有统计意义，整批升级为全审。 */
export const MIN_SAMPLE_POOL = 10;

/* ── 校验工具（与 qa-u3-safety 同款口径） ─────────────────────── */

const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  const raw = value.trim();
  if (raw.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (raw.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return raw;
};

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const itemId = (value: unknown): string => {
  const raw = text(value, 128, "invalid_item", "确认项编号");
  if (!ID.test(raw)) throw new HttpError(400, "invalid_item", "确认项编号只能含字母数字与 _.:-");
  return raw;
};

const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

/* ── 三层规则（纯函数，页面模型与测试共用同一口径） ───────────── */

/** 风险强制：P0 / 涉资 / 权限 → 强制全审；未标风险按强制处理。 */
export const isForceRisk = (risk: RiskKind): boolean =>
  risk === "P0" || risk === "money" || risk === "perm" || risk === "unknown";

/** 差异聚焦：与上一版有差异的强制审。 */
export const isDiff = (item: ConfirmItem): boolean => item.changed === true;

/** 必审集 = 差异项 ∪ 风险强制项（①∪③）。 */
export const isMust = (item: ConfirmItem): boolean => isForceRisk(item.risk) || isDiff(item);

/* ── 确定性抽样（与引擎侧 confirm-gate.mjs、原型同一算法） ─────── */

/** FNV-1a 32 位哈希：跨 JS/TS 实现一致，保证名单可复现。 */
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 抽样池：非必审项（避免同一条被差异/风险层和抽样层重复打扰）。 */
export const samplePool = (items: ConfirmItem[]): string[] =>
  items.filter(item => !isMust(item)).map(item => item.id);

/** 按种子确定性抽 10%（向上取整至少 1 条）；池太小返回空名单（升级全审）。 */
export function drawSample(items: ConfirmItem[], seed: string): { sampledIds: string[]; smallBatch: boolean } {
  const pool = samplePool(items);
  if (pool.length < MIN_SAMPLE_POOL) return { sampledIds: [], smallBatch: true };
  const n = Math.max(1, Math.ceil(pool.length * SAMPLE_RATE));
  const sampledIds = pool
    .map(id => ({ id, k: fnv1a(`${seed}|${id}`) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, n)
    .map(entry => entry.id);
  return { sampledIds, smallBatch: false };
}

/** 名单指纹：同种子重抽必须一致——复现性从"肉眼比对"变成"比一个哈希"。 */
export const sampleFingerprint = (seed: string, sampledIds: string[]): string =>
  fnv1a(`${seed}#${sampledIds.join(",")}`).toString(16).padStart(8, "0").slice(0, 8);

/* ── 退回全审与有效状态 ───────────────────────────────────────── */

/**
 * 抽样问题率是否超阈值。整数乘法比较，避免浮点误差：
 * problems / picked > threshold ⇔ problems*10000 > threshold*10000*picked。
 */
export function isRetroToFull(items: ConfirmItem[], sampledIds: string[]): boolean {
  if (!sampledIds.length) return false;
  const problems = sampledIds.filter(id => items.find(item => item.id === id)?.st === "problem").length;
  return problems * 10000 > PROBLEM_THRESHOLD * 10000 * sampledIds.length;
}

/** 退回全审期间，抽中项的「抽样通过」视为待审（作废，需人工重审）。 */
export function effectiveStatus(item: ConfirmItem, retro: boolean, sampled: boolean): ItemStatus {
  if (retro && sampled && item.st === "pass") return "todo";
  return item.st;
}

/* ── 硬闸（批准前置条件，不是建议） ───────────────────────────── */

/** 确认侧闸：必审集全部处置完成且抽样未退回全审。 */
export function confirmGateFailures(view: { mustDone: boolean; retroToFull: boolean }): GateFailure[] {
  const failures: GateFailure[] = [];
  if (view.retroToFull) failures.push({ gate: "sample_passed", detail: "抽样问题率超过阈值 10%，本批已退回全审；逐条人工审完才能批准。" });
  if (!view.mustDone) failures.push({ gate: "confirm_done", detail: "必审集（差异项 ∪ 风险强制项）尚有未处置项。" });
  return failures;
}

/** 执行证据闸（与 scripts/report-approval.mjs 同口径；缺证据直接闸死）。 */
export function executionGateFailures(evidence: ExecutionEvidence | null | undefined): GateFailure[] {
  const failures: GateFailure[] = [];
  if (!evidence || !evidence.replay) {
    failures.push({ gate: "evidence_present", detail: "未附重放执行证据；没有证据不批准，不是先批了再补。" });
    return failures;
  }
  const replay = evidence.replay;
  if (replay.status !== "completed") {
    failures.push({ gate: "replay_complete", detail: `重放状态为 ${replay.status}${replay.stop_reason ? `（stop_reason: ${replay.stop_reason}）` : ""}；部分重放撑不起可靠通过。` });
  }
  const perCase = Array.isArray(replay.per_case) ? replay.per_case : [];
  const unstable = perCase.filter(row => row?.verdict === "unstable").map(row => row.case_id);
  if (unstable.length) {
    failures.push({ gate: "no_unstable_in_pass", detail: `unstable 用例未隔离：${unstable.join("、")}；flaky 永不计入可靠通过。` });
  }
  const notRun = perCase.filter(row => row?.verdict === "not_run").map(row => row.case_id);
  if (notRun.length) {
    failures.push({ gate: "no_unexecuted_pass", detail: `未执行用例：${notRun.join("、")}；未执行不得出现在任何通过结论里。` });
  }
  return failures;
}

/* ── 存储 ─────────────────────────────────────────────────────── */

interface BatchRow {
  batch_id: string; project_id: string; title: string; status: string; seed: string;
  items_json: string; audit_json: string; created_by: string; created_at: string; updated_at: string;
}

const toDoc = (r: BatchRow): ConfirmBatchDoc => ({
  kind: "confirm-batch",
  batchId: r.batch_id,
  projectId: r.project_id,
  title: r.title,
  status: r.status as ConfirmStatus,
  seed: r.seed,
  items: parseJson(r.items_json, []) as ConfirmItem[],
  audit: parseJson(r.audit_json, []) as AuditEntry[],
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 审计校验：seq 必须从 1 起连续递增——断档/重复 = 记录被动过，文档不可信。 */
export const verifyAudit = (audit: AuditEntry[]): boolean =>
  audit.every((entry, index) => entry.seq === index + 1);

function appendAudit(doc: ConfirmBatchDoc, action: AuditEntry["action"], actor: string, note?: string, gateFailures?: GateFailure[]): void {
  doc.audit.push({
    seq: doc.audit.length ? (doc.audit[doc.audit.length - 1]?.seq ?? 0) + 1 : 1,
    at: new Date().toISOString(),
    action,
    actor,
    ...(note ? { note } : {}),
    ...(gateFailures?.length ? { gateFailures } : {}),
  });
}

export class QaConfirmGateStore {
  constructor(private readonly db: KnowledgeDb) {}

  private load(projectId: string, batchId: string): ConfirmBatchDoc {
    const row = this.db.prepare(
      "SELECT * FROM qa_confirm_batches WHERE project_id=? AND batch_id=?",
    ).get(projectId, batchId) as BatchRow | undefined;
    if (!row) throw new HttpError(404, "confirm_batch_not_found", "确认批次不存在。");
    return toDoc(row);
  }

  private save(doc: ConfirmBatchDoc): void {
    doc.updatedAt = new Date().toISOString();
    this.db.prepare(
      `UPDATE qa_confirm_batches SET status=?, seed=?, items_json=?, audit_json=?, updated_at=? WHERE project_id=? AND batch_id=?`,
    ).run(doc.status, doc.seed, JSON.stringify(doc.items), JSON.stringify(doc.audit), doc.updatedAt, doc.projectId, doc.batchId);
  }

  create(projectId: string, body: { title: unknown; items: unknown; seed?: unknown }, userId: string): ConfirmBatchDoc {
    const title = text(body.title, 200, "invalid_title", "批次标题");
    if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, "invalid_items", "确认项不能为空。");
    if (body.items.length > 2000) throw new HttpError(400, "invalid_items", "确认项超出单批上限（2000 条）。");
    const items: ConfirmItem[] = body.items.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "invalid_items", "确认项必须是对象。");
      const item = raw as Record<string, unknown>;
      const risk = oneOf(item.risk, RISK_KINDS, "invalid_items", "确认项风险档");
      return {
        id: itemId(item.id),
        type: text(item.type, 20, "invalid_items", "确认项类型"),
        text: text(item.text, 500, "invalid_items", "确认项内容"),
        risk,
        changed: item.changed === true,
        st: item.changed === true || isForceRisk(risk) ? "todo" : "inherit",
      };
    });
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) throw new HttpError(400, "invalid_items", `确认项编号重复：${item.id}`);
      ids.add(item.id);
    }
    const seed = body.seed === undefined ? String(Date.now()) : text(body.seed, 64, "invalid_seed", "抽样种子");
    const now = new Date().toISOString();
    const doc: ConfirmBatchDoc = {
      kind: "confirm-batch", batchId: randomUUID(), projectId, title,
      status: "draft", seed, items, audit: [], createdBy: userId, createdAt: now, updatedAt: now,
    };
    appendAudit(doc, "created", userId, `确认批次建立（${items.length} 项）`);
    this.db.prepare(
      `INSERT INTO qa_confirm_batches (batch_id, project_id, title, status, seed, items_json, audit_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(doc.batchId, projectId, doc.title, doc.status, doc.seed, JSON.stringify(doc.items), JSON.stringify(doc.audit), userId, now, now);
    return doc;
  }

  get(projectId: string, batchId: string): ConfirmBatchView {
    return buildView(this.load(projectId, batchId));
  }

  list(projectId: string, limit = 20): ConfirmBatchDoc[] {
    const rows = this.db.prepare(
      "SELECT * FROM qa_confirm_batches WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
    ).all(projectId, Math.min(Math.max(limit, 1), 100)) as BatchRow[];
    return rows.map(toDoc);
  }

  /** 重抽：换种子即换名单；不在新名单内的旧「抽样通过」作废（回到待审）。 */
  resample(projectId: string, batchId: string, seed: unknown, userId: string): ConfirmBatchView {
    const doc = this.load(projectId, batchId);
    if (doc.status === "approved") throw new HttpError(409, "confirm_batch_approved", "已批准的批次不能再重抽。");
    const nextSeed = text(seed, 64, "invalid_seed", "抽样种子");
    const before = new Set(drawSample(doc.items, doc.seed).sampledIds);
    const after = new Set(drawSample(doc.items, nextSeed).sampledIds);
    doc.seed = nextSeed;
    for (const item of doc.items) {
      if (item.st === "pass" && before.has(item.id) && !after.has(item.id) && !isMust(item)) {
        item.st = "todo";
      }
    }
    appendAudit(doc, "resampled", userId, `抽样种子改为 ${nextSeed}，名单指纹 ${sampleFingerprint(nextSeed, [...after])}`);
    this.save(doc);
    return buildView(doc);
  }

  review(projectId: string, batchId: string, entryId: string, decision: unknown, userId: string): ConfirmBatchView {
    const doc = this.load(projectId, batchId);
    if (doc.status === "approved") throw new HttpError(409, "confirm_batch_approved", "已批准的批次不能再改确认结论。");
    const item = doc.items.find(candidate => candidate.id === entryId);
    if (!item) throw new HttpError(404, "confirm_item_not_found", "确认项不存在。");
    const next = oneOf(decision, ["pass", "problem"] as const, "invalid_decision", "处置结论");
    item.st = next;
    this.save(doc);
    return buildView(doc);
  }

  submit(projectId: string, batchId: string, userId: string): ConfirmBatchView {
    const doc = this.load(projectId, batchId);
    if (doc.status !== "draft") throw new HttpError(409, "invalid_status", `只有 draft 可以送审，当前是 ${doc.status}。`);
    const view = buildView(doc);
    const blocking = confirmGateFailures(view);
    if (blocking.length) {
      throw new HttpError(409, "confirm_incomplete", `送审被阻止：${blocking.map(failure => failure.detail).join(" ")}`);
    }
    doc.status = "reviewing";
    appendAudit(doc, "submitted", userId, "必审集处置完成，送审回归报告");
    this.save(doc);
    return buildView(doc);
  }

  approve(projectId: string, batchId: string, evidence: ExecutionEvidence | null | undefined, userId: string, note?: string): ConfirmBatchView {
    const doc = this.load(projectId, batchId);
    if (doc.status !== "reviewing") throw new HttpError(409, "invalid_status", `只有 reviewing 可以批准，当前是 ${doc.status}。`);
    const view = buildView(doc);
    const failures = [...executionGateFailures(evidence), ...confirmGateFailures(view)];
    if (failures.length) {
      appendAudit(doc, "approve_blocked", userId, note, failures);
      this.save(doc);
      throw new HttpError(409, "hard_gate_failed", `硬闸阻止批准：${failures.map(failure => `${failure.gate}——${failure.detail}`).join(" ")}`, undefined, { gates: failures.map(failure => failure.gate).join(",") });
    }
    doc.status = "approved";
    appendAudit(doc, "approved", userId, note ?? "硬闸全过，报告生效");
    this.save(doc);
    return buildView(doc);
  }

  reject(projectId: string, batchId: string, reason: unknown, userId: string): ConfirmBatchView {
    const doc = this.load(projectId, batchId);
    if (doc.status !== "reviewing") throw new HttpError(409, "invalid_status", `只有 reviewing 可以退回，当前是 ${doc.status}。`);
    const why = text(reason, 500, "invalid_reason", "退回原因");
    doc.status = "draft";
    appendAudit(doc, "rejected", userId, why);
    this.save(doc);
    return buildView(doc);
  }
}

/* ── 派生视图 ─────────────────────────────────────────────────── */

function oneOf<T extends string>(value: unknown, allowed: readonly T[], code: string, label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new HttpError(400, code, `${label} 无效。`);
  return value as T;
}

export function buildView(doc: ConfirmBatchDoc): ConfirmBatchView {
  const { sampledIds, smallBatch } = drawSample(doc.items, doc.seed);
  const retro = isRetroToFull(doc.items, sampledIds);
  const sampledSet = new Set(sampledIds);
  const effective: Record<string, ItemStatus> = {};
  let mustRemaining = 0;
  for (const item of doc.items) {
    const status = effectiveStatus(item, retro, sampledSet.has(item.id));
    effective[item.id] = status;
    if (isMust(item) && status === "todo") mustRemaining += 1;
  }
  const mustDone = mustRemaining === 0;
  const sampledDone = sampledIds.filter(id => {
    const status = effective[id] ?? "todo";
    return status === "pass" || status === "problem";
  }).length;
  const problems = sampledIds.filter(id => (effective[id] ?? "todo") === "problem").length;
  return {
    batch: doc,
    sampledIds,
    sampleFingerprint: sampleFingerprint(doc.seed, sampledIds),
    smallBatch,
    retroToFull: retro,
    mustDone,
    effective,
    stats: {
      diffForced: doc.items.filter(isDiff).length,
      inherited: doc.items.filter(item => !isDiff(item)).length,
      forceFull: doc.items.filter(item => isForceRisk(item.risk)).length,
      riskUnknown: doc.items.filter(item => item.risk === "unknown").length,
      sampled: sampledIds.length,
      sampledDone,
      problems,
      problemRate: sampledIds.length ? `${Math.round(problems / sampledIds.length * 1000) / 10}%` : null,
      mustRemaining,
    },
    gates: confirmGateFailures({ mustDone, retroToFull: retro }),
    approvalNote: "批准时必须附重放执行证据（completed、无 unstable、无 not_run）；缺证据不批准。",
  };
}
