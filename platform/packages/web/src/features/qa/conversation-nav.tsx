import { useEffect, useState, type RefObject } from "react";
import type { OutlineEntry } from "../chat/outline-model";
import { useProject } from "../../state/project";
import { useAuth } from "../../state/auth";
import { toastError } from "@prismshadow/penguin-ui";
import { bookmarkKey, readBookmarks, toggleBookmark } from "./conversation-store";

export function QaConversationNav({
  entries,
  turnOffset,
  sessionId,
  scrollRef,
  older,
}: {
  entries: OutlineEntry[];
  turnOffset: number;
  sessionId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  older: { hasMore: boolean; loading: boolean; onLoad: () => void };
}) {
  const { currentProject } = useProject();
  const { user } = useAuth();
  const key = bookmarkKey(
    localStorage.getItem("penguin.installId"),
    user?.userId,
    currentProject?.projectId,
    sessionId,
  );
  const [saved, setSaved] = useState<number[]>([]);
  const [onlySaved, setOnlySaved] = useState(false);
  useEffect(() => {
    setSaved(readBookmarks(localStorage, key));
    setOnlySaved(false);
    const changed = (event: StorageEvent) => {
      if (event.key === key) setSaved(readBookmarks(localStorage, key));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  if (!sessionId) return null;
  return (
    <details key={key} className="relative text-sm">
      <summary className="cursor-pointer px-2" aria-label="提问与书签">
        提问与书签
      </summary>
      <section
        className="absolute right-0 top-full z-40 max-h-[60vh] w-80 overflow-auto rounded-lg border bg-white p-3 shadow-lg dark:bg-gray-900"
        aria-label="会话书签"
      >
        <label>
          <input
            type="checkbox"
            checked={onlySaved}
            onChange={(e) => setOnlySaved(e.target.checked)}
          />{" "}
          只看书签（{saved.length}）
        </label>
        {entries
          .map((entry, index) => ({ entry, turn: turnOffset + index }))
          .filter(({ turn }) => !onlySaved || saved.includes(turn))
          .map(({ entry, turn }) => (
            <div key={entry.anchorId} className="my-2 flex items-center gap-2">
              <button
                className="min-w-0 flex-1 truncate text-left"
                title={entry.question}
                onClick={() => {
                  const container = scrollRef.current;
                  const anchor = container?.querySelector<HTMLElement>(
                    `[data-outline-anchor="${entry.anchorId}"]`,
                  );
                  if (container && anchor)
                    container.scrollTo({ top: Math.max(0, anchor.offsetTop - 8) });
                }}
              >
                {turn + 1}. {entry.question || "图片提问"}
              </button>
              <button
                aria-label={`${saved.includes(turn) ? "取消" : "添加"}书签：${entry.question || "图片提问"}`}
                aria-pressed={saved.includes(turn)}
                onClick={() => {
                  try {
                    setSaved(toggleBookmark(localStorage, key, turn));
                  } catch {
                    toastError("书签保存失败，请检查浏览器存储空间。");
                  }
                }}
              >
                {saved.includes(turn) ? "★" : "☆"}
              </button>
            </div>
          ))}
        {onlySaved && !entries.some((_, index) => saved.includes(turnOffset + index)) && (
          <p className="my-2">已加载内容中暂无书签。</p>
        )}
        {older.hasMore && (
          <button disabled={older.loading} onClick={older.onLoad}>
            {older.loading ? "加载中…" : "加载更早提问"}
          </button>
        )}
      </section>
    </details>
  );
}
