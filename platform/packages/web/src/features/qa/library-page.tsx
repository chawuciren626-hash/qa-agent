import { useEffect, useRef, useState } from "react";
import { Button, ConfirmModal } from "@prismshadow/penguin-ui";
import { apiFetch } from "../../api/client";
import { useProject } from "../../state/project";
import { useAuth } from "../../state/auth";

type Entry = {
  id: string;
  name: string;
  kind: "file" | "folder" | "link";
  parentId: string | null;
  size: number;
  revision: string;
  updatedAt: string;
  content?: string;
  encoding?: string;
};
export function QaLibraryPage() {
  const { currentProject, agents } = useProject();
  const { user } = useAuth();
  const agent = agents.find((a) => a.agentId === "test_agent") ?? agents[0];
  if (!currentProject || !user || !agent)
    return <p className="p-6">请先创建项目并启用测试能力。</p>;
  return (
    <Library
      key={`${user.userId}:${currentProject.projectId}:${agent.agentId}`}
      base={`/api/projects/${encodeURIComponent(currentProject.projectId)}/agents/${encodeURIComponent(agent.agentId)}/memory/library`}
    />
  );
}
function Library({ base }: { base: string }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Entry["kind"]>("file");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const refresh = async () => {
    const result = await apiFetch<{ entries: Entry[] }>(base);
    if (alive.current) setRows(result.entries);
  };
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => {
      if (alive.current) setError(String(e.message));
    });
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, [base]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (alive.current) {
        await refresh();
        setEditing(false);
        setSelected(null);
        setRemoving(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function open(row: Entry) {
    const seq = ++sequence.current;
    setSelected(null);
    setEditing(false);
    setError("");
    if (row.kind === "folder") {
      setFolder(row.id);
      setSearch("");
      return;
    }
    setBusy(true);
    try {
      const value = await apiFetch<Entry>(`${base}/${row.id}`);
      if (alive.current && seq === sequence.current) setSelected(value);
    } catch (e) {
      if (alive.current && seq === sequence.current)
        setError(e instanceof Error ? e.message : "资料读取失败。");
    } finally {
      if (alive.current && seq === sequence.current) setBusy(false);
    }
  }
  function download(row: Entry) {
    const data =
      row.encoding === "base64"
        ? Uint8Array.from(atob(row.content ?? ""), (c) => c.charCodeAt(0))
        : (row.content ?? "");
    const url = URL.createObjectURL(new Blob([data]));
    const link = document.createElement("a");
    link.href = url;
    link.download = row.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <main className="mx-auto h-full max-w-5xl overflow-auto p-6" aria-label="项目资料库">
      <h1 className="text-xl font-semibold">资料库</h1>
      <p className="my-2 text-sm text-gray-500">
        当前项目下的个人资料。可整理需求、接口文档和参考链接；不会自动作为任务输入。
      </p>
      <div className="my-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            sequence.current++;
            setFolder(null);
            setSelected(null);
            setEditing(false);
            setSearch("");
          }}
        >
          根目录
        </Button>
        {folder && <span>{rows.find((r) => r.id === folder)?.name}</span>}
        <input
          aria-label="搜索资料"
          placeholder="搜索本项目资料"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border p-2"
        />
        <Button
          disabled={busy}
          onClick={() => {
            sequence.current++;
            setSelected(null);
            setName("");
            setContent("");
            setKind("file");
            setEditing(true);
          }}
        >
          新建资料
        </Button>
        <label className="cursor-pointer underline">
          导入文件
          <input
            type="file"
            multiple
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void mutate(async () => {
                for (const file of files) {
                  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB`);
                  const encoded = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
                    reader.onerror = () => reject(new Error("文件读取失败"));
                    reader.readAsDataURL(file);
                  });
                  await apiFetch(base, {
                    method: "POST",
                    body: {
                      name: file.name,
                      kind: "file",
                      parentId: folder,
                      content: encoded,
                      encoding: "base64",
                    },
                  });
                }
              });
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="my-3 text-red-600">
          {error}
        </p>
      )}
      {busy && <p role="status">正在处理…</p>}
      <ul className="divide-y rounded border">
        {rows
          .filter((row) =>
            search
              ? row.name.toLowerCase().includes(search.toLowerCase())
              : row.parentId === folder,
          )
          .map((row) => (
            <li key={row.id} className="flex items-center gap-3 p-3">
              <button disabled={busy} className="flex-1 text-left" onClick={() => void open(row)}>
                {row.kind === "folder" ? "▣ " : ""}
                {row.name}
              </button>
              <span className="text-xs text-gray-500">{row.size} B</span>
              <button disabled={busy} onClick={() => setRemoving(row)}>
                删除
              </button>
            </li>
          ))}
      </ul>
      {rows.length === 0 && <p className="my-4">暂无资料，可以导入文件或新建文档。</p>}
      {selected && !editing && (
        <section className="my-4 rounded border p-4">
          <h2 className="font-semibold">{selected.name}</h2>
          <div className="my-2 flex gap-3">
            <Button onClick={() => download(selected)}>下载</Button>
            {selected.encoding !== "base64" && (
              <Button
                onClick={() => {
                  setKind(selected.kind);
                  setName(selected.name);
                  setContent(selected.content ?? "");
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            )}
          </div>
          {selected.kind === "link" && /^https?:\/\//i.test(selected.content ?? "") ? (
            <a href={selected.content} target="_blank" rel="noreferrer" className="underline">
              打开参考链接
            </a>
          ) : selected.encoding !== "base64" ? (
            <pre className="whitespace-pre-wrap break-words">{selected.content}</pre>
          ) : (
            <p>此文件请下载后查看。</p>
          )}
        </section>
      )}
      {editing && (
        <form
          className="my-4 grid gap-3 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(() =>
              apiFetch(selected ? `${base}/${selected.id}` : base, {
                method: selected ? "PUT" : "POST",
                body: {
                  name,
                  kind,
                  content,
                  encoding: "utf8",
                  parentId: folder,
                  ...(selected ? { revision: selected.revision } : {}),
                },
              }),
            );
          }}
        >
          <label>
            名称
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="ml-2 rounded border p-2"
            />
          </label>
          {!selected && (
            <label>
              类型
              <select value={kind} onChange={(e) => setKind(e.target.value as Entry["kind"])}>
                <option value="file">文档</option>
                <option value="folder">文件夹</option>
                <option value="link">链接</option>
              </select>
            </label>
          )}
          {kind !== "folder" && (
            <label>
              {kind === "link" ? "链接地址" : "正文"}
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="block min-h-40 w-full rounded border p-2"
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              保存
            </Button>
            <Button disabled={busy} onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </form>
      )}
      <ConfirmModal
        open={removing !== null}
        title="删除资料"
        confirmLabel="删除"
        cancelLabel="取消"
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          void mutate(() =>
            apiFetch(`${base}/${removing!.id}`, {
              method: "DELETE",
              body: { revision: removing!.revision },
            }),
          )
        }
      >
        确认删除“{removing?.name}”？此操作无法撤销。
      </ConfirmModal>
    </main>
  );
}
