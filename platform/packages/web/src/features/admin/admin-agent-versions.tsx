import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@prismshadow/penguin-ui";
import type { AgentConfigResponse } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { controlRequest } from "../../api/control";
import { fileToBase64 } from "../agents/snapshot-file";
import type { Publication } from "./publications-page";

export interface AdminAgentVersionRow {
  resourceId: string;
  projectId: string;
  rootAgentId: string;
  publishedAgentId: string;
  draftAgentId: string;
  publishedVersion: number;
}

export function adminVersionAgentId(resourceId: string, version: number) {
  return `admin_${resourceId.replaceAll("-", "").slice(0, 12)}_v${version}`;
}

export function adminVersionRowForAgent(rows: AdminAgentVersionRow[], agentId: string) {
  return rows.find(row => agentId === row.rootAgentId || agentId === row.publishedAgentId ||
    agentId === row.draftAgentId || agentId.startsWith(`admin_${row.resourceId.replaceAll("-", "").slice(0, 12)}_v`));
}

export function adminAgentVersion(row: AdminAgentVersionRow | undefined, agentId: string, fallback: number) {
  if (!row) return fallback;
  if (agentId === row.draftAgentId) return row.publishedVersion + 1;
  if (agentId === row.publishedAgentId) return row.publishedVersion || 1;
  const prefix = `admin_${row.resourceId.replaceAll("-", "").slice(0, 12)}_v`;
  return agentId.startsWith(prefix) ? Number(agentId.slice(prefix.length)) || 1 : 1;
}

export function adminAgentVersionStatus(row: AdminAgentVersionRow | undefined, agentId: string) {
  if (row?.publishedAgentId === agentId) return "已发布";
  if (row && agentId !== row.draftAgentId && row.publishedVersion > 0) return "历史版本";
  return "未发布";
}

export function publicAgentDraft(agentId: string, data: AgentConfigResponse, existing?: Publication) {
  return {
    kind: "agents", name: data.config.name || agentId, description: data.config.description || "",
    payload: { prompt: data.config.systemPrompt || "", agentsMd: data.agentsMd || "",
      ...(data.config.maxTurns === undefined ? {} : { maxTurns: data.config.maxTurns }),
      modelResource: existing?.payload.modelResource || "",
      skillResources: existing?.payload.skillResources || [], pluginResources: existing?.payload.pluginResources || [] },
  };
}

/** Authoring controls beside upstream settings; the old publication page is not used for Agents. */
export function AdminAgentVersions({ projectId, agentId, data, onEditable }: {
  projectId: string; agentId: string; data: AgentConfigResponse; onEditable: (editable: boolean) => void;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AdminAgentVersionRow[]>([]);
  const [resources, setResources] = useState<Publication[]>([]);
  const [users, setUsers] = useState<{ userId: string; isAdmin: boolean }[]>([]);
  const [history, setHistory] = useState<{ version: number; body: { kind: string; name: string; description: string; payload: Record<string, unknown>; audience?: string[] } }[]>([]);
  const [audience, setAudience] = useState<string[]>([]);
  const [attachId, setAttachId] = useState("");
  const [validated, setValidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [local, central, accounts] = await Promise.all([
      controlRequest("/api/control/admin/agent-versions"),
      controlRequest("/api/control/admin/resources"),
      controlRequest("/api/account-client/api/admin/users"),
    ]);
    const nextRows = local.versions as AdminAgentVersionRow[];
    const nextResources = central.resources as Publication[];
    setRows(nextRows); setResources(nextResources); setUsers(accounts.users);
    const row = nextRows.find(item => item.rootAgentId === agentId || item.publishedAgentId === agentId || item.draftAgentId === agentId || agentId.startsWith(`admin_${item.resourceId.replaceAll("-", "").slice(0, 12)}_v`));
    const resource = nextResources.find(item => item.id === row?.resourceId);
    setAudience(resource?.audience ?? []);
    if (resource) setHistory((await controlRequest(`/api/control/admin/resources/${resource.id}/history`)).versions);
    else setHistory([]);
    onEditable(!row || row.draftAgentId === agentId);
  }, [agentId, onEditable]);
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "读取版本失败")); }, [load]);
  const row = rows.find(item => item.rootAgentId === agentId || item.publishedAgentId === agentId || item.draftAgentId === agentId || agentId.startsWith(`admin_${item.resourceId.replaceAll("-", "").slice(0, 12)}_v`));
  const resource = resources.find(item => item.id === row?.resourceId);
  const draft = useMemo(() => publicAgentDraft(agentId, data, resource), [agentId, data, resource]);
  const published = history[0]?.body;
  const hasDraftChanges = !!resource && (JSON.stringify({ name: resource.name, description: resource.description, payload: resource.payload }) !== JSON.stringify({ name: draft.name, description: draft.description, payload: draft.payload }) || JSON.stringify(resource.audience) !== JSON.stringify(audience));
  const sameAsPublished = !!published && JSON.stringify({ kind: published.kind, name: published.name, description: published.description, payload: published.payload, audience: published.audience }) === JSON.stringify({ ...draft, audience });
  const editable = !row || row.draftAgentId === agentId;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "版本操作失败"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const body = { ...draft, audience, ...(resource ? { revision: resource.revision } : {}) };
    const saved = await controlRequest(`/api/control/admin/resources${resource ? `/${resource.id}` : ""}`, resource ? "PUT" : "POST", body) as Publication;
    if (!row) await controlRequest("/api/control/admin/agent-versions", "PUT", { resourceId: saved.id, rootAgentId: agentId, publishedAgentId: "", draftAgentId: agentId, publishedVersion: 0 });
    setValidated(false); setNotice(`v${saved.version + 1} 的发布草稿已保存；已发布版本未改变。`);
    await load();
  };
  const attach = async () => {
    const selected = resources.find(item => item.id === attachId && item.kind === "agents");
    if (!selected || rows.some(item => item.resourceId === selected.id)) throw new Error("该模板已关联其他本机智能体。");
    await controlRequest("/api/control/admin/agent-versions", "PUT", { resourceId: selected.id, rootAgentId: agentId,
      publishedAgentId: "", draftAgentId: agentId, publishedVersion: selected.version });
    await load();
  };
  const addVersion = async () => {
    if (!row || !resource || row.draftAgentId) return;
    const nextId = adminVersionAgentId(resource.id, resource.version + 1);
    const existing = await api.listAgents(projectId, null);
    if (existing.agents.some(item => item.agentId === nextId)) throw new Error("下一版本的本机工作副本已存在，请先检查，不会覆盖它。");
    const response = await fetch(api.agentExportUrl(projectId, agentId, null), { credentials: "same-origin" });
    if (!response.ok) throw new Error("导出当前版本失败，未创建新版本。");
    const file = new File([await response.blob()], `${agentId}.tar.gz`);
    await api.createAgent(projectId, { agentId: nextId, dataBase64: await fileToBase64(file) }, null);
    await controlRequest("/api/control/admin/agent-versions", "PUT", { resourceId: resource.id, rootAgentId: row.rootAgentId,
      publishedAgentId: row.publishedAgentId, draftAgentId: nextId, publishedVersion: row.publishedVersion });
    navigate(`/agents/${nextId}`);
  };
  const publish = async () => {
    if (!row || !resource || row.draftAgentId !== agentId || hasDraftChanges || sameAsPublished || !validated) return;
    const updated = await controlRequest(`/api/control/admin/resources/${resource.id}/publish`, "POST", { revision: resource.revision }) as Publication;
    await controlRequest("/api/control/admin/agent-versions", "PUT", { resourceId: resource.id, rootAgentId: row.rootAgentId,
      publishedAgentId: agentId, draftAgentId: "", publishedVersion: updated.version });
    onEditable(false); setValidated(false); setNotice(`v${updated.version} 已发布。用户端会看到更新提示。`);
    await load();
  };
  return <section className="mb-5 rounded-lg border border-[var(--border)] p-4" aria-label="智能体版本管理">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><strong>版本管理</strong><p className="text-sm opacity-70">{row ? editable ? `正在编辑 v${(resource?.version ?? row.publishedVersion) + 1} 工作副本` : `已发布 v${row.publishedVersion} · 当前版本只读` : "本机智能体尚未关联公共版本"}</p></div>
      <div className="flex flex-wrap gap-2">{editable && <Button size="sm" disabled={busy} onClick={() => void run(save)}>保存发布草稿</Button>}{row && !editable && row.publishedAgentId === agentId && <Button size="sm" disabled={busy} onClick={() => void run(addVersion)}>添加版本</Button>}{row?.draftAgentId && row.draftAgentId !== agentId && <Button size="sm" onClick={() => navigate(`/agents/${row.draftAgentId}`)}>打开 v{(resource?.version ?? 0) + 1} 工作副本</Button>}</div></div>
    {editable && <><details className="mt-3 text-sm"><summary>查看待发布内容与授权</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(draft, null, 2)}</pre><fieldset className="mt-3"><legend>授权用户</legend><label className="mr-4"><input type="checkbox" checked={audience.includes("*")} onChange={event => setAudience(event.target.checked ? ["*"] : [])} />全部用户</label>{!audience.includes("*") && users.filter(user => !user.isAdmin).map(user => <label className="mr-4" key={user.userId}><input type="checkbox" checked={audience.includes(user.userId)} onChange={event => setAudience(event.target.checked ? [...audience, user.userId] : audience.filter(id => id !== user.userId))} />{user.userId}</label>)}</fieldset></details>
      {row && resource && <div className="mt-3 flex flex-wrap items-center gap-3"><label className="text-sm"><input type="checkbox" checked={validated} onChange={event => setValidated(event.target.checked)} />已在本机工作副本完成调试</label><Button size="sm" disabled={busy || hasDraftChanges || sameAsPublished || !validated} onClick={() => void run(publish)}>发布 v{resource.version + 1}</Button>{hasDraftChanges && <small>先保存当前配置为发布草稿</small>}{sameAsPublished && <small>公开内容与上一版相同，无需重复发布</small>}</div>}</>}
    {!row && resources.some(item => item.kind === "agents" && !rows.some(mapped => mapped.resourceId === item.id)) && <div className="mt-4 text-sm"><label>关联已有公共模板 <select className="ml-2 rounded border bg-transparent p-1" value={attachId} onChange={event => setAttachId(event.target.value)}><option value="">请选择</option>{resources.filter(item => item.kind === "agents" && !rows.some(mapped => mapped.resourceId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label><Button size="sm" disabled={!attachId || busy} onClick={() => void run(attach)}>关联</Button></div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}{notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>;
}
