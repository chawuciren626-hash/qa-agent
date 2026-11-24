/**
 * 任务平台（sbkj-taskassignment）对接契约类型。
 *
 * 权威口径：《任务平台与AITestHarness对接接口清单-2026-11-20.md》（D1~D6 + 五组接口）。
 * 字段只增不改：对端按 schema_version 演进，未知字段必须保留透传，不允许解析期丢弃。
 *
 *snake_case 与任务平台外部契约一致；本模块不做命名适配，适配只发生在消费侧。
 */
import { createHash } from "node:crypto";

export const SOURCE_SYSTEM = "sbkj-taskassignment" as const;
export const HANDOFF_SCHEMA_VERSION = "1.0" as const;
export const RESULT_SCHEMA_VERSION = "1.0" as const;

/** 事件类型三值（接口清单 §4.2）。 */
export type HandoffEventType =
  | "initial_handoff"
  | "material_changed"
  | "new_pm_round";

export const HANDOFF_EVENT_TYPES: readonly HandoffEventType[] = [
  "initial_handoff",
  "material_changed",
  "new_pm_round",
];

/** 结果执行状态五值（接口清单 §4.5）。 */
export type ExecutionStatus =
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled"
  | "blocked";

/** 结果测试结论四值（接口清单 §4.5）。 */
export type TestVerdict = "pass" | "fail" | "blocked" | "inconclusive";

/** 任务平台反馈类型五值（原编码透传）。 */
export type FeedbackType =
  | "requirement"
  | "data_fix"
  | "bug"
  | "question"
  | "config";

/** ---- ① 产品线目录（GET /product-lines） ---- */

export interface ProductModuleDto {
  module_id: string;
  module_code: string;
  module_name: string;
  status: string;
}

export interface ProductSectionDto {
  product_section_id: string;
  section_code: string;
  section_name: string;
  status: string;
  modules: ProductModuleDto[];
}

export interface ProductLineDto {
  product_line_id: string;
  line_code: string;
  line_name: string;
  status: string;
  remark: string | null;
  sort_order: number;
  updated_at: string | null;
  sections: ProductSectionDto[];
}

export interface ProductLinePage {
  items: ProductLineDto[];
  next_cursor: string | null;
  has_more: boolean;
  catalog_version?: string;
}

/** ---- ② 交接事件（GET /handoff-events，游标） ---- */

export interface HandoffEventDto {
  event_id: string;
  event_type: HandoffEventType;
  tenant_id: string;
  task_id: string;
  task_no: string;
  package_version: number;
  parent_package_version: number | null;
  pm_round_id: string | null;
  product_line_ids: string[];
  occurred_at: string;
}

export interface HandoffEventPage {
  items: HandoffEventDto[];
  next_cursor: string | null;
  has_more: boolean;
}

/** ---- ③ 交接包（GET /tasks/{task_id}/handoff-packages/{version}，11 组字段） ---- */

export interface HandoffEventBlock {
  event_id: string;
  event_type: HandoffEventType;
  generated_at: string | null;
  reason: string | null;
}

export interface ProductLineRef {
  product_line_id: string;
  line_code: string;
  line_name: string;
  is_primary: boolean;
}

export interface OperatorRef {
  user_id: string | null;
  display_name: string | null;
}

export interface TaskBasicBlock {
  parent_task_id: string | null;
  root_task_id: string | null;
  task_kind: string;
  title: string;
  feedback_type: string;
  priority: string;
  complexity_level: string | null;
  estimated_hours: number | null;
  estimated_days: number | null;
  status_code: string;
  submitter: OperatorRef;
  assignee: OperatorRef;
  created_at: string | null;
}

export interface PmRoundBlock {
  pm_round_id: string;
  round_no: number;
  entered_at: string | null;
}

export interface FlowBlock {
  development_round_id: string | null;
  pm_round: PmRoundBlock;
}

export interface OriginalSupplement {
  comment_id: string;
  content: string;
  created_at: string | null;
  operator: OperatorRef;
  attachments: unknown[];
}

export interface ConfirmedBaselineBlock {
  final_content: string;
  acceptance_criteria: string[];
  missing_fields: string[];
  confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  document_signature: unknown;
}

export interface RequirementBlock {
  original_content: string;
  original_supplements: OriginalSupplement[];
  original_rich_content: string | null;
  ai_content: string | null;
  ai_structured_result: Record<string, unknown> | null;
  final_content: string;
  confirmed_baseline: ConfirmedBaselineBlock;
}

export interface ScheduleDesignDocumentRef {
  document_key: string;
  file_name: string;
  attachment_id: string;
}

export interface SelfTestSubmissionBlock {
  development_round_id: string | null;
  self_test_submission_id: string;
  submitted_at: string | null;
  review_mode: string | null;
  approval_status: string;
  reviewed_at: string | null;
  request_reason: string | null;
  submission_sections: Record<string, unknown>[];
  related_links: string[];
}

export interface ChangeRecord {
  change_id: string;
  node_code: string;
  node_label: string;
  flow_round_id: string;
  change_batch_no: number;
  change_sequence: number;
  change_content: string;
  sections: Record<string, unknown>[];
  changed_at: string | null;
  operator: OperatorRef;
  attachment_ids: string[];
  package_version: number | null;
  source_refs: Record<string, unknown>[];
}

export interface AttachmentMeta {
  attachment_id: string;
  file_name: string;
  content_type: string | null;
  file_size: number;
  sha256: string | null;
  file_category: string;
  node_code: string | null;
  flow_round_id: string | null;
  flow_record_id: string | null;
  parse_status: string;
  download_mode: string;
  uri: string;
  download_url: string | null;
  expires_at: string | null;
  authorization_scope: string;
}

export interface HandoffDocumentBlock {
  format: string;
  title: string;
  content: string;
  content_hash: string;
}

export interface PreviousFailedIssue {
  issue_no: string;
  title: string;
  problem_description: string;
  expected_result: string | null;
  test_scene: string | null;
  severity: string;
  status: string;
}

export interface RectificationRecord {
  issue_id: string;
  solution: string;
  changed_content: string;
  test_method: string;
  test_result: string;
  risk_note: string | null;
  evidence_attachment_ids: string[];
}

export interface RegressionContextBlock {
  previous_pm_round_id: string;
  previous_failed_issues: PreviousFailedIssue[];
  rectifications: RectificationRecord[];
}

export interface HandoffPackage {
  schema_version: string;
  source_system: string;
  tenant_id: string;
  task_id: string;
  task_no: string;
  source_url: string;
  package_version: number;
  parent_package_version: number | null;
  content_hash: string;
  event: HandoffEventBlock;
  product_lines: ProductLineRef[];
  unresolved_product_line_names: string[];
  task: TaskBasicBlock;
  flow: FlowBlock;
  requirement: RequirementBlock;
  schedule_design_documents: ScheduleDesignDocumentRef[];
  development_self_test: SelfTestSubmissionBlock;
  changes: ChangeRecord[];
  attachments: AttachmentMeta[];
  handoff_document: HandoffDocumentBlock;
  regression_context: RegressionContextBlock | null;
  /** 契约演进：未识别字段原样保留（D6 整包透传原则）。 */
  [extra: string]: unknown;
}

/** ---- ⑤ 测试结果回传（POST /tasks/{task_id}/test-results） ---- */

export interface ResultTestScope {
  summary: string;
  covered_scope?: string[];
  not_covered_scope?: string[];
  [extra: string]: unknown;
}

export interface ResultStatistics {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  not_executed: number;
}

export interface ResultIssue {
  issue_no: string;
  title: string;
  severity: "high" | "medium" | "low";
  test_point_id?: string;
  preconditions?: string[];
  steps?: string[];
  expected_result?: string;
  actual_result?: string;
  evidence_ids?: string[];
  source_refs?: Record<string, unknown>[];
  [extra: string]: unknown;
}

export interface EvidenceIndexItem {
  evidence_id: string;
  type: string;
  description: string;
  uri: string;
  [extra: string]: unknown;
}

export interface RegressionResultBlock {
  is_regression: boolean;
  trigger_package_version?: number;
  previous_result_id?: string;
  failed_test_point_ids?: string[];
  [extra: string]: unknown;
}

export interface TestResultPayload {
  schema_version: string;
  source_system: string;
  tenant_id: string;
  task_id: string;
  pm_round_id: string;
  package_version: number;
  package_hash: string;
  project_id: string;
  test_task_id: string;
  session_id: string;
  run_id: string;
  result_id: string;
  result_version: number;
  execution_status: ExecutionStatus;
  test_verdict: TestVerdict;
  started_at: string;
  finished_at: string;
  test_scope: ResultTestScope;
  statistics: ResultStatistics;
  issues: ResultIssue[];
  summary: string;
  risks: string[];
  evidence_index: EvidenceIndexItem[];
  result_attachments?: unknown[];
  regression?: RegressionResultBlock;
  created_at: string;
}

export interface TestResultAck {
  result_id: string;
  result_version: number;
  receive_status: "accepted" | "duplicate";
  received_at: string | null;
}

/** ---- 任务平台统一响应外壳与错误码（接口清单 §3.5） ---- */

export interface PlatformEnvelope<T> {
  code: number;
  message: string;
  subCode: string;
  subMessage: string;
  data: T | null;
  traceId: string | null;
  timestamp: string | null;
}

/** 可重试错误码（接口清单 §3.5）：网络/限流/临时不可用，允许退避重试。 */
export const RETRYABLE_SUB_CODES: readonly string[] = [
  "INTEGRATION.UPSTREAM_TIMEOUT",
  "INTEGRATION.UPSTREAM_UNAVAILABLE",
  "INTEGRATION.RATE_LIMITED",
  "INTEGRATION.ATTACHMENT_TEMPORARILY_UNAVAILABLE",
];

/** 事件游标过期：需要从最早可用游标重建（客户端负责清空游标重拉）。 */
export const CURSOR_EXPIRED_SUB_CODE = "INTEGRATION.EVENT_CURSOR_EXPIRED" as const;

/** ---- 运行时校验（窄化用，不做全字段校验——契约由平台侧保证） ---- */

export function isHandoffEventType(value: unknown): value is HandoffEventType {
  return typeof value === "string" && (HANDOFF_EVENT_TYPES as readonly string[]).includes(value);
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return (
    value === "completed" ||
    value === "partially_completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "blocked"
  );
}

export function isTestVerdict(value: unknown): value is TestVerdict {
  return value === "pass" || value === "fail" || value === "blocked" || value === "inconclusive";
}

/** 包最小完整性：缺任一关键字段视为坏包，不激活（对接方案 §13.1）。 */
export function looksLikeValidHandoffPackage(value: unknown): value is HandoffPackage {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.task_id === "string" &&
    typeof p.task_no === "string" &&
    typeof p.package_version === "number" &&
    typeof p.content_hash === "string" &&
    Array.isArray(p.product_lines) &&
    Array.isArray(p.attachments) &&
    Array.isArray(p.changes) &&
    typeof p.task === "object" &&
    p.task !== null &&
    typeof p.requirement === "object" &&
    p.requirement !== null &&
    typeof p.development_self_test === "object" &&
    p.development_self_test !== null
  );
}

/** 幂等键格式（接口清单 §4.5）：aitest:{tenant}:{task}:{pm_round}:{result_id}。 */
export function buildIdempotencyKey(
  tenantId: string,
  taskId: string,
  pmRoundId: string,
  resultId: string,
): string {
  return `aitest:${tenantId}:${taskId}:${pmRoundId}:${resultId}`;
}

/**
 * 测试结果载荷形态校验（C1 服务端接收面）：关键标识与统计块齐全即接受；
 * 全量业务字段（statistics/issues/evidence_index）形态由任务平台侧 422 把关——
 * 服务端接收面只拦"结构性不可投递"的载荷（缺标识 = 无法构建幂等键）。
 */
export function looksLikeValidTestResultPayload(value: unknown): value is TestResultPayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.task_id === "string" && p.task_id.length > 0 &&
    typeof p.pm_round_id === "string" &&
    typeof p.result_id === "string" && p.result_id.length > 0 &&
    typeof p.result_version === "number" && Number.isInteger(p.result_version) && p.result_version >= 1 &&
    typeof p.package_version === "number" &&
    typeof p.test_verdict === "string" &&
    typeof p.execution_status === "string" &&
    typeof p.summary === "string"
  );
}

/** 结果载荷哈希（C1 幂等防线第二层）：同 result_id+version 但内容不同 = 配置错误（409 拒绝）。 */
export function testResultPayloadHash(payload: TestResultPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
