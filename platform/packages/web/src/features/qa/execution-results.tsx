import { useEffect, useMemo, useState } from "react";
import { executionRows, executionSummary, loadVerifiedJson, localizeActualResult, type DesignCase, type ResultArtifact, type ResultCase } from "./task-results";
import { ResultEvidenceFields } from "./result-evidence";
import { localizedValue } from "./stage-localization";

type ResultDocument = { cases?: ResultCase[] };
type DesignDocument = DesignCase[] | { cases?: DesignCase[] };
const display = (value: unknown): string => value == null || value === "" ? "—" : Array.isArray(value) ? value.map(display).join("、") : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);

export function ExecutionResults({ projectId, sessionId, runId, stageId, artifacts, refresh }: { projectId: string; sessionId: string; runId: string; stageId: string; artifacts: ResultArtifact[]; refresh: number }) {
  const [results, setResults] = useState<ResultCase[] | null>(null);
  const [designed, setDesigned] = useState<DesignCase[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ id: string; title: string; design: DesignCase | null; results: ResultCase[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const resultName = stageId === "api_execution" ? "execution/api/test_results.json" : "execution/test_results.json";
  const resultArtifact = artifacts.find(item => item.stage === stageId && item.path.endsWith(`/${resultName}`));
  const designArtifact = artifacts.find(item => item.stage === "test_cases" && item.name === "test_cases.json");
  useEffect(() => {
    const controller = new AbortController();
    setResults(null); setDesigned(null); setError(""); setSelected(null); setPage(1);
    if (resultArtifact && (!resultArtifact.available || resultArtifact.verified !== true)) setError("用例执行结果尚未通过交付校验，请在阶段产物中查看状态。");
    void Promise.all([loadVerifiedJson<ResultDocument>(sessionId, resultArtifact, controller.signal), loadVerifiedJson<DesignDocument>(sessionId, designArtifact, controller.signal).catch(() => null)])
      .then(([result, design]) => { if (controller.signal.aborted) return; setResults(Array.isArray(result?.cases) ? result.cases : []); setDesigned(Array.isArray(design) ? design : Array.isArray(design?.cases) ? design.cases : null); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "执行结果读取失败。"); });
    return () => controller.abort();
  }, [sessionId, runId, stageId, resultArtifact?.path, resultArtifact?.verified, designArtifact?.path, designArtifact?.verified, refresh]);
  const view = useMemo(() => executionRows(designed, results ?? []), [designed, results]);
  const pages = Math.max(1, Math.ceil(view.rows.length / pageSize));
  const status = (row: (typeof view.rows)[number]) => row.design && row.results.some(item => item.case_ref) ? executionSummary(row.results).status : !row.results.length ? "待执行" : row.results.some(item => item.status === "failed") ? "不通过" : localizedValue(row.results[0]!.status ?? "unknown");
  const exportUrl = `/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/results/${encodeURIComponent(stageId)}/export`;
  return <section className="qtd-structured-results" aria-label="用例执行结果">
    {error && <p role="alert" className="qtd-message qtd-error">{error}</p>}
    {!results && !error && <p role="status" className="qtd-message">正在读取用例执行结果…</p>}
    {results && <><div className="qtd-metrics">{[["用例总数",view.metrics.total],["已关联执行",view.metrics.executed],["完整通过",view.metrics.passed],["含失败断言",view.metrics.failed],["补充用例数量",view.metrics.supplemental],["待执行用例数量",view.metrics.pending]].map(([label,value])=><div className="qtd-metric" key={label}><span>{label}</span><strong>{value == null ? "未提供" : value}</strong></div>)}</div>
      {designed === null && resultArtifact && <p className="qtd-result-note">本次没有已校验的设计用例清单，用例总数与覆盖数量暂无法计算。</p>}
      <div className="qtd-list-heading"><strong>执行结果 · {view.rows.length} 条</strong>{resultArtifact?.verified === true && <a className="qtd-export-button" href={exportUrl} download>导出 Excel</a>}</div>
      <div className="qtd-table-wrap"><table className="qtd-execution-table"><thead><tr><th>用例编号</th><th>模块</th><th>优先级</th><th>测试项</th><th>预期结果</th><th>执行状态</th><th>实际结果</th><th>来源</th><th>操作</th></tr></thead><tbody>{view.rows.slice((page-1)*pageSize,page*pageSize).map((row,index)=><tr key={`${row.id}-${index}`}><td>{row.id || "—"}</td><td>{row.design?.module || "—"}</td><td>{row.design?.priority || "—"}</td><td>{row.title || row.results[0]?.title || "—"}</td><td><div className="qtd-execution-cell">{display(row.design?.expected ?? row.results[0]?.expected)}</div></td><td><span className="qtd-result-status">{status(row)}</span></td><td><div className="qtd-execution-cell">{!row.results.length ? "—" : row.results.every(item => item.status === "passed") ? "通过" : "不通过"}</div></td><td>{row.supplemental ? "补充用例" : designed ? "设计用例" : "执行记录"}</td><td><button type="button" className="qtd-link-button" onClick={() => setSelected(row)}>查看结果</button></td></tr>)}{!view.rows.length && <tr><td colSpan={9} className="qtd-empty">暂无数据</td></tr>}</tbody></table></div>
      <div className="qtd-case-pagination"><span>共 {view.rows.length} 条</span><label>每页 <select aria-label="每页条数" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[10,20,50].map(size=><option key={size} value={size}>{size} 条</option>)}</select></label><button type="button" disabled={page===1} onClick={() => setPage(value=>value-1)}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page===pages} onClick={() => setPage(value=>value+1)}>下一页</button></div></>}
    {selected && <div className="qtd-mask" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setSelected(null);}}><section className="qtd-modal" role="dialog" aria-modal="true" aria-label="用例执行详情"><header><strong>{selected.id || "用例"} · {selected.title || "执行详情"}</strong><button type="button" aria-label="关闭执行详情" onClick={()=>setSelected(null)}>×</button></header><div className="qtd-detail-fields"><div><strong>覆盖说明</strong><span>{selected.results.length ? `关联 ${selected.results.length} 条执行断言；仅代表已验证的断言，不能据此认定全部设计步骤完成。` : "尚无关联执行记录"}</span></div>{selected.results.map((result,index)=><section key={`${result.case_id}-${index}`} className="qtd-assertion"><h4>{result.case_id || `断言 ${index+1}`} · {localizedValue(result.status ?? "unknown")}</h4><div><strong>预期结果</strong><span>{display(result.expected)}</span></div><div><strong>实际结果</strong><span>{localizeActualResult(result.actual_result ?? result.error_message ?? result.reason)}</span></div><ResultEvidenceFields sessionId={sessionId} runId={runId} references={result.evidence_paths}/></section>)}</div><footer><button type="button" onClick={()=>setSelected(null)}>关闭</button></footer></section></div>}
  </section>;
}
