import { useEffect, useState } from "react";
import { loadVerifiedJson, localizeActualResult, type Defect, type ResultArtifact } from "./task-results";
import { ResultEvidenceFields } from "./result-evidence";
import { localizedValue } from "./stage-localization";
import { breakNumberedItems } from "./structured-text";
import { DEFECT_SEVERITY_ORDER, isSeverityUnknown, severityLabel, severitySummary, type DefectSeverity } from "./quality-traceability-model";

type DefectDocument = Defect[] | { records?: Defect[]; defects?: Defect[] };
type SeverityFilter = DefectSeverity | "unrecorded" | "all";
const display = (value: unknown) => value == null || value === "" ? "—" : Array.isArray(value) ? value.map(String).join("\n") : String(value);

export function DefectResults({ projectId, sessionId, runId, artifacts, refresh }: { projectId: string; sessionId: string; runId: string; artifacts: ResultArtifact[]; refresh: number }) {
  const artifact = artifacts.find(item => item.stage === "defects" && item.name === "defect-records.json");
  const [records, setRecords] = useState<Defect[] | null>(null);
  const [selected, setSelected] = useState<Defect | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  useEffect(() => {
    const controller = new AbortController();
    setRecords(null); setSelected(null); setError(""); setPage(1);
    if (!artifact) { setRecords([]); return () => controller.abort(); }
    if (!artifact.available || artifact.verified !== true) { setError("缺陷记录尚未通过交付校验，请在阶段产物中查看状态。"); setRecords([]); return () => controller.abort(); }
    void loadVerifiedJson<DefectDocument>(sessionId, artifact, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRecords(Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : Array.isArray(value?.defects) ? value.defects : []);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "缺陷记录读取失败。"); });
    return () => controller.abort();
  }, [sessionId, runId, artifact?.path, artifact?.verified, refresh]);
  const summary = severitySummary(records ?? []);
  const unassessed = summary.unknown + summary.unrecorded;
  const visible = (records ?? []).filter(row => {
    if (severityFilter === "all") return true;
    if (severityFilter === "unrecorded") return !row.severity;
    return row.severity === severityFilter;
  });
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const exportUrl = `/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/results/defects/export`;
  return <section className="qtd-structured-results" aria-label="缺陷列表">
    {error && <p role="alert" className="qtd-message qtd-error">{error}</p>}
    {artifact && !records && !error && <p role="status" className="qtd-message">正在读取缺陷记录…</p>}
    {records && <><div className="qtd-list-heading"><strong>缺陷列表 · {visible.length} / {records.length} 条</strong>{artifact?.verified === true && <a className="qtd-export-button" href={exportUrl} download>导出 Excel</a>}</div><div className="qtd-defect-filters"><label>严重程度筛选 <select aria-label="缺陷严重程度筛选" value={severityFilter} onChange={event => { setSeverityFilter(event.target.value as SeverityFilter); setPage(1); }}><option value="all">全部严重程度</option>{DEFECT_SEVERITY_ORDER.map(level => <option key={level} value={level}>{severityLabel(level)}</option>)}<option value="unrecorded">未记录严重程度</option></select></label>{unassessed > 0 && <span role="note">其中 {unassessed} 条严重度未评估或未记录；不代表低风险，也不代表没有高严重度缺陷。</span>}</div><div className="qtd-table-wrap"><table><thead><tr><th>缺陷编号</th><th>缺陷标题</th><th>分类</th><th>严重程度</th><th>关联用例</th><th>操作</th></tr></thead><tbody>{visible.slice((page-1)*pageSize,page*pageSize).map((row,index)=><tr key={`${row.defect_id ?? "defect"}-${index}`}><td>{row.defect_id || "—"}</td><td>{row.title || "—"}</td><td>{localizedValue(row.category ?? "unknown")}</td><td>{severityLabel(row.severity)}</td><td>{row.related_cases?.join("、") || "—"}</td><td><button type="button" className="qtd-link-button" onClick={()=>setSelected(row)}>查看详情</button></td></tr>)}{!visible.length && <tr><td colSpan={6} className="qtd-empty">暂无数据</td></tr>}</tbody></table></div>
      <div className="qtd-case-pagination"><span>共 {visible.length} 条</span><label>每页 <select aria-label="缺陷每页条数" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[10,20,50].map(size=><option key={size} value={size}>{size} 条</option>)}</select></label><button type="button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page===pages} onClick={()=>setPage(value=>value+1)}>下一页</button></div></>}
    {selected && <div className="qtd-mask" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setSelected(null);}}><section className="qtd-modal qtd-defect-modal" role="dialog" aria-modal="true" aria-label="缺陷详情"><header><strong>{selected.defect_id || "缺陷"} · {selected.title || "详情"}</strong><button type="button" aria-label="关闭缺陷详情" onClick={()=>setSelected(null)}>×</button></header><div className="qtd-detail-fields">
      {([["缺陷现象",selected.actual_result],["复现步骤",selected.steps_to_reproduce],["预期结果",selected.expected_result],["影响范围",selected.impact],["处理建议",selected.recommendation],["分类",localizedValue(selected.category ?? "unknown")],["状态",localizedValue(selected.lifecycle_status ?? "unknown")],["严重程度",severityLabel(selected.severity)],["严重程度理由",selected.severity_reason],["关联用例",selected.related_cases]] as [string, unknown][]).map(([label,value])=><div key={label as string}><strong>{label}</strong><span>{label === "缺陷现象" ? localizeActualResult(value) : ["复现步骤","处理建议"].includes(label as string) ? breakNumberedItems(display(value)) : display(value)}</span></div>)}
      {isSeverityUnknown(selected.severity) && <p role="note">该缺陷严重度未评估或未记录，需补充影响证据或人工复核，不能按低风险处理。</p>}
      <ResultEvidenceFields sessionId={sessionId} runId={runId} references={selected.evidence_refs}/>
    </div><footer><button type="button" onClick={()=>setSelected(null)}>关闭</button></footer></section></div>}
  </section>;
}
