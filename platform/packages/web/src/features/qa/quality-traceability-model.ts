/**
 * Q3 quality traceability as the read-only surfaces see it: coverage/risk, defect lifecycle and
 * the report evidence index. These are display types only — nothing here writes results,
 * confirms defects or publishes reports.
 *
 * Honesty rules the copy must keep:
 * - coverage means "a case is linked", never "it passed";
 * - skipped, blocked and missing results are not passed;
 * - a missing report index reads "尚未登记", never a conclusion inferred from session text;
 * - a stale report is labelled as no longer current.
 */

export type RiskLevel = "high" | "medium" | "low";
export type ResultStatus = "passed" | "failed" | "skipped" | "blocked";
export type DefectStatus = "draft" | "needs_review" | "confirmed" | "rejected" | "fixed" | "closed";
export type DefectCategory =
  | "product_defect"
  | "script_issue"
  | "environment_issue"
  | "test_data_issue"
  | "needs_review";
export type DefectSeverity = "Blocker" | "Critical" | "Major" | "Minor" | "Trivial" | "unknown";
export type DefectPriority = "P0" | "P1" | "P2" | "P3" | "unknown";
export type ReportConclusion = "passed" | "failed" | "partial" | "blocked" | "not_run";
export type QualityGate = "blocked" | "review_required" | "risk_present" | "informational";
export type EvidenceRef = import("./project-knowledge-model").EvidenceRef;

export interface PointCoverageView {
  pointKey: string;
  module: string;
  feature: string;
  risk: RiskLevel;
  coveredBy: string[];
  status: "passed" | "failed" | "blocked" | "partial" | "untested";
  caseCounts: { passed: number; failed: number; skipped: number; blocked: number; notRun: number };
  untestedReason: string | null;
}

export interface CoverageView {
  projectId: string;
  sessionId: string;
  runId: string;
  designRevision: number;
  designStatus: "open" | "frozen";
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
  gate: {
    qualityGate: QualityGate;
    conclusion: ReportConclusion;
    allPassed: boolean;
    complete: boolean;
    evidenceComplete: boolean;
    reasons: string[];
  };
  points: PointCoverageView[];
  untested: { kind: "point" | "case"; id: string; reason: string }[];
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

export interface DefectView {
  defectId: string;
  projectId: string;
  fingerprint: string;
  title: string;
  category: DefectCategory;
  status: DefectStatus;
  confidence: "low" | "medium" | "strong";
  severity: DefectSeverity;
  /** Present only for records written with the severity standard; older records omit it. */
  severityReason?: string;
  severityDimensions?: {
    user_business_impact?: string;
    reach_frequency?: string;
    recoverability?: string;
    data_security_compliance?: string;
  };
  severityStandardVersion?: number;
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

export interface DefectOccurrenceView {
  occurrenceId: string;
  sessionId: string;
  runId: string;
  caseKey: string;
  evidenceRefs: EvidenceRef[];
  observedAt: string;
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

export interface DefectDetailView {
  defect: DefectView;
  occurrences: DefectOccurrenceView[];
  events: DefectEventView[];
  retests: RetestView[];
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
  counts: CoverageView["counts"];
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

export interface ReportIndexResponse {
  report: ReportIndexView | null;
  /** The results changed after this report was written, so it is not the current report. */
  stale: boolean;
}

export const RISK_LABELS: Readonly<Record<RiskLevel, string>> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const RESULT_STATUS_LABELS: Readonly<Record<ResultStatus, string>> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  blocked: "阻塞",
};

export const POINT_STATUS_LABELS: Readonly<Record<PointCoverageView["status"], string>> = {
  passed: "通过",
  failed: "失败",
  blocked: "阻塞",
  partial: "部分执行",
  untested: "未测",
};

export const DEFECT_STATUS_LABELS: Readonly<Record<DefectStatus, string>> = {
  draft: "草稿",
  needs_review: "待复核",
  confirmed: "已确认",
  rejected: "已拒绝",
  fixed: "已修复（未验证）",
  closed: "已关闭",
};

export const DEFECT_SEVERITY_LABELS: Readonly<Record<DefectSeverity, string>> = {
  Blocker: "阻断",
  Critical: "严重",
  Major: "较严重",
  Minor: "轻微",
  Trivial: "提示",
  unknown: "未评估",
};

/** High to low; unknown is last because it is unclassified, not low risk. */
export const DEFECT_SEVERITY_ORDER: readonly DefectSeverity[] = [
  "Blocker",
  "Critical",
  "Major",
  "Minor",
  "Trivial",
  "unknown",
];

export function severityLabel(severity: string | null | undefined): string {
  if (!severity) return "未记录";
  return DEFECT_SEVERITY_LABELS[severity as DefectSeverity] ?? severity;
}

export function severityRank(severity: string | null | undefined): number {
  const index = DEFECT_SEVERITY_ORDER.indexOf((severity ?? "unknown") as DefectSeverity);
  return index < 0 ? DEFECT_SEVERITY_ORDER.length : index;
}

export function isSeverityUnknown(severity: string | null | undefined): boolean {
  return !severity || severity === "unknown";
}

export const SEVERITY_DIMENSION_LABELS: Readonly<Record<string, string>> = {
  user_business_impact: "业务影响",
  reach_frequency: "影响范围",
  recoverability: "恢复方式",
  data_security_compliance: "数据/安全/合规",
};

export const SEVERITY_DIMENSION_VALUE_LABELS: Readonly<Record<string, string>> = {
  critical: "严重",
  major: "较大",
  minor: "较小",
  none: "无",
  unknown: "未知",
  all: "全部",
  many: "多数",
  some: "部分",
  few: "少数",
  expensive: "代价高",
  workaround: "有绕过",
  easy: "容易",
  confirmed: "已确认",
  suspected: "疑似",
};

export function severityDimensionLabel(key: string): string {
  return SEVERITY_DIMENSION_LABELS[key] ?? key;
}

export function severityDimensionValueLabel(value: string): string {
  return SEVERITY_DIMENSION_VALUE_LABELS[value] ?? value;
}

/** Known levels and unassessed are counted apart; unknown is never folded into a low level. */
export function severitySummary(defects: { severity?: string }[]): {
  levels: Record<DefectSeverity, number>;
  unknown: number;
  unrecorded: number;
  total: number;
} {
  const levels = Object.fromEntries(DEFECT_SEVERITY_ORDER.map((level) => [level, 0])) as Record<DefectSeverity, number>;
  let unknown = 0;
  let unrecorded = 0;
  for (const defect of defects) {
    if (!defect.severity) unrecorded += 1;
    else if (defect.severity === "unknown") unknown += 1;
    else if (defect.severity in levels) levels[defect.severity as DefectSeverity] += 1;
    else unrecorded += 1;
  }
  return { levels, unknown, unrecorded, total: defects.length };
}

export const DEFECT_CATEGORY_LABELS: Readonly<Record<DefectCategory, string>> = {
  product_defect: "产品缺陷",
  script_issue: "脚本问题",
  environment_issue: "环境问题",
  test_data_issue: "测试数据问题",
  needs_review: "待分类",
};

export const CONCLUSION_LABELS: Readonly<Record<ReportConclusion, string>> = {
  passed: "通过",
  failed: "失败",
  partial: "部分完成",
  blocked: "阻塞",
  not_run: "未执行",
};

export const QUALITY_GATE_LABELS: Readonly<Record<QualityGate, string>> = {
  blocked: "阻断",
  review_required: "需复核",
  risk_present: "存在风险",
  informational: "仅供参考",
};

export function riskLabel(risk: RiskLevel): string {
  return RISK_LABELS[risk] ?? risk;
}

export function resultStatusLabel(status: ResultStatus): string {
  return RESULT_STATUS_LABELS[status] ?? status;
}

export function pointStatusLabel(status: PointCoverageView["status"]): string {
  return POINT_STATUS_LABELS[status] ?? status;
}

export function defectStatusLabel(status: DefectStatus): string {
  return DEFECT_STATUS_LABELS[status] ?? status;
}

export function defectCategoryLabel(category: DefectCategory): string {
  return DEFECT_CATEGORY_LABELS[category] ?? category;
}

export function conclusionLabel(conclusion: ReportConclusion): string {
  return CONCLUSION_LABELS[conclusion] ?? conclusion;
}

export function qualityGateLabel(gate: QualityGate): string {
  return QUALITY_GATE_LABELS[gate] ?? gate;
}

/** A rate as a percentage; a null rate is unknown, never zero. */
export function percent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * The report's state as one phrase. A missing index is "尚未登记"; a stale one is "结果已变化";
 * neither may be read as a passing report.
 */
export function reportStateLabel(report: ReportIndexView | null, stale: boolean): string {
  if (report === null) return "尚未登记";
  const base = `${report.status === "published" ? "已发布" : "已被新版本取代"} · ${conclusionLabel(report.conclusion)}`;
  return stale ? `${base} · 结果已变化，不是当前报告` : base;
}

/** Every reason a point is not "through": untested, blocked, failed or partially executed. */
export function pointConcern(point: PointCoverageView): string | null {
  if (point.untestedReason) return point.untestedReason;
  if (point.status === "untested") return "无关联用例或没有执行结果";
  if (point.status === "blocked") return "存在阻塞用例";
  if (point.status === "failed") return "存在失败用例";
  if (point.status === "partial") return "存在跳过或未执行用例";
  return null;
}

/**
 * Q3 read errors in plain language. Write/confirmation codes are included only so a page never
 * claims a write happened; the components here never send them.
 */
export function qualityErrorHint(code: string | undefined): string | undefined {
  switch (code) {
    case "design_not_found":
      return "该运行还没有设计批次，无法计算覆盖与风险。";
    case "task_not_found":
      return "任务不存在，或不属于当前项目。";
    case "report_not_found":
      return "该运行尚未登记报告索引。";
    case "project_forbidden":
      return "没有该项目的访问权限。";
    case "project_member_required":
      return "仅项目成员可以写入测试产物；当前账号只能读取。";
    case "project_owner_required":
      return "仅项目所有者可以确认缺陷、登记复测或发布报告。";
    case "defect_not_found":
      return "缺陷不存在，或不属于当前项目。";
    case "invalid_defect":
      return "缺陷数据无效。";
    default:
      return undefined;
  }
}
