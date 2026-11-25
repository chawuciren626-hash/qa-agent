/**
 * 平台任务列表前端 API（TL-4 切片）。
 *
 * 口径：见《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5。
 * 数据来源为平台同步任务与用户创建的本地任务；开始测试返回 sessionId 后由页面
 * 打开既有全流程阶段页（/chat/:sessionId）——本模块不做流程页。
 * 接口失败统一抛 ApiError，由页面展示服务端错误消息（同 project-management/api.ts 约定）。
 */
import { apiFetch } from "../../../api/client";

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/agents/qa/platform-tasks`;

export type TaskSource = "platform" | "local";

export interface TaskListItem {
  id: string;
  /** 任务所属项目（跨项目列表每行都带，行内操作据此回落项目作用域接口）。 */
  projectId: string;
  source: TaskSource;
  taskNo: string;
  title: string;
  priority: "high" | "medium" | "low";
  packageVersion: number | null;
  roundNo: number | null;
  productLines: Array<{ name: string; isPrimary: boolean }>;
  /** 任务声明的涉及端（B1-7，标准枚举子集）；空数组 = 未声明。 */
  ends: string[];
  changeSource: string | null;
  suggestedPriority: string | null;
  analysisSource: string | null;
  status: string;
  edited: boolean;
  mainSessionId: string | null;
  sourceUrl: string;
  updatedAt: string;
}

export interface AiSummary {
  /** 需求内容整理（一段话概括要测什么）。 */
  requirement_summary?: string;
  requirement_points: string[];
  suggested_test_scope: string[];
  /** 测试环境（URL 或说明，从填写内容与任务环境字段整理）。 */
  test_environment?: string;
  /** 测试账号（从填写内容提取）。 */
  test_account?: string;
  /** 测试密码（从填写内容提取；来自用户自己录入的任务材料）。 */
  test_password?: string;
  suggested_priority: string;
  priority_reason: string;
  risks: string[];
  open_questions: string[];
  analyzed_at: string;
  source: string;
  stage?: string;
}

export interface TaskProgressRun {
  runId: string;
  /** planned = 发起前预登记（预约已建、事实未发生）。 */
  status: string;
  counts: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  env: string;
  kind: string;
}

export interface TaskDetail {
  task: TaskListItem & {
    feedbackType: string | null;
    /** 反馈类型中文名（服务端映射；未知编码原样）。 */
    feedbackTypeLabel?: string | null;
    estimatedHours: number | null;
    submitter?: string | null;
    assignee?: string | null;
    complexityLevel?: string | null;
    estimatedDays?: number | null;
    requirementBaseline?: { final_content?: string; original_content?: string; acceptance_criteria?: string[]; confirmed?: boolean; confirmed_at?: string | null } | null;
    selfTestDigest?: { reviewed_at?: string | null; review_mode?: string | null; test_address?: string; self_test_result?: string; affected_modules?: string; known_risks?: string; test_focus?: string; version_info?: string; related_links?: string[] } | null;
    changesDigest?: Array<{ node?: string; node_code?: string; batch?: number; sequence?: number; content?: string; changed_at?: string | null; operator?: string | null }>;
    /** 交接包结构化资料全集（内容整理/原始反馈含补充意见/自测提交字段级/变更 sections/包附件/文档引用/回归上下文）；老库回填前 null。 */
    packageDetail?: Record<string, unknown> | null;
    description: string | null;
    localTitleNote: string;
    localTestFocusNote: string;
    localEditedAt: string | null;
    createdBy: string | null;
    /** 本地任务：测试环境关联（env 名 + URL 快照）；未填为 null。 */
    envName: string | null;
    envBaseUrl: string | null;
    /** 本地任务：登录账号（选填；密码不落任务表）。 */
    account: string | null;
    /** 任务声明的涉及端（B1-7）；空数组 = 未声明。 */
    ends: string[];
    changeSource: string | null;
  };
  summary: AiSummary | null;
  progress: { mainSessionId: string | null; runs: TaskProgressRun[] };
}

export interface TaskListResponse {
  items: TaskListItem[];
  counts: Record<string, number>;
}

export function listTasks(projectId: string, includeTerminated = false): Promise<TaskListResponse> {
  return apiFetch<TaskListResponse>(
    `${base(projectId)}${includeTerminated ? "?includeTerminated=true" : ""}`
  );
}

/**
 * 全部项目的任务（列表页默认口径）。
 * 项目管理是独立模块：在里面点项目视图 / 环境 / 资料不会反向筛掉任务列表，
 * 所以列表按账号可访问的项目聚合，而不是按当前选中项目过滤。
 * projectNames 由服务端随列表下发（项目配置名）：前端项目切换器未加载/缓存过期时，
 * "所属项目"列仍显示名称而不是项目编号。
 */
export function listAllTasks(includeTerminated = true): Promise<TaskListResponse & { projectIds: string[]; projectNames?: Record<string, string> }> {
  return apiFetch<TaskListResponse & { projectIds: string[]; projectNames?: Record<string, string> }>(
    `/api/me/qa-platform-tasks${includeTerminated ? "?includeTerminated=true" : ""}`
  );
}

export function getTaskDetail(projectId: string, taskId: string): Promise<TaskDetail> {
  return apiFetch<TaskDetail>(`${base(projectId)}/${encodeURIComponent(taskId)}`);
}

/**
 * 新建本地任务。优先级不再由表单收集（以 AI 建议为准）；测试环境 URL 与登录账号选填，
 * 服务端把 URL 解析/登记进项目环境后存关联结果。
 */
export function createLocalTask(
  projectId: string,
  input: { title: string; description: string; envBaseUrl?: string; account?: string; ends?: string[]; changeSource?: string }
): Promise<{ task: TaskListItem }> {
  return apiFetch<{ task: TaskListItem }>(`${base(projectId)}/local`, {
    method: "POST",
    body: input,
  });
}

export function editTask(
  projectId: string,
  taskId: string,
  input: {
    localTitleNote?: string;
    localTestFocusNote?: string;
    title?: string;
    description?: string;
    envBaseUrl?: string;
    account?: string;
    ends?: string[];
    changeSource?: string;
  }
): Promise<{ updated: TaskListItem | null; analysisStale: boolean }> {
  return apiFetch<{ updated: TaskListItem | null; analysisStale: boolean }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/edit`,
    { method: "POST", body: input }
  );
}

/**
 * 发起 AI 分析：账号级默认模型同步分析任务填写内容，直接返回结构化结论（需求整理/
 * 测试环境/测试账号/建议范围等）并落库。模型最长可等 90s，超过 socket 的 20s
 * 应答期限；socket 超时既不会重试写请求，还会取消服务端正在跑的分析，故固定走 HTTP。
 */
export function analyzeTask(
  projectId: string,
  taskId: string
): Promise<{ updated: TaskListItem | null; summary: AiSummary | null; degraded?: { reason: string } }> {
  return apiFetch<{ updated: TaskListItem | null; summary: AiSummary | null; degraded?: { reason: string } }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/analyze`,
    { method: "POST", body: {}, transport: "http" }
  );
}

export function startTask(
  projectId: string,
  taskId: string
): Promise<{ task: TaskListItem | null; sessionId: string; previousStatus: string | null }> {
  return apiFetch<{ task: TaskListItem | null; sessionId: string; previousStatus: string | null }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/start`,
    { method: "POST", body: {} }
  );
}

export function terminateTask(
  projectId: string,
  taskId: string,
  reason: string
): Promise<{ updated: TaskListItem | null }> {
  return apiFetch<{ updated: TaskListItem | null }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/terminate`,
    { method: "POST", body: { reason } }
  );
}

// ---------------------------------------------------------------- 附件（B1-3b）

export interface TaskAttachment {
  attachmentId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

export function listTaskAttachments(projectId: string, taskId: string): Promise<{ attachments: TaskAttachment[] }> {
  return apiFetch<{ attachments: TaskAttachment[] }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/attachments`
  );
}

/** 上传文本附件：客户端读为 UTF-8 文本后 base64 传输（同 trace import 的传输先例）。 */
export function uploadTaskAttachment(
  projectId: string,
  taskId: string,
  input: { filename: string; mime: string; dataBase64: string }
): Promise<{ attachment: TaskAttachment; attachments: TaskAttachment[] }> {
  return apiFetch<{ attachment: TaskAttachment; attachments: TaskAttachment[] }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/attachments`,
    { method: "POST", body: input }
  );
}

export function deleteTaskAttachment(
  projectId: string,
  taskId: string,
  attachmentId: string
): Promise<{ removed: boolean }> {
  return apiFetch<{ removed: boolean }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" }
  );
}
