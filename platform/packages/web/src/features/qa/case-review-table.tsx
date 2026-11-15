import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";
import { redactPreview } from "./artifact-preview";

type Column = { key: string; label: string; editable: boolean };
type Row = { id: string; values: Record<string, unknown> };
type CaseData = { columns: Column[]; rows: Row[]; version: string; confirmationId: string };
const fallbackColumns: Column[] = [
  ["case_id","编号"],["module","模块"],["priority","优先级"],["title","测试项"],["preconditions","前置条件"],["steps","操作步骤 / 测试数据"],["expected","预期结果"],["actual","实际结果 / 未执行原因"],["status","执行结果"],["issues","关联问题"],["evidence","证据文件"],
].map(([key,label]) => ({ key: key!, label: label!, editable: false }));
const designColumns = (columns: Column[]) => columns.filter(column => !["actual", "status", "issues", "evidence"].includes(column.key));
const text = (value: unknown): string => value == null ? "" : Array.isArray(value) ? value.map(text).join("\n") : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
const numbered = (value: unknown): string => Array.isArray(value) && value.length > 1 ? value.map((item, index) => `${index + 1}. ${text(item)}`).join("\n") : text(value);
const stripNumber = (value: string): string => value.replace(/^\d+[.、．]\s*/, "").trim();
const cellText = (row: Row, key: string) => redactPreview(key === "steps" ? numbered(row.values.steps) + (Object.keys((row.values.test_data ?? {}) as object).length ? `\n测试数据：\n${text(row.values.test_data)}` : "") : numbered(row.values[key]));

export function CaseReviewTable({ endpoint, canEdit, refresh, onSaved, onBusyChange }: { endpoint: string; canEdit: boolean; refresh: number; onSaved: () => void; onBusyChange: (busy: boolean) => void }) {
  const [data, setData] = useState<CaseData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<{ row: Row; mode: "view" | "edit" | "delete" } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null); setError(""); setLoading(true); setDialog(null); onBusyChange(false);
    void apiFetch<CaseData>(endpoint).then(value => { if (active) { setData(value); setPage(current => Math.min(current, Math.max(1, Math.ceil(value.rows.length / pageSize)))); } })
      .catch(cause => { if (active) setError(cause && typeof cause === "object" && "code" in cause && cause.code === "cases_unavailable" ? "" : cause instanceof Error ? cause.message : "读取用例失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; onBusyChange(false); };
  }, [endpoint, refresh]);
  const open = (row: Row, mode: "view" | "edit" | "delete") => {
    setError(""); setDialog({ row, mode });
    setDraft(Object.fromEntries(Object.entries(row.values).map(([key,value]) => [key,["steps","preconditions"].includes(key) ? numbered(value) : text(value)])));
    onBusyChange(mode !== "view");
  };
  const close = () => { if (!saving) { setDialog(null); onBusyChange(false); } };
  const save = async () => {
    if (!dialog || !data || saving) return;
    setError("");
    try {
      let values: Record<string, unknown> | undefined;
      if (dialog.mode === "edit") {
        values = {};
        for (const column of data.columns.filter(item => item.editable)) {
          const value = draft[column.key] ?? "";
          values[column.key] = ["preconditions","steps"].includes(column.key) ? value.split(/\r?\n/).map(stripNumber).filter(Boolean) : value;
        }
        values.test_data = JSON.parse(draft.test_data || "{}");
        if (!values.test_data || typeof values.test_data !== "object" || Array.isArray(values.test_data)) throw Error("测试数据须为 JSON 对象。");
      }
      setSaving(true);
      await apiFetch(endpoint, { method: "POST", body: { version: data.version, confirmationId: data.confirmationId, caseId: dialog.row.id, operation: dialog.mode, values } });
      setDialog(null); onBusyChange(false); onSaved();
    } catch (cause) { setError(cause instanceof SyntaxError ? "测试数据的 JSON 格式不正确。" : cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const pages = Math.max(1, Math.ceil((data?.rows.length ?? 0) / pageSize));
  return <section aria-label="测试用例结果列表" className="qtd-cases">
    {error && <p role="alert" className="qtd-message qtd-error">{error}</p>}
    {loading && <p role="status" className="qtd-message">正在读取测试用例…</p>}
    <div className="qtd-table-wrap"><table><thead><tr>{designColumns(data?.columns ?? fallbackColumns).map(column=><th key={column.key}>{column.label}</th>)}<th className="qtd-case-operations">操作</th></tr></thead><tbody>
      {data?.rows.slice((page-1)*pageSize,page*pageSize).map(row=><tr key={row.id}>{designColumns(data.columns).map(column=><td key={column.key}><div className="qtd-case-cell">{cellText(row,column.key) || "—"}</div></td>)}<td className="qtd-case-operations"><div className="qtd-actions"><button type="button" onClick={()=>open(row,"view")}>查看</button><button type="button" disabled={!canEdit || !data.confirmationId} onClick={()=>open(row,"edit")}>编辑</button><button type="button" disabled={!canEdit || !data.confirmationId} onClick={()=>open(row,"delete")}>删除</button></div></td></tr>)}
      {!loading && !data?.rows.length && <tr><td colSpan={designColumns(data?.columns ?? fallbackColumns).length+1} className="qtd-empty">暂无数据</td></tr>}
    </tbody></table></div>{data && <div className="qtd-case-pagination"><span>共 {data.rows.length} 条</span><label>每页 <select aria-label="每页用例数量" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[10,20,50,100].map(size=><option key={size} value={size}>{size} 条</option>)}</select></label><button type="button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page===pages} onClick={()=>setPage(value=>value+1)}>下一页</button></div>}
    {dialog && data && <div className="qtd-mask"><section className="qtd-modal" role="dialog" aria-modal="true" aria-label={`${dialog.mode==="view"?"查看":dialog.mode==="edit"?"编辑":"删除"}用例`}><header><strong>{dialog.row.id} · {dialog.mode==="view"?"查看用例":dialog.mode==="edit"?"编辑用例":"删除用例"}</strong><button type="button" aria-label="关闭用例窗口" disabled={saving} onClick={close}>×</button></header>
      <div className="qtd-case-form">{error && <p role="alert" className="qtd-error">{error}</p>}{dialog.mode==="delete" ? <p>确认删除“{text(dialog.row.values.title)}”？保存后仍需确认阶段结果才会继续。</p> : data.columns.map(column=><label key={column.key}><strong>{column.label}</strong>{dialog.mode==="edit" && column.editable ? column.key==="priority" ? <select aria-label={column.label} value={draft[column.key]} onChange={event=>setDraft(value=>({...value,[column.key]:event.target.value}))}>{["P0","P1","P2","P3"].map(priority=><option key={priority}>{priority}</option>)}</select> : <textarea aria-label={column.label} rows={["steps","preconditions","expected"].includes(column.key)?4:2} value={draft[column.key] ?? ""} onChange={event=>setDraft(value=>({...value,[column.key]:event.target.value}))} onBlur={() => { if (["steps","preconditions"].includes(column.key)) setDraft(value => { const items = (value[column.key] ?? "").split(/\r?\n/).map(stripNumber).filter(Boolean); return {...value,[column.key]:numbered(items)}; }); }}/>: <div className="qtd-case-value">{cellText(dialog.row,column.key) || "—"}</div>}</label>)}
      {dialog.mode==="edit" && <label><strong>测试数据（JSON）</strong><textarea aria-label="测试数据" rows={5} value={draft.test_data ?? "{}"} onChange={event=>setDraft(value=>({...value,test_data:event.target.value}))}/></label>}</div>
      <footer><button type="button" disabled={saving} onClick={close}>{dialog.mode==="view"?"关闭":"取消"}</button>{dialog.mode!=="view" && <button type="button" disabled={saving} onClick={()=>void save()}>{saving?"正在保存…":dialog.mode==="delete"?"确认删除":"保存"}</button>}</footer>
    </section></div>}
  </section>;
}
