/**
 * Q3 quality traceability: immutable test design batches, per-run case results, coverage and
 * risk aggregation, project-level defect lifecycle with retests, and report evidence indexes.
 *
 * The store never derives a pass from a partial run: a case without a result, a skipped case
 * or a blocked case is not passed. Defect facts and report indexes append; they are never
 * rewritten. Every evidence reference uses the Q2 `EvidenceRef` union.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http/errors.js";
import { parseEvidenceRefs, type EvidenceRef, type KnowledgeDb } from "./qa-project-knowledge.js";

export const RISK_LEVELS = ["high", "medium", "low"] as const;
export const RESULT_STATUSES = ["passed", "failed", "skipped", "blocked"] as const;
export const DEFECT_STATUSES = ["draft", "needs_review", "confirmed", "rejected", "fixed", "closed"] as const;
export const DEFECT_CATEGORIES = ["product_defect", "script_issue", "environment_issue", "test_data_issue", "needs_review"] as const;
export const DEFECT_SEVERITIES = ["Blocker", "Critical", "Major", "Minor", "Trivial", "unknown"] as const;
export const DEFECT_PRIORITIES = ["P0", "P1", "P2", "P3", "unknown"] as const;
export const DEFECT_CONFIDENCES = ["low", "medium", "strong"] as const;
export const REPORT_CONCLUSIONS = ["passed", "failed", "partial", "blocked", "not_run"] as const;
export const QUALITY_GATES = ["blocked", "review_required", "risk_present", "informational"] as const;

export const DESIGN_MAX_POINTS = 2000;
export const DESIGN_MAX_CASES = 5000;
export const RESULT_MAX_PER_BATCH = 5000;
export const DEFECT_MAX_PER_PROJECT = 20000;
export const REPORT_MAX_EVIDENCE = 200;
export const REPORT_MAX_BYTES = 16 * 1024 * 1024;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ResultStatus = (typeof RESULT_STATUSES)[number];
export type DefectStatus = (typeof DEFECT_STATUSES)[number];
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];
export type DefectPriority = (typeof DEFECT_PRIORITIES)[number];
export type DefectConfidence = (typeof DEFECT_CONFIDENCES)[number];
export type ReportConclusion = (typeof REPORT_CONCLUSIONS)[number];
export type QualityGate = (typeof QUALITY_GATES)[number];

export interface TraceSession {
  projectId: string;
  agentId: string;
  workspace?: string;
}

export interface DesignBatch {
  batchId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  revision: number;
  status: "open" | "frozen";
  source: { type: "run" | "manual"; path?: string };
  testPointCount: number;
  testCaseCount: number;
  contentHash: string;
  createdAt: string;
  createdBy: string;
}

export interface TestPointView {
  pointKey: string;
  module: string;
  feature: string;
  description: string;
  risk: RiskLevel;
  riskLabel: string;
  coverageType: string[];
  evidenceRefs: EvidenceRef[];
  source: string;
  sourceLocator: string;
  executionLayer?: "ui" | "api" | "both";
}

export interface TestCaseView {
  caseKey: string;
  title: string;
  priority: DefectPriority;
  type: string;
  preconditions: string[];
  testData: Record<string, unknown>;
  steps: string[];
  expected: string;
  automationFeasible: boolean;
  relatedPoint: string;
  evidenceRefs: EvidenceRef[];
  designContract: Record<string, unknown>;
}

export interface DesignDetail {
  batch: DesignBatch;
  points: TestPointView[];
  cases: TestCaseView[];
}

export interface CaseResultView {
  caseKey: string;
  status: ResultStatus;
  reason: string;
  invocationId: string;
  evidenceRefs: EvidenceRef[];
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface PointCoverage {
  pointKey: string;
  module: string;
  feature: string;
  risk: RiskLevel;
  coveredBy: string[];
  status: "passed" | "failed" | "blocked" | "partial" | "untested";
  caseCounts: { passed: number; failed: number; skipped: number; blocked: number; notRun: number };
  untestedReason: string | null;
}

export interface Coverage {
  projectId: string;
  sessionId: string;
  runId: string;
  designRevision: number;
  designStatus: DesignBatch["status"];
  counts: {
    points: number;
    cases: number;
    coveredPoints: number;
    uncoveredPoints: number;
    executed: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
    untestedCases: number;
  };
  rates: { pointCoverage: number; caseExecution: number; passRate: number | null };
  risk: Record<RiskLevel, { points: number; covered: number; executed: number; failed: number; untested: number }>;
  gate: { qualityGate: QualityGate; conclusion: ReportConclusion; allPassed: boolean; complete: boolean; evidenceComplete: boolean; reasons: string[] };
  points: PointCoverage[];
  untested: { kind: "point" | "case"; id: string; reason: string }[];
}

export interface DefectView {
  defectId: string;
  projectId: string;
  fingerprint: string;
  title: string;
  category: DefectCategory;
  status: DefectStatus;
  confidence: DefectConfidence;
  severity: DefectSeverity;
  priority: DefectPriority;
  expectedResult: string;
  actualResult: string;
  analysis: string;
  duplicateOf?: string;
  relatedCases: string[];
  evidenceRefs: EvidenceRef[];
  originSessionId: string;
  originRunId: string;
  firstSeenAt: string;
  updatedAt: string;
  revision: number;
  eventCount: number;
}

export interface DefectEventView {
  eventId: string;
  sequence: number;
  action: string;
  fromStatus: string;
  toStatus: string;
  actorUserId: string;
  reason: string;
  evidenceRefs: EvidenceRef[];
  retestRunId?: string;
  prevEventHash: string;
  eventHash: string;
  createdAt: string;
}

export interface DefectOccurrenceView {
  occurrenceId: string;
  sessionId: string;
  runId: string;
  caseKey: string;
  evidenceRefs: EvidenceRef[];
  observedAt: string;
}

export interface RetestView {
  retestId: string;
  defectId: string;
  sessionId: string;
  runId: string;
  batchId: string;
  result: "passed" | "failed";
  caseResults: { caseKey: string; status: ResultStatus }[];
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  createdBy: string;
}

export interface ReportIndexView {
  reportId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  batchId: string;
  designRevision: number;
  revision: number;
  status: "published" | "superseded";
  htmlPath: string;
  htmlSha256: string;
  conclusion: ReportConclusion;
  qualityGate: QualityGate;
  counts: Coverage["counts"];
  coverage: { pointCoverage: number; caseExecution: number; passRate: number | null; allPassed: boolean };
  untested: { kind: "point" | "case"; id: string; reason: string }[];
  evidence: { label: string; ref: EvidenceRef; path?: string; sha256?: string }[];
  limitations: string[];
  openDefects: { defectId: string; status: DefectStatus; severity: DefectSeverity }[];
  resultsFingerprint: string;
  createdAt: string;
  createdBy: string;
  contentHash: string;
}

interface BatchRow {
  batch_id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  revision: number;
  status: "open" | "frozen";
  source_json: string;
  test_point_count: number;
  test_case_count: number;
  content_hash: string;
  created_at: string;
  created_by: string;
}

interface PointRow {
  point_key: string;
  module: string;
  feature: string;
  description: string;
  risk: RiskLevel;
  coverage_type_json: string;
  evidence_refs_json: string;
  source: string;
  source_locator: string;
  execution_layer: string | null;
}

interface CaseRow {
  case_key: string;
  title: string;
  priority: string;
  type: string;
  preconditions_json: string;
  test_data_json: string;
  steps_json: string;
  expected: string;
  automation_feasible: number;
  related_point_key: string;
  evidence_refs_json: string;
  design_contract_json: string;
}

interface ResultRow {
  result_id: string;
  case_key: string;
  status: ResultStatus;
  reason: string;
  invocation_id: string;
  evidence_refs_json: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface DefectRow {
  defect_id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  category: DefectCategory;
  status: DefectStatus;
  confidence: DefectConfidence;
  severity: DefectSeverity;
  priority: DefectPriority;
  expected_result: string;
  actual_result: string;
  analysis: string;
  duplicate_of: string | null;
  related_cases_json: string;
  evidence_refs_json: string;
  origin_session_id: string;
  origin_run_id: string;
  first_seen_at: string;
  updated_at: string;
  revision: number;
  event_count: number;
  last_event_hash: string;
  created_at: string;
  created_by: string;
}

interface DefectEventRow {
  event_id: string;
  defect_id: string;
  sequence: number;
  action: string;
  from_status: string;
  to_status: string;
  actor_user_id: string;
  reason: string;
  evidence_refs_json: string;
  retest_run_id: string | null;
  prev_event_hash: string;
  event_hash: string;
  created_at: string;
}

interface OccRow {
  occurrence_id: string;
  defect_id: string;
  session_id: string;
  run_id: string;
  case_key: string;
  evidence_refs_json: string;
  observed_at: string;
}

interface RetestRow {
  retest_id: string;
  defect_id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  batch_id: string;
  result: "passed" | "failed";
  case_results_json: string;
  evidence_refs_json: string;
  created_at: string;
  created_by: string;
}

interface ReportRow {
  report_id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  batch_id: string;
  revision: number;
  status: "published" | "superseded";
  html_path: string;
  html_sha256: string;
  conclusion: ReportConclusion;
  quality_gate: QualityGate;
  counts_json: string;
  coverage_json: string;
  untested_json: string;
  evidence_json: string;
  limitations_json: string;
  open_defects_json: string;
  results_fingerprint: string;
  created_at: string;
  created_by: string;
  content_hash: string;
}

const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const RISK_LABEL: Record<RiskLevel, string> = { high: "高", medium: "中", low: "低" };
const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

const object = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, code, "内容格式无效。");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  if (value.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (value.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return value;
};
const optionalText = (value: unknown, max: number, code: string, label: string): string | undefined =>
  value === undefined ? undefined : text(value, max, code, label, 0);
const nonNegativeInt = (value: unknown, code: string, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, code, `${label} 必须是非负整数。`);
  return value;
};
const positiveInt = (value: unknown, code: string, label: string): number => {
  const number = nonNegativeInt(value, code, label);
  if (number < 1) throw new HttpError(400, code, `${label} 必须是正整数。`);
  return number;
};
const bool = (value: unknown, code: string, label: string): boolean => {
  if (typeof value !== "boolean") throw new HttpError(400, code, `${label} 必须是布尔值。`);
  return value;
};
const stringArray = (value: unknown, max: number, code: string, label: string, itemMax = 500, min = 0): string[] => {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new HttpError(400, code, `${label} 必须是 ${min} 至 ${max} 项文本。`);
  return value.map((item) => text(item, itemMax, code, label));
};
const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
};
const canonical = (value: unknown) => JSON.stringify(sorted(value));
const safeRelative = (value: unknown, code: string, label: string): string => {
  const rel = text(value, 1000, code, label);
  if (rel.includes("\\") || rel.startsWith("/") || rel.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, code, `${label} 路径不安全。`);
  }
  return rel;
};
const normalizeHash = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 80, code, label);
  if (/^sha256:[a-f0-9]{64}$/.test(raw)) return raw;
  if (/^[a-f0-9]{64}$/.test(raw)) return `sha256:${raw}`;
  throw new HttpError(400, code, `${label} 必须是 SHA-256。`);
};
const normalizeRisk = (value: unknown, code: string): RiskLevel => {
  if (typeof value !== "string") throw new HttpError(400, code, "风险等级无效。");
  const raw = value.trim();
  if (raw === "高" || raw === "high") return "high";
  if (raw === "中" || raw === "medium") return "medium";
  if (raw === "低" || raw === "low") return "low";
  throw new HttpError(400, code, "风险等级必须是高/中/低。");
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], code: string, label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new HttpError(400, code, `${label} 无效。`);
  return value as T;
};
const optionalOneOf = <T extends string>(value: unknown, allowed: readonly T[], code: string, label: string): T | undefined =>
  value === undefined ? undefined : oneOf(value, allowed, code, label);
const encodeCursor = (updatedAt: string, id: string) => Buffer.from(JSON.stringify([updatedAt, id]), "utf8").toString("base64url");
const decodeCursor = (raw: string | undefined, code: string): { updatedAt: string; id: string } | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") throw Error("bad");
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    throw new HttpError(400, code, "分页游标无效。");
  }
};

export class QaQualityTraceabilityStore {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly db: KnowledgeDb,
    private readonly findSession: (sessionId: string) => TraceSession | null = () => null,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private count(sql: string, ...params: unknown[]): number {
    return Number((this.db.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);
  }

  private session(projectId: string, sessionId: string): TraceSession {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    const session = this.findSession(sessionId);
    if (!session || session.projectId !== projectId) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    return session;
  }

  private task(projectId: string, sessionId: string, runId: string): TraceSession {
    const session = this.session(projectId, sessionId);
    if (!RUN_ID.test(runId)) throw new HttpError(400, "invalid_result", "运行标识无效。");
    return session;
  }

  private evidence(projectId: string, refs: EvidenceRef[], code: string, bind: { sessionId?: string; runId?: string } = {}): EvidenceRef[] {
    for (const ref of refs) {
      if (ref.type === "document") {
        const row = this.db.prepare(`SELECT r.revision_id FROM qa_document_revisions r
          JOIN qa_documents d ON d.document_id=r.document_id
          WHERE d.project_id=? AND d.document_id=? AND r.revision=?`).get(projectId, ref.documentId, ref.revision) as { revision_id: string } | undefined;
        if (!row) throw new HttpError(400, code, "资料证据不存在或不属于当前项目。");
        if (ref.revisionId !== undefined && ref.revisionId !== row.revision_id) throw new HttpError(400, code, "资料证据修订标识不匹配。");
      } else if (ref.type === "rule") {
        const row = this.db.prepare("SELECT 1 AS ok FROM qa_rule_versions WHERE project_id=? AND rule_id=? AND version=?")
          .get(projectId, ref.ruleId, ref.version) as { ok?: number } | undefined;
        if (!row) throw new HttpError(400, code, "规则证据不存在或不属于当前项目。");
      } else if (ref.type === "execution") {
        const session = this.findSession(String(ref.sessionId));
        if (!session || session.projectId !== projectId) throw new HttpError(400, code, "执行证据任务不存在或不属于当前项目。");
        if (bind.sessionId && ref.sessionId !== bind.sessionId) throw new HttpError(400, code, "执行证据不属于当前任务。");
        if (bind.runId && ref.runId !== bind.runId) throw new HttpError(400, code, "执行证据不属于当前运行。");
      }
    }
    return refs;
  }

  // ---------------------------------------------------------------- design

  private latestBatchRow(projectId: string, sessionId: string, runId: string): BatchRow | undefined {
    return this.db.prepare("SELECT * FROM qa_design_batches WHERE project_id=? AND session_id=? AND run_id=? ORDER BY revision DESC LIMIT 1")
      .get(projectId, sessionId, runId) as BatchRow | undefined;
  }

  private batchRow(projectId: string, batchId: string): BatchRow | undefined {
    return this.db.prepare("SELECT * FROM qa_design_batches WHERE project_id=? AND batch_id=?").get(projectId, batchId) as BatchRow | undefined;
  }

  private mapBatch(row: BatchRow): DesignBatch {
    return {
      batchId: row.batch_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      runId: row.run_id,
      revision: row.revision,
      status: row.status,
      source: parseJson(row.source_json, { type: "run" as const }),
      testPointCount: row.test_point_count,
      testCaseCount: row.test_case_count,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }

  private mapPoint(row: PointRow): TestPointView {
    return {
      pointKey: row.point_key,
      module: row.module,
      feature: row.feature,
      description: row.description,
      risk: row.risk,
      riskLabel: RISK_LABEL[row.risk],
      coverageType: parseJson(row.coverage_type_json, []),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      source: row.source,
      sourceLocator: row.source_locator,
      ...(row.execution_layer ? { executionLayer: row.execution_layer as "ui" | "api" | "both" } : {})
    };
  }

  private mapCase(row: CaseRow): TestCaseView {
    return {
      caseKey: row.case_key,
      title: row.title,
      priority: row.priority as DefectPriority,
      type: row.type,
      preconditions: parseJson(row.preconditions_json, []),
      testData: parseJson(row.test_data_json, {}),
      steps: parseJson(row.steps_json, []),
      expected: row.expected,
      automationFeasible: row.automation_feasible === 1,
      relatedPoint: row.related_point_key,
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      designContract: parseJson(row.design_contract_json, {})
    };
  }

  private parsePoint(projectId: string, value: unknown, code: string): Omit<TestPointView, "riskLabel"> {
    const point = object(value, code);
    const pointKey = text(point.id, 100, code, "测试点编号");
    if (!KEY.test(pointKey)) throw new HttpError(400, code, "测试点编号格式无效。");
    const coverageType = stringArray(point.coverageType, 50, code, "覆盖类型", 100);
    const evidenceRefs = this.evidence(projectId, parseEvidenceRefs(point.evidenceRefs, code), code);
    const source = optionalText(point.source, 1000, code, "来源文件") ?? "";
    const sourceLocator = optionalText(point.sourceLocator, 300, code, "来源定位") ?? "";
    const executionLayer = optionalOneOf(point.executionLayer, ["ui", "api", "both"] as const, code, "执行层");
    return {
      pointKey,
      module: text(point.module, 200, code, "模块"),
      feature: text(point.feature, 200, code, "功能"),
      description: text(point.description, 5000, code, "测试点描述"),
      risk: normalizeRisk(point.risk, code),
      coverageType,
      evidenceRefs,
      source,
      sourceLocator,
      ...(executionLayer ? { executionLayer } : {})
    };
  }

  private parseCase(projectId: string, value: unknown, code: string, pointKeys: Set<string>): TestCaseView {
    const item = object(value, code);
    const caseKey = text(item.caseId, 100, code, "用例编号");
    if (!KEY.test(caseKey)) throw new HttpError(400, code, "用例编号格式无效。");
    const relatedPoint = text(item.relatedTestPoint, 100, code, "关联测试点");
    if (!pointKeys.has(relatedPoint)) throw new HttpError(400, code, "用例关联的测试点不在本批次。");
    const evidenceRefs = this.evidence(projectId, parseEvidenceRefs(item.evidenceRefs, code), code);
    return {
      caseKey,
      title: text(item.title, 300, code, "用例标题"),
      priority: oneOf(item.priority, DEFECT_PRIORITIES.slice(0, 4) as readonly DefectPriority[], code, "优先级"),
      type: optionalText(item.type, 100, code, "用例类型") ?? "",
      preconditions: stringArray(item.preconditions, 50, code, "前置条件", 1000),
      testData: item.testData === undefined ? {} : object(item.testData, code),
      steps: stringArray(item.steps, 200, code, "步骤", 2000),
      expected: text(item.expected, 10000, code, "预期结果"),
      automationFeasible: bool(item.automationFeasible, code, "可自动化标记"),
      relatedPoint,
      evidenceRefs,
      designContract: item.designContract === undefined ? {} : object(item.designContract, code)
    };
  }

  createDesignBatch(input: {
    projectId: string;
    sessionId: string;
    runId: string;
    userId: string;
    expectedRevision?: number;
    source?: unknown;
    points: unknown;
    cases: unknown;
  }): { created: boolean; batch: DesignBatch } {
    this.task(input.projectId, input.sessionId, input.runId);
    if (!Array.isArray(input.points) || !input.points.length || input.points.length > DESIGN_MAX_POINTS) {
      throw new HttpError(400, "invalid_design", `测试点必须是 1 至 ${DESIGN_MAX_POINTS} 项。`);
    }
    if (!Array.isArray(input.cases) || input.cases.length > DESIGN_MAX_CASES) {
      throw new HttpError(400, "invalid_design", `用例必须不超过 ${DESIGN_MAX_CASES} 项。`);
    }
    const source = input.source === undefined ? { type: "run" as const } : object(input.source, "invalid_design");
    if (source.type !== "run" && source.type !== "manual") throw new HttpError(400, "invalid_design", "设计来源无效。");
    if (Object.keys(source).some((key) => !["type", "path"].includes(key))) throw new HttpError(400, "invalid_design", "设计来源含未允许的字段。");
    const normalizedSource = { type: source.type as "run" | "manual", ...(source.path === undefined ? {} : { path: safeRelative(source.path, "invalid_design", "设计来源路径") }) };

    const points = input.points.map((point) => this.parsePoint(input.projectId, point, "invalid_design"));
    const pointKeys = new Set<string>();
    for (const point of points) {
      if (pointKeys.has(point.pointKey)) throw new HttpError(400, "invalid_design", "测试点编号重复。");
      pointKeys.add(point.pointKey);
    }
    const cases = input.cases.map((item) => this.parseCase(input.projectId, item, "invalid_design", pointKeys));
    const caseKeys = new Set<string>();
    for (const item of cases) {
      if (caseKeys.has(item.caseKey)) throw new HttpError(400, "invalid_design", "用例编号重复。");
      caseKeys.add(item.caseKey);
    }
    for (const point of points) {
      if (!cases.some((item) => item.relatedPoint === point.pointKey)) {
        // An uncovered point is a valid design gap; coverage will list it as untested.
      }
    }
    const contentHash = sha256(canonical({ source: normalizedSource, points, cases }));
    const latest = this.latestBatchRow(input.projectId, input.sessionId, input.runId);
    if (latest && latest.content_hash === contentHash) return { created: false, batch: this.mapBatch(latest) };
    if (latest && latest.status === "frozen") throw new HttpError(409, "design_frozen", "本次运行已有执行结果，设计不能再变更。");
    const expected = input.expectedRevision;
    if (latest) {
      if (expected === undefined || expected !== latest.revision) throw new HttpError(409, "design_revision_conflict", "设计批次版本已变化。");
    } else if (expected !== undefined && expected !== 0) {
      throw new HttpError(409, "design_revision_conflict", "首次设计批次版本必须为 0 或省略。");
    }
    const at = iso(this.now());
    const batchId = `batch-${this.id()}`;
    const revision = latest ? latest.revision + 1 : 1;
    this.tx(() => {
      this.db.prepare(`INSERT INTO qa_design_batches
        (batch_id,project_id,session_id,run_id,revision,status,source_json,test_point_count,test_case_count,content_hash,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batchId, input.projectId, input.sessionId, input.runId, revision, "open", JSON.stringify(normalizedSource), points.length, cases.length, contentHash, at, input.userId
      );
      for (const point of points) {
        this.db.prepare(`INSERT INTO qa_test_points
          (row_id,batch_id,project_id,point_key,module,feature,description,risk,coverage_type_json,evidence_refs_json,source,source_locator,execution_layer,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          `tp-${this.id()}`, batchId, input.projectId, point.pointKey, point.module, point.feature, point.description, point.risk,
          JSON.stringify(point.coverageType), JSON.stringify(point.evidenceRefs), point.source, point.sourceLocator, point.executionLayer ?? null, at
        );
      }
      for (const item of cases) {
        this.db.prepare(`INSERT INTO qa_test_cases
          (row_id,batch_id,project_id,case_key,title,priority,type,preconditions_json,test_data_json,steps_json,expected,automation_feasible,related_point_key,evidence_refs_json,design_contract_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          `tc-${this.id()}`, batchId, input.projectId, item.caseKey, item.title, item.priority, item.type,
          JSON.stringify(item.preconditions), JSON.stringify(item.testData), JSON.stringify(item.steps), item.expected,
          item.automationFeasible ? 1 : 0, item.relatedPoint, JSON.stringify(item.evidenceRefs), JSON.stringify(item.designContract), at
        );
      }
    });
    return { created: true, batch: this.mapBatch(this.batchRow(input.projectId, batchId)!) };
  }

  getDesign(projectId: string, sessionId: string, runId: string): DesignDetail {
    this.task(projectId, sessionId, runId);
    const batch = this.latestBatchRow(projectId, sessionId, runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    const points = this.db.prepare("SELECT * FROM qa_test_points WHERE batch_id=? ORDER BY rowid").all(batch.batch_id) as PointRow[];
    const cases = this.db.prepare("SELECT * FROM qa_test_cases WHERE batch_id=? ORDER BY rowid").all(batch.batch_id) as CaseRow[];
    return { batch: this.mapBatch(batch), points: points.map((row) => this.mapPoint(row)), cases: cases.map((row) => this.mapCase(row)) };
  }

  listDesignBatches(projectId: string, sessionId: string, runId: string): { batches: DesignBatch[] } {
    this.task(projectId, sessionId, runId);
    const rows = this.db.prepare("SELECT * FROM qa_design_batches WHERE project_id=? AND session_id=? AND run_id=? ORDER BY revision DESC")
      .all(projectId, sessionId, runId) as BatchRow[];
    return { batches: rows.map((row) => this.mapBatch(row)) };
  }

  // ---------------------------------------------------------------- results and coverage

  private mapResult(row: ResultRow): CaseResultView {
    return {
      caseKey: row.case_key,
      status: row.status,
      reason: row.reason,
      invocationId: row.invocation_id,
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      updatedAt: row.updated_at
    };
  }

  ingestResults(input: {
    projectId: string;
    sessionId: string;
    runId: string;
    userId: string;
    expectedRevision: number;
    invocationId: unknown;
    results: unknown;
  }): { idempotent: boolean; designRevision: number; invocationId: string; stored: number; coverage: Coverage } {
    this.task(input.projectId, input.sessionId, input.runId);
    const batch = this.latestBatchRow(input.projectId, input.sessionId, input.runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    if (positiveInt(input.expectedRevision, "invalid_result", "expectedRevision") !== batch.revision) {
      throw new HttpError(409, "design_revision_conflict", "设计批次版本已变化。");
    }
    const invocationId = text(input.invocationId, 200, "invalid_result", "调用标识");
    if (!/^[A-Za-z0-9_.:-]+$/.test(invocationId)) throw new HttpError(400, "invalid_result", "调用标识格式无效。");
    if (!Array.isArray(input.results) || input.results.length > RESULT_MAX_PER_BATCH) throw new HttpError(400, "invalid_result", "执行结果格式无效。");
    const cases = this.db.prepare("SELECT case_key FROM qa_test_cases WHERE batch_id=?").all(batch.batch_id) as { case_key: string }[];
    const caseKeys = new Set(cases.map((row) => row.case_key));
    const seen = new Set<string>();
    const parsed = input.results.map((raw) => {
      const item = object(raw, "invalid_result");
      const caseKey = text(item.caseId, 100, "invalid_result", "用例编号");
      if (!caseKeys.has(caseKey)) throw new HttpError(400, "unknown_case", "执行结果引用了本批次不存在的用例。");
      if (seen.has(caseKey)) throw new HttpError(400, "invalid_result", "执行结果中用例重复。");
      seen.add(caseKey);
      const status = oneOf(item.status, RESULT_STATUSES, "invalid_result", "结果状态");
      const reason = optionalText(item.reason, 2000, "invalid_result", "原因") ?? "";
      if ((status === "skipped" || status === "blocked") && !reason) throw new HttpError(400, "invalid_result", "跳过或阻塞必须说明原因。");
      const refs = item.evidenceRefs === undefined ? [] : parseEvidenceRefs(item.evidenceRefs, "invalid_result");
      if (status === "failed" && !refs.length) throw new HttpError(400, "invalid_result", "失败结果必须带证据。");
      this.evidence(input.projectId, refs, "invalid_result", { sessionId: input.sessionId, runId: input.runId });
      const startedAt = optionalText(item.startedAt, 40, "invalid_result", "开始时间");
      const finishedAt = optionalText(item.finishedAt, 40, "invalid_result", "结束时间");
      if (startedAt && Number.isNaN(Date.parse(startedAt))) throw new HttpError(400, "invalid_result", "开始时间格式无效。");
      if (finishedAt && Number.isNaN(Date.parse(finishedAt))) throw new HttpError(400, "invalid_result", "结束时间格式无效。");
      if (startedAt && finishedAt && Date.parse(startedAt) > Date.parse(finishedAt)) throw new HttpError(400, "invalid_result", "结束时间不能早于开始时间。");
      return { caseKey, status, reason, refs, startedAt, finishedAt };
    });
    let changed = 0;
    const at = iso(this.now());
    this.tx(() => {
      for (const item of parsed) {
        const existing = this.db.prepare("SELECT * FROM qa_case_results WHERE project_id=? AND run_id=? AND case_key=?")
          .get(input.projectId, input.runId, item.caseKey) as ResultRow | undefined;
        if (existing) {
          if (existing.invocation_id === invocationId && existing.status === item.status &&
            existing.reason === item.reason && canonical(parseJson(existing.evidence_refs_json, [])) === canonical(item.refs)) continue;
          this.db.prepare(`UPDATE qa_case_results SET status=?,reason=?,invocation_id=?,evidence_refs_json=?,started_at=?,finished_at=?,updated_at=?
            WHERE result_id=?`).run(item.status, item.reason, invocationId, JSON.stringify(item.refs), item.startedAt ?? null, item.finishedAt ?? null, at, existing.result_id);
          changed++;
        } else {
          this.db.prepare(`INSERT INTO qa_case_results
            (result_id,project_id,session_id,run_id,batch_id,case_key,status,reason,invocation_id,evidence_refs_json,started_at,finished_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            `res-${this.id()}`, input.projectId, input.sessionId, input.runId, batch.batch_id, item.caseKey, item.status, item.reason,
            invocationId, JSON.stringify(item.refs), item.startedAt ?? null, item.finishedAt ?? null, at, at
          );
          changed++;
        }
      }
      this.db.prepare("UPDATE qa_design_batches SET status='frozen' WHERE batch_id=?").run(batch.batch_id);
    });
    return { idempotent: changed === 0, designRevision: batch.revision, invocationId, stored: parsed.length, coverage: this.readCoverage(input.projectId, input.sessionId, input.runId) };
  }

  listResults(projectId: string, sessionId: string, runId: string): { designRevision: number; results: CaseResultView[] } {
    this.task(projectId, sessionId, runId);
    const batch = this.latestBatchRow(projectId, sessionId, runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    const rows = this.db.prepare("SELECT * FROM qa_case_results WHERE project_id=? AND run_id=? ORDER BY case_key").all(projectId, runId) as ResultRow[];
    return { designRevision: batch.revision, results: rows.map((row) => this.mapResult(row)) };
  }

  readCoverage(projectId: string, sessionId: string, runId: string): Coverage {
    this.task(projectId, sessionId, runId);
    const batch = this.latestBatchRow(projectId, sessionId, runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    const points = this.db.prepare("SELECT * FROM qa_test_points WHERE batch_id=? ORDER BY rowid").all(batch.batch_id) as PointRow[];
    const cases = this.db.prepare("SELECT * FROM qa_test_cases WHERE batch_id=? ORDER BY rowid").all(batch.batch_id) as CaseRow[];
    const results = new Map((this.db.prepare("SELECT * FROM qa_case_results WHERE project_id=? AND run_id=?")
      .all(projectId, runId) as ResultRow[]).map((row) => [row.case_key, row]));

    const counts = { points: points.length, cases: cases.length, coveredPoints: 0, uncoveredPoints: 0, executed: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, untestedCases: 0 };
    const risk: Coverage["risk"] = {
      high: { points: 0, covered: 0, executed: 0, failed: 0, untested: 0 },
      medium: { points: 0, covered: 0, executed: 0, failed: 0, untested: 0 },
      low: { points: 0, covered: 0, executed: 0, failed: 0, untested: 0 }
    };
    const pointViews: PointCoverage[] = [];
    const untested: Coverage["untested"] = [];
    const casesByPoint = new Map<string, CaseRow[]>();
    for (const item of cases) {
      const list = casesByPoint.get(item.related_point_key) ?? [];
      list.push(item);
      casesByPoint.set(item.related_point_key, list);
    }
    for (const item of cases) {
      const result = results.get(item.case_key);
      if (!result) counts.untestedCases++;
      else if (result.status === "passed") { counts.passed++; counts.executed++; }
      else if (result.status === "failed") { counts.failed++; counts.executed++; }
      else if (result.status === "skipped") { counts.skipped++; counts.untestedCases++; }
      else { counts.blocked++; counts.untestedCases++; }
      if (!result) untested.push({ kind: "case", id: item.case_key, reason: "本次运行未执行" });
      else if (result.status === "skipped") untested.push({ kind: "case", id: item.case_key, reason: result.reason });
      else if (result.status === "blocked") untested.push({ kind: "case", id: item.case_key, reason: result.reason });
    }
    for (const point of points) {
      const related = casesByPoint.get(point.point_key) ?? [];
      const stats = { passed: 0, failed: 0, skipped: 0, blocked: 0, notRun: 0 };
      for (const item of related) {
        const result = results.get(item.case_key);
        if (!result) stats.notRun++;
        else stats[result.status]++;
      }
      let status: PointCoverage["status"];
      let reason: string | null = null;
      if (!related.length) {
        status = "untested";
        reason = "无关联用例";
        untested.push({ kind: "point", id: point.point_key, reason });
        counts.uncoveredPoints++;
        risk[point.risk].untested++;
      } else {
        counts.coveredPoints++;
        risk[point.risk].covered++;
        if (stats.failed) status = "failed";
        else if (stats.blocked) status = "blocked";
        else if (stats.skipped || stats.notRun) status = stats.notRun === related.length ? "untested" : "partial";
        else status = "passed";
        if (status === "untested") reason = "关联用例均未执行";
        else if (status === "partial") reason = stats.notRun ? "部分关联用例未执行" : "存在跳过用例";
        if (status === "untested" || status === "partial" || status === "blocked") risk[point.risk].untested++;
        if (status === "failed") risk[point.risk].failed++;
        if (stats.passed + stats.failed > 0) risk[point.risk].executed++;
      }
      risk[point.risk].points++;
      pointViews.push({
        pointKey: point.point_key,
        module: point.module,
        feature: point.feature,
        risk: point.risk,
        coveredBy: related.map((item) => item.case_key),
        status,
        caseCounts: stats,
        untestedReason: reason
      });
    }
    const pointCoverage = counts.points ? counts.coveredPoints / counts.points : 0;
    const caseExecution = counts.cases ? counts.executed / counts.cases : 0;
    const passRate = counts.executed ? counts.passed / counts.executed : null;
    const allPassed = counts.points > 0 && counts.cases > 0 && counts.uncoveredPoints === 0 &&
      counts.cases === counts.passed && counts.failed === 0 && counts.skipped === 0 && counts.blocked === 0;
    const complete = counts.points > 0 && counts.cases > 0 && counts.uncoveredPoints === 0 &&
      counts.failed + counts.passed + counts.skipped + counts.blocked === counts.cases;
    const evidenceComplete = (this.db.prepare("SELECT count(*) AS n FROM qa_case_results WHERE project_id=? AND run_id=? AND status='failed' AND evidence_refs_json='[]'")
      .get(projectId, runId) as { n: number }).n === 0;
    const reasons: string[] = [];
    if (counts.failed) reasons.push("存在失败用例");
    if (counts.blocked) reasons.push("存在阻塞用例");
    if (counts.skipped) reasons.push("存在跳过用例");
    if (counts.uncoveredPoints) reasons.push("存在无关联用例的测试点");
    if (counts.untestedCases) reasons.push("存在未执行或未通过的用例");
    if (!evidenceComplete) reasons.push("失败结果缺少证据");
    let qualityGate: QualityGate;
    if (counts.failed || counts.blocked || !evidenceComplete) qualityGate = "blocked";
    else if (counts.untestedCases || counts.uncoveredPoints) {
      const highUntested = risk.high.untested > 0;
      qualityGate = highUntested ? "risk_present" : "review_required";
    } else qualityGate = "informational";
    let conclusion: ReportConclusion;
    if (counts.failed) conclusion = "failed";
    else if (counts.blocked) conclusion = "blocked";
    else if (counts.executed === 0) conclusion = "not_run";
    else if (allPassed) conclusion = "passed";
    else conclusion = "partial";
    return {
      projectId,
      sessionId,
      runId,
      designRevision: batch.revision,
      designStatus: batch.status,
      counts,
      rates: { pointCoverage, caseExecution, passRate },
      risk,
      gate: { qualityGate, conclusion, allPassed, complete, evidenceComplete, reasons },
      points: pointViews,
      untested
    };
  }

  // ---------------------------------------------------------------- defects

  private defectRow(projectId: string, defectId: string): DefectRow {
    const row = this.db.prepare("SELECT * FROM qa_defects WHERE project_id=? AND defect_id=?").get(projectId, defectId) as DefectRow | undefined;
    if (!row) throw new HttpError(404, "defect_not_found", "项目内没有该缺陷。");
    return row;
  }

  private mapDefect(row: DefectRow): DefectView {
    return {
      defectId: row.defect_id,
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      title: row.title,
      category: row.category,
      status: row.status,
      confidence: row.confidence,
      severity: row.severity,
      priority: row.priority,
      expectedResult: row.expected_result,
      actualResult: row.actual_result,
      analysis: row.analysis,
      ...(row.duplicate_of ? { duplicateOf: row.duplicate_of } : {}),
      relatedCases: parseJson(row.related_cases_json, []),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      originSessionId: row.origin_session_id,
      originRunId: row.origin_run_id,
      firstSeenAt: row.first_seen_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      eventCount: row.event_count
    };
  }

  private mapEvent(row: DefectEventRow): DefectEventView {
    return {
      eventId: row.event_id,
      sequence: row.sequence,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorUserId: row.actor_user_id,
      reason: row.reason,
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      ...(row.retest_run_id ? { retestRunId: row.retest_run_id } : {}),
      prevEventHash: row.prev_event_hash,
      eventHash: row.event_hash,
      createdAt: row.created_at
    };
  }

  private appendEvent(input: {
    projectId: string;
    defect: DefectRow;
    action: string;
    fromStatus: string;
    toStatus: DefectStatus;
    userId: string;
    reason: string;
    evidenceRefs: EvidenceRef[];
    retestRunId?: string;
    at: string;
  }): { sequence: number; hash: string } {
    const sequence = input.defect.event_count + 1;
    const prev = input.defect.last_event_hash;
    const payload = {
      defectId: input.defect.defect_id,
      sequence,
      action: input.action,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorUserId: input.userId,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs,
      retestRunId: input.retestRunId ?? null,
      createdAt: input.at
    };
    const hash = sha256(`${prev}|${canonical(payload)}`);
    this.db.prepare(`INSERT INTO qa_defect_events
      (event_id,defect_id,project_id,sequence,action,from_status,to_status,actor_user_id,reason,evidence_refs_json,retest_run_id,prev_event_hash,event_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `evt-${this.id()}`, input.defect.defect_id, input.projectId, sequence, input.action, input.fromStatus, input.toStatus,
      input.userId, input.reason, JSON.stringify(input.evidenceRefs), input.retestRunId ?? null, prev, hash, input.at
    );
    this.db.prepare("UPDATE qa_defects SET status=?,revision=revision+1,event_count=?,last_event_hash=?,updated_at=? WHERE defect_id=?")
      .run(input.toStatus, sequence, hash, input.at, input.defect.defect_id);
    return { sequence, hash };
  }

  private fingerprintOf(input: { fingerprint?: unknown; category: DefectCategory; title: string; relatedCases: string[]; expectedResult: string; actualResult: string }): string {
    const computed = sha256(canonical({
      category: input.category,
      title: input.title,
      relatedCases: [...input.relatedCases].sort(),
      expectedResult: input.expectedResult,
      actualResult: input.actualResult
    }));
    if (input.fingerprint !== undefined && normalizeHash(input.fingerprint, "invalid_defect", "缺陷指纹") !== computed) {
      throw new HttpError(400, "invalid_defect", "客户端缺陷指纹与服务端计算结果不一致。");
    }
    return computed;
  }

  discoverDefect(input: {
    projectId: string;
    sessionId: string;
    runId: string;
    userId: string;
    fingerprint?: unknown;
    title: unknown;
    category: unknown;
    confidence?: unknown;
    severity?: unknown;
    priority?: unknown;
    expectedResult?: unknown;
    actualResult?: unknown;
    analysis?: unknown;
    duplicateOf?: unknown;
    relatedCases: unknown;
    evidenceRefs: unknown;
    initialStatus?: unknown;
  }): { created: boolean; occurrenceAdded: boolean; defect: DefectView } {
    this.task(input.projectId, input.sessionId, input.runId);
    const batch = this.latestBatchRow(input.projectId, input.sessionId, input.runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    const relatedCases = stringArray(input.relatedCases, 100, "invalid_defect", "关联用例", 100, 1);
    const caseKeys = new Set((this.db.prepare("SELECT case_key FROM qa_test_cases WHERE batch_id=?").all(batch.batch_id) as { case_key: string }[]).map((row) => row.case_key));
    for (const caseKey of relatedCases) {
      if (!caseKeys.has(caseKey)) throw new HttpError(400, "unknown_case", "缺陷引用了本批次不存在的用例。");
      const result = this.db.prepare("SELECT status FROM qa_case_results WHERE project_id=? AND run_id=? AND case_key=?")
        .get(input.projectId, input.runId, caseKey) as { status: ResultStatus } | undefined;
      if (!result || result.status !== "failed") throw new HttpError(400, "invalid_defect", "缺陷只能关联本运行中真实失败的用例。");
    }
    const refs = parseEvidenceRefs(input.evidenceRefs, "invalid_defect");
    this.evidence(input.projectId, refs, "invalid_defect", { sessionId: input.sessionId, runId: input.runId });
    const category = oneOf(input.category, DEFECT_CATEGORIES, "invalid_defect", "缺陷分类");
    const title = text(input.title, 300, "invalid_defect", "缺陷标题");
    const expectedResult = optionalText(input.expectedResult, 10000, "invalid_defect", "预期结果") ?? "";
    const actualResult = optionalText(input.actualResult, 10000, "invalid_defect", "实际结果") ?? "";
    const analysis = optionalText(input.analysis, 10000, "invalid_defect", "分析") ?? "";
    const initialStatus = optionalOneOf(input.initialStatus, ["draft", "needs_review"] as const, "invalid_defect", "初始状态") ??
      (category === "needs_review" ? "needs_review" : "draft");
    const confidence = optionalOneOf(input.confidence, DEFECT_CONFIDENCES, "invalid_defect", "置信度") ?? "low";
    const severity = optionalOneOf(input.severity, DEFECT_SEVERITIES, "invalid_defect", "严重程度") ?? "unknown";
    const priority = optionalOneOf(input.priority, DEFECT_PRIORITIES, "invalid_defect", "优先级") ?? "unknown";
    let duplicateOf: string | undefined;
    if (input.duplicateOf !== undefined) {
      duplicateOf = text(input.duplicateOf, 100, "invalid_defect", "重复缺陷");
      this.defectRow(input.projectId, duplicateOf);
    }
    const fingerprint = this.fingerprintOf({ fingerprint: input.fingerprint, category, title, relatedCases, expectedResult, actualResult });
    const existing = this.db.prepare("SELECT * FROM qa_defects WHERE project_id=? AND fingerprint=?").get(input.projectId, fingerprint) as DefectRow | undefined;
    const at = iso(this.now());
    if (existing) {
      if (existing.category !== category || existing.title !== title ||
          existing.expected_result !== expectedResult || existing.actual_result !== actualResult ||
          canonical([...JSON.parse(existing.related_cases_json) as string[]].sort()) !== canonical([...relatedCases].sort())) {
        throw new HttpError(409, "defect_fingerprint_conflict", "缺陷指纹命中的记录与本次缺陷语义不一致。");
      }
      const occurrence = this.db.prepare("SELECT 1 AS ok FROM qa_defect_occurrences WHERE defect_id=? AND run_id=? AND case_key=?")
        .get(existing.defect_id, input.runId, relatedCases[0]) as { ok?: number } | undefined;
      if (occurrence) return { created: false, occurrenceAdded: false, defect: this.mapDefect(existing) };
      if (existing.status === "closed" || existing.status === "rejected") {
        throw new HttpError(409, "defect_status_conflict", "已关闭或已驳回缺陷不能自动归并；请由项目所有者复核并显式复测，或登记语义不同的新缺陷。");
      }
      this.tx(() => {
        this.db.prepare(`INSERT INTO qa_defect_occurrences
          (occurrence_id,defect_id,project_id,session_id,run_id,case_key,evidence_refs_json,observed_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          `occ-${this.id()}`, existing.defect_id, input.projectId, input.sessionId, input.runId, relatedCases[0], JSON.stringify(refs), at, at
        );
        this.appendEvent({
          projectId: input.projectId, defect: existing, action: "observed", fromStatus: existing.status, toStatus: existing.status,
          userId: input.userId, reason: "", evidenceRefs: refs, at
        });
      });
      return { created: false, occurrenceAdded: true, defect: this.mapDefect(this.defectRow(input.projectId, existing.defect_id)) };
    }
    if (this.count("SELECT count(*) AS n FROM qa_defects WHERE project_id=?", input.projectId) >= DEFECT_MAX_PER_PROJECT) {
      throw new HttpError(409, "defect_limit", "项目缺陷数量已达上限。");
    }
    const defectId = `bug-${this.id()}`;
    this.tx(() => {
      this.db.prepare(`INSERT INTO qa_defects
        (defect_id,project_id,fingerprint,title,category,status,confidence,severity,priority,expected_result,actual_result,analysis,duplicate_of,
         related_cases_json,evidence_refs_json,origin_session_id,origin_run_id,first_seen_at,updated_at,revision,event_count,last_event_hash,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        defectId, input.projectId, fingerprint, title, category, initialStatus, confidence, severity, priority,
        expectedResult, actualResult, analysis, duplicateOf ?? null, JSON.stringify(relatedCases), JSON.stringify(refs),
        input.sessionId, input.runId, at, at, 0, 0, "", at, input.userId
      );
      this.db.prepare(`INSERT INTO qa_defect_occurrences
        (occurrence_id,defect_id,project_id,session_id,run_id,case_key,evidence_refs_json,observed_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        `occ-${this.id()}`, defectId, input.projectId, input.sessionId, input.runId, relatedCases[0], JSON.stringify(refs), at, at
      );
      const created = this.defectRow(input.projectId, defectId);
      this.appendEvent({
        projectId: input.projectId, defect: created, action: "discovered", fromStatus: "",
        toStatus: initialStatus, userId: input.userId, reason: "", evidenceRefs: refs, at
      });
    });
    return { created: true, occurrenceAdded: true, defect: this.mapDefect(this.defectRow(input.projectId, defectId)) };
  }

  listDefects(input: {
    projectId: string;
    status?: string;
    category?: string;
    severity?: string;
    sessionId?: string;
    runId?: string;
    limit?: number;
    cursor?: string;
  }): { defects: DefectView[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where = ["project_id=?"];
    const params: unknown[] = [input.projectId];
    if (input.status && input.status !== "all") {
      where.push("status=?");
      params.push(oneOf(input.status, DEFECT_STATUSES, "invalid_defect", "缺陷状态"));
    }
    if (input.category && input.category !== "all") {
      where.push("category=?");
      params.push(oneOf(input.category, DEFECT_CATEGORIES, "invalid_defect", "缺陷分类"));
    }
    if (input.severity && input.severity !== "all") {
      where.push("severity=?");
      params.push(oneOf(input.severity, DEFECT_SEVERITIES, "invalid_defect", "严重程度"));
    }
    if (input.runId || input.sessionId) {
      where.push("EXISTS (SELECT 1 FROM qa_defect_occurrences o WHERE o.defect_id=qa_defects.defect_id AND (? IS NULL OR o.run_id=?) AND (? IS NULL OR o.session_id=?))");
      params.push(input.runId ?? null, input.runId ?? null, input.sessionId ?? null, input.sessionId ?? null);
    }
    const cursor = decodeCursor(input.cursor, "invalid_defect");
    if (cursor) {
      where.push("(updated_at < ? OR (updated_at = ? AND defect_id < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM qa_defects WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, defect_id DESC LIMIT ?`)
      .all(...params, limit + 1) as DefectRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      defects: page.map((row) => this.mapDefect(row)),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.updated_at, page[page.length - 1]!.defect_id) : null
    };
  }

  getDefect(projectId: string, defectId: string): {
    defect: DefectView;
    occurrences: DefectOccurrenceView[];
    events: DefectEventView[];
    retests: RetestView[];
  } {
    const row = this.defectRow(projectId, defectId);
    const occurrences = (this.db.prepare("SELECT * FROM qa_defect_occurrences WHERE defect_id=? ORDER BY observed_at, occurrence_id")
      .all(defectId) as OccRow[]).map((occ) => ({
        occurrenceId: occ.occurrence_id,
        sessionId: occ.session_id,
        runId: occ.run_id,
        caseKey: occ.case_key,
        evidenceRefs: parseJson(occ.evidence_refs_json, []),
        observedAt: occ.observed_at
      }));
    const events = (this.db.prepare("SELECT * FROM qa_defect_events WHERE defect_id=? ORDER BY sequence").all(defectId) as DefectEventRow[])
      .map((event) => this.mapEvent(event));
    const retests = (this.db.prepare("SELECT * FROM qa_retests WHERE defect_id=? ORDER BY created_at, retest_id").all(defectId) as RetestRow[])
      .map((retest) => ({
        retestId: retest.retest_id,
        defectId: retest.defect_id,
        sessionId: retest.session_id,
        runId: retest.run_id,
        batchId: retest.batch_id,
        result: retest.result,
        caseResults: parseJson(retest.case_results_json, []),
        evidenceRefs: parseJson(retest.evidence_refs_json, []),
        createdAt: retest.created_at,
        createdBy: retest.created_by
      }));
    return { defect: this.mapDefect(row), occurrences, events, retests };
  }

  listDefectEvents(projectId: string, defectId: string): { events: DefectEventView[] } {
    this.defectRow(projectId, defectId);
    const rows = this.db.prepare("SELECT * FROM qa_defect_events WHERE defect_id=? ORDER BY sequence").all(defectId) as DefectEventRow[];
    return { events: rows.map((row) => this.mapEvent(row)) };
  }

  private requireRevision(row: DefectRow, expectedRevision: number): void {
    if (expectedRevision !== row.revision) throw new HttpError(409, "defect_version_conflict", "缺陷状态已变化，请刷新后重试。");
  }

  confirmDefect(input: {
    projectId: string;
    defectId: string;
    userId: string;
    expectedRevision: number;
    category: unknown;
    severity?: unknown;
    priority?: unknown;
    reason: unknown;
    evidenceRefs?: unknown;
  }): { idempotent: boolean; defect: DefectView } {
    const row = this.defectRow(input.projectId, input.defectId);
    const category = oneOf(input.category, DEFECT_CATEGORIES, "invalid_defect", "缺陷分类");
    if (category === "needs_review") throw new HttpError(400, "invalid_defect", "确认缺陷必须给出明确分类。");
    if (row.status === "confirmed" && row.category === category) {
      return { idempotent: true, defect: this.mapDefect(row) };
    }
    this.requireRevision(row, positiveInt(input.expectedRevision, "invalid_defect", "expectedRevision"));
    if (row.status !== "draft" && row.status !== "needs_review") throw new HttpError(409, "defect_status_conflict", "当前缺陷状态不能确认。");
    const reason = text(input.reason, 5000, "invalid_defect", "确认理由");
    const refs = input.evidenceRefs === undefined ? parseJson<EvidenceRef[]>(row.evidence_refs_json, []) : parseEvidenceRefs(input.evidenceRefs, "invalid_defect");
    this.evidence(input.projectId, refs, "invalid_defect");
    const severity = optionalOneOf(input.severity, DEFECT_SEVERITIES, "invalid_defect", "严重程度") ?? row.severity;
    const priority = optionalOneOf(input.priority, DEFECT_PRIORITIES, "invalid_defect", "优先级") ?? row.priority;
    const at = iso(this.now());
    this.tx(() => {
      this.db.prepare("UPDATE qa_defects SET category=?,severity=?,priority=? WHERE defect_id=?").run(category, severity, priority, row.defect_id);
      this.appendEvent({
        projectId: input.projectId, defect: row, action: "confirmed", fromStatus: row.status, toStatus: "confirmed",
        userId: input.userId, reason, evidenceRefs: refs, at
      });
    });
    return { idempotent: false, defect: this.mapDefect(this.defectRow(input.projectId, row.defect_id)) };
  }

  rejectDefect(input: {
    projectId: string;
    defectId: string;
    userId: string;
    expectedRevision: number;
    reason: unknown;
    evidenceRefs?: unknown;
  }): { defect: DefectView } {
    const row = this.defectRow(input.projectId, input.defectId);
    this.requireRevision(row, positiveInt(input.expectedRevision, "invalid_defect", "expectedRevision"));
    if (row.status !== "draft" && row.status !== "needs_review") throw new HttpError(409, "defect_status_conflict", "当前缺陷状态不能拒绝。");
    const reason = text(input.reason, 5000, "invalid_defect", "拒绝理由");
    const refs = input.evidenceRefs === undefined ? parseJson<EvidenceRef[]>(row.evidence_refs_json, []) : parseEvidenceRefs(input.evidenceRefs, "invalid_defect");
    this.evidence(input.projectId, refs, "invalid_defect");
    const at = iso(this.now());
    this.tx(() => {
      this.appendEvent({
        projectId: input.projectId, defect: row, action: "rejected", fromStatus: row.status, toStatus: "rejected",
        userId: input.userId, reason, evidenceRefs: refs, at
      });
    });
    return { defect: this.mapDefect(this.defectRow(input.projectId, row.defect_id)) };
  }

  fixDefect(input: {
    projectId: string;
    defectId: string;
    userId: string;
    expectedRevision: number;
    reason: unknown;
    evidenceRefs: unknown;
  }): { defect: DefectView } {
    const row = this.defectRow(input.projectId, input.defectId);
    this.requireRevision(row, positiveInt(input.expectedRevision, "invalid_defect", "expectedRevision"));
    if (row.status !== "confirmed") throw new HttpError(409, "defect_status_conflict", "只有已确认缺陷可以登记修复。");
    const reason = text(input.reason, 5000, "invalid_defect", "修复说明");
    const refs = parseEvidenceRefs(input.evidenceRefs, "invalid_defect");
    this.evidence(input.projectId, refs, "invalid_defect");
    const at = iso(this.now());
    this.tx(() => {
      this.appendEvent({
        projectId: input.projectId, defect: row, action: "fixed", fromStatus: row.status, toStatus: "fixed",
        userId: input.userId, reason, evidenceRefs: refs, at
      });
    });
    return { defect: this.mapDefect(this.defectRow(input.projectId, row.defect_id)) };
  }

  retestDefect(input: {
    projectId: string;
    defectId: string;
    userId: string;
    expectedRevision: number;
    retestSessionId: unknown;
    retestRunId: unknown;
    note?: unknown;
    evidenceRefs?: unknown;
  }): { idempotent: boolean; defect: DefectView; retest: RetestView | null } {
    const row = this.defectRow(input.projectId, input.defectId);
    const retestRunId = text(input.retestRunId, 120, "invalid_defect", "复测运行标识");
    if (!RUN_ID.test(retestRunId)) throw new HttpError(400, "invalid_defect", "复测运行标识无效。");
    const existing = this.db.prepare("SELECT * FROM qa_retests WHERE defect_id=? AND run_id=?").get(row.defect_id, retestRunId) as RetestRow | undefined;
    if (existing) return { idempotent: true, defect: this.mapDefect(row), retest: this.getDefect(input.projectId, row.defect_id).retests.find((item) => item.retestId === existing.retest_id) ?? null };
    this.requireRevision(row, positiveInt(input.expectedRevision, "invalid_defect", "expectedRevision"));
    if (row.status !== "fixed" && row.status !== "closed") throw new HttpError(409, "defect_status_conflict", "只有已修复或已关闭缺陷可以复测。");
    if (retestRunId === row.origin_run_id) throw new HttpError(400, "invalid_defect", "复测必须使用与发现运行不同的独立运行。");
    const retestSessionId = text(input.retestSessionId, 120, "invalid_defect", "复测任务标识");
    const retestSession = this.task(input.projectId, retestSessionId, retestRunId);
    const batch = this.latestBatchRow(input.projectId, retestSessionId, retestRunId);
    if (!batch) throw new HttpError(404, "design_not_found", "复测运行还没有设计批次。");
    const relatedCases = parseJson<string[]>(row.related_cases_json, []);
    if (!relatedCases.length) throw new HttpError(409, "retest_incomplete", "缺陷没有关联用例，不能通过复测关闭。");
    const results = new Map((this.db.prepare("SELECT * FROM qa_case_results WHERE project_id=? AND run_id=?")
      .all(input.projectId, retestRunId) as ResultRow[]).map((result) => [result.case_key, result]));
    const missing = relatedCases.filter((caseKey) => !results.has(caseKey) || results.get(caseKey)!.status === "skipped");
    if (missing.length) throw new HttpError(409, "retest_incomplete", "复测缺少关联用例的有效结果。", undefined, { missingCases: missing.join(",") });
    const failed = relatedCases.filter((caseKey) => {
      const status = results.get(caseKey)!.status;
      return status === "failed" || status === "blocked";
    });
    const passed = failed.length === 0;
    if (passed && row.status === "closed") return { idempotent: true, defect: this.mapDefect(row), retest: null };
    const note = optionalText(input.note, 5000, "invalid_defect", "复测说明") ?? "";
    const extraRefs = input.evidenceRefs === undefined ? [] : parseEvidenceRefs(input.evidenceRefs, "invalid_defect");
    this.evidence(input.projectId, extraRefs, "invalid_defect");
    const caseResults = relatedCases.map((caseKey) => ({ caseKey, status: results.get(caseKey)!.status }));
    const evidenceRefs = extraRefs.length ? extraRefs : relatedCases.flatMap((caseKey) => parseJson<EvidenceRef[]>(results.get(caseKey)!.evidence_refs_json, []));
    const at = iso(this.now());
    const retestId = `ret-${this.id()}`;
    this.tx(() => {
      this.db.prepare(`INSERT INTO qa_retests
        (retest_id,defect_id,project_id,session_id,run_id,batch_id,result,case_results_json,evidence_refs_json,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        retestId, row.defect_id, input.projectId, retestSessionId, retestRunId, batch.batch_id, passed ? "passed" : "failed",
        JSON.stringify(caseResults), JSON.stringify(evidenceRefs), at, input.userId
      );
      this.appendEvent({
        projectId: input.projectId, defect: row, action: row.status === "closed" && !passed ? "reopened" : "retested",
        fromStatus: row.status, toStatus: passed ? "closed" : "confirmed",
        userId: input.userId, reason: note, evidenceRefs, retestRunId, at
      });
    });
    const detail = this.getDefect(input.projectId, row.defect_id);
    return { idempotent: false, defect: detail.defect, retest: detail.retests.find((item) => item.retestId === retestId) ?? null };
  }

  // ---------------------------------------------------------------- reports

  private async assertReportRun(session: TraceSession, runId: string): Promise<void> {
    if (!session.workspace) throw new HttpError(400, "report_run_invalid", "任务没有可核验的工作区。");
    try {
      const workspace = await fs.realpath(path.resolve(session.workspace));
      const runDir = path.join(workspace, "output", "runs", runId);
      if (await fs.realpath(runDir) !== runDir) throw Error("linked run");
      const manifestPath = path.join(runDir, "manifest.json");
      if (await fs.realpath(manifestPath) !== manifestPath) throw Error("linked manifest");
      const stat = await fs.lstat(manifestPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw Error("invalid manifest size");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { run_id?: unknown; manifest_version?: unknown };
      if (manifest.run_id !== runId || !Number.isInteger(manifest.manifest_version)) throw Error("manifest identity mismatch");
    } catch {
      throw new HttpError(400, "report_run_invalid", "运行清单不存在或与当前任务不匹配，不能发布报告索引。");
    }
  }

  private async runFile(session: TraceSession, runId: string, relative: string): Promise<string> {
    if (!session.workspace) throw new HttpError(400, "report_artifact_missing", "任务没有可读取的工作区。");
    let root: string;
    try {
      root = await fs.realpath(path.resolve(session.workspace));
    } catch {
      throw new HttpError(400, "report_artifact_missing", "任务工作区不可读。");
    }
    const runDir = path.join(root, "output", "runs", runId);
    let realRun: string;
    try {
      realRun = await fs.realpath(runDir);
      if (realRun !== runDir) throw Error("linked run");
    } catch {
      throw new HttpError(400, "report_artifact_missing", "运行目录不存在。");
    }
    const target = path.resolve(realRun, relative);
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
      if (realTarget !== target) throw Error("linked artifact");
      if (realTarget !== realRun && !realTarget.startsWith(realRun + path.sep)) throw Error("outside run");
      const stat = await fs.lstat(realTarget);
      if (!stat.isFile() || stat.size > REPORT_MAX_BYTES) throw Error("not a file");
      return sha256(await fs.readFile(realTarget));
    } catch {
      throw new HttpError(400, "report_artifact_missing", "报告或证据文件不存在、越界或过大。");
    }
  }

  private mapReport(row: ReportRow): ReportIndexView {
    return {
      reportId: row.report_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      runId: row.run_id,
      batchId: row.batch_id,
      designRevision: parseJson<{ designRevision?: number }>(row.coverage_json, {}).designRevision ?? 0,
      revision: row.revision,
      status: row.status,
      htmlPath: row.html_path,
      htmlSha256: row.html_sha256,
      conclusion: row.conclusion,
      qualityGate: row.quality_gate,
      counts: parseJson(row.counts_json, {} as Coverage["counts"]),
      coverage: parseJson(row.coverage_json, { pointCoverage: 0, caseExecution: 0, passRate: null, allPassed: false }),
      untested: parseJson(row.untested_json, []),
      evidence: parseJson(row.evidence_json, []),
      limitations: parseJson(row.limitations_json, []),
      openDefects: parseJson(row.open_defects_json, []),
      resultsFingerprint: row.results_fingerprint,
      createdAt: row.created_at,
      createdBy: row.created_by,
      contentHash: row.content_hash
    };
  }

  private resultsFingerprint(projectId: string, batch: BatchRow, runId: string): string {
    const results = (this.db.prepare("SELECT case_key,status,invocation_id,evidence_refs_json,updated_at FROM qa_case_results WHERE project_id=? AND run_id=? ORDER BY case_key")
      .all(projectId, runId) as { case_key: string; status: string; invocation_id: string; evidence_refs_json: string; updated_at: string }[]);
    return sha256(canonical({ batchId: batch.batch_id, batchHash: batch.content_hash, results }));
  }

  private currentResultsFingerprint(projectId: string, sessionId: string, runId: string): string | null {
    const batch = this.latestBatchRow(projectId, sessionId, runId);
    return batch ? this.resultsFingerprint(projectId, batch, runId) : null;
  }

  private openDefects(projectId: string): { defectId: string; status: DefectStatus; severity: DefectSeverity }[] {
    return (this.db.prepare("SELECT defect_id,status,severity FROM qa_defects WHERE project_id=? AND status IN ('confirmed','fixed') ORDER BY updated_at DESC, defect_id DESC")
      .all(projectId) as { defect_id: string; status: DefectStatus; severity: DefectSeverity }[])
      .map((row) => ({ defectId: row.defect_id, status: row.status, severity: row.severity }));
  }

  private allowedConclusions(coverage: Coverage): Set<ReportConclusion> {
    const allowed = new Set<ReportConclusion>();
    if (coverage.gate.allPassed) {
      allowed.add("passed");
      return allowed;
    }
    if (coverage.counts.failed) {
      allowed.add("failed");
      if (coverage.counts.untestedCases || coverage.counts.uncoveredPoints) allowed.add("partial");
    } else if (coverage.counts.blocked) {
      allowed.add("blocked");
    } else if (coverage.counts.executed === 0) {
      allowed.add("not_run");
    } else {
      allowed.add("partial");
    }
    return allowed;
  }

  async createReportIndex(input: {
    projectId: string;
    sessionId: string;
    runId: string;
    userId: string;
    expectedDesignRevision: number;
    htmlPath: unknown;
    htmlSha256: unknown;
    conclusion: unknown;
    evidence: unknown;
    untested: unknown;
    limitations?: unknown;
  }): Promise<{ report: ReportIndexView; coverage: Coverage }> {
    const session = this.task(input.projectId, input.sessionId, input.runId);
    const batch = this.latestBatchRow(input.projectId, input.sessionId, input.runId);
    if (!batch) throw new HttpError(404, "design_not_found", "本次运行还没有设计批次。");
    if (positiveInt(input.expectedDesignRevision, "invalid_report", "expectedDesignRevision") !== batch.revision) {
      throw new HttpError(409, "design_revision_conflict", "设计批次版本已变化。");
    }
    await this.assertReportRun(session, input.runId);
    const coverage = this.readCoverage(input.projectId, input.sessionId, input.runId);
    const conclusion = oneOf(input.conclusion, REPORT_CONCLUSIONS, "invalid_report", "报告结论");
    if (!this.allowedConclusions(coverage).has(conclusion)) {
      throw new HttpError(400, "report_overstates_results", "报告结论与执行事实不一致，不能把未完成或失败写成通过。");
    }
    const htmlPath = safeRelative(input.htmlPath, "invalid_report", "报告文件路径");
    const htmlSha256 = normalizeHash(input.htmlSha256, "invalid_report", "报告文件哈希");
    const actualHtml = await this.runFile(session, input.runId, htmlPath);
    if (actualHtml !== htmlSha256) throw new HttpError(400, "report_artifact_missing", "报告文件哈希不匹配。");
    if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > REPORT_MAX_EVIDENCE) {
      throw new HttpError(400, "invalid_report", `报告证据必须是 1 至 ${REPORT_MAX_EVIDENCE} 条。`);
    }
    const evidence: { label: string; ref: EvidenceRef; path?: string; sha256?: string }[] = [];
    for (const raw of input.evidence) {
      const item = object(raw, "invalid_report");
      const label = text(item.label, 200, "invalid_report", "证据标签");
      const ref = parseEvidenceRefs([item.ref], "invalid_report")[0]!;
      this.evidence(input.projectId, [ref], "invalid_report", { sessionId: input.sessionId, runId: input.runId });
      let evidencePath: string | undefined;
      let evidenceSha: string | undefined;
      if (item.path !== undefined) {
        evidencePath = safeRelative(item.path, "invalid_report", "证据路径");
        if (ref.type === "execution" && evidencePath !== ref.evidencePath) {
          throw new HttpError(400, "invalid_report", "执行证据引用与文件路径不一致。");
        }
        evidenceSha = normalizeHash(item.sha256, "invalid_report", "证据哈希");
        const actual = await this.runFile(session, input.runId, evidencePath);
        if (actual !== evidenceSha) throw new HttpError(400, "report_artifact_missing", "证据文件哈希不匹配。");
      } else if (item.sha256 !== undefined) {
        throw new HttpError(400, "invalid_report", "证据哈希必须与证据路径一起提供。");
      }
      evidence.push({ label, ref, ...(evidencePath ? { path: evidencePath, sha256: evidenceSha } : {}) });
    }
    if (!Array.isArray(input.untested) || input.untested.length > 5000) throw new HttpError(400, "invalid_report", "未测原因格式无效。");
    const untested = input.untested.map((raw) => {
      const item = object(raw, "invalid_report");
      return {
        kind: oneOf(item.kind, ["point", "case"] as const, "invalid_report", "未测类型"),
        id: text(item.id, 100, "invalid_report", "未测标识"),
        reason: text(item.reason, 2000, "invalid_report", "未测原因")
      };
    });
    const required = new Set(coverage.untested.map((item) => `${item.kind}:${item.id}`));
    const supplied = new Set(untested.map((item) => `${item.kind}:${item.id}`));
    const missing = [...required].filter((key) => !supplied.has(key));
    if (missing.length) throw new HttpError(400, "report_untested_incomplete", "报告必须说明所有未测项的原因。", undefined, { missing: missing.join(",") });
    const design = this.getDesign(input.projectId, input.sessionId, input.runId);
    const knownPoints = new Set(design.points.map((point) => `point:${point.pointKey}`));
    const knownCases = new Set(design.cases.map((item) => `case:${item.caseKey}`));
    for (const item of untested) {
      const key = `${item.kind}:${item.id}`;
      if (!knownPoints.has(key) && !knownCases.has(key)) throw new HttpError(400, "invalid_report", "未测项不属于本次设计批次。");
    }
    const limitations = stringArray(input.limitations, 50, "invalid_report", "限制说明", 2000);
    const openDefects = this.openDefects(input.projectId);
    let qualityGate = coverage.gate.qualityGate;
    if (qualityGate !== "blocked") {
      if (openDefects.some((defect) => defect.severity === "Blocker" || defect.severity === "Critical")) qualityGate = "risk_present";
      else if (qualityGate === "informational" && openDefects.length) qualityGate = "review_required";
    }
    const fingerprint = this.resultsFingerprint(input.projectId, batch, input.runId);
    const at = iso(this.now());
    const reportId = `report-${this.id()}`;
    const counts = coverage.counts;
    const coverageSummary = {
      designRevision: coverage.designRevision,
      pointCoverage: coverage.rates.pointCoverage,
      caseExecution: coverage.rates.caseExecution,
      passRate: coverage.rates.passRate,
      allPassed: coverage.gate.allPassed
    };
    this.tx(() => {
      const currentBatch = this.latestBatchRow(input.projectId, input.sessionId, input.runId);
      if (currentBatch?.batch_id !== batch.batch_id || this.resultsFingerprint(input.projectId, batch, input.runId) !== fingerprint ||
          canonical(this.openDefects(input.projectId)) !== canonical(openDefects)) {
        throw new HttpError(409, "report_source_changed", "报告生成期间设计、执行结果或缺陷发生变化，请重新核对后发布。");
      }
      const revision = (this.db.prepare("SELECT max(revision) AS n FROM qa_report_indexes WHERE project_id=? AND session_id=? AND run_id=?")
        .get(input.projectId, input.sessionId, input.runId) as { n: number | null }).n ?? 0;
      const contentHash = sha256(canonical({
        projectId: input.projectId, sessionId: input.sessionId, runId: input.runId, batchId: batch.batch_id,
        revision: revision + 1, htmlPath, htmlSha256, conclusion, qualityGate, counts, coverage: coverageSummary,
        untested, evidence, limitations, openDefects, fingerprint
      }));
      this.db.prepare("UPDATE qa_report_indexes SET status='superseded' WHERE project_id=? AND session_id=? AND run_id=? AND status='published'")
        .run(input.projectId, input.sessionId, input.runId);
      this.db.prepare(`INSERT INTO qa_report_indexes
        (report_id,project_id,session_id,run_id,batch_id,revision,status,html_path,html_sha256,conclusion,quality_gate,counts_json,coverage_json,
         untested_json,evidence_json,limitations_json,open_defects_json,results_fingerprint,created_at,created_by,content_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        reportId, input.projectId, input.sessionId, input.runId, batch.batch_id, revision + 1, "published", htmlPath, htmlSha256,
        conclusion, qualityGate, JSON.stringify(counts), JSON.stringify(coverageSummary), JSON.stringify(untested), JSON.stringify(evidence),
        JSON.stringify(limitations), JSON.stringify(openDefects), fingerprint, at, input.userId, contentHash
      );
    });
    const report = this.mapReport(this.db.prepare("SELECT * FROM qa_report_indexes WHERE report_id=?").get(reportId) as ReportRow);
    return { report, coverage };
  }

  async getReportIndex(projectId: string, sessionId: string, runId: string): Promise<{ report: ReportIndexView | null; stale: boolean }> {
    this.task(projectId, sessionId, runId);
    const row = this.db.prepare("SELECT * FROM qa_report_indexes WHERE project_id=? AND session_id=? AND run_id=? ORDER BY revision DESC LIMIT 1")
      .get(projectId, sessionId, runId) as ReportRow | undefined;
    if (!row) return { report: null, stale: false };
    const current = this.currentResultsFingerprint(projectId, sessionId, runId);
    return { report: this.mapReport(row), stale: current !== null && current !== row.results_fingerprint };
  }

  listReportIndexes(projectId: string, sessionId: string, runId: string): { reports: ReportIndexView[] } {
    this.task(projectId, sessionId, runId);
    const rows = this.db.prepare("SELECT * FROM qa_report_indexes WHERE project_id=? AND session_id=? AND run_id=? ORDER BY revision DESC")
      .all(projectId, sessionId, runId) as ReportRow[];
    return { reports: rows.map((row) => this.mapReport(row)) };
  }
}
