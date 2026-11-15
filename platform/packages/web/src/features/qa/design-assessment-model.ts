/**
 * Pure, explainable design assessment for points, cases and report residual risk.
 *
 * This module deliberately returns labels and reasons, never a composite score: a number would
 * invite "AI says 82/100" to stand in for the owner's confirmation. Every judgement names the
 * factor it saw, or says the factor is unknown because the source was not available.
 */
import type {
  CaseResultView,
  CoverageView,
  DefectView,
  QualityGate,
  ReportIndexResponse,
} from "./quality-traceability-model";

export type AssessmentLevel = "low" | "medium" | "high" | "unknown";
export type FactorStatus = "observed" | "not_observed" | "unknown";
export type ConfidenceStatus = "executable" | "needs_revision" | "pending_clarification";
export type DimensionStatus = "supported" | "unsupported" | "pending" | "not_recorded" | "unknown";

export interface RawPoint {
  id?: unknown;
  point_id?: unknown;
  module?: unknown;
  feature?: unknown;
  description?: unknown;
  risk?: unknown;
  coverage_type?: unknown;
  coverageType?: unknown;
  source?: unknown;
  source_locator?: unknown;
  sourceLocator?: unknown;
  rule_ids?: unknown;
  ruleIds?: unknown;
  execution_layer?: unknown;
  executionLayer?: unknown;
  risk_basis?: unknown;
  riskBasis?: unknown;
}

export interface RawExpectedBasis {
  expected?: unknown;
  kind?: unknown;
  source_path?: unknown;
  sourcePath?: unknown;
  quote?: unknown;
}

export interface RawObservation {
  statement?: unknown;
  kind?: unknown;
  reason?: unknown;
}

export interface RawDesignBasis {
  rule_id?: unknown;
  ruleId?: unknown;
  source?: unknown;
  rule?: unknown;
  status?: unknown;
}

export interface RawDesignContract {
  basis?: unknown;
  assumptions?: unknown;
  data_checks?: unknown;
  dataChecks?: unknown;
}

export interface RawExecutionContract {
  data_isolation?: unknown;
  dataIsolation?: unknown;
  setup?: unknown;
  assertion_mode?: unknown;
  assertionMode?: unknown;
  cleanup_required?: unknown;
  cleanupRequired?: unknown;
}

export interface RawExecutionMetadata {
  modules?: unknown;
  tags?: unknown;
  risk_level?: unknown;
  riskLevel?: unknown;
  execution_cost?: unknown;
  executionCost?: unknown;
  data_impact?: unknown;
  dataImpact?: unknown;
  environment_dependencies?: unknown;
  environmentDependencies?: unknown;
  automation_maturity?: unknown;
  automationMaturity?: unknown;
  estimated_duration_ms?: unknown;
  estimatedDurationMs?: unknown;
}

export interface RawCase {
  case_id?: unknown;
  caseId?: unknown;
  title?: unknown;
  priority?: unknown;
  type?: unknown;
  preconditions?: unknown;
  steps?: unknown;
  expected?: unknown;
  test_data?: unknown;
  testData?: unknown;
  automation_feasible?: unknown;
  automationFeasible?: unknown;
  related_test_point?: unknown;
  relatedTestPoint?: unknown;
  design_contract?: unknown;
  designContract?: unknown;
  expected_basis?: unknown;
  expectedBasis?: unknown;
  observations?: unknown;
  execution_contract?: unknown;
  executionContract?: unknown;
  execution_metadata?: unknown;
  executionMetadata?: unknown;
  asset_refs?: unknown;
  assetRefs?: unknown;
  coverage_type?: unknown;
  coverageType?: unknown;
}

export interface AssessmentRule {
  ruleId: string;
  statement: string;
  status?: string;
  source?: string;
  citations?: { quote?: string; sourceId?: string }[];
}

export interface PointComplexityFactor {
  key: "condition_combinations" | "state_transitions" | "permission_roles" | "cross_module_dependencies" | "boundary_count";
  label: string;
  status: FactorStatus;
  evidence: string[];
  reason: string;
}

export interface PointRiskAssessment {
  level: "high" | "medium" | "low" | "unknown";
  reasons: string[];
  basis: {
    businessImpact: string;
    changeScope: string;
    usageFrequency: string;
    recoveryDifficulty: string;
  };
}

export interface PointAssessment {
  pointId: string;
  title: string;
  complexity: AssessmentLevel;
  complexityReasons: string[];
  factors: PointComplexityFactor[];
  unknowns: string[];
  risk: PointRiskAssessment;
}

export interface CaseComplexityFactor {
  key: "data_preparation" | "environment_account" | "steps_and_assertions" | "state_restore_cleanup";
  label: string;
  status: FactorStatus;
  evidence: string[];
  reason: string;
}

export interface CaseDimension {
  status: DimensionStatus;
  reasons: string[];
}

export interface CaseConfidence {
  expectedBasis: CaseDimension;
  designValidity: CaseDimension;
  executability: CaseDimension;
  coverageSufficiency: CaseDimension;
}

export interface CaseAssessment {
  caseId: string;
  title: string;
  complexity: AssessmentLevel;
  complexityReasons: string[];
  factors: CaseComplexityFactor[];
  confidence: CaseConfidence;
  status: ConfidenceStatus;
  /** The linked point's risk, so a reviewer can focus high-risk cases; unknown when standalone. */
  pointRisk: "high" | "medium" | "low" | "unknown";
  reasons: string[];
  executionBlockers: string[];
  pendingClarifications: string[];
  unknowns: string[];
}

export interface CaseAssessmentInput {
  case: RawCase;
  point?: RawPoint;
  sources?: Record<string, string>;
  rules?: AssessmentRule[];
}

export interface DesignAssessmentInput {
  points: RawPoint[];
  cases: RawCase[];
  sources?: Record<string, string>;
  rules?: AssessmentRule[];
}

export interface DesignAssessment {
  points: PointAssessment[];
  cases: CaseAssessment[];
  summary: {
    points: number;
    cases: number;
    highComplexityPoints: number;
    highComplexityCases: number;
    needsRevisionCases: number;
    pendingClarificationCases: number;
    executableCases: number;
  };
  unknowns: string[];
}

export type ResidualRiskKind =
  | "confirmed_defect"
  | "pending_phenomenon"
  | "uncovered_risk"
  | "untested_case"
  | "evidence_gap"
  | "design_gap"
  | "report_gap";

export interface ResidualRiskItem {
  id: string;
  kind: ResidualRiskKind;
  title: string;
  source: string;
  impact: "blocker" | "high" | "medium" | "low" | "unknown";
  status: string;
  action: string;
  reasons: string[];
}

export interface ResidualRiskInput {
  coverage?: CoverageView | null;
  results?: CaseResultView[] | null;
  defects?: DefectView[] | null;
  report?: ReportIndexResponse | null;
  reportLoaded?: boolean;
  designCases?: { caseId: string; expected?: string }[] | null;
}

export interface ResidualRiskAssessment {
  /** A label mapped from the existing quality gate; not a new score. */
  headline: "blocked" | "high" | "review" | "informational" | "unknown";
  headlineLabel: string;
  items: ResidualRiskItem[];
  groups: {
    confirmedDefects: ResidualRiskItem[];
    pendingPhenomena: ResidualRiskItem[];
    uncoveredRisks: ResidualRiskItem[];
  };
  counts: {
    points: number | null;
    businessCases: number | null;
    assertions: number | null;
    executed: number | null;
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    blocked: number | null;
    untestedCases: number | null;
    uncoveredPoints: number | null;
    confirmedDefects: number | null;
    pendingDefects: number | null;
  };
  unknowns: string[];
  notes: string[];
}

const CONDITION_WORDS = ["如果", "当", "且", "或", "同时", "分别", "组合", "条件", "分支", "否则"];
const STATE_WORDS = ["状态", "流转", "切换", "进入", "退出", "恢复", "重试", "回滚", "重新打开"];
const PERMISSION_WORDS = ["角色", "权限", "管理员", "普通用户", "成员", "所有者", "未登录", "越权", "授权"];
const CROSS_MODULE_WORDS = ["跨模块", "依赖", "关联", "多个模块", "接口", "数据库", "第三方", "消息", "通知", "同步", "回调"];
const BOUNDARY_WORDS = ["边界", "上限", "下限", "空", "为空", "空值", "超长", "最大", "最小", "并发", "重复", "极限"];
const ACTION_WORDS = ["点击", "输入", "打开", "访问", "提交", "请求", "调用", "选择", "上传", "删除", "修改", "创建", "登录", "刷新", "切换", "拖拽", "填写"];
const ASSERTION_WORDS = ["显示", "提示", "返回", "跳转", "保存", "不保存", "成功", "失败", "状态", "包含", "等于", "不应", "应该", "不得"];
const ENVIRONMENT_WORDS = ["环境", "账号", "登录", "设备", "浏览器", "网络", "服务", "接口地址", "token", "证书", "代理"];
const CLEANUP_WORDS = ["清理", "恢复", "重置", "删除数据", "回滚", "还原", "关闭"];
const GENERIC_WORDS = ["用户", "页面", "系统", "进行", "一个", "当前", "相关", "需要", "应该", "应当", "可以", "是否"];
const FORMAL_BASIS_KINDS = new Set(["requirement", "contract", "ui_explicit"]);

const textOf = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const arrayOfText = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const boolOf = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function hasAny(text: string, words: string[]): string[] {
  return words.filter((word) => text.includes(word));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function bigrams(value: string): string[] {
  const normalized = normalize(value).replace(/[，。；;、：:！!？?（）()【】[\]"'“”‘’]/g, "");
  const result: string[] = [];
  for (let index = 0; index < normalized.length - 1; index++) {
    const pair = normalized.slice(index, index + 2);
    if (!GENERIC_WORDS.some((word) => pair.includes(word))) result.push(pair);
  }
  return [...new Set(result)];
}

/** Splits an expected sentence into the clauses a basis must separately support. */
export function expectedClauses(expected: string): string[] {
  return expected
    .split(/(?:[；;。\n]|并且|同时|以及|且|、)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * A conservative lexical check. It replaces the most common display synonyms, then asks whether
 * the clause's character bigrams occur in the quote/source. It can prove a missing clause
 * (returns unsupported); it cannot prove real business semantics, so a supported result is
 * still labelled as mechanical only.
 */
export function clauseSupport(clause: string, evidence: string): DimensionStatus {
  const left = normalize(clause).replace(/显示|弹出|出现/g, "提示");
  const right = normalize(evidence).replace(/显示|弹出|出现/g, "提示");
  if (!left || !right) return "unknown";
  if (right.includes(left)) return "supported";
  const parts = bigrams(left);
  if (parts.length === 0) return "unknown";
  const hits = parts.filter((part) => right.includes(part)).length;
  const ratio = hits / parts.length;
  if (ratio >= 0.75) return "supported";
  if (ratio > 0) return "unsupported";
  return "unsupported";
}

function basisItems(raw: RawCase): { item: RawExpectedBasis; index: number }[] {
  const direct = raw.expected_basis ?? raw.expectedBasis;
  if (Array.isArray(direct)) {
    return direct.map((item, index) => ({ item: recordOf(item) as RawExpectedBasis, index }));
  }
  return [];
}

function designBasisItems(raw: RawCase): RawDesignBasis[] {
  const contract = recordOf(raw.design_contract ?? raw.designContract);
  const basis = contract.basis;
  return Array.isArray(basis) ? basis.map((item) => recordOf(item) as RawDesignBasis) : [];
}

function observationsOf(raw: RawCase): RawObservation[] {
  return Array.isArray(raw.observations) ? raw.observations.map((item) => recordOf(item) as RawObservation) : [];
}

function factor(
  key: PointComplexityFactor["key"],
  label: string,
  text: string,
  words: string[],
  extra: string[] = [],
): PointComplexityFactor {
  const hits = hasAny(text, words);
  if (text.trim().length === 0) {
    return { key, label, status: "unknown", evidence: [], reason: "没有可读取的测试点描述或来源文本，无法判断。" };
  }
  if (hits.length === 0 && extra.length === 0) {
    return {
      key,
      label,
      status: "not_observed",
      evidence: [],
      reason: "当前文本未观察到该类因素；这不证明业务上不存在。",
    };
  }
  return {
    key,
    label,
    status: "observed",
    evidence: [...hits, ...extra],
    reason: `文本中出现：${[...hits, ...extra].join("、")}。`,
  };
}

function riskLevel(value: unknown): PointRiskAssessment["level"] {
  const text = textOf(value).toLowerCase();
  if (text === "high" || text === "高" || text === "高風險" || text === "高风险") return "high";
  if (text === "medium" || text === "中" || text === "中风险" || text === "中風險") return "medium";
  if (text === "low" || text === "低" || text === "低风险" || text === "低風險") return "low";
  return "unknown";
}

function pointRisk(raw: RawPoint): PointRiskAssessment {
  const level = riskLevel(raw.risk);
  const basis = recordOf(raw.risk_basis ?? raw.riskBasis);
  const read = (key: string): string => {
    const value = basis[key] ?? basis[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
    return typeof value === "string" && value.trim() ? value.trim() : "未提供";
  };
  return {
    level,
    reasons:
      level === "unknown"
        ? ["产物未提供风险等级，不能把复杂度当作风险。"]
        : [`风险等级来自产物字段「${textOf(raw.risk)}」；复杂度与风险分开评估。`],
    basis: {
      businessImpact: read("businessImpact"),
      changeScope: read("changeScope"),
      usageFrequency: read("usageFrequency"),
      recoveryDifficulty: read("recoveryDifficulty"),
    },
  };
}

export function assessPoint(raw: RawPoint, rules: AssessmentRule[] = []): PointAssessment {
  const pointId = textOf(raw.id ?? raw.point_id) || "未命名测试点";
  const description = textOf(raw.description);
  const coverage = arrayOfText(raw.coverage_type ?? raw.coverageType);
  const ruleIds = arrayOfText(raw.rule_ids ?? raw.ruleIds);
  const relatedRules = rules.filter((rule) => ruleIds.includes(rule.ruleId));
  const ruleText = relatedRules.map((rule) => rule.statement).join("；");
  const text = [description, ruleText, coverage.join(" "), textOf(raw.module), textOf(raw.feature)].join(" ");

  const factors: PointComplexityFactor[] = [
    factor("condition_combinations", "条件组合", text, CONDITION_WORDS, coverage.length > 1 ? [`覆盖类型 ${coverage.length} 类`] : []),
    factor("state_transitions", "状态迁移", text, STATE_WORDS),
    factor("permission_roles", "权限角色", text, PERMISSION_WORDS),
    factor("cross_module_dependencies", "跨模块依赖", text, CROSS_MODULE_WORDS),
    factor("boundary_count", "边界数量", text, BOUNDARY_WORDS, numericBoundaries(text)),
  ];

  const observed = factors.filter((item) => item.status === "observed");
  const unknown = factors.filter((item) => item.status === "unknown");
  const complexity: AssessmentLevel =
    unknown.length === factors.length
      ? "unknown"
      : observed.length >= 3
        ? "high"
        : observed.length >= 1
          ? "medium"
          : "low";

  const complexityReasons =
    complexity === "unknown"
      ? ["没有可读取的描述、规则或覆盖类型，无法评估复杂度。"]
      : [
          `观察到 ${observed.length} 类复杂因素${observed.length ? `：${observed.map((item) => item.label).join("、")}` : "（当前文本未出现条件、状态、权限、跨模块或边界信号）"}。`,
          ...observed.map((item) => `${item.label}：${item.reason}`),
          ...unknown.map((item) => `${item.label}：${item.reason}`),
        ];

  return {
    pointId,
    title: description || textOf(raw.feature) || pointId,
    complexity,
    complexityReasons,
    factors,
    unknowns: unknown.map((item) => `${item.label}：${item.reason}`),
    risk: pointRisk(raw),
  };
}

function numericBoundaries(text: string): string[] {
  const matches = text.match(/(?:≤|>=|<=|>|<|不超过|至少|最多|最少|上限|下限)\s*\d+(?:\.\d+)?/g);
  return matches ? [...new Set(matches)] : [];
}

function dataKeys(raw: RawCase): string[] {
  const data = recordOf(raw.test_data ?? raw.testData);
  return Object.keys(data);
}

function caseText(raw: RawCase): string {
  return [
    textOf(raw.title),
    ...arrayOfText(raw.preconditions),
    ...arrayOfText(raw.steps),
    textOf(raw.expected),
    textOf(raw.type),
  ].join(" ");
}

function caseFactor(
  key: CaseComplexityFactor["key"],
  label: string,
  status: FactorStatus,
  evidence: string[],
  reason: string,
): CaseComplexityFactor {
  return { key, label, status, evidence, reason };
}

export function assessCaseComplexity(raw: RawCase): CaseComplexityFactor[] {
  const preconditions = arrayOfText(raw.preconditions);
  const steps = arrayOfText(raw.steps);
  const expected = textOf(raw.expected);
  const data = dataKeys(raw);
  const contract = recordOf(raw.execution_contract ?? raw.executionContract);
  const metadata = recordOf(raw.execution_metadata ?? raw.executionMetadata);
  const environment = arrayOfText(metadata.environment_dependencies ?? metadata.environmentDependencies);
  const text = caseText(raw);
  const assertions = expectedClauses(expected);
  const dataChecks = recordOf(recordOf(raw.design_contract ?? raw.designContract).data_checks ?? recordOf(raw.design_contract ?? raw.designContract).dataChecks);

  const dataEvidence = [
    ...(data.length ? [`test_data 字段 ${data.length} 个`] : []),
    ...(Object.keys(dataChecks).length ? [`data_checks ${Object.keys(dataChecks).length} 项`] : []),
    ...(steps.some((step) => /test_data\.[A-Za-z_][A-Za-z0-9_]*/.test(step)) ? ["步骤引用了 test_data 字段"] : []),
  ];
  const dataStatus: FactorStatus = dataEvidence.length
    ? "observed"
    : steps.length === 0
      ? "unknown"
      : "not_observed";

  const envEvidence = [
    ...preconditions.filter((item) => hasAny(item, ENVIRONMENT_WORDS).length > 0),
    ...environment,
  ];
  const envStatus: FactorStatus = envEvidence.length ? "observed" : preconditions.length || environment.length ? "not_observed" : "unknown";

  const stepEvidence = [
    ...(steps.length ? [`步骤 ${steps.length} 条`] : []),
    ...(assertions.length ? [`预期子句 ${assertions.length} 条`] : []),
    ...(steps.some((step) => hasAny(step, ACTION_WORDS).length > 0) ? ["步骤包含动作"] : []),
    ...(assertions.length || hasAny(expected, ASSERTION_WORDS).length ? ["预期包含可观察断言"] : []),
  ];
  const stepStatus: FactorStatus = steps.length || expected ? "observed" : "unknown";

  const cleanupSignals = [
    ...(contract.cleanup_required === true || contract.cleanupRequired === true ? ["声明需要清理"] : []),
    ...arrayOfText(contract.setup).filter((item) => hasAny(item, CLEANUP_WORDS).length > 0),
    ...preconditions.filter((item) => hasAny(item, CLEANUP_WORDS).length > 0),
    ...(textOf(contract.data_isolation ?? contract.dataIsolation) === "shared" ? ["共享数据隔离"] : []),
  ];
  const cleanupStatus: FactorStatus = cleanupSignals.length
    ? "observed"
    : contract.cleanup_required === false || contract.cleanupRequired === false
      ? "not_observed"
      : "unknown";

  return [
    caseFactor("data_preparation", "数据准备", dataStatus, dataEvidence, dataStatus === "observed" ? `准备了：${dataEvidence.join("、")}。` : dataStatus === "not_observed" ? "步骤未显式引用测试数据；这不等于不需要数据。" : "缺少步骤，无法判断数据准备。"),
    caseFactor("environment_account", "环境/账号", envStatus, envEvidence, envStatus === "observed" ? `前置条件或元数据提到：${envEvidence.join("；")}。` : envStatus === "not_observed" ? "未观察到环境或账号要求；可能由默认环境承担。" : "缺少前置条件，无法判断环境/账号。"),
    caseFactor("steps_and_assertions", "步骤与断言", stepStatus, stepEvidence, stepStatus === "observed" ? `步骤与预期：${stepEvidence.join("、")}。` : "缺少步骤或预期，无法判断执行路径。"),
    caseFactor("state_restore_cleanup", "状态恢复与清理", cleanupStatus, cleanupSignals, cleanupStatus === "observed" ? `清理/恢复信号：${cleanupSignals.join("；")}。` : cleanupStatus === "not_observed" ? "明确声明无需清理。" : "未提供清理声明，无法判断是否影响后续用例。"),
  ];
}

function dimension(status: DimensionStatus, ...reasons: string[]): CaseDimension {
  return { status, reasons };
}

function assessExpectedBasis(raw: RawCase, sources: Record<string, string>, rules: AssessmentRule[]): CaseDimension {
  const expected = textOf(raw.expected);
  const clauses = expectedClauses(expected);
  const direct = basisItems(raw);
  const contract = designBasisItems(raw);

  if (!expected.trim()) {
    return dimension("unsupported", "用例没有预期结果，无法核对预期依据。");
  }

  if (direct.length) {
    const missingSources = new Set<string>();
    const unsupported: string[] = [];
    const supported: string[] = [];
    const covered = new Set<string>();
    for (const { item } of direct) {
      const clause = textOf(item.expected);
      const sourcePath = textOf(item.source_path ?? item.sourcePath);
      const quote = textOf(item.quote);
      const kind = textOf(item.kind);
      const source = sources[sourcePath];
      if (!clause) {
        unsupported.push("存在没有 expected 子句的依据项。");
        continue;
      }
      covered.add(clause);
      if (kind && !FORMAL_BASIS_KINDS.has(kind)) {
        unsupported.push(`「${clause}」的依据类型「${kind}」不是正式预期依据。`);
        continue;
      }
      if (!sourcePath || !quote) {
        unsupported.push(`「${clause}」缺少来源路径或逐字引文。`);
        continue;
      }
      if (source === undefined) {
        missingSources.add(sourcePath);
        continue;
      }
      if (!normalize(source).includes(normalize(quote))) {
        unsupported.push(`「${clause}」的引文在来源「${sourcePath}」中不可逐字定位。`);
        continue;
      }
      const support = clauseSupport(clause, `${quote}\n${source}`);
      if (support === "supported") supported.push(clause);
      else unsupported.push(`引文未支持「${clause}」的完整语义。`);
    }
    for (const clause of clauses) {
      if (![...covered].some((item) => item.includes(clause) || clause.includes(item))) {
        unsupported.push(`预期子句「${clause}」没有对应依据。`);
      }
    }
    if (unsupported.length) {
      return dimension("unsupported", ...unsupported, "引用存在不等于语义受支持；需要修订或补充依据。");
    }
    if (missingSources.size) {
      return dimension("pending", `来源原文未加载：${[...missingSources].join("、")}。不能仅凭引用路径判为可信。`);
    }
    return dimension(
      "supported",
      `已逐句核对 ${supported.length} 个预期子句的引文；这是机械语义检查，不等同人工确认或产品通过。`,
    );
  }

  if (contract.length) {
    const pending = contract.filter((item) => textOf(item.status) === "pending");
    const conflicted = contract.filter((item) => textOf(item.status) === "conflicted");
    const confirmed = contract.filter((item) => textOf(item.status) === "confirmed");
    if (conflicted.length) {
      return dimension("unsupported", ...conflicted.map((item) => `依据「${textOf(item.rule)}」处于冲突状态，不能作为预期支撑。`));
    }
    if (pending.length) {
      return dimension("pending", ...pending.map((item) => `依据「${textOf(item.rule)}」尚未确认，需要业务澄清。`));
    }
    if (confirmed.length) {
      const missing = confirmed.filter((item) => !textOf(item.rule) || !textOf(item.source));
      if (missing.length) return dimension("unsupported", "存在缺少规则或来源的已确认依据。");
      return dimension("supported", `生命周期依据 ${confirmed.length} 条均为 confirmed；规则语义仍应由审阅人复核。`);
    }
    return dimension("unsupported", "设计合同没有可判定的依据状态。");
  }

  const ruleStatuses = rules.map((rule) => rule.status).filter(Boolean);
  if (ruleStatuses.includes("pending")) return dimension("pending", "关联规则中存在待澄清规则。");
  if (ruleStatuses.includes("conflicted")) return dimension("unsupported", "关联规则中存在冲突规则。");
  return dimension("not_recorded", "旧产物或当前用例未记录预期依据；仍可读取，但不能据此判为可信。");
}

function assessDesignValidity(raw: RawCase, point: RawPoint | undefined): CaseDimension {
  const issues: string[] = [];
  const expected = textOf(raw.expected);
  const steps = arrayOfText(raw.steps);
  const title = textOf(raw.title);
  const data = recordOf(raw.test_data ?? raw.testData);
  const contract = recordOf(raw.design_contract ?? raw.designContract);
  const dataChecks = recordOf(contract.data_checks ?? contract.dataChecks);
  const assumptions = Array.isArray(contract.assumptions) ? contract.assumptions.map(recordOf) : [];

  if (!expected.trim()) issues.push("缺少预期结果。");
  if (steps.length === 0) issues.push("缺少操作步骤。");
  if (steps.length > 0 && !steps.some((step) => hasAny(step, ACTION_WORDS).length > 0)) issues.push("步骤中没有可识别的动作，无法触发目标行为。");
  if (expected && !hasAny(expected, ASSERTION_WORDS).length) issues.push("预期没有可观察的断言词，审阅人需确认是否仍可判定。");
  if (point && !textOf(point.description).trim()) issues.push("关联测试点没有描述，无法核对设计目标。");

  for (const step of [...steps, ...arrayOfText(raw.preconditions)]) {
    for (const match of step.matchAll(/test_data\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!hasOwn(data, match[1]!)) issues.push(`步骤引用了不存在的测试数据字段「${match[1]}」。`);
    }
  }
  const referencesData = [...steps, ...arrayOfText(raw.preconditions)].some((step) => /test_data\.[A-Za-z_][A-Za-z0-9_]*/.test(step));
  if (Object.keys(data).length > 0 && !referencesData) {
    issues.push("用例声明了测试数据，但步骤和前置条件没有引用 test_data 字段，无法确认数据由谁设置。");
  }
  const blankKeys = Object.entries(data)
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  const clearsExplicitly = [...steps, ...arrayOfText(raw.preconditions)].some((item) => /清空|置空/.test(item));
  if (blankKeys.length > 0 && !clearsExplicitly) {
    issues.push(`测试数据字段 ${blankKeys.join("、")} 是空字符串；需在步骤中明确清空并核对为空，仅把空值列入数据不足。`);
  }
  const resetScenario = /刷新|导航|重置/.test(`${title} ${expected} ${steps.join(" ")}`);
  const resetsInput = steps.some((step) => /重新|再次|重填|重新输入|重新选择/.test(step));
  if (resetScenario && !resetsInput) {
    issues.push("刷新/导航/重置场景没有说明重新设置输入状态；不能沿用已失效的值。");
  }

  const boundaryGoal = /空|为空|空值|超长|上限|下限|边界|最大|最小|并发|重复/.test(`${title} ${expected}`);
  if (boundaryGoal && Object.keys(data).length === 0 && Object.keys(dataChecks).length === 0) {
    issues.push("空值/边界场景没有声明测试数据或 data_checks，无法证明样本命中目标。");
  } else if (boundaryGoal && Object.keys(dataChecks).length === 0) {
    issues.push("空值/边界场景没有 data_checks，精确边界和测量口径无法核对。");
  }
  const stateGoal = /状态|流转|切换|恢复|重试|回滚/.test(`${title} ${expected}`);
  if (stateGoal && !arrayOfText(raw.preconditions).some((item) => /初始|当前|已有|已存在|状态/.test(item))) {
    issues.push("状态迁移场景没有说明初始状态。");
  }
  const permissionGoal = /权限|角色|管理员|普通用户|成员|所有者|越权/.test(`${title} ${expected}`);
  if (permissionGoal && !arrayOfText(raw.preconditions).some((item) => /账号|角色|权限|登录/.test(item))) {
    issues.push("权限场景没有说明所用账号或角色。");
  }
  if (assumptions.some((item) => textOf(item.status) === "pending")) {
    issues.push("设计合同仍有 pending 假设。");
  }

  return issues.length
    ? dimension("unsupported", ...issues)
    : dimension("supported", "预期、步骤、关联测试点和数据检查具备基本一致性；这是设计可执行性，不是产品测试通过。");
}

function assessExecutability(raw: RawCase): { dimension: CaseDimension; blockers: string[] } {
  const blockers: string[] = [];
  const steps = arrayOfText(raw.steps);
  const expected = textOf(raw.expected);
  const contract = recordOf(raw.execution_contract ?? raw.executionContract);
  const automation = boolOf(raw.automation_feasible ?? raw.automationFeasible);
  if (!steps.length) blockers.push("没有操作步骤，无法执行。");
  if (!expected.trim()) blockers.push("没有预期结果，无法判定执行是否通过。");
  if (automation === false) blockers.push("用例标记为不可自动化；需要人工执行或改写自动化方案。");
  const isolation = textOf(contract.data_isolation ?? contract.dataIsolation);
  const cleanup = boolOf(contract.cleanup_required ?? contract.cleanupRequired);
  if (isolation === "shared" && cleanup !== true) blockers.push("使用共享数据但没有声明清理，可能影响后续用例。");

  if (blockers.length) return { dimension: dimension("unsupported", ...blockers), blockers };
  if (automation === undefined) {
    return { dimension: dimension("unknown", "用例未声明是否可自动化，执行可行性无法判断。"), blockers };
  }
  return {
    dimension: dimension("supported", automation ? "用例标记为可自动化，且步骤与预期齐全。" : "用例可人工执行，步骤与预期齐全。"),
    blockers,
  };
}

function assessCoverage(raw: RawCase, point: RawPoint | undefined): CaseDimension {
  if (!point) return dimension("unknown", "没有关联测试点，无法判断覆盖是否充分。");
  const pointCoverage = arrayOfText(point.coverage_type ?? point.coverageType);
  const caseCoverage = arrayOfText(raw.coverage_type ?? raw.coverageType);
  if (pointCoverage.length === 0) return dimension("unknown", "测试点没有覆盖类型，无法判断用例覆盖是否充分。");
  if (caseCoverage.length === 0) {
    return dimension("unknown", `测试点声明覆盖类型 ${pointCoverage.join("、")}，但用例未声明覆盖类型；无法判断覆盖是否充分，不据此阻断。`);
  }
  const missing = pointCoverage.filter((item) => !caseCoverage.includes(item));
  if (missing.length) return dimension("unsupported", `用例未覆盖测试点声明的：${missing.join("、")}。`);
  return dimension("supported", `用例覆盖类型与测试点一致：${caseCoverage.join("、")}。`);
}

export function assessCase(input: CaseAssessmentInput): CaseAssessment {
  const raw = input.case;
  const caseId = textOf(raw.case_id ?? raw.caseId) || "未命名用例";
  const title = textOf(raw.title) || caseId;
  const factors = assessCaseComplexity(raw);
  const observed = factors.filter((item) => item.status === "observed");
  const unknown = factors.filter((item) => item.status === "unknown");
  const complexity: AssessmentLevel =
    unknown.length === factors.length
      ? "unknown"
      : observed.length >= 3
        ? "high"
        : observed.length >= 1
          ? "medium"
          : "low";
  const expectedBasis = assessExpectedBasis(raw, input.sources ?? {}, input.rules ?? []);
  const designValidity = assessDesignValidity(raw, input.point);
  const executability = assessExecutability(raw);
  const coverageSufficiency = assessCoverage(raw, input.point);
  const observations = observationsOf(raw);
  const pendingClarifications = observations
    .filter((item) => textOf(item.kind) === "needs_confirmation")
    .map((item) => textOf(item.statement) || "未命名的待确认事项");
  const pendingBasis = [expectedBasis].filter((item) => item.status === "pending");

  const hardIssues = [expectedBasis, designValidity, executability.dimension, coverageSufficiency].filter(
    (item) => item.status === "unsupported",
  );
  const status: ConfidenceStatus = hardIssues.length
    ? "needs_revision"
    : pendingClarifications.length || pendingBasis.length
      ? "pending_clarification"
      : expectedBasis.status === "supported" &&
          designValidity.status === "supported" &&
          executability.dimension.status === "supported" &&
          coverageSufficiency.status !== "unsupported"
        ? "executable"
        : "needs_revision";

  const reasons = [
    ...expectedBasis.reasons,
    ...designValidity.reasons,
    ...executability.dimension.reasons,
    ...coverageSufficiency.reasons,
    ...(expectedBasis.status === "not_recorded" ? ["置信度不能从“有引用”推出；未记录依据的旧用例只判为可读取，不判为可信。"] : []),
  ];

  return {
    caseId,
    title,
    complexity,
    complexityReasons: [
      `观察到 ${observed.length} 类执行复杂因素${observed.length ? `：${observed.map((item) => item.label).join("、")}` : ""}；等级不由步骤数单独决定。`,
      ...factors.map((item) => `${item.label}：${item.reason}`),
    ],
    factors,
    confidence: { expectedBasis, designValidity, executability: executability.dimension, coverageSufficiency },
    status,
    pointRisk: input.point ? riskLevel(input.point.risk) : "unknown",
    reasons,
    executionBlockers: executability.blockers,
    pendingClarifications,
    unknowns: unknown.map((item) => `${item.label}：${item.reason}`),
  };
}

export function assessDesign(input: DesignAssessmentInput): DesignAssessment {
  const rules = input.rules ?? [];
  const pointById = new Map<string, RawPoint>();
  for (const point of input.points) {
    const id = textOf(point.id ?? point.point_id);
    if (id) pointById.set(id, point);
  }
  const points = input.points.map((point) => assessPoint(point, rules));
  const cases = input.cases.map((raw) =>
    assessCase({
      case: raw,
      point: pointById.get(textOf(raw.related_test_point ?? raw.relatedTestPoint)),
      sources: input.sources ?? {},
      rules,
    }),
  );
  return {
    points,
    cases,
    summary: {
      points: points.length,
      cases: cases.length,
      highComplexityPoints: points.filter((item) => item.complexity === "high").length,
      highComplexityCases: cases.filter((item) => item.complexity === "high").length,
      needsRevisionCases: cases.filter((item) => item.status === "needs_revision").length,
      pendingClarificationCases: cases.filter((item) => item.status === "pending_clarification").length,
      executableCases: cases.filter((item) => item.status === "executable").length,
    },
    unknowns: [
      ...(input.points.length === 0 ? ["没有测试点数据，无法评估测试点复杂度。"] : []),
      ...(input.cases.length === 0 ? ["没有用例数据，无法评估用例可信度。"] : []),
      ...(Object.keys(input.sources ?? {}).length === 0 ? ["没有加载来源原文；预期依据只能检查引用完整性，不能核对语义。"] : []),
    ],
  };
}

function gateHeadline(gate: QualityGate | undefined): { headline: ResidualRiskAssessment["headline"]; label: string } {
  if (gate === "blocked") return { headline: "blocked", label: "阻断" };
  if (gate === "risk_present") return { headline: "high", label: "存在风险" };
  if (gate === "review_required") return { headline: "review", label: "需复核" };
  if (gate === "informational") return { headline: "informational", label: "仅供参考" };
  return { headline: "unknown", label: "无法评估" };
}

function defectImpact(severity: string): ResidualRiskItem["impact"] {
  if (severity === "Blocker") return "blocker";
  if (severity === "Critical") return "high";
  if (severity === "Major") return "medium";
  if (severity === "Minor" || severity === "Trivial") return "low";
  return "unknown";
}

export function assessResidualRisk(input: ResidualRiskInput): ResidualRiskAssessment {
  const items: ResidualRiskItem[] = [];
  const unknowns: string[] = [];
  const coverage = input.coverage ?? null;
  const defects = input.defects ?? null;
  const results = input.results ?? null;
  const gate = coverage?.gate.qualityGate ?? input.report?.report?.qualityGate;
  const headline = gateHeadline(gate);

  const confirmedDefects: ResidualRiskItem[] = [];
  const pendingPhenomena: ResidualRiskItem[] = [];
  const uncoveredRisks: ResidualRiskItem[] = [];

  if (defects === null) {
    unknowns.push("缺陷事实未加载，无法评估已确认缺陷与待核查现象。");
  } else {
    for (const defect of defects) {
      if (defect.status === "confirmed" || defect.status === "fixed") {
        confirmedDefects.push({
          id: `defect:${defect.defectId}`,
          kind: "confirmed_defect",
          title: defect.title,
          source: `缺陷 ${defect.defectId}`,
          impact: defectImpact(defect.severity),
          status: defect.status === "fixed" ? "已修复（未验证）" : "已确认",
          action: defect.status === "fixed" ? "安排独立复测；未复测不得视为关闭。" : "修复后安排独立复测，并保留证据。",
          reasons: [`严重程度 ${defect.severity}`, `分类 ${defect.category}`, `置信度 ${defect.confidence}`],
        });
      } else if (defect.status === "draft" || defect.status === "needs_review") {
        pendingPhenomena.push({
          id: `defect:${defect.defectId}`,
          kind: "pending_phenomenon",
          title: defect.title,
          source: `缺陷 ${defect.defectId}`,
          impact: defectImpact(defect.severity),
          status: "待核查",
          action: "核对证据与复现条件，确认后转为缺陷或拒绝；不要计入已确认风险。",
          reasons: [`严重程度 ${defect.severity}`, `分类 ${defect.category}`, `置信度 ${defect.confidence}`],
        });
      }
    }
  }

  if (coverage === null) {
    unknowns.push("覆盖事实未加载，无法评估未测用例、未覆盖测试点和高风险未测项。");
  } else {
    for (const point of coverage.points) {
      if (point.status === "untested" || point.status === "blocked" || point.status === "partial") {
        const risky = point.risk === "high";
        const item: ResidualRiskItem = {
          id: `point:${point.pointKey}`,
          kind: "uncovered_risk",
          title: `${point.module} / ${point.feature}`,
          source: `测试点 ${point.pointKey}`,
          impact: risky ? "high" : point.risk === "medium" ? "medium" : "low",
          status: point.status === "untested" ? "未测" : point.status === "blocked" ? "阻塞" : "部分执行",
          action: point.status === "untested" ? "补充执行或说明不执行原因。" : "处理阻塞/补齐未执行用例后重新评估。",
          reasons: [
            `测试点风险：${point.risk}`,
            ...(point.untestedReason ? [point.untestedReason] : []),
            ...(risky ? ["高风险测试点没有完整执行结果，不能视为通过。"] : []),
          ],
        };
        uncoveredRisks.push(item);
      }
    }
    for (const untested of coverage.untested) {
      if (untested.kind !== "case") continue;
      const item: ResidualRiskItem = {
        id: `case:${untested.id}`,
        kind: "untested_case",
        title: `未测用例 ${untested.id}`,
        source: "覆盖统计",
        impact: "unknown",
        status: "未测",
        action: "补充执行或在报告中逐项说明未测原因。",
        reasons: [untested.reason],
      };
      uncoveredRisks.push(item);
    }
    if (!coverage.gate.complete) {
      uncoveredRisks.push({
        id: "coverage:incomplete",
        kind: "design_gap",
        title: "覆盖不完整",
        source: "覆盖门禁",
        impact: coverage.counts.uncoveredPoints > 0 ? "high" : "medium",
        status: "未完成",
        action: "补齐未覆盖测试点或用例，再由所有者确认。",
        reasons: [
          `未覆盖测试点 ${coverage.counts.uncoveredPoints} 个`,
          `未测用例 ${coverage.counts.untestedCases} 个`,
          ...coverage.gate.reasons,
        ],
      });
    }
    if (!coverage.gate.evidenceComplete) {
      uncoveredRisks.push({
        id: "evidence:incomplete",
        kind: "evidence_gap",
        title: "证据不完整",
        source: "覆盖门禁",
        impact: "high",
        status: "待补证",
        action: "补齐失败用例的证据；证据不足的失败不能当作已确认缺陷。",
        reasons: coverage.gate.reasons.filter((reason) => /evidence|insufficient|triage/i.test(reason)),
      });
    }
  }

  if (results === null) {
    unknowns.push("执行结果事实未加载，无法判断失败用例是否缺少证据。");
  } else {
    const failedWithoutEvidence = results.filter(
      (result) => result.status === "failed" && (!result.evidenceRefs || result.evidenceRefs.length === 0),
    );
    for (const result of failedWithoutEvidence) {
      uncoveredRisks.push({
        id: `evidence:${result.caseKey}`,
        kind: "evidence_gap",
        title: `失败断言 ${result.caseKey} 缺少证据`,
        source: "执行结果",
        impact: "high",
        status: "待补证",
        action: "补充失败截图、日志或请求响应；否则不能确认缺陷。",
        reasons: [result.reason || "失败结果未附证据。"],
      });
    }
  }

  if (input.reportLoaded !== true) {
    unknowns.push("报告索引未加载，无法判断报告是否登记或已过期。");
  } else if (!input.report || input.report.report === null) {
    uncoveredRisks.push({
      id: "report:missing",
      kind: "report_gap",
      title: "尚未登记报告索引",
      source: "报告索引",
      impact: "high",
      status: "未登记",
      action: "由项目所有者登记报告；没有报告不得推断已通过。",
      reasons: ["报告索引为空，不能把覆盖或执行结果当作最终报告。"],
    });
  } else if (input.report.stale) {
    uncoveredRisks.push({
      id: "report:stale",
      kind: "report_gap",
      title: "报告索引已过期",
      source: `报告 ${input.report.report.reportId}`,
      impact: "high",
      status: "结果已变化",
      action: "重新生成并登记报告，旧报告不能代表当前结果。",
      reasons: ["结果指纹与报告登记时不一致。"],
    });
  }

  if (input.report?.report) {
    for (const defect of input.report.report.openDefects ?? []) {
      if (defect.status === "confirmed" || defect.status === "fixed") {
        const exists = confirmedDefects.some((item) => item.id === `defect:${defect.defectId}`);
        if (!exists) {
          confirmedDefects.push({
            id: `defect:${defect.defectId}`,
            kind: "confirmed_defect",
            title: `报告中仍有未关闭缺陷 ${defect.defectId}`,
            source: "报告索引",
            impact: defectImpact(defect.severity),
            status: defect.status === "fixed" ? "已修复（未验证）" : "已确认",
            action: "修复并独立复测后关闭。",
            reasons: [`严重程度 ${defect.severity}`],
          });
        }
      }
    }
  }

  items.push(...confirmedDefects, ...pendingPhenomena, ...uncoveredRisks);

  return {
    headline: headline.headline,
    headlineLabel: headline.label,
    items,
    groups: { confirmedDefects, pendingPhenomena, uncoveredRisks },
    counts: {
      points: coverage ? coverage.counts.points : null,
      businessCases: coverage ? coverage.counts.cases : null,
      assertions: results ? results.length : null,
      executed: coverage ? coverage.counts.executed : null,
      passed: coverage ? coverage.counts.passed : null,
      failed: coverage ? coverage.counts.failed : null,
      skipped: coverage ? coverage.counts.skipped : null,
      blocked: coverage ? coverage.counts.blocked : null,
      untestedCases: coverage ? coverage.counts.untestedCases : null,
      uncoveredPoints: coverage ? coverage.counts.uncoveredPoints : null,
      confirmedDefects: defects ? confirmedDefects.length : null,
      pendingDefects: defects ? pendingPhenomena.length : null,
    },
    unknowns,
    notes: [
      "剩余风险等级映射自现有质量门，不是新的评分。",
      "覆盖只表示有关联用例，不等于通过；没有执行结果不得计为通过。",
      "缺失事实显示“无法评估”，不默认低风险或零风险。",
    ],
  };
}

export function assessmentLevelLabel(level: AssessmentLevel): string {
  return level === "low" ? "低" : level === "medium" ? "中" : level === "high" ? "高" : "无法评估";
}

export function factorStatusLabel(status: FactorStatus): string {
  return status === "observed" ? "观察到" : status === "not_observed" ? "未观察到" : "未知";
}

export function confidenceStatusLabel(status: ConfidenceStatus): string {
  return status === "executable"
    ? "可执行"
    : status === "needs_revision"
      ? "需修订"
      : "待业务澄清";
}

export function dimensionStatusLabel(status: DimensionStatus): string {
  return status === "supported"
    ? "有支持"
    : status === "unsupported"
      ? "不支持"
      : status === "pending"
        ? "待确认"
        : status === "not_recorded"
          ? "未记录"
          : "未知";
}

export function residualRiskKindLabel(kind: ResidualRiskKind): string {
  return kind === "confirmed_defect"
    ? "已确认缺陷"
    : kind === "pending_phenomenon"
      ? "待核查现象"
      : kind === "uncovered_risk" || kind === "untested_case" || kind === "design_gap"
        ? "未覆盖风险"
        : kind === "evidence_gap"
          ? "证据缺口"
          : "报告缺口";
}

export function residualImpactLabel(impact: ResidualRiskItem["impact"]): string {
  return impact === "blocker" ? "阻断" : impact === "high" ? "高" : impact === "medium" ? "中" : impact === "low" ? "低" : "未知";
}

export function residualCount(value: number | null): string {
  return value === null ? "无法评估" : String(value);
}
