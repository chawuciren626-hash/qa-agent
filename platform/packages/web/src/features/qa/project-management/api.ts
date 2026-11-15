/**
 * 项目管理页的统一数据适配层：页面组件只 import 这里的接口对象与类型，
 * 不直接 import mock（需求文档 §11 / §15：mock 数据不会进入生产接口结果）。
 *
 * 接口失败时页面会展示服务端错误消息：
 * - 列表失败 / 进入失败 / 创建失败 / 置顶失败：可重试，停留原状态；
 * - 更新冲突：消息为「项目已被更新，请刷新后重试」，不得静默覆盖；
 * - 归档冲突：消息说明存在运行中或排队中的任务，先处理任务；
 * - 未授权项目：不返回详情，消息不泄露项目内容。
 */
import type {
  CreateProjectInput,
  ManagedProject,
  ProjectListQuery,
  ProjectListResult,
  UpdateProjectInput,
} from "./types";
import { apiFetch } from "../../../api/client";

const base = "/api/projects/managed";
const item = (projectId: string) => `${base}/${encodeURIComponent(projectId)}`;
const project = (response: { project: ManagedProject }) => response.project;

/**
 * 按查询条件返回一页项目（搜索/筛选/排序/分页在接口层对完整结果集执行）。
 */
export async function listProjects(query: ProjectListQuery): Promise<ProjectListResult> {
  return apiFetch<ProjectListResult>(base, { query: { ...query } });
}

/** 读取单个项目详情（含 capabilities/revision）。 */
export async function getProject(projectId: string): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(item(projectId)));
}

/**
 * 手动创建项目（来源固定手动；Project id 与名称均由用户提供，服务端再校验）。
 */
export async function createProject(input: CreateProjectInput): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(base, { method: "POST", body: input }));
}

/**
 * 编辑基本信息（手动项目：名称/简介；expectedRevision 并发保护）。
 */
export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(item(projectId), { method: "PATCH", body: input }));
}

/** 个人置顶/取消置顶（账号级偏好）。 */
export async function setProjectPinned(projectId: string, pinned: boolean): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(`${item(projectId)}/pin`, { method: "PUT", body: { pinned } }));
}

/** 手动项目归档（存在运行/排队任务时后端拒绝并说明原因）。 */
export async function archiveProject(projectId: string): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(`${item(projectId)}/archive`, { method: "POST", body: {} }));
}

/** 恢复已归档的手动项目（不自动重跑历史任务）。 */
export async function restoreProject(projectId: string): Promise<ManagedProject> {
  return project(await apiFetch<{ project: ManagedProject }>(`${item(projectId)}/restore`, { method: "POST", body: {} }));
}

/**
 * 进入项目前的服务端校验（项目仍可进入、账号仍有成员身份）；成功后由页面
 * 复用现有项目上下文（setCurrentProjectId）完成真实切换。
 */
export async function enterProject(projectId: string): Promise<void> {
  await apiFetch(`${item(projectId)}/enter`, { method: "POST", body: {} });
}

/**
 * 左上角快速切换的候选列表：≤8 个、当前项目在前，置顶优先、其次最近访问，去重。
 */
export async function quickSwitchProjects(currentProjectId: string | null): Promise<ManagedProject[]> {
  const result = await apiFetch<{ projects: ManagedProject[] }>(`${base}/quick-switch`, { query: { currentProjectId: currentProjectId ?? undefined } });
  return result.projects;
}
