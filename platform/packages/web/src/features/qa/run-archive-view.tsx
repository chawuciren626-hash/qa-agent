// A5：历史档案内嵌视图——资料页「历史档案」页签展示历次 run 产物列表
// （run_id / 报告 / 用例 / 缺陷，只读）。数据来自项目 QA overview（已校验运行记录），
// 只做汇总与下载链接，不做任何写操作或推断。
import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";

type ArchiveArtifact = { path: string; category: string };
type ArchiveRun = { id: string; status: string; caseCount?: number; defectCount?: number; artifacts?: ArchiveArtifact[] };
type ArchiveTask = { session: { sessionId: string; title: string }; runs: ArchiveRun[] };
const artifactName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const downloadUrl = (sessionId: string, path: string) => `/api/sessions/${encodeURIComponent(sessionId)}/files/content?download=1&path=${encodeURIComponent(path)}`;

export function RunArchiveView({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<ArchiveTask[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setTasks(null); setError(""); setLoading(true);
    void apiFetch<{ tasks: ArchiveTask[] }>(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/overview`)
      .then(value => { if (alive) setTasks(value.tasks); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "运行档案读取失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId]);
  const rows = (tasks ?? []).flatMap(task => task.runs.map(run => ({ task, run })));
  return <section className="qa-k-archive" aria-label="历史档案">
    {error && <p role="alert" className="rounded border border-red-300 p-2 text-sm text-red-600">{error}</p>}
    {loading && <p role="status" className="text-sm opacity-70">正在读取历史档案…</p>}
    {!loading && !rows.length && !error && <p className="text-sm opacity-70">这个项目还没有已登记的测试运行产物。</p>}
    {!loading && rows.length > 0 && <div className="overflow-x-auto"><table className="qa-k-archive-table w-full text-sm" aria-label="历次运行产物">
      <thead><tr className="text-left opacity-70"><th className="py-1 pr-3">运行 ID</th><th className="py-1 pr-3">所属任务</th><th className="py-1 pr-3">状态</th><th className="py-1 pr-3">用例数</th><th className="py-1 pr-3">缺陷数</th><th className="py-1 pr-3">产物（报告 / 用例 / 缺陷）</th></tr></thead>
      <tbody>{rows.map(({ task, run }) => <tr key={`${task.session.sessionId}/${run.id}`} className="border-t border-[var(--border)]">
        <td className="py-1.5 pr-3 font-mono text-xs">{run.id}</td>
        <td className="py-1.5 pr-3">{task.session.title || task.session.sessionId}</td>
        <td className="py-1.5 pr-3">{run.status}</td>
        <td className="py-1.5 pr-3">{run.caseCount ?? 0}</td>
        <td className="py-1.5 pr-3">{run.defectCount ?? 0}</td>
        <td className="py-1.5 pr-3">{run.artifacts?.length ? run.artifacts.map(file => <a key={file.path} className="mr-3 underline" href={downloadUrl(task.session.sessionId, file.path)} download>{artifactName(file.path)}</a>) : <span className="opacity-60">无可下载产物</span>}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className="mt-2 text-xs opacity-60">只读视图：产物以运行记录登记为准；报告按端分节等结论请打开任务详情查看。</p>
  </section>;
}
