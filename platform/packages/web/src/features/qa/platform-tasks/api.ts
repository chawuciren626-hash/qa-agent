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
  source: TaskSource;
  taskNo: string;
  title: string;
  priority: "high" | "medium" | "low";
  packageVersion: number | null;
  roundNo: number | null;
  productLines: Array<{ name: string; isPrimary: boolean }>;
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
  status: string;
  counts: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskDetail {
  task: TaskListItem & {
    feedbackType: string | null;
    estimatedHours: number | null;
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

export function getTaskDetail(projectId: string, taskId: string): Promise<TaskDetail> {
  return apiFetch<TaskDetail>(`${base(projectId)}/${encodeURIComponent(taskId)}`);
}

/**
 * 新建本地任务。优先级不再由表单收集（以 AI 建议为准）；测试环境 URL 与登录账号选填，
 * 服务端把 URL 解析/登记进项目环境后存关联结果。
 */
export function createLocalTask(
  projectId: string,
  input: { title: string; description: string; envBaseUrl?: string; account?: string }
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
  }
): Promise<{ updated: TaskListItem | null; analysisStale: boolean }> {
  return apiFetch<{ updated: TaskListItem | null; analysisStale: boolean }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/edit`,
    { method: "POST", body: input }
  );
}

/**
 * 发起 AI 分析：项目默认模型同步分析任务填写内容，直接返回结构化结论（需求整理/
 * 测试环境/测试账号/建议范围等）并落库。
 */
export function analyzeTask(
  projectId: string,
  taskId: string
): Promise<{ updated: TaskListItem | null; summary: AiSummary | null; degraded?: { reason: string } }> {
  return apiFetch<{ updated: TaskListItem | null; summary: AiSummary | null; degraded?: { reason: string } }>(
    `${base(projectId)}/${encodeURIComponent(taskId)}/analyze`,
    { method: "POST", body: {} }
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
