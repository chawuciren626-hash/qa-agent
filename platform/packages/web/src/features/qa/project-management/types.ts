/**
 * 项目管理页的数据契约（需求文档《项目管理模块交互需求 2026-11-10》§11 字段全集）。
 *
 * 这里只定义前端页面消费的类型与查询语义；真实接口由 Codex 在后端实现后按同一形状接入
 * （见 ./api.ts 的适配层）。字段含义以需求文档 §4.2 / §11 为准：
 * - 显示名称与稳定 projectId 分开；同步项目名称允许重复，靠来源与外部编号区分；
 * - `purpose` 为服务端提供的可见性标志（区分业务项目与内部配置项目），前端不自行推断；
 * - `capabilities` 是后端返回的能力标志，前端按能力渲染，不做隐藏式权限控制。
 */

/** 项目来源：手动创建 | 平台同步。 */
export type ProjectSourceType = "manual" | "sync";

/** 项目状态（不与测试任务的执行状态混用）。 */
export type ProjectStatus = "active" | "archived" | "disabled";

/** 服务端返回的操作能力标志（§9 权限矩阵的前端消费形态）。 */
export interface ProjectCapabilities {
  /** 能否进入项目（按项目状态与后端权限决定；false 时页面显示「不可进入」）。 */
  canEnter: boolean;
  /** 不可进入时后端给出的原因（展示给用户；可进入时为 null）。 */
  cannotEnterReason: string | null;
  /** 能否编辑显示名称/简介（手动项目有维护权限；同步项目外部维护字段只读）。 */
  canMaintain: boolean;
  /** 能否进行成员/权限设置（复用既有项目设置能力）。 */
  canManageMembers: boolean;
  /** 能否归档（仅后端允许归档的手动项目；存在运行/排队任务时后端仍会拒绝）。 */
  canArchive: boolean;
  /** 能否恢复（已归档手动项目）。 */
  canRestore: boolean;
  /** 能否个人置顶（§9：所有有访问权限的用户可置顶）。 */
  canPin: boolean;
}

/** 项目管理列表/详情的项目条目（§11 字段全集）。 */
export interface ManagedProject {
  /** 稳定项目身份；重命名只改显示名称，不改变任务关联。 */
  projectId: string;
  name: string;
  description: string | null;
  sourceType: ProjectSourceType;
  /** 同步项目的来源平台名（如 Jira / 禅道）；手动项目为 null。 */
  sourceSystemName: string | null;
  externalProjectId: string | null;
  /** 外部链接：仅允许经过校验的 HTTP(S) 地址；缺失时为 null 且不展示链接。 */
  externalUrl: string | null;
  status: ProjectStatus;
  /** 用途/可见性标志（§2.3：服务端提供；缺失为 null，前端不按名称猜测隐藏）。 */
  purpose: "business" | "internal" | null;
  /** 我的角色（既有权限含义的中文名：创建者/项目管理员/成员/只读成员）。 */
  myRole: string;
  createdByDisplayName: string;
  /** ISO 8601（UTC 带时区），界面按用户本地时区展示。 */
  createdAt: string;
  /** 业务活动时间（后端定义；缺失为 null，显示「—」，不可伪造）。 */
  lastActivityAt: string | null;
  /** 最近同步时间（手动项目为 null）。 */
  lastSyncedAt: string | null;
  /** 运行中任务数（未知为 null 显示「—」，明确为 0 显示 0）。 */
  runningTaskCount: number | null;
  /** 排队待执行任务数（归档限制判断依据之一）。 */
  queuedTaskCount: number | null;
  /** 当前账号的个人置顶偏好（账号级，不回写外部平台）。 */
  isPinned: boolean;
  /** 当前账号最近一次访问时间（与 lastActivityAt 分开记录）。 */
  lastVisitedAt: string | null;
  capabilities: ProjectCapabilities;
  /** 并发更新标识；编辑保存需回传 expectedRevision，冲突时提示刷新。 */
  revision: number;
}

/** 列表查询条件（搜索/筛选/排序/分页在适配层按真实接口语义实现）。 */
export interface ProjectListQuery {
  /** 搜索关键词：匹配项目名称、内部项目编号、外部项目编号。 */
  keyword: string;
  sourceType: "all" | ProjectSourceType;
  /** 状态筛选，页面默认「进行中」。 */
  status: "all" | ProjectStatus;
  /** 排序：最近活动优先 / 最近创建优先 / 名称排序。 */
  sort: "activity" | "created" | "name";
  page: number;
  pageSize: 20 | 50 | 100;
}

/** 列表结果：分页依据完整结果集，不能只搜索已加载页。 */
export interface ProjectListResult {
  total: number;
  page: number;
  pageSize: ProjectListQuery["pageSize"];
  projects: ManagedProject[];
  /** 账号是否允许手动新建项目（§10 无创建权限时隐藏新建按钮）。 */
  canCreate: boolean;
}

/** 手动新建项目的提交内容（来源固定为手动创建，无需用户选择平台）。 */
export interface CreateProjectInput {
  projectId: string;
  name: string;
  description?: string;
}

/** 基本信息编辑的提交内容（同步项目的外部维护字段不在可编辑范围）。 */
export interface UpdateProjectInput {
  name?: string;
  description?: string;
  /** 并发保护：服务端比对 revision，不匹配时拒绝并提示刷新。 */
  expectedRevision: number;
}
