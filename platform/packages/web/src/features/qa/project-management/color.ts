/**
 * 项目名首字头像 / 项目徽章的底色：由稳定的键（projectId）散列出固定颜色，
 * 同一项目在任何界面（列表头像、侧栏徽章）颜色一致，且不依赖名称（重命名不变色）。
 */

const PALETTE = [
  "#3370ff",
  "#2e9e6b",
  "#d98a1f",
  "#8a5cd6",
  "#0ea5a5",
  "#64748b",
  "#d45555",
  "#0e7490",
] as const;

/** 由稳定键散列出的项目色（与数据无关的纯函数，便于测试与复用）。 */
export function projectAccentColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0];
}

/** 项目名/编号里取展示首字（徽章用；空值回退「?」）。 */
export function projectInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}
