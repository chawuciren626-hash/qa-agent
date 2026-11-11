/**
 * 项目管理页的 mock 数据源（合成数据，不使用真实账号/地址/凭据）。
 *
 * 仅被 ./api.ts 引用，生产页面代码不得直接 import 本模块（需求文档 §11 / §15：
 * 「mock 数据不会进入生产接口结果」）。搜索、筛选、排序、分页、置顶、归档等语义
 * 在这里按真实接口的预期行为实现，供 Codex 接入真实接口时对齐。
 *
 * mock 账号级置顶以内存中的账号键隔离（正式实现为服务端账号偏好，不得用
 * 未隔离的全局 localStorage 冒充账号级设置，§7.1）。
 */
import type {
  CreateProjectInput,
  ManagedProject,
  ProjectListQuery,
  ProjectListResult,
  ProjectSourceType,
  ProjectStatus,
  UpdateProjectInput,
} from "./types";

/** 场景开关（演示/测试用）：打开后下一次或持续触发对应异常路径。 */
export const mockScenarios = {
  /** 列表加载失败（网络失败态：有旧数据时保留并标明尚未刷新）。 */
  failList: false,
  /** 创建项目失败（创建中失败，不产生半创建）。 */
  failCreate: false,
  /** 进入项目失败（停留在项目管理，保留筛选/页码/滚动位置）。 */
  failEnter: false,
  /** 置顶保存失败（回退原状并提示）。 */
  failPin: false,
  /** 归档失败（后端拒绝：存在运行/排队任务时并发校验不通过的演示）。 */
  failArchive: false,
  /** 编辑保存冲突（revision 不匹配的演示）。 */
  failUpdate: false,
  /** 列表为空（无任何项目空态）。 */
  empty: false,
  /** 账号无创建权限（隐藏新建按钮）。 */
  noCreatePermission: false,
  /** 关闭全部场景开关。 */
  reset(): void {
    this.failList = false;
    this.failCreate = false;
    this.failEnter = false;
    this.failPin = false;
    this.failArchive = false;
    this.failUpdate = false;
    this.empty = false;
    this.noCreatePermission = false;
  },
};

/** mock 演示账号：置顶/最近访问都记在这个键下（账号级隔离的示意）。 */
const MOCK_ACCOUNT = "demo-admin";

/** 合成的模拟网络延迟（ms），让加载/骨架屏/防重复提交真实可见。 */
const MOCK_LATENCY = 140;

function delay(ms = MOCK_LATENCY): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 模拟接口失败：错误文案与真实接口预期一致，页面直接 toast/展示。 */
function fail(flag: boolean, message: string): void {
  if (flag) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/* 合成数据（≥128 条，含重名、超长名称、手动+同步、各状态）            */
/* ------------------------------------------------------------------ */

const SYNC_PLATFORMS = ["Jira", "禅道", "GitLab", "TAPD"] as const;

const NAME_SEEDS = [
  "商城交易测试",
  "会员中心改版回归",
  "支付网关联调测试",
  "小程序券包链路验证",
  "登录页兼容性冒烟",
  "订单履约链路回归",
  "库存扣减幂等验证",
  "营销活动灰度验证",
  "结算对账一致性",
  "优惠券核销链路",
  "购物车并发压测",
  "搜索联想质量回归",
  "地址库升级回归",
  "跨境清关链路验证",
  "发票开具链路测试",
  "物流轨迹解析验证",
  "售后退款链路回归",
  "积分商城兑换验证",
  "拼团活动链路测试",
  "直播带货下单回归",
  "秒杀库存预热验证",
  "风控规则回归",
  "实名认证链路测试",
  "消息推送通道验证",
  "短信网关压测",
  "邮件通知模板回归",
  "客服工单流转验证",
  "埋点上报质量回归",
  "性能基线对比",
  "安全扫描修复验证",
  "权限中心改造回归",
  "组织架构同步验证",
  "审批流引擎回归",
  "数据大屏渲染验证",
  "报表导出链路回归",
  "文件上传断点续传",
  "音视频转码验证",
  "端智能推理回归",
  "小程序分包加载验证",
  "H5 容器桥接回归",
] as const;

/** 同名项目对（平台同步允许重名，靠外部编号区分，不能按名称合并）。 */
const DUPLICATE_NAME = "商城交易测试";

/** 超长名称（>80 字符，验证表格两行截断与「查看完整值」）。 */
const LONG_NAME =
  "超长名称验证项目：跨大区多环境灰度发布下的全链路回归测试与资损防控专项——涵盖下单、支付、履约、结算、对账、开票与售后退款等核心交易链路的自动化验证与缺陷跟踪";

interface RowSpec {
  name: string;
  source: ProjectSourceType;
  status: ProjectStatus;
  role: string;
  daysAgoCreated: number;
  daysAgoActivity: number | null;
  running: number;
  queued: number;
  platform?: (typeof SYNC_PLATFORMS)[number];
  pinned?: boolean;
}

const ROLES = ["创建者", "项目管理员", "成员", "只读成员"] as const;

/** 确定性合成：从种子名单循环展开，保证可重复、无随机漂移。 */
function buildRows(): RowSpec[] {
  const rows: RowSpec[] = [
    { name: "test_project", source: "manual", status: "active", role: "创建者", daysAgoCreated: 420, daysAgoActivity: 0, running: 1, queued: 1, pinned: true },
    { name: "会员中心改版回归", source: "manual", status: "active", role: "项目管理员", daysAgoCreated: 300, daysAgoActivity: 0, running: 1, queued: 0, pinned: true },
    { name: "支付网关联调测试", source: "sync", status: "active", role: "成员", daysAgoCreated: 260, daysAgoActivity: 1, running: 0, queued: 2, platform: "Jira", pinned: true },
    { name: "小程序券包链路验证", source: "sync", status: "active", role: "成员", daysAgoCreated: 200, daysAgoActivity: 2, running: 0, queued: 0, platform: "禅道" },
    { name: "旧版接口回归存档", source: "manual", status: "archived", role: "成员", daysAgoCreated: 500, daysAgoActivity: 28, running: 0, queued: 0 },
    { name: "第三方短信网关压测", source: "sync", status: "disabled", role: "只读成员", daysAgoCreated: 480, daysAgoActivity: 60, running: 0, queued: 0, platform: "Jira" },
    { name: DUPLICATE_NAME, source: "sync", status: "active", role: "成员", daysAgoCreated: 180, daysAgoActivity: 1, running: 2, queued: 0, platform: "TAPD" },
    { name: DUPLICATE_NAME, source: "manual", status: "active", role: "项目管理员", daysAgoCreated: 150, daysAgoActivity: 3, running: 0, queued: 0 },
    { name: LONG_NAME, source: "manual", status: "active", role: "成员", daysAgoCreated: 90, daysAgoActivity: 2, running: 0, queued: 1 },
    { name: "无活动归档项目", source: "manual", status: "archived", role: "只读成员", daysAgoCreated: 700, daysAgoActivity: null, running: 0, queued: 0 },
  ];
  for (let i = 0; i < 124; i++) {
    const name = `${NAME_SEEDS[i % NAME_SEEDS.length]} · 批次${String(Math.floor(i / NAME_SEEDS.length) + 2).padStart(2, "0")}`;
    const cycle = i % 12;
    const source: ProjectSourceType = i % 3 === 0 ? "sync" : "manual";
    const status: ProjectStatus = cycle === 5 ? "archived" : cycle === 9 ? "disabled" : "active";
    rows.push({
      name,
      source,
      status,
      role: ROLES[i % ROLES.length] ?? "成员",
      daysAgoCreated: 30 + (i * 7) % 360,
      daysAgoActivity: status === "active" ? i % 21 : i % 45 + 20,
      running: status === "active" && cycle % 4 === 1 ? (i % 3) + 1 : 0,
      queued: status === "active" && cycle % 5 === 2 ? 1 : 0,
      platform: source === "sync" ? (SYNC_PLATFORMS[i % SYNC_PLATFORMS.length] ?? "Jira") : undefined,
    });
  }
  return rows;
}

const isoDaysAgo = (days: number | null, hourOffset = 0): string | null => {
  if (days === null) return null;
  const base = Date.UTC(2026, 10, 10, 10, 30) - days * 86400000 + hourOffset * 3600000;
  return new Date(base).toISOString();
};

interface MockRecord extends ManagedProject {
  /** mock 账号键 → 置顶（示意账号级隔离；正式实现由服务端管理）。 */
  pinnedBy: Map<string, boolean>;
  visitedBy: Map<string, string | null>;
}

function capabilitiesFor(row: RowSpec): ManagedProject["capabilities"] {
  const maintainer = row.role === "创建者" || row.role === "项目管理员";
  const canEnter = row.status === "active";
  return {
    canEnter,
    cannotEnterReason: canEnter ? null : row.status === "archived" ? "项目已归档" : "项目已停用",
    canMaintain: row.source === "manual" && maintainer && row.status !== "disabled",
    canManageMembers: maintainer,
    canArchive: row.source === "manual" && maintainer && row.status === "active",
    canRestore: row.source === "manual" && maintainer && row.status === "archived",
    canPin: true,
  };
}

function buildStore(): MockRecord[] {
  return buildRows().map((row, index) => ({
    projectId: `PRJ-${String(index + 1).padStart(4, "0")}`,
    name: row.name,
    description: index % 4 === 0 ? `${row.name}：覆盖核心链路的自动化回归与缺陷跟踪（合成简介）。` : null,
    sourceType: row.source,
    sourceSystemName: row.source === "sync" ? (row.platform ?? "外部平台") : null,
    externalProjectId: row.source === "sync" ? `EXT-${1000 + index}` : null,
    externalUrl: row.source === "sync" && index % 2 === 0 ? `https://example.com/track/${1000 + index}` : null,
    status: row.status,
    purpose: "business",
    myRole: row.role,
    createdByDisplayName: ["张伟", "李娜", "王强", "陈晓"][index % 4] ?? "成员",
    createdAt: isoDaysAgo(row.daysAgoCreated)!,
    lastActivityAt: isoDaysAgo(row.daysAgoActivity, index % 8),
    lastSyncedAt: row.source === "sync" ? isoDaysAgo(Math.min(row.daysAgoActivity ?? 7, 7), index % 6) : null,
    runningTaskCount: row.status === "active" ? row.running : 0,
    queuedTaskCount: row.status === "active" ? row.queued : 0,
    isPinned: row.pinned ?? false,
    lastVisitedAt: isoDaysAgo(row.daysAgoActivity === null ? null : Math.min(row.daysAgoActivity, 5)),
    capabilities: capabilitiesFor(row),
    revision: 1,
    pinnedBy: new Map([[MOCK_ACCOUNT, row.pinned ?? false]]),
    visitedBy: new Map<string, string | null>([[MOCK_ACCOUNT, isoDaysAgo(row.daysAgoActivity === null ? null : Math.min(row.daysAgoActivity, 5))]]),
  }));
}

/** mock 存储（模块级；Provider 每次挂载读到同一份，接口接入后整体移除）。 */
const store: MockRecord[] = buildStore();

export function resetMockProjects(): void {
  store.splice(0, store.length, ...buildStore());
}

function pinOf(record: MockRecord): boolean {
  return record.pinnedBy.get(MOCK_ACCOUNT) ?? false;
}

function visitedOf(record: MockRecord): string | null {
  return record.visitedBy.get(MOCK_ACCOUNT) ?? null;
}

function toManaged(record: MockRecord): ManagedProject {
  return { ...record, isPinned: pinOf(record), lastVisitedAt: visitedOf(record) };
}

/* ------------------------------------------------------------------ */
/* 查询语义（对齐真实接口：筛选完整结果集、置顶不绕过筛选）            */
/* ------------------------------------------------------------------ */

function matchesKeyword(record: MockRecord, keyword: string): boolean {
  const q = keyword.trim().toLowerCase();
  if (!q) return true;
  return (
    record.name.toLowerCase().includes(q) ||
    record.projectId.toLowerCase().includes(q) ||
    (record.externalProjectId ?? "").toLowerCase().includes(q)
  );
}

function sortProjects(records: MockRecord[], query: ProjectListQuery): MockRecord[] {
  const compare = (a: MockRecord, b: MockRecord): number => {
    if (query.sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
    if (query.sort === "created") return b.createdAt.localeCompare(a.createdAt);
    // activity：业务活动时间倒序，缺失排在最后（不可伪造时间）。
    const av = a.lastActivityAt ?? "";
    const bv = b.lastActivityAt ?? "";
    if (!av && !bv) return a.projectId.localeCompare(b.projectId);
    if (!av) return 1;
    if (!bv) return -1;
    return bv.localeCompare(av);
  };
  // 置顶在当前筛选结果内优先；置顶项之间仍遵守所选排序。
  return [...records].sort(
    (a, b) => Number(pinOf(b)) - Number(pinOf(a)) || compare(a, b),
  );
}

/* ------------------------------------------------------------------ */
/* mock 操作实现                                                       */
/* ------------------------------------------------------------------ */

export async function mockListProjects(query: ProjectListQuery): Promise<ProjectListResult> {
  await delay();
  fail(mockScenarios.failList, "项目列表加载失败，请检查网络后重试");
  const source = mockScenarios.empty ? [] : store;
  const filtered = source.filter(
    (r) =>
      matchesKeyword(r, query.keyword) &&
      (query.sourceType === "all" || r.sourceType === query.sourceType) &&
      (query.status === "all" || r.status === query.status),
  );
  const sorted = sortProjects(filtered, query);
  const start = (query.page - 1) * query.pageSize;
  return {
    total: sorted.length,
    page: query.page,
    pageSize: query.pageSize,
    projects: sorted.slice(start, start + query.pageSize).map(toManaged),
    canCreate: !mockScenarios.noCreatePermission,
  };
}

export async function mockGetProject(projectId: string): Promise<ManagedProject> {
  await delay();
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  return toManaged(record);
}

export async function mockCreateProject(input: CreateProjectInput): Promise<ManagedProject> {
  await delay();
  fail(mockScenarios.failCreate, "项目创建失败，请稍后重试");
  const name = input.name.trim();
  if (!name) throw new Error("请填写项目名称");
  if (name.length > 80) throw new Error("项目名称不能超过 80 字");
  if (!input.projectId.trim()) throw new Error("请填写 Project id");
  if (store.some(record => record.projectId === input.projectId)) throw new Error("Project id 已存在，请更换");
  const now = new Date().toISOString();
  const spec: RowSpec = { name, source: "manual", status: "active", role: "创建者", daysAgoCreated: 0, daysAgoActivity: 0, running: 0, queued: 0 };
  const record: MockRecord = {
    projectId: input.projectId,
    name,
    description: input.description?.trim() || null,
    sourceType: "manual",
    sourceSystemName: null,
    externalProjectId: null,
    externalUrl: null,
    status: "active",
    purpose: "business",
    myRole: "创建者",
    createdByDisplayName: "当前账号（演示）",
    createdAt: now,
    lastActivityAt: now,
    lastSyncedAt: null,
    runningTaskCount: 0,
    queuedTaskCount: 0,
    isPinned: false,
    lastVisitedAt: now,
    capabilities: capabilitiesFor(spec),
    revision: 1,
    pinnedBy: new Map([[MOCK_ACCOUNT, false]]),
    visitedBy: new Map<string, string | null>([[MOCK_ACCOUNT, now]]),
  };
  store.unshift(record);
  return toManaged(record);
}

export async function mockUpdateProject(projectId: string, input: UpdateProjectInput): Promise<ManagedProject> {
  await delay();
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  if (!record.capabilities.canMaintain) throw new Error("没有该项目的维护权限");
  fail(mockScenarios.failUpdate, "项目已被更新，请刷新后重试");
  if (record.revision !== input.expectedRevision) throw new Error("项目已被更新，请刷新后重试");
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("请填写项目名称");
    if (name.length > 80) throw new Error("项目名称不能超过 80 字");
    record.name = name;
  }
  if (input.description !== undefined) record.description = input.description.trim() || null;
  record.revision += 1;
  record.lastActivityAt = new Date().toISOString();
  return toManaged(record);
}

export async function mockSetProjectPinned(projectId: string, pinned: boolean): Promise<ManagedProject> {
  await delay();
  fail(mockScenarios.failPin, "置顶失败，请重试");
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  record.pinnedBy.set(MOCK_ACCOUNT, pinned);
  return toManaged(record);
}

export async function mockArchiveProject(projectId: string): Promise<ManagedProject> {
  await delay();
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  if (!record.capabilities.canArchive) throw new Error("没有归档该项目的权限");
  fail(mockScenarios.failArchive, "该项目存在运行中或排队中的任务，请先处理后再归档");
  if ((record.runningTaskCount ?? 0) > 0 || (record.queuedTaskCount ?? 0) > 0) {
    throw new Error("该项目存在运行中或排队中的任务，请先处理后再归档");
  }
  record.status = "archived";
  record.capabilities = capabilitiesFor({ ...recordToSpec(record), status: "archived" });
  record.revision += 1;
  return toManaged(record);
}

export async function mockRestoreProject(projectId: string): Promise<ManagedProject> {
  await delay();
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  if (!record.capabilities.canRestore) throw new Error("没有恢复该项目的权限");
  record.status = "active";
  record.capabilities = capabilitiesFor(recordToSpec(record));
  record.revision += 1;
  return toManaged(record);
}

/** 进入项目校验（成功后由页面复用现有项目上下文切换，不重开项目数据体系）。 */
export async function mockEnterProject(projectId: string): Promise<void> {
  await delay();
  fail(mockScenarios.failEnter, "进入项目失败，请重试");
  const record = store.find((r) => r.projectId === projectId);
  if (!record) throw new Error("项目不存在或没有访问权限");
  if (!record.capabilities.canEnter) throw new Error(record.capabilities.cannotEnterReason ?? "当前不可进入该项目");
  const now = new Date().toISOString();
  record.visitedBy.set(MOCK_ACCOUNT, now);
}

/** 快速切换候选：≤8 个、当前项目置顶高亮；置顶优先，其次最近访问，去重。 */
export async function mockQuickSwitchProjects(currentProjectId: string | null): Promise<ManagedProject[]> {
  await delay();
  const candidates = store.filter((r) => r.status === "active" || r.projectId === currentProjectId);
  const ranked = [...candidates].sort((a, b) => {
    const cur = (r: MockRecord) => (r.projectId === currentProjectId ? 0 : 1);
    const pinned = (r: MockRecord) => (pinOf(r) ? 0 : 1);
    const visited = (r: MockRecord) => visitedOf(r) ?? "";
    return cur(a) - cur(b) || pinned(a) - pinned(b) || visited(b).localeCompare(visited(a));
  });
  return ranked.slice(0, 8).map(toManaged);
}

function recordToSpec(record: MockRecord): RowSpec {
  return {
    name: record.name,
    source: record.sourceType,
    status: record.status,
    role: record.myRole,
    daysAgoCreated: 0,
    daysAgoActivity: 0,
    running: record.runningTaskCount ?? 0,
    queued: record.queuedTaskCount ?? 0,
  };
}
