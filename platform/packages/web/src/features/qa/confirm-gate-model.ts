/**
 * 确认卡点页的前端模型：类型与服务端派生视图的展示口径。
 *
 * 规则本体在服务端 `qa-confirm-gate.ts`，这里只放两样东西：
 *   1. 与服务端一致的类型（渲染要用）；
 *   2. 展示层的纯函数——风险档标签、状态标签、层叠徽标（红条=风险强制、绿条=抽中）。
 * 不在前端重算抽样名单：名单与指纹以服务端为准，前端重算会造出第二个真相源。
 */

export type RiskKind = "P0" | "P1" | "P2" | "money" | "perm" | "unknown";
export type ItemStatus = "todo" | "pass" | "problem" | "inherit";
export type BatchStatus = "draft" | "reviewing" | "approved";

export interface ConfirmItem {
  id: string;
  type: string;
  text: string;
  risk: RiskKind;
  changed: boolean;
  st: ItemStatus;
}

export interface AuditEntry {
  seq: number;
  at: string;
  action: "created" | "submitted" | "approve_blocked" | "approved" | "rejected" | "resampled";
  actor: string;
  note?: string;
  gateFailures?: { gate: string; detail: string }[];
}

export interface ConfirmBatch {
  kind: "confirm-batch";
  batchId: string;
  projectId: string;
  title: string;
  status: BatchStatus;
  seed: string;
  items: ConfirmItem[];
  audit: AuditEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmBatchView {
  batch: ConfirmBatch;
  sampledIds: string[];
  sampleFingerprint: string;
  smallBatch: boolean;
  retroToFull: boolean;
  mustDone: boolean;
  effective: Record<string, ItemStatus>;
  stats: {
    diffForced: number;
    inherited: number;
    forceFull: number;
    riskUnknown: number;
    sampled: number;
    sampledDone: number;
    problems: number;
    problemRate: string | null;
    mustRemaining: number;
  };
  gates: { gate: string; detail: string }[];
  approvalNote: string;
}

export const RISK_LABEL: Record<RiskKind, string> = {
  P0: "P0", P1: "P1", P2: "P2",
  money: "涉资字段", perm: "权限变更", unknown: "未标风险",
};

export const RISK_CLASS: Record<RiskKind, string> = {
  P0: "cg-risk-p0", P1: "cg-risk-p1", P2: "cg-risk-p2",
  money: "cg-risk-money", perm: "cg-risk-perm", unknown: "cg-risk-unknown",
};

export const STATUS_LABEL: Record<ItemStatus, string> = {
  todo: "待审", pass: "通过", problem: "发现问题", inherit: "继承上版",
};

export const STATUS_CLASS: Record<ItemStatus, string> = {
  todo: "cg-st-todo", pass: "cg-st-pass", problem: "cg-st-problem", inherit: "cg-st-inherit",
};

/** 条目左条：风险强制红、抽中绿、其余无条（与原型一致的层叠视觉）。 */
export function rowAccent(item: ConfirmItem, view: ConfirmBatchView): "" | "force-row" | "sampled-row" {
  if (item.risk === "P0" || item.risk === "money" || item.risk === "perm" || item.risk === "unknown") return "force-row";
  if (view.sampledIds.includes(item.id)) return "sampled-row";
  return "";
}

/** 有效状态：服务端算好随视图下发；页面只用 effective 渲染，不用原始 st。 */
export const displayStatus = (item: ConfirmItem, view: ConfirmBatchView): ItemStatus =>
  view.effective[item.id] ?? item.st;

export type ItemFilter = "all" | "must" | "sampled" | "todo" | "inherit";

/** 必审判定前端复刻（与服务端 isMust 同口径），用于筛选按钮。 */
export const isMustItem = (item: ConfirmItem): boolean =>
  item.risk === "P0" || item.risk === "money" || item.risk === "perm" || item.risk === "unknown" || item.changed === true;

export function filterItems(view: ConfirmBatchView, filter: ItemFilter): ConfirmItem[] {
  const items = view.batch.items;
  switch (filter) {
    case "must": return items.filter(isMustItem);
    case "sampled": return items.filter(item => view.sampledIds.includes(item.id));
    case "todo": return items.filter(item => displayStatus(item, view) === "todo");
    case "inherit": return items.filter(item => item.st === "inherit");
    default: return items;
  }
}

export const ACTION_LABEL: Record<AuditEntry["action"], string> = {
  created: "创建批次", submitted: "提交送审", approve_blocked: "批准被硬闸阻止",
  approved: "批准生效", rejected: "退回修改", resampled: "重抽名单",
};
