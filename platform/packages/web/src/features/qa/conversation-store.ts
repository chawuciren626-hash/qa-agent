type Store = Pick<Storage, "getItem" | "setItem">;
// Preserve existing local bookmark keys and zero-based global turn numbers.
export function bookmarkKey(
  installation: string | null,
  user: string | undefined,
  project: string | undefined,
  session: string,
) {
  return `aitest.client.v2.${encodeURIComponent(installation || "local")}.${encodeURIComponent(user || "anonymous")}.${encodeURIComponent(project || "default")}.bookmarks.${encodeURIComponent(session)}`;
}
export function readBookmarks(store: Store, key: string): number[] {
  try {
    const value: unknown = JSON.parse(store.getItem(key) || "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((n): n is number => Number.isSafeInteger(n) && n >= 0))]
      : [];
  } catch {
    return [];
  }
}
export function toggleBookmark(store: Store, key: string, turn: number) {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new Error("Invalid turn");
  const saved = readBookmarks(store, key);
  const next = saved.includes(turn)
    ? saved.filter((n) => n !== turn)
    : [...saved, turn].sort((a, b) => a - b);
  store.setItem(key, JSON.stringify(next));
  return next;
}
