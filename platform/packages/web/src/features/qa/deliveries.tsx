import { useEffect, useMemo, useState } from "react";
import { Button } from "@prismshadow/penguin-ui";
import {
  extractDeliveries,
  deliveryEvidenceKind,
} from "../../../../../../penguin/ui/delivery-ui.mjs";
import { apiFetch } from "../../api/client";
import { apiUrl } from "../../lib/server-context";
import { machineForPath } from "../../lib/session-machines";
import type { StreamRenderContext } from "../chat/message-stream";

export function QaDeliveries({ text, ctx }: { text: string; ctx: StreamRenderContext }) {
  const files = useMemo(() => extractDeliveries(text, ctx.workspace), [text, ctx.workspace]);
  const [existing, setExisting] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setExisting(new Set());
    setError("");
    if (files.length && ctx.statFiles)
      ctx
        .statFiles(files.map((f) => f.path))
        .then((value) => {
          if (alive) setExisting(value);
        })
        .catch(() => {
          if (alive) setError("暂时无法检查交付文件。");
        });
    return () => {
      alive = false;
    };
  }, [files, ctx.statFiles]);
  const base = `/api/sessions/${encodeURIComponent(ctx.qaSessionId ?? "")}/files`;
  const url = (file: string, mode: string) =>
    apiUrl(`${base}/${mode}?path=${encodeURIComponent(file)}&download=1`, machineForPath(base));
  const openNative = async (file: string) => {
    setError("");
    try {
      await apiFetch(`${base}/open-deliverable`, { method: "POST", query: { path: file } });
    } catch {
      setError("本机打开失败或当前使用 Web 端，请下载文件后打开。");
    }
  };
  if (!ctx.qaSessionId) return null;
  return (
    <section className="my-2 grid gap-2" aria-label="测试交付文件">
      {files
        .filter((f) => existing.has(f.path))
        .map((file) => (
          <div
            key={file.path}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <button
              className="min-w-0 flex-1 break-all text-left font-medium"
              onClick={() => ctx.onOpenFile?.(file.path)}
            >
              {file.label}
            </button>
            {/\.(xlsx|xmind)$/i.test(file.path) && (
              <Button onClick={() => void openNative(file.path)}>本机打开</Button>
            )}
            {deliveryEvidenceKind(file.path) !== "directory" && (
              <a
                className="text-sm underline"
                href={url(file.path, deliveryEvidenceKind(file.path) ? "evidence" : "content")}
                download
              >
                下载
              </a>
            )}
          </div>
        ))}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
