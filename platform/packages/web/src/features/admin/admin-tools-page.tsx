/**
 * 工具管理（平台管理后台 `/tools`）。
 *
 * 布局照技能管理页：左侧阶段分类 + 右侧卡片网格 + 整页编辑器。
 * 不同之处是卡片要回答四个问题——**属于哪个阶段、读还是写、被谁引用、是否启用**，
 * 因为这四样是「这条纪律真的接上了」的唯一证据；技能页不需要回答这些。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmModal, GlyphIcon, ICONS, Modal, PageFrame, PageHeader, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { apiErrorText } from "../../lib/api-error";
import "./admin-tools-page.css";

type Permission = "read" | "write";
type Tool = {
  id: string; name: string; displayName: string; summary: string; description: string;
  categoryId: string; permissions: Permission; parameters: string; returns: string;
  version: number; revision: number; enabled: boolean; builtin: boolean; agents: string[];
  /** 这条工具在运行期管着哪些 action。null = 引擎侧读不到，或者它本来就没绑任何 action。 */
  bindings: { hard: string[]; soft: string[] } | null;
  /** 引擎侧记录到的调用次数。 */
  calls: number;
};
type Category = { id: string; name: string; builtin: number };
type AuditEntry = { action: string; actor: string; detail: string; createdAt: string };
const base = "/api/control/tools/admin";

const ACTION_LABEL: Record<string, string> = {
  create: "新建", update: "更新契约", touch: "微调描述", enable: "启用", disable: "停用", delete: "删除",
};

function pretty(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
/** 显示 agentId 原文：改写成中文反而让人对不上资源清单里的 id。 */
function agentLabel(agentId: string): string {
  return agentId;
}

function Editor({ entry, categories, agents, close, saved }: {
  entry: Tool | null; categories: Category[]; agents: string[]; close: () => void; saved: () => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [displayName, setDisplayName] = useState(entry?.displayName ?? "");
  const [summary, setSummary] = useState(entry?.summary ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [categoryId, setCategoryId] = useState(entry?.categoryId ?? categories[0]?.id ?? "common");
  const [permissions, setPermissions] = useState<Permission>(entry?.permissions ?? "read");
  const [parameters, setParameters] = useState(pretty(entry?.parameters ?? "{}"));
  const [returns, setReturns] = useState(pretty(entry?.returns ?? "{}"));
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [links, setLinks] = useState<string[]>(entry?.agents ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const jsonOk = (value: string) => { try { const parsed = JSON.parse(value) as unknown; return !!parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch { return false; } };
  const valid = /^[a-z][a-z0-9_.-]{0,63}$/.test(name) && !!displayName.trim() && !!summary.trim()
    && !!description.trim() && jsonOk(parameters) && jsonOk(returns);
  const save = async () => {
    if (!valid) return;
    setSaving(true); setError("");
    try {
      const body = { name, displayName: displayName.trim(), summary: summary.trim(), description: description.trim(), categoryId, permissions, parameters, returns, enabled, agents: links };
      if (entry) await controlRequest(`${base}/${entry.id}`, "PUT", { ...body, revision: entry.revision });
      else await controlRequest(base, "POST", body);
      toastSuccess(entry ? "工具已保存" : "工具已创建");
      saved();
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setSaving(false); }
  };
  const toggleLink = (agentId: string) =>
    setLinks(current => current.includes(agentId) ? current.filter(item => item !== agentId) : [...current, agentId]);
  return <div className="at-editor">
    <PageHeader
      title={entry ? `编辑 ${entry.displayName}` : "新增工具"}
      description={entry ? `${entry.name} · 当前 v${entry.version}${entry.builtin ? " · 内置工具（不可删除）" : ""}` : "登记一个可被 Agent 调用的能力单元"}
      back={{ label: "返回工具列表", onClick: close }}
      actions={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={!valid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></>}
    />
    <div className="at-editor-columns">
      <div>
        <section className="at-box">
          <h2>基本信息</h2>
          <label>调用名称（Agent 用它定位工具）<input value={name} disabled={!!entry} maxLength={64} onChange={event => setName(event.target.value)} placeholder="如 expected.provenance" /></label>
          <small>小写字母开头，可含数字、下划线、点与短横线；创建后不可修改。</small>
          <label>显示名称<input value={displayName} maxLength={60} onChange={event => setDisplayName(event.target.value)} placeholder="如 预期结果溯源校验" /></label>
          <label>一句话摘要<textarea value={summary} rows={2} maxLength={200} onChange={event => setSummary(event.target.value)} placeholder="它替谁保证了什么" /></label>
          <label>详细说明<textarea value={description} rows={5} maxLength={4000} onChange={event => setDescription(event.target.value)} placeholder="写清它能做与做不到的边界，Agent 会读到这段" /></label>
        </section>
        <section className="at-box">
          <div className="at-box-title"><h2>参数契约（JSON Schema）</h2><span className={jsonOk(parameters) ? "at-ok" : "at-bad"}>{jsonOk(parameters) ? "合法 JSON" : "不是合法 JSON 对象"}</span></div>
          <textarea className="at-code" value={parameters} spellCheck={false} onChange={event => setParameters(event.target.value)} />
        </section>
        <section className="at-box">
          <div className="at-box-title"><h2>返回结构</h2><span className={jsonOk(returns) ? "at-ok" : "at-bad"}>{jsonOk(returns) ? "合法 JSON" : "不是合法 JSON 对象"}</span></div>
          <textarea className="at-code" value={returns} spellCheck={false} onChange={event => setReturns(event.target.value)} />
        </section>
      </div>
      <aside>
        <section className="at-box">
          <h2>归属与权限</h2>
          <label>所属阶段<select value={categoryId} onChange={event => setCategoryId(event.target.value)}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>读写权限<select value={permissions} onChange={event => setPermissions(event.target.value as Permission)}><option value="read">read — 只读不改产物</option><option value="write">write — 会写资产或产物</option></select></label>
          <label className="at-switch"><span>启用</span><button type="button" role="switch" aria-checked={enabled} className={enabled ? "on" : ""} onClick={() => setEnabled(!enabled)}><i /></button></label>
          <small>停用后该工具从运行期清单中消失，但保留契约与历史，随时可以重新启用。</small>
        </section>
        <section className="at-box">
          <h2>被哪些 Agent 引用（{links.length}）</h2>
          <div className="at-agents">{agents.length === 0 ? <p className="at-muted">暂无可用 Agent</p> : agents.map(agentId => <label key={agentId} className="at-agent"><input type="checkbox" checked={links.includes(agentId)} onChange={() => toggleLink(agentId)} /><span title={agentId}>{agentLabel(agentId)}</span></label>)}</div>
        </section>
        <section className="at-box">
          <h2>完成度检查</h2>
          <p>{/^[a-z][a-z0-9_.-]{0,63}$/.test(name) ? "✓" : "○"} 调用名称合法</p>
          <p>{displayName.trim() ? "✓" : "○"} 显示名称已填</p>
          <p>{summary.trim() ? "✓" : "○"} 摘要已填</p>
          <p>{description.trim() ? "✓" : "○"} 详细说明已填</p>
          <p>{jsonOk(parameters) ? "✓" : "○"} 参数契约是合法 JSON 对象</p>
          <p>{links.length > 0 ? "✓" : "○"} 至少一个 Agent 引用</p>
        </section>
      </aside>
    </div>
    {error && <p role="alert" className="at-error">{error}</p>}
  </div>;
}

function Detail({ tool, close, edit }: { tool: Tool; close: () => void; edit: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  useEffect(() => {
    void controlRequest(`${base}/${tool.id}/audit`).then(result => setEntries(result.entries as AuditEntry[])).catch(() => setEntries([]));
  }, [tool.id]);
  return <Modal open title={tool.displayName} onClose={close} widthClass="sm:max-w-4xl" footer={<><Button onClick={close}>关闭</Button><Button variant="primary" onClick={edit}>编辑</Button></>}>
    <div className="at-detail">
      <p className="at-detail-name">{tool.name}</p>
      <p className="at-detail-summary">{tool.summary}</p>
      <p className="at-detail-desc">{tool.description}</p>
      <div className="at-detail-facts">
        <span>v{tool.version}</span><span>{tool.permissions}</span>
        <span className={tool.enabled ? "at-on" : "at-off"}>{tool.enabled ? "已启用" : "已停用"}</span>
        {tool.builtin && <span>内置</span>}
        <span>引用 {tool.agents.length} 个 Agent</span>
        <span>{tool.calls} 次运行期调用</span>
      </div>
      <h3>停用它会发生什么</h3>
      {tool.bindings === null
        ? <p className="at-muted">这条工具在运行期没有绑定任何 action。停用后它只会从运行期清单里消失，<strong>不会拦住任何调用</strong>——它目前还是一份登记，不是一道闸门。</p>
        : <>
            {tool.bindings.hard.length > 0 && <>
              <p className="at-bind-title">硬依赖：停用后这些 action 直接拒绝执行</p>
              <p className="at-bind-list">{tool.bindings.hard.join("、")}</p>
            </>}
            {tool.bindings.soft.length > 0 && <>
              <p className="at-bind-title">软依赖：停用后照常执行，但回执里标注「这条纪律未生效」</p>
              <p className="at-bind-list">{tool.bindings.soft.join("、")}</p>
            </>}
          </>}
      <h3>参数契约</h3><pre>{pretty(tool.parameters)}</pre>
      <h3>返回结构</h3><pre>{pretty(tool.returns)}</pre>
      <h3>变更记录</h3>
      {entries.length === 0 ? <p className="at-muted">暂无记录</p> : <ul className="at-audit">{entries.map((item, index) => <li key={`${item.createdAt}-${index}`}><strong>{ACTION_LABEL[item.action] ?? item.action}</strong><span>{item.actor}</span>{item.detail && <span>{item.detail}</span>}<time>{item.createdAt.replace("T", " ").slice(0, 19)}</time></li>)}</ul>}
    </div>
  </Modal>;
}

export function AdminToolsPage() {
  const [entries, setEntries] = useState<Tool[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [stage, setStage] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Tool | "new" | null>(null);
  const [viewing, setViewing] = useState<Tool | null>(null);
  const [removing, setRemoving] = useState<Tool | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 运行面证据：引擎侧是否真的收到了状态文件、每条工具被调了多少次。
   * 拿不到就是 null——不猜「大概生效了吧」，那种假设正是「后台点了停用、agent 照样跑」的来源。
   */
  const [runtime, setRuntime] = useState<{ enforced: boolean; total: number; per_tool: Record<string, number>; note: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await controlRequest(base);
      setEntries(result.tools as Tool[]);
      setCategories(result.categories as Category[]);
      const roles = await controlRequest("/api/control/catalog/roles").catch(() => ({ roles: [] }));
      setAgents((roles.roles as { agentId: string }[]).map(item => item.agentId).sort());
      const usage = await controlRequest(`${base}/usage`).catch(() => null);
      setRuntime(usage ? {
        enforced: usage.enforced === true,
        total: Number(usage.total ?? 0),
        per_tool: (usage.per_tool ?? {}) as Record<string, number>,
        note: typeof usage.note === "string" ? usage.note : null,
      } : null);
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const stageName = useCallback((id: string) => categories.find(item => item.id === id)?.name ?? id, [categories]);
  const visible = useMemo(() => entries.filter(item =>
    (stage === "all" || item.categoryId === stage)
    && (!query.trim() || `${item.name} ${item.displayName} ${item.summary} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()))),
  [entries, stage, query]);
  // 候选 = 中央已导入的 Agent ∪ 工具当前已引用的 Agent：
  // 内置引用（如 test_agent）在设计上先于资源导入存在，不并进来就看不到、也删不掉。
  const agentOptions = useMemo(() => {
    const set = new Set(agents);
    for (const tool of entries) for (const id of tool.agents) set.add(id);
    return [...set].sort();
  }, [agents, entries]);
  const enabledCount = entries.filter(item => item.enabled).length;
  const writeCount = entries.filter(item => item.permissions === "write").length;
  const linkCount = entries.reduce((sum, item) => sum + item.agents.length, 0);

  const toggle = async (tool: Tool) => {
    setBusy(true);
    try { await controlRequest(`${base}/${tool.id}/toggle`, "POST", {}); await load(); toastSuccess(tool.enabled ? "已停用" : "已启用"); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try { await controlRequest(`${base}/${removing.id}`, "DELETE"); setRemoving(null); await load(); toastSuccess("工具已删除"); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };

  if (editing !== null) return <PageFrame width="full" className="at-frame" contentClassName="at-content">
    <Editor key={editing === "new" ? "new" : editing.id} entry={editing === "new" ? null : editing} categories={categories} agents={agentOptions}
      close={() => setEditing(null)} saved={() => { setEditing(null); void load(); }} />
  </PageFrame>;

  return <PageFrame width="full" className="at-frame" contentClassName="at-content">
    <PageHeader title="工具管理" description="登记可被 Agent 调用的能力单元：参数契约、读写权限、启用状态与引用关系"
      actions={<Button variant="primary" onClick={() => setEditing("new")}>＋ 新增工具</Button>} />
    <div className="at-stats">
      <div><strong>{entries.length}</strong><span>登记工具</span></div>
      <div><strong>{enabledCount}</strong><span>已启用</span></div>
      <div><strong>{writeCount}</strong><span>写权限</span></div>
      <div><strong>{linkCount}</strong><span>Agent 引用</span></div>
      <div><strong>{runtime?.total ?? 0}</strong><span>运行期调用</span></div>
      <p>{runtime?.total
        ? "调用次数来自引擎侧流水，是判断这条纪律是否真的在必经路径上的唯一证据。"
        : "还没有调用记录。工具刚接入时为零是正常的；长期为零说明它不在任何阶段的必经路径上。"}</p>
    </div>
    {runtime && !runtime.enforced && <p role="status" className="at-warn">
      未与引擎同步{runtime.note ? `（${runtime.note}）` : ""}：此时停用只影响运行期清单，<strong>不会拦住 Agent 的调用</strong>。
    </p>}
    <div className="at-columns">
      <aside className="at-stages" aria-label="所属阶段">
        <div className="at-stage-head">所属阶段</div>
        <button type="button" className={stage === "all" ? "active" : ""} onClick={() => setStage("all")}><span className="at-stage-mark">全</span><span>全部</span><small>{entries.length}</small></button>
        {categories.map(item => <button key={item.id} type="button" className={stage === item.id ? "active" : ""} onClick={() => setStage(item.id)}>
          <span className="at-stage-mark">{item.name.slice(0, 1)}</span><span className="at-stage-name">{item.name}</span><small>{entries.filter(entry => entry.categoryId === item.id).length}</small>
        </button>)}
      </aside>
      <section className="at-results">
        <div className="at-results-head">
          <h2>{stage === "all" ? "全部" : stageName(stage)}</h2><span>{visible.length} 个工具</span>
          <input type="search" aria-label="搜索工具" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称 / 摘要 / 说明" />
        </div>
        {loading ? <p className="at-empty">正在加载工具…</p> : visible.length === 0 ? <p className="at-empty">没有匹配的工具</p> : <div className="at-grid">
          {visible.map(item => <article key={item.id} className="at-card" role="button" tabIndex={0} aria-label={`查看 ${item.displayName}`}
            onClick={() => setViewing(item)}
            onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setViewing(item); } }}>
            <div className="at-card-top">
              <span className={`at-dot${item.enabled ? " on" : ""}`} title={item.enabled ? "已启用" : "已停用"} />
              <strong title={item.displayName}>{item.displayName}</strong>
              <span className="at-perm">{item.permissions}</span>
            </div>
            <code className="at-name">{item.name}</code>
            <p title={item.summary}>{item.summary}</p>
            <footer>
              <span>{stageName(item.categoryId)}</span>
              <span>v{item.version}</span>
              <span title={item.bindings ? `硬依赖 ${item.bindings.hard.length} 个 action，软依赖 ${item.bindings.soft.length} 个` : "这条工具在运行期没有绑定任何 action，停用它不会影响流程"}>
                {item.bindings ? `管 ${item.bindings.hard.length + item.bindings.soft.length} 个 action` : "未接入运行期"}
              </span>
              <span title="引擎侧记录的运行期调用次数">{item.calls} 次</span>
              <div className="at-card-actions">
                <button type="button" title={item.enabled ? "停用" : "启用"} aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`} disabled={busy} onClick={event => { event.stopPropagation(); void toggle(item); }}><GlyphIcon d={item.enabled ? ICONS.pause : ICONS.play} size={14} /></button>
                <button type="button" title="编辑" aria-label={`编辑 ${item.name}`} onClick={event => { event.stopPropagation(); setEditing(item); }}><GlyphIcon d={ICONS.pencil} size={14} /></button>
                <button type="button" title={item.builtin ? "内置工具不可删除" : "删除"} aria-label={`删除 ${item.name}`} disabled={item.builtin} onClick={event => { event.stopPropagation(); setRemoving(item); }}><GlyphIcon d={ICONS.trash} size={14} /></button>
              </div>
            </footer>
          </article>)}
        </div>}
      </section>
    </div>
    {error && <p role="alert" className="at-error">{error}</p>}
    {viewing && <Detail tool={viewing} close={() => setViewing(null)} edit={() => { setEditing(viewing); setViewing(null); }} />}
    <ConfirmModal open={!!removing} title={removing ? `删除 ${removing.displayName}` : ""} busy={busy}
      onClose={() => setRemoving(null)} onConfirm={() => void remove()} confirmLabel="删除" cancelLabel="取消">
      <p>删除后该工具的契约与变更历史一并移除；若仍被 Agent 引用，需要先解除引用。</p>
    </ConfirmModal>
  </PageFrame>;
}
