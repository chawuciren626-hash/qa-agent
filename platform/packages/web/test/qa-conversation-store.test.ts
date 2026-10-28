import { expect, it } from "vitest";
import { bookmarkKey, readBookmarks, toggleBookmark } from "../src/features/qa/conversation-store";
it("preserves old bookmark keys while isolating account, installation, project and session", () => {
  const key = bookmarkKey("install", "owner", "project", "session");
  expect(key).toBe("aitest.client.v2.install.owner.project.bookmarks.session");
  const data = new Map([[key, '[2,9,9,-1,1.5,"bad"]']]);
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  expect(readBookmarks(store, key)).toEqual([2, 9]);
  expect(toggleBookmark(store, key, 9)).toEqual([2]);
  for (const other of [
    bookmarkKey("other", "owner", "project", "session"),
    bookmarkKey("install", "other", "project", "session"),
    bookmarkKey("install", "owner", "other", "session"),
    bookmarkKey("install", "owner", "project", "other"),
  ])
    expect(readBookmarks(store, other)).toEqual([]);
  expect(toggleBookmark(store, key, 50)).toEqual([2, 50]);
  expect(() => toggleBookmark(store, key, -1)).toThrow();
});
