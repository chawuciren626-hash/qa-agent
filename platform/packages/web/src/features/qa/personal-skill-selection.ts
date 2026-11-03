/**
 * The round-scoped personal Skill model (pure): what a selection says on screen and what its
 * error codes mean to the person choosing.
 *
 * A selection pins one round of one task to specific imported resources. It is not an
 * installation: the service copies the chosen Skill files into a round snapshot, the Agent's
 * default `skills/` directory keeps what it had, and the next round starts from the defaults
 * again. Nothing here may suggest the resource was installed permanently.
 */

/** Personal resource as the listing endpoint summarises it (`GET .../personal-resources`). */
export interface PersonalResourceSummary {
  id: string;
  name: string;
  kind: "skill" | "plugin";
  version?: number;
  contentHash?: string;
  createdAt: string;
  skills: string[];
  appliedAgents: string[];
}

export type SelectionStatus = "active" | "consumed" | "superseded" | "expired";

export interface SelectionResource {
  resourceId: string;
  name: string;
  version: number;
  contentHash: string;
  skills: string[];
}

export interface SelectionSkill {
  name: string;
  resourceId: string;
  resourceVersion: number;
  contentHash: string;
}

/**
 * The selection as the service returns it (`selection` of GET/POST/DELETE answers). The fields
 * the panel never reads (project/session ids, authorization) are left to the service.
 */
export interface RoundSelectionView {
  selectionId: string;
  scope: "round";
  status: SelectionStatus;
  round: number;
  projectId: string;
  sessionId: string;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  resources: SelectionResource[];
  skills: SelectionSkill[];
}

export const SELECTION_STATUS_TITLES: Readonly<Record<SelectionStatus, string>> = {
  active: "本轮生效",
  consumed: "本轮已使用",
  superseded: "已被新选择取代",
  expired: "已过期",
};

export function selectionStatusLabel(status: SelectionStatus): string {
  return SELECTION_STATUS_TITLES[status] ?? status;
}

/** A stored `sha256:…` digest cut to the part a person can compare by eye. */
export function shortHash(hash: string | undefined): string {
  if (!hash) return "未知";
  const bare = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return bare.slice(0, 8) || "未知";
}

/** A selection may be cancelled unless it was already used: a consumed one stays for the audit. */
export function canCancel(view: RoundSelectionView): boolean {
  return view.status !== "consumed";
}

/** One resource of a selection: its name, pinned version, chosen Skill names and content hash. */
export function resourceLine(resource: SelectionResource): string {
  const skills = resource.skills.length > 0 ? resource.skills.join("、") : "未选择 Skill";
  return `${resource.name} v${resource.version} · ${skills} · 内容 ${shortHash(resource.contentHash)}`;
}

/** The one-line summary above the list: round number and how much it pins. */
export function selectionHeadline(view: RoundSelectionView): string {
  return `第 ${view.round} 轮 · ${view.resources.length} 个资源 · ${view.skills.length} 个 Skill`;
}

function clockOf(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** How long the selection still lives, in the units a person reads at a glance. */
export function expiryLabel(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "已过期";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours > 0) return minutes > 0 ? `约剩 ${hours} 小时 ${minutes} 分钟` : `约剩 ${hours} 小时`;
  return minutes > 0 ? `约剩 ${minutes} 分钟` : "即将过期";
}

/** Every fact the panel states about a selection, in reading order. */
export function selectionLines(view: RoundSelectionView, now: number): string[] {
  return [
    ...view.resources.map(resourceLine),
    `有效期至 ${clockOf(view.expiresAt)}（${expiryLabel(view.expiresAt, now)}）`,
  ];
}

/**
 * The server's selection error codes, in the person's language. A code not listed here is the
 * caller's to localise (`apiErrorText`), so this map only holds what needs its own phrasing.
 */
export function selectionErrorHint(code: string | undefined): string | undefined {
  switch (code) {
    case "invalid_selection":
      return "请选择 1 至 20 个个人资源，同一资源只能选一次。";
    case "protected_skill":
      return "内置测试 Skill 不能作为个人选择，请换一个。";
    case "skill_selection_conflict":
      return "多个个人资源里有同名 Skill，请只保留其中一个。";
    case "selection_conflict":
      return "同一请求标识下的选择内容不一致，请关闭后重新选择。";
    case "selection_not_active":
      return "本轮选择已过期或已被新选择取代，请重新选择。";
    case "selection_not_found":
      return "本轮选择不存在或已被取消。";
    case "selection_snapshot_missing":
      return "本轮选择的内容快照已不可读取，请重新选择。";
    case "session_not_found":
      return "该任务不存在，或不属于所选智能体，请重新选择任务。";
    case "resource_not_found":
      return "该个人资源已被删除，请刷新列表后重试。";
    case "skill_not_in_resource":
      return "所选资源中已没有这个 Skill，请刷新列表后重试。";
    case "project_forbidden":
      return "没有该项目的访问权限。";
    case "resource_in_selection":
      return "该资源正在本轮任务中使用，请先取消选择。";
    case "invalid_agent":
      return "所选智能体无效，请重新选择任务。";
    default:
      return undefined;
  }
}
