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
  EnvironmentKnowledge,
  EnvironmentView,
  Hypothesis,
  HypothesisStatus,
  HypothesisSummary,
  ExplorationView,
  ManagedProject,
  ProjectListQuery,
  StartExplorationInput,
  ProjectListResult,
  UpdateProjectInput,
  WhyUnknown,
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

// ---------------------------------------------------------------- 项目环境

const envBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/environments`;
const envItem = (projectId: string, env: string) => `${envBase(projectId)}/${encodeURIComponent(env)}`;

/** 一个项目的全部环境；defaultEnv 为 null 表示还没连过环境。 */
export async function listEnvironments(
  projectId: string,
): Promise<{ environments: EnvironmentView[]; defaultEnv: string | null }> {
  return apiFetch<{ environments: EnvironmentView[]; defaultEnv: string | null }>(envBase(projectId));
}

/** 新增或修改一个环境（地址变更会清空旧建档摘要，不会出现旧站点的页面数描述新地址）。 */
export async function saveEnvironment(
  projectId: string,
  input: { env?: string; baseUrl: string; isDefault?: boolean; endType?: string },
): Promise<EnvironmentView> {
  const response = await apiFetch<{ environment: EnvironmentView }>(envBase(projectId), { method: "POST", body: input });
  return response.environment;
}

/** 读取单个环境（建档期间用于轮询 status）。 */
export async function getEnvironment(projectId: string, env: string): Promise<EnvironmentView> {
  const response = await apiFetch<{ environment: EnvironmentView }>(envItem(projectId, env));
  return response.environment;
}

/**
 * 触发建档：服务端立刻返回（status=probing），实际抓取在后台跑。
 * 调用方按 getEnvironment 轮询，不要在这里等——建档最长两分钟。
 */
export async function bootstrapEnvironment(projectId: string, env: string): Promise<EnvironmentView> {
  const response = await apiFetch<{ environment: EnvironmentView }>(`${envItem(projectId, env)}/bootstrap`, {
    method: "POST",
    body: {},
  });
  return response.environment;
}

// ---------------------------------------------------------------- 探索派发

/** 轮次列表 + 最近一轮；探索进行中由页面轮询这个接口。 */
export async function listExplorations(
  projectId: string,
  env: string,
): Promise<{ explorations: ExplorationView[]; latest: ExplorationView | null }> {
  return apiFetch<{ explorations: ExplorationView[]; latest: ExplorationView | null }>(
    `${envItem(projectId, env)}/explorations`,
  );
}

/**
 * 派发一轮探索：服务端立刻返回（status=running），浏览器脚本在后台跑。
 * 凭据只用于当次派发，不落库——下次派发的密码框一律重新填。
 */
export async function startExploration(
  projectId: string,
  env: string,
  input: StartExplorationInput,
): Promise<ExplorationView> {
  const response = await apiFetch<{ exploration: ExplorationView }>(`${envItem(projectId, env)}/explore`, {
    method: "POST",
    body: input,
  });
  return response.exploration;
}

/** 人工填答验证码（只在 waiting_human 的那一轮有效）。 */
export async function answerExplorationCaptcha(
  projectId: string,
  env: string,
  explorationId: string,
  answer: string,
): Promise<ExplorationView> {
  const response = await apiFetch<{ exploration: ExplorationView }>(
    `${envItem(projectId, env)}/explore/${encodeURIComponent(explorationId)}/answer`,
    { method: "POST", body: { answer } },
  );
  return response.exploration;
}

/** 中止：已采部分随本轮封存，不算成功也不算失败。 */
export async function abortExploration(
  projectId: string,
  env: string,
  explorationId: string,
): Promise<ExplorationView> {
  const response = await apiFetch<{ exploration: ExplorationView }>(
    `${envItem(projectId, env)}/explore/${encodeURIComponent(explorationId)}/abort`,
    { method: "POST", body: {} },
  );
  return response.exploration;
}

/** 验证码截图地址（<img src> 直接用；后端不缓存）。 */
export function explorationCaptchaUrl(projectId: string, env: string, explorationId: string): string {
  return `${envItem(projectId, env)}/explore/${encodeURIComponent(explorationId)}/captcha`;
}

// ---------------------------------------------------------------- 探索资产与假设

/**
 * 一次取回四层资产 + 假设计数。
 * 分开请求会让首屏出现「地图有了、计数还是 0」的错帧，所以后端就配成一次返回。
 */
export async function getEnvironmentKnowledge(
  projectId: string,
  env: string,
): Promise<{ knowledge: EnvironmentKnowledge; hypotheses: HypothesisSummary }> {
  return apiFetch<{ knowledge: EnvironmentKnowledge; hypotheses: HypothesisSummary }>(
    `${envItem(projectId, env)}/knowledge`,
  );
}

export async function listHypotheses(
  projectId: string,
  env: string,
  status?: HypothesisStatus,
): Promise<{ hypotheses: Hypothesis[]; summary: HypothesisSummary }> {
  return apiFetch<{ hypotheses: Hypothesis[]; summary: HypothesisSummary }>(
    `${envItem(projectId, env)}/hypotheses`,
    { query: status ? { status } : undefined },
  );
}

/** 人提一条待验证假设（不进地图：验证通过后由探索程序写回）。 */
export async function createHypothesis(
  projectId: string,
  env: string,
  input: {
    statement: string;
    whyUnknown: WhyUnknown;
    moduleKey?: string;
    expectation?: string;
    dataSetup?: string;
    allowSeed?: boolean;
  },
): Promise<Hypothesis> {
  const response = await apiFetch<{ hypothesis: Hypothesis }>(`${envItem(projectId, env)}/hypotheses`, {
    method: "POST",
    body: input,
  });
  return response.hypothesis;
}
