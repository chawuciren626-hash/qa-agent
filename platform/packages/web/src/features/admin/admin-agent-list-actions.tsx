import { useState } from "react";
import { Button, Modal } from "@prismshadow/penguin-ui";
import type { AgentSummary } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { controlRequest } from "../../api/control";
import { fileToBase64 } from "../agents/snapshot-file";
import type { Publication } from "./publications-page";
import { adminVersionAgentId, publicAgentDraft } from "./admin-agent-versions";
import type { AdminAgentVersionRow } from "./admin-agent-versions";

export function AdminAgentListActions({ projectId, agent, row, stageId, onChanged }: {
  projectId: string;
  agent: AgentSummary;
  row?: AdminAgentVersionRow;
  stageId: string;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<string[]>([]);
  const [users, setUsers] = useState<{ userId: string; isAdmin: boolean }[]>([]);
  const [preview, setPreview] = useState<ReturnType<typeof publicAgentDraft> | null>(null);
  const [validated, setValidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isDraft = !row || row.draftAgentId === agent.agentId;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const openPublish = () => void run(async () => {
    if (!isDraft) throw new Error("只有未发布版本可以发布。");
    const [config, catalog, accounts] = await Promise.all([
      api.getAgentConfig(projectId, agent.agentId, null),
      controlRequest("/api/control/admin/resources"),
      controlRequest("/api/account-client/api/admin/users"),
    ]);
    const existing = (catalog.resources as Publication[]).find(item => item.id === row?.resourceId);
    setAudience(existing?.audience ?? []);
    setUsers(accounts.users ?? []);
    setPreview(publicAgentDraft(row?.rootAgentId ?? agent.agentId, config, existing));
    setValidated(false);
    setOpen(true);
  });
  const publish = () => void run(async () => {
    if (!preview || !validated) return;
    const catalog = await controlRequest("/api/control/admin/resources");
    const current = (catalog.resources as Publication[]).find(item => item.id === row?.resourceId);
    if (row && (!current || current.kind !== "agents" || current.version !== row.publishedVersion)) {
      throw new Error("本机版本记录与内置发布版本不一致，请先核对版本来源；未发布旧工作副本。");
    }
    // Read again at publication time so edits made while the dialog was open are included.
    const config = await api.getAgentConfig(projectId, agent.agentId, null);
    const body = { ...publicAgentDraft(row?.rootAgentId ?? agent.agentId, config, current), audience,
      ...(current ? { revision: current.revision } : {}) };
    const checked = await controlRequest("/api/control/admin/resources/validate", "POST", body);
    if (checked.valid !== true || (Array.isArray(checked.warnings) && checked.warnings.length)) {
      throw new Error(checked.error?.message ?? checked.warnings?.join("；") ?? "内置配置校验未通过。");
    }
    const saved = await controlRequest(`/api/control/admin/resources${current ? `/${current.id}` : ""}`, current ? "PUT" : "POST", body) as Publication;
    if (!row) await controlRequest("/api/control/admin/agent-versions", "PUT", {
      resourceId: saved.id, rootAgentId: agent.agentId, publishedAgentId: "", draftAgentId: agent.agentId, publishedVersion: 0,
    });
    const storedCheck = await controlRequest(`/api/control/admin/resources/${saved.id}/validate`, "POST");
    if (storedCheck.valid !== true || (Array.isArray(storedCheck.warnings) && storedCheck.warnings.length)) {
      throw new Error(storedCheck.error?.message ?? storedCheck.warnings?.join("；") ?? "内置草稿校验未通过。");
    }
    const published = await controlRequest(`/api/control/admin/resources/${saved.id}/publish`, "POST", { revision: saved.revision }) as Publication;
    await controlRequest("/api/control/admin/agent-versions", "PUT", {
      resourceId: saved.id, rootAgentId: row?.rootAgentId ?? agent.agentId,
      publishedAgentId: agent.agentId, draftAgentId: "", publishedVersion: published.version,
    });
    setOpen(false);
    await onChanged();
  });
  const copy = () => void run(async () => {
    if (!row || !row.publishedAgentId || row.draftAgentId) throw new Error("请先发布当前工作副本。");
    const catalog = await controlRequest("/api/control/catalog");
    const current = (catalog.resources as Publication[]).find(item => item.id === row.resourceId);
    if (!current || current.kind !== "agents" || !current.published || current.version !== row.publishedVersion) {
      throw new Error("本机已发布副本与内置当前版本不一致，请先完成版本来源核对；不会复制旧 Agent State。");
    }
    const local = await api.getAgentConfig(projectId, row.publishedAgentId, null);
    if (local.config.systemPrompt !== current.payload.prompt || local.agentsMd !== current.payload.agentsMd) {
      throw new Error("本机已发布副本的提示词与内置当前版本不同；不会将旧内容复制为新版本。");
    }
    const nextId = adminVersionAgentId(row.resourceId, row.publishedVersion + 1);
    const existing = await api.listAgents(projectId, null);
    if (existing.agents.some(item => item.agentId === nextId)) throw new Error("下一版本工作副本已存在，未覆盖原有内容。");
    const response = await fetch(api.agentExportUrl(projectId, row.publishedAgentId, null), { credentials: "same-origin" });
    if (!response.ok) throw new Error("导出上一版本失败。");
    const snapshot = new File([await response.blob()], `${row.publishedAgentId}.tar.gz`);
    await api.createAgent(projectId, { agentId: nextId, dataBase64: await fileToBase64(snapshot) }, null);
    await controlRequest("/api/control/admin/agent-stages/assign", "PUT", { agentId: nextId, stageId });
    await controlRequest("/api/control/admin/agent-versions", "PUT", {
      resourceId: row.resourceId, rootAgentId: row.rootAgentId,
      publishedAgentId: row.publishedAgentId, draftAgentId: nextId, publishedVersion: row.publishedVersion,
    });
    await onChanged();
  });
  return <>
    {isDraft && <Button size="sm" disabled={busy} onClick={openPublish}>发布</Button>}
    {row && row.publishedAgentId === agent.agentId && <Button size="sm" disabled={busy || !!row.draftAgentId} title={row.draftAgentId ? "请先完成当前未发布版本" : undefined} onClick={copy}>复制</Button>}
    {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    {open && preview && <Modal open title={`发布 v${(row?.publishedVersion ?? 0) + 1}`} onClose={() => { if (!busy) setOpen(false); }} footer={<><Button size="sm" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button size="sm" variant="primary" disabled={busy || !validated} onClick={publish}>确认发布</Button></>}>
      <p className="mb-3 text-sm">仅发布以下公开配置；本机 Agent State、凭据和调试记录不会上传。</p>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-xs">{JSON.stringify(preview, null, 2)}</pre>
      <fieldset className="mt-3 text-sm"><legend>授权用户</legend><label className="mr-3"><input type="checkbox" checked={audience.includes("*")} onChange={event => setAudience(event.target.checked ? ["*"] : [])} /> 全部用户</label>{!audience.includes("*") && users.filter(user => !user.isAdmin).map(user => <label key={user.userId} className="mr-3"><input type="checkbox" checked={audience.includes(user.userId)} onChange={event => setAudience(event.target.checked ? [...audience, user.userId] : audience.filter(id => id !== user.userId))} /> {user.userId}</label>)}</fieldset>
      <label className="mt-4 block text-sm"><input type="checkbox" checked={validated} onChange={event => setValidated(event.target.checked)} /> 已在本机完成调试并确认发布内容</label>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </Modal>}
  </>;
}
