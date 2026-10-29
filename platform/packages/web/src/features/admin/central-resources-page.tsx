import { useCallback, useEffect, useState } from "react";
import { Button, Modal, PageFrame } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import type { ManagedKind } from "../../lib/managed-resources";
import { RESOURCE_NAMES, type Publication } from "./publications-page";
import { providerInfo } from "@prismshadow/penguin-server/model-catalog";
import "./central-resources-page.css";

type Form = Pick<Publication, "kind" | "name" | "description" | "payload" | "audience"> & { id?: string; revision?: number };
type Account = { userId: string; isAdmin: boolean };
type Version = { version: number; created_at: string; body: { name: string; description: string; payload: Record<string, unknown> } };

function newForm(kind: ManagedKind): Form {
  const payload = kind === "agents" ? { prompt: "", agentsMd: "", modelResource: "", skillResources: [], pluginResources: [] }
    : kind === "models" ? { provider: "", modelId: "", vision: true }
    : kind === "plugins" ? { pluginName: "", pluginVersion: "", source: "upstream-library" }
    : { skillName: "", content: "" };
  return { kind, name: "", description: "", payload, audience: [] };
}

const inputClass = "mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm";
const identity = (resource: Publication) => String(resource.payload.modelId || resource.payload.pluginName || resource.payload.skillName || (resource.kind === "agents" ? resource.description.match(/·\s*([a-z][a-z0-9_-]*)$/)?.[1] || resource.id.slice(0, 8) : resource.name));
const status = (resource: Publication) => resource.published ? "已发布" : resource.version ? "已下架" : "草稿";
const audience = (resource: Publication) => resource.audience.includes("*") ? "全部用户" : resource.audience.length ? `${resource.audience.length} 个授权账号` : "仅管理员";
const groupLabel = (provider: string) => providerInfo(provider)?.label || provider;

export function CentralResourcesPage({ kind }: { kind: ManagedKind }) {
  const [resources, setResources] = useState<Publication[]>([]);
  const [users, setUsers] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [detailTab, setDetailTab] = useState("overview");
  const [history, setHistory] = useState<Version[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [catalog, accounts] = await Promise.all([
      controlRequest("/api/control/admin/resources"),
      controlRequest("/api/admin/users"),
    ]);
    setResources(catalog.resources); setUsers(accounts.users);
  }, []);
  useEffect(() => { void load().catch(cause => setError(String(cause.message || cause))); }, [load]);

  function setPayload(patch: Record<string, unknown>) {
    setForm(current => current ? { ...current, payload: { ...current.payload, ...patch } } : current);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const providers = [...new Set(resources.filter(item => item.kind === "models").map(item => String(item.payload.provider || "")))].filter(Boolean).sort();
  const rows = resources.filter(item => item.kind === kind && (!providerFilter || kind !== "models" || item.payload.provider === providerFilter) && `${item.name} ${item.description} ${identity(item)}`.toLowerCase().includes(query.toLowerCase()));
  const groups = kind === "models" ? Object.entries(Object.groupBy(rows, item => String(item.payload.provider || "其他"))).sort(([a], [b]) => a.localeCompare(b)) : kind === "plugins" ? Object.entries(Object.groupBy(rows, item => item.payload.source === "upstream-library" ? "上游插件库" : "公共插件")) : kind === "skills" ? Object.entries(Object.groupBy(rows, item => item.payload.archiveBase64 ? "原格式技能包" : "公共技能")) : [];
  const toggleGroup = (group: string) => setExpandedGroups(current => current.includes(group) ? current.filter(item => item !== group) : [...current, group]);
  const openEdit = (resource: Publication) => { setForm(structuredClone(resource)); setDetailTab("overview"); };
  const saveForm = async () => { if (!form) return; await act(async () => { const saved = await controlRequest(`/api/control/admin/resources${form.id ? `/${form.id}` : ""}`, form.id ? "PUT" : "POST", { kind, name: form.name, description: form.description, payload: form.payload, audience: form.audience, ...(form.id ? { revision: form.revision } : {}) }); if (!saved.id) throw new Error("保存后未返回资源编号。"); setForm(null); await load(); }); };
  const audienceFields = form && <fieldset className="central-resource-audience"><legend>使用范围</legend><label><input type="checkbox" checked={form.audience.includes("*")} onChange={event => setForm({ ...form, audience: event.target.checked ? ["*"] : [] })} />全部用户</label>{!form.audience.includes("*") && users.filter(user => !user.isAdmin).map(user => <label key={user.userId}><input type="checkbox" checked={form.audience.includes(user.userId)} onChange={event => setForm({ ...form, audience: event.target.checked ? [...form.audience, user.userId] : form.audience.filter(id => id !== user.userId) })} />{user.userId}</label>)}</fieldset>;
  const actions = (resource: Publication) => <div className="central-resource-actions">
    <button onClick={() => openEdit(resource)}>配置与授权</button>
    <button disabled={busy} onClick={() => void act(async () => { if (!confirm(`发布「${resource.name}」的新版本？`)) return; await controlRequest(`/api/control/admin/resources/${resource.id}/publish`, "POST", { revision: resource.revision }); await load(); })}>发布版本</button>
    {resource.published && <button disabled={busy} onClick={() => void act(async () => { if (!confirm(`下架「${resource.name}」？已有本地任务和资料将保留。`)) return; await controlRequest(`/api/control/admin/resources/${resource.id}/withdraw`, "POST", {}); await load(); })}>下架</button>}
    <button onClick={() => void act(async () => setHistory((await controlRequest(`/api/control/admin/resources/${resource.id}/history`)).versions))}>版本记录</button>
    {!resource.version && <button className="danger" disabled={busy} onClick={() => void act(async () => { if (!confirm(`删除草稿「${resource.name}」？此操作无法恢复。`)) return; await controlRequest(`/api/control/admin/resources/${resource.id}`, "DELETE", { revision: resource.revision }); await load(); })}>删除草稿</button>}
  </div>;
  const card = (resource: Publication) => <article className="central-resource-card" key={resource.id}>
    <div className="central-resource-avatar">{resource.name.trim().slice(0, 1).toUpperCase()}</div>
    <div className="central-resource-content"><div className="central-resource-name"><strong>{resource.name}</strong><span className="central-resource-id">{identity(resource)}</span><small>v{resource.version}</small><em className={resource.published ? "published" : ""}>{status(resource)}</em></div><p>{resource.description || "暂无说明"}</p><div className="central-resource-meta"><span>{audience(resource)}</span>{kind === "agents" && <span>公共关联 {(resource.payload.skillResources as string[] | undefined)?.length || 0} 个技能 · {(resource.payload.pluginResources as string[] | undefined)?.length || 0} 个插件</span>}{kind === "models" && <span>{resource.payload.vision === false ? "文本" : "视觉"} · {resource.payload.contextWindow ? `${resource.payload.contextWindow} token` : "上下文未配置"}</span>}</div></div>
    {actions(resource)}
  </article>;
  return <PageFrame><div className="central-resource-page">
    {form && kind === "agents" ? <div className="central-agent-detail"><button className="central-agent-back" onClick={() => { if (confirm("放弃未保存的修改？")) setForm(null); }}>← 返回智能体管理</button><h1>{form.name || "新建智能体"}</h1><p className="central-agent-detail-id">{form.id || "新公共模板"}</p><div className="central-agent-tabs">{[["overview","概览"],["prompt","系统提示词"],["runtime","运行参数"],["resources","插件与技能"],["access","授权与发布"]].map(([key,title]) => <button key={key} className={detailTab === key ? "active" : ""} onClick={() => setDetailTab(key!)}>{title}</button>)}</div><div className="central-agent-panel">{detailTab === "overview" && <><label>名称<input className={inputClass} maxLength={100} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>说明<textarea className={inputClass} rows={4} maxLength={2000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><div className="central-agent-note">公共模板由管理员维护。智能体状态、快照、内核更新与本机任务仍通过原有用户端管理。</div></>}{detailTab === "prompt" && <><label>系统提示词<textarea className={inputClass} rows={12} value={String(form.payload.prompt || "")} onChange={event => setPayload({ prompt: event.target.value })} /></label><label>AGENTS.md 说明<textarea className={inputClass} rows={8} value={String(form.payload.agentsMd || "")} onChange={event => setPayload({ agentsMd: event.target.value })} /></label></>}{detailTab === "runtime" && <><label>最大轮数<input className={inputClass} type="number" min={1} value={String(form.payload.maxTurns || "")} onChange={event => setPayload({ maxTurns: event.target.value ? Number(event.target.value) : undefined })} /></label><label>关联公共模型<select className={inputClass} value={String(form.payload.modelResource || "")} onChange={event => setPayload({ modelResource: event.target.value })}><option value="">用户自行选择本机模型</option>{resources.filter(item => item.kind === "models" && item.published).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}{detailTab === "resources" && (["plugins","skills"] as const).map(dependencyKind => { const key = dependencyKind === "plugins" ? "pluginResources" : "skillResources"; const selected = (form.payload[key] as string[] | undefined) || []; return <fieldset key={key} className="central-resource-audience"><legend>关联已发布{RESOURCE_NAMES[dependencyKind]}</legend>{resources.filter(item => item.kind === dependencyKind && item.published).map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setPayload({ [key]: event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id) })} />{item.name}</label>)}</fieldset>; })}{detailTab === "access" && <>{audienceFields}<p className="central-agent-note">保存草稿后才可发布版本；授权调整在保存后立即生效。</p></>}</div><div className="central-agent-footer"><button className="primary" disabled={busy} onClick={() => void saveForm()}>保存草稿</button><button onClick={() => setForm(null)}>取消</button></div></div> : <>
    <div className="central-resource-head"><div><h1>{kind === "models" ? "模型库" : `${RESOURCE_NAMES[kind]}管理`}</h1><p>{kind === "agents" ? "管理公共智能体模板、配置与授权。运行状态和本机任务在用户端查看。" : kind === "models" ? "按上游供应商分组管理公共模型参数；个人密钥和地址由用户在本机填写。" : kind === "plugins" ? "维护上游插件引用与公共使用配置；安装和升级沿用原有插件市场。" : "维护公共技能内容与原格式技能包，按账号授权发布。"}</p></div><div className="central-resource-head-actions"><input aria-label={`搜索${RESOURCE_NAMES[kind]}`} placeholder={`搜索${RESOURCE_NAMES[kind]}名称或标识`} value={query} onChange={event => setQuery(event.target.value)} /><button className="primary" onClick={() => setForm(newForm(kind))}>＋ 新建{RESOURCE_NAMES[kind]}</button></div></div>
    {kind === "models" && <div className="central-resource-filter"><label>供应商 <select aria-label="筛选供应商" value={providerFilter} onChange={event => setProviderFilter(event.target.value)}><option value="">全部供应商</option>{providers.map(provider => <option key={provider} value={provider}>{groupLabel(provider)}</option>)}</select></label></div>}
    <div className="central-resource-count">共 {rows.length} 项{query && ` · 搜索“${query}”`}</div>
    {error && <p role="alert" className="mb-4 text-red-600">{error}</p>}
    {kind === "agents" ? <div className="central-resource-list">{rows.map(card)}</div> : <div className="central-resource-groups">{groups.map(([group, items]) => <section key={group} className="central-resource-group"><button className="central-resource-group-head" onClick={() => toggleGroup(group)} aria-expanded={expandedGroups.includes(group) || !!query}><span className="central-resource-avatar small">{groupLabel(group).slice(0, 1).toUpperCase()}</span><strong>{kind === "models" ? groupLabel(group) : group}</strong><span>{items?.length || 0} 项</span><span className="chevron">⌄</span></button>{(expandedGroups.includes(group) || !!query) && <div className="central-resource-list">{items?.map(card)}</div>}</section>)}{kind === "models" && <button className="central-add-group" onClick={() => setForm(newForm("models"))}>＋ 新增分组 / 模型</button>}</div>}
    {!rows.length && <p className="py-12 text-center text-sm opacity-60">{query ? "没有匹配的配置。" : `暂无公共${RESOURCE_NAMES[kind]}。点击右上角新建。`}</p>}
    {form && <Modal open title={`${form.id ? "编辑" : "新建"}${RESOURCE_NAMES[kind]}`} onClose={() => { if (!busy && confirm("放弃未保存的修改？")) setForm(null); }} footer={<Button disabled={busy} onClick={() => void saveForm()}>保存草稿</Button>}>
      <div className="max-h-[65vh] space-y-4 overflow-auto pr-2 text-sm">
        <label className="block">名称<input className={inputClass} maxLength={100} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label className="block">说明<textarea className={inputClass} rows={2} maxLength={2000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
        <PayloadFields form={form} setPayload={setPayload} resources={resources} />
        {audienceFields}
        <p className="text-xs opacity-60">保存为草稿后点击“发布版本”才会更新用户可获取的配置；修改授权立即生效。</p>
      </div>
    </Modal>}
    </>}{history && <Modal open title="发布版本记录" onClose={() => setHistory(null)}>{history.length ? history.map(version => <details key={version.version} className="mb-3"><summary>v{version.version} · {version.created_at}</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ ...version.body, payload: { ...version.body.payload, ...(version.body.payload.archiveBase64 ? { archiveBase64: "已保存的技能包" } : {}) } }, null, 2)}</pre></details>) : <p>尚无已发布版本。</p>}</Modal>}
  </div></PageFrame>;
}

function PayloadFields({ form, setPayload, resources }: { form: Form; setPayload: (patch: Record<string, unknown>) => void; resources: Publication[] }) {
  const value = (key: string) => String(form.payload[key] ?? "");
  const field = (title: string, key: string, multiline = false) => <label className="block" key={key}>{title}{multiline ? <textarea className={inputClass} rows={5} value={value(key)} onChange={event => setPayload({ [key]: event.target.value })} /> : <input className={inputClass} value={value(key)} onChange={event => setPayload({ [key]: event.target.value })} />}</label>;
  const numberField = (title: string, key: string) => <label className="block" key={key}>{title}<input className={inputClass} type="number" min={1} value={value(key)} onChange={event => setPayload({ [key]: event.target.value ? Number(event.target.value) : undefined })} /></label>;
  const dependencies = (dependencyKind: ManagedKind, key: string) => <fieldset key={key}><legend className="font-medium">关联已发布{RESOURCE_NAMES[dependencyKind]}</legend>{resources.filter(item => item.kind === dependencyKind && item.published).map(item => { const selected = (form.payload[key] as string[] | undefined) ?? []; return <label key={item.id} className="mt-2 flex gap-2"><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setPayload({ [key]: event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id) })} />{item.name}</label>; })}</fieldset>;
  if (form.kind === "agents") return <div className="space-y-4">{field("系统提示词", "prompt", true)}{field("AGENTS.md 说明", "agentsMd", true)}{numberField("最大轮数", "maxTurns")}<label className="block">关联公共模型<select className={inputClass} value={value("modelResource")} onChange={event => setPayload({ modelResource: event.target.value })}><option value="">用户自行选择本机模型</option>{resources.filter(item => item.kind === "models" && item.published).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{dependencies("plugins", "pluginResources")}{dependencies("skills", "skillResources")}</div>;
  if (form.kind === "models") {
    const pricing = (form.payload.pricing || {}) as Record<string, number>;
    return <div className="space-y-4">{field("供应商标识（小写英文）", "provider")}{field("模型 ID", "modelId")}{field("公共 API 地址（可选，不含凭据）", "baseUrl")}{field("客户端类型（可选）", "clientType")}{numberField("上下文窗口", "contextWindow")}{numberField("最大输出 token", "maxTokens")}<label className="flex gap-2"><input type="checkbox" checked={form.payload.vision !== false} onChange={event => setPayload({ vision: event.target.checked })} />支持视觉</label><label className="flex gap-2"><input type="checkbox" checked={form.payload.fastMode === true} onChange={event => setPayload({ fastMode: event.target.checked })} />快速模式</label><fieldset><legend className="font-medium">价格（美元 / 百万 token）</legend>{(["input", "cacheRead", "cacheWrite", "output"] as const).map(key => <label key={key} className="mt-2 block">{({input:"输入",cacheRead:"缓存读取",cacheWrite:"缓存写入",output:"输出"} as const)[key]}<input className={inputClass} type="number" min="0" step="any" value={pricing[key] ?? ""} onChange={event => setPayload({ pricing: { ...pricing, [key]: event.target.value ? Number(event.target.value) : undefined } })} /></label>)}</fieldset><label className="block">折扣比例（0 到 1，可选）<input className={inputClass} type="number" min="0" max="1" step="any" value={value("discount")} onChange={event => setPayload({ discount: event.target.value ? Number(event.target.value) : undefined })} /></label><p className="text-xs opacity-60">分组由供应商标识决定，保存首个模型后出现。价格、协议和模型能力由管理员维护；API 密钥与个人地址由用户在本机设置。</p></div>;
  }
  if (form.kind === "plugins") return <div className="space-y-4"><label className="block">来源<select className={inputClass} value={value("source") || "custom"} onChange={event => setPayload(event.target.value === "upstream-library" ? { pluginName: value("pluginName"), pluginVersion: "", source: "upstream-library", skillResources: undefined, instructions: undefined } : { pluginName: value("pluginName"), skillResources: [], instructions: "", source: undefined, pluginVersion: undefined })}><option value="upstream-library">上游插件库引用</option><option value="custom">公共说明与技能组合</option></select></label>{field("插件标识（小写英文）", "pluginName")}{form.payload.source === "upstream-library" ? <>{field("上游插件版本", "pluginVersion")}<p className="text-xs opacity-60">安装和升级继续使用原有插件市场。</p></> : <>{field("使用说明", "instructions", true)}{dependencies("skills", "skillResources")}</>}</div>;
  return <div className="space-y-4">{field("技能标识（须与技能包 SKILL.md 中的名称一致）", "skillName")}{form.payload.archiveBase64 ? <p>已选择原格式技能包。保存时会校验包内 SKILL.md 与技能标识。</p> : field("SKILL.md 内容", "content", true)}<label className="block">上传原格式技能包（ZIP，最大 1 MB）<input className={inputClass} type="file" accept=".zip,.skill" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1024 * 1024) { alert("技能包不能超过 1 MB。"); return; } const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); const archiveBase64 = btoa(binary); setPayload({ archiveBase64, fileNames: undefined, content: undefined }); }} /></label><p className="text-xs opacity-60">请勿在公共技能内容中填写个人资料或凭据。</p></div>;
}
