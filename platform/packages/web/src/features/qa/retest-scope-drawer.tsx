// A6：复测范围选择（三层）。复测轮次创建时展示三层范围：
//  1. 缺陷关联用例——来自已校验运行记录中缺陷的 related_cases；
//  2. 回归影响选集——regression-impact 端点尚未提供，如实空态占位；
//  3. 冒烟子集——设计用例中优先级 P0 的子集。
// 用户勾选后提交到平台任务复测端点；端点未上线（后端流 E 并行补齐）时
// 提交会得到明确失败消息，不假装提交成功。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../api/client";

type OverviewDefect = { id: string; title: string; detail?: { related_cases?: string[] } };
type OverviewCase = { id: string; title: string; priority?: string };
type OverviewRun = { id: string; defects?: OverviewDefect[]; cases?: OverviewCase[] };
type OverviewTask = { session: { sessionId: string; title: string }; runs: OverviewRun[] };

export type RetestScope = { defectCases: string[]; regressionCases: string[]; smokeCases: string[] };

export function retestCandidates(tasks: OverviewTask[]) {
  const defectCases: string[] = [];
  const smokeCases: { id: string; title: string }[] = [];
  const seenDefect = new Set<string>();
  const seenSmoke = new Set<string>();
  for (const task of tasks) for (const run of task.runs ?? []) {
    for (const defect of run.defects ?? []) for (const caseId of defect.detail?.related_cases ?? []) {
      if (caseId && !seenDefect.has(caseId)) { seenDefect.add(caseId); defectCases.push(caseId); }
    }
    for (const item of run.cases ?? []) {
      if (item.priority === "P0" && item.id && !seenSmoke.has(item.id)) { seenSmoke.add(item.id); smokeCases.push({ id: item.id, title: item.title }); }
    }
  }
  return { defectCases, smokeCases };
}

const useSet = () => useState<Set<string>>(new Set());
const toggle = (set: Set<string>, value: string): Set<string> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
};

export function RetestScopeDrawer({ projectId, taskId, taskTitle, onClose }: { projectId: string; taskId: string; taskTitle: string; onClose: () => void }) {
  const [tasks, setTasks] = useState<OverviewTask[] | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState("");
  const [defectPick, setDefectPick] = useSet();
  const [regressionPick, setRegressionPick] = useSet();
  const [smokePick, setSmokePick] = useSet();
  useEffect(() => {
    let alive = true;
    void apiFetch<{ tasks: OverviewTask[] }>(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/overview`)
      .then(value => { if (alive) setTasks(value.tasks); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "用例范围读取失败"); });
    return () => { alive = false; };
  }, [projectId]);
  const { defectCases, smokeCases } = useMemo(() => retestCandidates(tasks ?? []), [tasks]);
  const selected = defectPick.size + regressionPick.size + smokePick.size;
  const submit = async () => {
    const scope: RetestScope = { defectCases: [...defectPick], regressionCases: [...regressionPick], smokeCases: [...smokePick] };
    setSubmitting(true); setError(""); setResult("");
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/platform-tasks/${encodeURIComponent(taskId)}/retest`, { method: "POST", body: { scope } });
      setResult("复测轮次已创建。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复测创建失败，请稍后重试。");
    } finally { setSubmitting(false); }
  };
  const layer = (title: string, hint: string, items: { id: string; label: string }[], pick: Set<string>, onToggle: (value: string) => void, empty: string) => <fieldset className="qrs-layer">
    <legend>{title}<small>{hint}</small></legend>
    {items.length ? <ul>{items.map(item => <li key={item.id}><label><input type="checkbox" checked={pick.has(item.id)} onChange={() => onToggle(item.id)} /> {item.label}</label></li>)}</ul> : <p className="qrs-empty">{empty}</p>}
  </fieldset>;
  return createPortal(<div className="qtd-mask qrs-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
    <section className="qtd-modal qrs-modal" role="dialog" aria-modal="true" aria-label="发起复测">
      <header><strong>发起复测 · {taskTitle || taskId}</strong><button type="button" aria-label="关闭" disabled={submitting} onClick={onClose}>×</button></header>
      <div className="qrs-body">
        <p className="qrs-hint">勾选本次复测要覆盖的用例范围（三层可叠加）；提交后按所选范围创建复测轮次。</p>
        {error && <p role="alert" className="qrs-error">{error}</p>}
        {result && <p role="status" className="qrs-ok">{result}</p>}
        {tasks === null && !error && <p role="status">正在读取用例范围…</p>}
        {tasks !== null && <>
          {layer("缺陷关联用例", `共 ${defectCases.length} 条（来自缺陷 related_cases）`, defectCases.map(id => ({ id, label: id })), defectPick, value => setDefectPick(current => toggle(current, value)), "现有缺陷没有登记关联用例。")}
          {layer("回归影响选集", "regression-impact 分析端点尚未提供", [], regressionPick, value => setRegressionPick(current => toggle(current, value)), "回归影响选集数据尚未登记（后端由流 E 补齐）；当前可先用缺陷关联用例与冒烟子集圈定范围。")}
          {layer("冒烟子集", `共 ${smokeCases.length} 条（设计用例 P0）`, smokeCases.map(item => ({ id: item.id, label: `${item.id}${item.title ? ` · ${item.title}` : ""}` })), smokePick, value => setSmokePick(current => toggle(current, value)), "没有登记 P0 用例。")}
        </>}
      </div>
      <footer>
        <span className="qrs-count">已选用例 {selected} 条（缺陷 {defectPick.size} · 回归 {regressionPick.size} · 冒烟 {smokePick.size}）</span>
        <button type="button" disabled={submitting || selected === 0} onClick={() => void submit()}>{submitting ? "正在创建复测…" : "提交复测范围"}</button>
        <button type="button" disabled={submitting} onClick={onClose}>关闭</button>
      </footer>
    </section>
  </div>, document.body);
}
