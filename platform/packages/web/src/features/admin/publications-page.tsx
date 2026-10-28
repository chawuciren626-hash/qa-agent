import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import { Button, Modal, PageFrame, PageHeader, toastError } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import * as api from "../../api/endpoints";
import { useAuth } from "../../state/auth";
import { useProject } from "../../state/project";
import type { ManagedKind, ManagedResource } from "../../lib/managed-resources";
import { agentPublication, modelPublication, pluginPublication } from "./publication-source";

export const RESOURCE_NAMES: Record<ManagedKind, string> = { agents: "智能体", models: "模型", plugins: "插件", skills: "技能" };
export interface Publication extends ManagedResource { audience: string[]; revision: number; published: boolean }
interface User { userId: string; isAdmin: boolean }

/** Publication metadata only. Authoring remains in the upstream feature pages. */
export function PublicationsPage({ central = false, resourceKind }: { central?: boolean; resourceKind?: ManagedKind }) {
  const params = useParams();
  const kind = resourceKind ?? params.kind as ManagedKind;
  const { accountClient } = useAuth();
  const [resources, setResources] = useState<Publication[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Publication | null>(null);
  const [choosing, setChoosing] = useState<Publication | "new" | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [catalog, accounts] = await Promise.all([
      controlRequest("/api/control/admin/resources"),
      controlRequest((accountClient ? "/api/account-client" : "") + "/api/admin/users"),
    ]);
    setResources(catalog.resources); setUsers(accounts.users);
  }, [accountClient]);
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, [load]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  if (!(kind in RESOURCE_NAMES)) return <PageFrame>未知发布类型。</PageFrame>;
  return <PageFrame><PageHeader title={`${RESOURCE_NAMES[kind]}授权与发布`} description="配置使用原有页面编辑；这里仅管理公共版本和使用范围。" actions={!central && <Button onClick={() => setChoosing("new")}>从本机已有配置生成草稿</Button>} />
    {central ? <p className="mb-4 text-sm opacity-70">此处为中央发布库。配置编辑请使用本机 AITestHarness 的 Web 管理入口；本机配置与密钥不会自动上传。</p> : <Link className="mb-4 inline-block underline" to={`/${kind}`}>返回{RESOURCE_NAMES[kind]}配置</Link>}
    {error && <p className="mb-4 text-red-600" role="alert">{error}</p>}
    <div className="space-y-3">{resources.filter(resource => resource.kind === kind).map(resource => <section key={resource.id} className="rounded-lg border border-[var(--border)] p-4">
      <strong>{resource.name}</strong><p className="my-2 text-sm opacity-70">{resource.description}</p>
      <p className="mb-3 text-xs">{resource.published ? "已发布" : "未发布 / 已下架"} · v{resource.version} · {resource.audience.includes("*") ? "全部用户" : resource.audience.join("、") || "仅管理员"}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setEditing(structuredClone(resource))}>授权与依赖</Button>
        {!central && <Button size="sm" onClick={() => setChoosing(resource)}>从本机配置更新草稿</Button>}
        <Button size="sm" disabled={busy} onClick={() => void act(async () => {
          if (!confirm(`发布「${resource.name}」的新版本？现有本机配置不会被自动覆盖。`)) return;
          await controlRequest(`/api/control/admin/resources/${resource.id}/publish`, "POST", { revision: resource.revision }); await load();
        })}>发布版本</Button>
        {resource.published && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
          if (!confirm("下架将停止新的获取和使用，保留已有任务与本机资料。继续？")) return;
          await controlRequest(`/api/control/admin/resources/${resource.id}/withdraw`, "POST", {}); await load();
        })}>下架</Button>}
        <Button size="sm" onClick={() => void act(async () => setHistory((await controlRequest(`/api/control/admin/resources/${resource.id}/history`)).versions))}>版本记录</Button>
      </div>
      <details className="mt-3 text-xs"><summary>查看待发布内容</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(previewPayload(resource.payload), null, 2)}</pre></details>
    </section>)}</div>
    {!resources.some(resource => resource.kind === kind) && <p className="py-8 opacity-60">尚未发布{RESOURCE_NAMES[kind]}。请先在原有功能页完成配置，再明确选择要公开的内容。</p>}
    {editing && <Modal open title="授权与依赖" onClose={() => { if (confirm("放弃本次未保存的授权编辑？")) setEditing(null); }} footer={<Button disabled={busy} onClick={() => void act(async () => {
      const { kind, name, description, payload, audience, revision } = editing;
      await controlRequest(`/api/control/admin/resources/${editing.id}`, "PUT", { kind, name, description, payload, audience, revision }); setEditing(null); await load();
    })}>保存</Button>}>
      <p className="mb-4 text-sm">授权范围保存后立即生效；依赖变化保存为草稿，发布后生效。</p>
      <label className="mb-3 flex gap-2"><input type="checkbox" checked={editing.audience.includes("*")} onChange={event => setEditing({ ...editing, audience: event.target.checked ? ["*"] : [] })} />全部用户</label>
      {!editing.audience.includes("*") && users.filter(user => !user.isAdmin).map(user => <label key={user.userId} className="mb-2 flex gap-2"><input type="checkbox" checked={editing.audience.includes(user.userId)} onChange={event => setEditing({ ...editing, audience: event.target.checked ? [...editing.audience, user.userId] : editing.audience.filter(id => id !== user.userId) })} />{user.userId}</label>)}
      {editing.kind === "agents" && <div className="mt-4 space-y-3">
        <label className="block">关联公共模型<select className="ml-2 rounded border bg-transparent p-2" value={String(editing.payload.modelResource || "")} onChange={event => setEditing({ ...editing, payload: { ...editing.payload, modelResource: event.target.value } })}><option value="">用户自行选择本机模型</option>{resources.filter(r => r.kind === "models" && r.published).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        {(["skills", "plugins"] as const).map(dependencyKind => <fieldset key={dependencyKind}><legend>关联已发布{RESOURCE_NAMES[dependencyKind]}</legend>{resources.filter(r => r.kind === dependencyKind && r.published).map(r => {
          const key = dependencyKind === "skills" ? "skillResources" : "pluginResources";
          const selected = (editing.payload[key] || []) as string[];
          return <label className="my-2 flex gap-2" key={r.id}><input type="checkbox" checked={selected.includes(r.id)} onChange={event => setEditing({ ...editing, payload: { ...editing.payload, [key]: event.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id) } })} />{r.name}</label>;
        })}</fieldset>)}
      </div>}
    </Modal>}
    {history && <Modal open title="已发布版本" onClose={() => setHistory(null)}>{history.map(version => <details key={version.version} className="mb-3"><summary>v{version.version} · {version.created_at}</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify({ ...version.body, payload: previewPayload(version.body.payload) }, null, 2)}</pre></details>)}</Modal>}
    {choosing && !central && <LocalPublicationDialog key={`${kind}:${choosing === "new" ? "new" : choosing.id}`} kind={kind} existing={choosing === "new" ? undefined : choosing} onClose={() => setChoosing(null)} onSaved={async () => { setChoosing(null); await load(); }} />}
  </PageFrame>;
}

function previewPayload(payload: Record<string, unknown>) {
  const { archiveBase64, ...visible } = payload;
  return { ...visible, ...(archiveBase64 ? { archive: "已选择的完整技能包（含附属文件）" } : {}) };
}

function LocalPublicationDialog({ kind, existing, onClose, onSaved }: { kind: ManagedKind; existing?: Publication; onClose: () => void; onSaved: () => Promise<void> }) {
  const { currentProject, agents } = useProject();
  const projectId = currentProject?.projectId;
  const [agentId, setAgentId] = useState(agents[0]?.agentId || "");
  const [options, setOptions] = useState<{ key: string; label: string; value: any }[]>([]);
  const [selected, setSelected] = useState("");
  const [prepared, setPrepared] = useState<{ name: string; description: string; payload: Record<string, unknown> } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setOptions([]); setSelected(""); setPrepared(null); setError("");
    if (!projectId) return;
    const read = async () => {
      if (kind === "agents") return agents.map(agent => ({ key: agent.agentId, label: agent.name || agent.agentId, value: agent }));
      if (kind === "models") return (await api.getModels(projectId, null)).models.map(model => ({ key: JSON.stringify([model.provider, model.modelId]), label: `${model.provider} / ${model.displayName || model.modelId}`, value: model }));
      if (kind === "plugins") return (await api.getPluginLibrary(null)).groups.flatMap(group => group.plugins).map(plugin => ({ key: plugin.name, label: `${plugin.titleZh || plugin.title || plugin.name} · ${plugin.version}`, value: plugin }));
      return agentId ? (await api.getAgentSkills(projectId, agentId, null)).skills.map(skill => ({ key: skill.name, label: skill.name, value: skill })) : [];
    };
    void read().then(values => { if (active) setOptions(values); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [projectId, kind, agentId, agents]);
  async function prepare() {
    const choice = options.find(option => option.key === selected);
    if (!choice || !projectId) return;
    setBusy(true); setError("");
    try {
      let result;
      if (kind === "agents") result = agentPublication(choice.value, await api.getAgentConfig(projectId, choice.key, null));
      else if (kind === "models") result = modelPublication(choice.value);
      else if (kind === "plugins") result = pluginPublication(choice.value);
      else {
        const [files, response] = await Promise.all([api.getAgentSkillFiles(projectId, agentId, choice.key, null), fetch(api.agentSkillArchiveUrl(projectId, agentId, choice.key, null))]);
        if (!response.ok) throw new Error("技能导出失败，请使用原有技能页检查。");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 1024 * 1024) throw new Error("公共技能包当前上限为 1 MB；原有本机导入导出不受此限制。");
        let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
        result = { name: choice.value.name, description: choice.value.description, payload: { skillName: choice.value.name, archiveBase64: btoa(binary), fileNames: Object.keys(files.files) } };
      }
      if (existing && kind === "agents") result.payload = { ...result.payload, modelResource: existing.payload.modelResource, skillResources: existing.payload.skillResources, pluginResources: existing.payload.pluginResources };
      setPrepared(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setBusy(false); }
  }
  return <Modal open title={`选择要公开的${RESOURCE_NAMES[kind]}`} onClose={() => { if (!busy && (!prepared || confirm("放弃本次尚未保存的发布草稿？"))) onClose(); }} footer={<Button disabled={!prepared || busy} onClick={async () => {
    if (!prepared || !confirm("确认将预览中的公共内容同步到中央草稿库？不会上传项目、会话、模型密钥或智能体完整状态快照。")) return;
    setBusy(true);
    try {
      await controlRequest("/api/control/admin/resources" + (existing ? "/" + existing.id : ""), existing ? "PUT" : "POST", { kind, ...prepared, audience: existing?.audience || [], ...(existing ? { revision: existing.revision } : {}) }); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }}>保存为中央草稿</Button>}>
    <p className="mb-4 text-sm opacity-70">本机项目：{currentProject?.name || projectId}。先在原有功能页面保存，再读取预览。草稿默认仅管理员可见。</p>
    {kind === "skills" && <select className="mb-3 w-full rounded border bg-transparent p-2" aria-label="发布技能的来源智能体" value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.name || agent.agentId}</option>)}</select>}
    <select className="mb-3 w-full rounded border bg-transparent p-2" aria-label="选择已有配置" value={selected} onChange={event => { setSelected(event.target.value); setPrepared(null); }}><option value="">请选择</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
    <Button size="sm" disabled={!selected || busy} onClick={() => void prepare()}>读取并预览公开内容</Button>
    {error && <p role="alert" className="my-3 text-red-600">{error}</p>}
    {kind === "agents" && <p className="my-3 text-sm">智能体仅公开名称、说明、提示词、AGENTS.md 和轮数；插件及技能通过已发布依赖单独关联。完整状态快照、记忆、工具凭据不发布。</p>}
    {kind === "plugins" && <p className="my-3 text-sm">公开已有插件的名称与版本引用。用户仍通过上游插件库获取、安装和升级，不重新打包插件实现。</p>}
    {kind === "skills" && <p className="my-3 text-sm">此操作会公开选定技能包及其附属文件，请确认其中没有个人资料或凭据。</p>}
    {prepared && <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ ...prepared, payload: previewPayload(prepared.payload) }, null, 2)}</pre>}
  </Modal>;
}
