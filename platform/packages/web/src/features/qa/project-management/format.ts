/**
 * 项目管理页的展示格式化：时间统一按用户本地时区渲染（接口统一 ISO 8601）。
 * 缺失值显示「—」，不伪造为当前时间（需求文档 §4.2）。
 */

/** ISO 时间 → 本地展示；缺失/非法 → null（调用方显示「—」）。 */
export function formatActivityTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const now = new Date();
  const sameYear = at.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  if (sameYear) return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hm}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 时间的展示文本（缺失显示「—」）。 */
export function timeText(value: string | null | undefined): string {
  return formatActivityTime(value) ?? "—";
}

/** 完整时间（详情侧栏 title / 同步时间等）。 */
export function fullTimeText(value: string | null | undefined): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 来源列文案：手动创建 | 平台同步·平台名。 */
export function sourceText(project: { sourceType: string; sourceSystemName: string | null }): string {
  return project.sourceType === "sync" ? `平台同步 · ${project.sourceSystemName ?? "外部平台"}` : "手动创建";
}

/** 状态列文案。 */
export const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  archived: "已归档",
  disabled: "已停用",
};
