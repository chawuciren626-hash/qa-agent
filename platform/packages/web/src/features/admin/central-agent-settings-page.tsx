import { ProfessionalAgentPluginTab } from "./professional-agent-plugin-tab";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { AgentConfigResponse, AgentConfigUpdateRequest } from "@prismshadow/penguin-server/api";
import { Button, ConfirmModal, CopyButton, HelpFold, HiddenFileInput, Input, Modal, PageFrame, PageHeader, SettingsEmpty, Skeleton, Textarea, ToggleRow } from "@prismshadow/penguin-ui";
import { CentralAgentComponentTab } from "./central-agent-component-tabs";
import { agentDescription } from "./agent-description";
import { controlRequest } from "../../api/control";
import { S } from "../../lib/strings";
import { PromptTab, RuntimeTab, ToolsTab } from "../agents/agent-settings-page";
import { SNAPSHOT_BUTTON_CLASS } from "../agents/snapshot-file";
import "../agents/agent-settings-page.css";

type TabKey = "plugins" | "overview" | "prompt" | "runtime" | "tools" | "skills" | "hooks" | "workbenches" | "memory" | "vault" | "schedules" | "api";
interface Resource { id: string; kind: string; name: string; description: string; payload: Record<string, unknown>; audience: string[]; revision: number; version: number; published: boolean; hasWorkCopy?: boolean }
interface Version { version: number; body: { name: string; description: string; payload: Record<string, unknown>; audience: string[] } }
interface Entry { name: string; value?: string; updatedAt: string }
interface Defaults { skills?: {enabled:boolean;prompt:string}; hooks?:{enabled:boolean}; prompt: string; maxTurns?: number; model?: AgentConfigResponse["config"]["model"]; compaction?: AgentConfigResponse["config"]["compaction"]; toolsBuiltin: AgentConfigResponse["config"]["toolsBuiltin"]; kernelVersion?: string }
const tabs: { key: TabKey; label: () => string }[] = [
  { key: "overview", label: () => S.agent.tabOverview }, { key: "prompt", label: () => S.agent.tabPrompt },
  { key: "runtime", label: () => S.agent.tabRuntime }, { key: "tools", label: () => S.agent.tabTools },
  { key: "plugins", label: () => "插件" },
  { key: "skills", label: () => S.agent.tabSkills }, { key: "hooks", label: () => S.agent.tabHooks },
  { key: "workbenches", label: () => S.agent.tabWorkbenches }, { key: "memory", label: () => S.agent.tabMemory },
  { key: "vault", label: () => S.agent.tabVault }, { key: "schedules", label: () => S.agent.tabSchedules },
  { key: "api", label: () => S.agent.tabApi },
];
function configOf(body: Resource | Version["body"], version: number, defaults: Defaults, directory: string): AgentConfigResponse {
  const payload = body.payload;
  const model = payload.model as Record<string, unknown> | undefined;
  const compaction = payload.compaction as Record<string, unknown> | undefined;
  return {
    agentsMd: String(payload.agentsMd ?? ""), systemConfigYaml: "", stateDir: directory, activeSessionCount: 0,
    config: { name: body.name, description: agentDescription(body), version, kernelVersion: typeof payload.kernelVersion === "string" ? payload.kernelVersion : null, kernelLatest: defaults.kernelVersion ?? "", kernelOutdated: typeof payload.kernelVersion !== "string" || payload.kernelVersion < (defaults.kernelVersion ?? ""),
      systemPrompt: String(payload.prompt ?? ""), maxTurns: typeof payload.maxTurns === "number" ? payload.maxTurns : defaults.maxTurns,
      model: { ...defaults.model, ...model } as AgentConfigResponse["config"]["model"],
      compaction: { ...defaults.compaction, ...compaction } as AgentConfigResponse["config"]["compaction"],
      toolsBuiltin: (Array.isArray(payload.toolsBuiltin) ? payload.toolsBuiltin : defaults.toolsBuiltin) as AgentConfigResponse["config"]["toolsBuiltin"], mcpServers: [],
      memory: { enabled: true, prompt: "", workspacePrompt: "" }, vault: { enabled: true, prompt: "", templateHasPlaceholder: false, legacySectionPresent: false },
      skills: { enabled: true, prompt: "", ...defaults.skills, ...(payload.skills as {enabled?:boolean;prompt?:string}|undefined), templateHasPlaceholder: String(payload.prompt??"").includes("{{SKILLS}}"), legacySectionPresent: false },
      schedules: { enabled: true, prompt: "", templateHasPlaceholder: false }, hooks: { enabled: true, ...defaults.hooks, ...(payload.hooks as {enabled?:boolean}|undefined) },
    },
  };
}

export function CentralAgentSettingsPage() {
  const navigate = useNavigate();
  const { agentId: resourceId = "" } = useParams<{ agentId: string }>();
  const [params, setParams] = useSearchParams();
  const requestedVersion = "current";
  const tab: TabKey = tabs.some(item => item.key === params.get("tab")) ? params.get("tab") as TabKey : "overview";
  const [resource, setResource] = useState<Resource | null>(null);
  const [publishedCatalog, setPublishedCatalog] = useState<Resource[]>([]);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const viewingDraft = !resource?.published;
  const editable = true;
  const effectiveVersion = resource?.version ?? 0;
  const load = useCallback(async () => {
    const [found, published, defaultData, storage] = await Promise.all([
      controlRequest(`/api/control/admin/agents/${encodeURIComponent(resourceId)}/live`),
      controlRequest("/api/control/catalog"),
      controlRequest("/api/control/admin/agent-defaults"),
      controlRequest(`/api/control/admin/resources/${encodeURIComponent(resourceId)}/storage`).catch(() => ({directory:""})),
    ]);
    if (!found) throw new Error("内置智能体不存在。");
    setResource(found); setPublishedCatalog(published.resources as Resource[]); setDefaults(defaultData as Defaults); setDirectory(String(storage.directory ?? ""));
  }, [resourceId]);
  useEffect(() => { setLoading(true); void load().catch(cause => setError(cause instanceof Error ? cause.message : "读取配置失败")).finally(() => setLoading(false)); }, [load]);
  const selectedBody = resource;
  const selected = useMemo(() => selectedBody ? { ...selectedBody, description: agentDescription(selectedBody) } : null, [selectedBody]);
  const data = useMemo(() => selected && defaults ? configOf(selected, effectiveVersion, defaults, directory) : null, [selected, effectiveVersion, defaults, directory]);
  const save = useCallback(async (update: AgentConfigUpdateRequest): Promise<AgentConfigResponse | null> => {
    if (!resource || !editable) return null;
    setBusy(true); setError("");
    try {
      const config = update.config;
      const payload = { ...resource.payload,
        ...(update.agentsMd === undefined ? {} : { agentsMd: update.agentsMd }),
        ...(config?.systemPrompt === undefined ? {} : { prompt: config.systemPrompt }),
        ...(config?.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
        ...(config?.model === undefined ? {} : { model: { ...(resource.payload.model as Record<string, unknown> | undefined), ...config.model } }),
        ...(config?.compaction === undefined ? {} : { compaction: { ...(resource.payload.compaction as Record<string, unknown> | undefined), ...config.compaction } }),
        ...(config?.skills === undefined ? {} : { skills: { ...(resource.payload.skills as object ?? {}), ...config.skills } }),
        ...(config?.hooks === undefined ? {} : { hooks: { ...(resource.payload.hooks as object ?? {}), ...config.hooks } }),
        ...(config?.toolsBuiltin === undefined ? {} : { toolsBuiltin: config.toolsBuiltin }),
      };
      const result = await controlRequest(`/api/control/admin/agents/${resourceId}/live`, "PUT", {
        kind: "agents", name: config?.name ?? resource.name, description: config?.description ?? resource.description,
        payload, audience: resource.audience, revision: resource.revision,
      }) as Resource;
      setResource(result);
      return configOf(result, result.version, defaults!, directory);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); return null; }
    finally { setBusy(false); }
  }, [resource, editable, resourceId, defaults, directory]);
  const saveReferences = async (key: "skillResources" | "pluginResources", ids: string[]) => {
    if (!resource || !editable) return;
    setBusy(true); setError("");
    try {
      const result = await controlRequest(`/api/control/admin/agents/${resourceId}/live`, "PUT", {
        kind: "agents", name: resource.name, description: resource.description,
        payload: { ...resource.payload, [key]: ids }, audience: resource.audience, revision: resource.revision,
      }) as Resource;
      setResource(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); throw cause; }
    finally { setBusy(false); }
  };
  const updateKernel = async (reset: boolean) => {
    if (!resource || !editable) return;
    setBusy(true); setError("");
    try {
      const result = await controlRequest(`/api/control/admin/resources/${resourceId}/kernel-update`, "POST", { revision: resource.revision, reset }) as Resource;
      setResource(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "内核更新失败"); }
    finally { setBusy(false); }
  };
  const importSnapshot = async (snapshot: unknown) => {
    if (!resource || !editable) return;
    setBusy(true); setError("");
    try {
      const result = await controlRequest(`/api/control/admin/resources/${resourceId}/snapshot`, "POST", { revision: resource.revision, snapshot }) as Resource;
      setResource(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导入快照失败"); }
    finally { setBusy(false); }
  };
  const switchTab = (next: TabKey) => setParams(previous => { const result = new URLSearchParams(previous); result.set("tab", next); return result; }, { replace: true });
  if (loading) return <div className="space-y-3 p-6"><Skeleton className="h-6 w-64" /><Skeleton className="h-32 w-full" /></div>;
  if (error && !resource) return <p role="alert" className="p-6 text-sm text-red-600">{error}</p>;
  if (!resource || !selected || !data) return <p role="alert" className="p-6 text-sm text-red-600">智能体不存在。</p>;
  const payload = selected.payload;
  const entries = (key: string): string[] => Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
  return <PageFrame width="full" className="agent-settings-frame relative" contentClassName="agent-settings-content">
    <PageHeader title={selected.name} back={{ label: S.agent.backToList, onClick: () => navigate("/agents") }} description={<span className="block font-mono text-xs text-gray-400">{String(payload.agentId ?? resourceId)} · {resource.published ? "已发布" : "待发布"}</span>} />
    <div className="agent-settings-columns"><nav className="agent-settings-nav" role="tablist" aria-orientation="vertical" aria-label={S.agent.settings}>{tabs.map(item => <button key={item.key} id={`agent-settings-tab-${item.key}`} type="button" role="tab" aria-selected={tab === item.key} aria-controls="agent-settings-panel" onClick={() => switchTab(item.key)} className={`agent-settings-nav-item${tab === item.key ? " active" : ""}`}><span>{item.label()}</span></button>)}</nav>
      <div id="agent-settings-panel" role="tabpanel" aria-labelledby={`agent-settings-tab-${tab}`} className="agent-settings-panel">
        {tab === "overview" && <CentralOverview body={selected} data={data} resource={resource} editable={editable} busy={busy} save={save} updateKernel={updateKernel} importSnapshot={importSnapshot} snapshotVersion={viewingDraft ? "draft" : String(effectiveVersion)} />}
        {tab === "prompt" && <fieldset disabled={!editable}><PromptTab key={`${resourceId}:${requestedVersion}`} data={data} onSave={save} /></fieldset>}
        {tab === "runtime" && <fieldset disabled={!editable}><RuntimeTab key={`${resourceId}:${requestedVersion}`} data={data} onSave={save} projectId="" /></fieldset>}
        {tab === "tools" && <fieldset disabled={!editable}><ToolsTab key={`${resourceId}:${requestedVersion}`} data={data} onSave={save} /></fieldset>}
        {(tab === "skills" || tab === "hooks") && <CentralAgentComponentTab key={`${resourceId}:${requestedVersion}:${tab}`} resourceId={resourceId} version={viewingDraft?"draft":String(effectiveVersion)} feature={tab} data={data} editable={editable} catalog={publishedCatalog} onSave={save} selectedIds={entries(tab === "skills"?"skillResources":"pluginResources")} onChange={ids=>saveReferences(tab === "skills"?"skillResources":"pluginResources",ids)} />}
        {tab === "plugins" && <ProfessionalAgentPluginTab resourceId={resourceId} onChanged={load} />}
        {tab === "workbenches" && <div className="space-y-4"><HelpFold label={S.agent.tabWorkbenches}>{S.workbenches.agentTabDesc}</HelpFold><SettingsEmpty>{S.workbenches.empty}</SettingsEmpty></div>}
        {tab === "memory" && <CentralPrivateEntries resourceId={resourceId} kind="memory" />}
        {tab === "vault" && <CentralPrivateEntries resourceId={resourceId} kind="vault" />}
        {tab === "schedules" && <div className="space-y-4"><HelpFold label={S.agent.tabSchedules}>{S.schedule.desc}</HelpFold><ToggleRow variant="card" label={S.agent.tabSchedules} checked={false} onChange={() => {}} disabled /><div className="flex justify-end gap-2"><Button size="sm" disabled>用 AI 创建</Button><Button size="sm" disabled>手动设置</Button></div><SettingsEmpty>{S.schedule.empty}</SettingsEmpty></div>}
        {tab === "api" && <div className="space-y-6"><div className="space-y-2"><ToggleRow variant="card" label={S.agent.apiEnable} info={S.agent.apiEnableHint} checked={false} onChange={() => {}} disabled /><p className="text-xs text-fg-muted">{S.agent.apiAdminOff}</p></div></div>}
      </div>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
  </PageFrame>;
}

function CentralOverview({ body, data, resource, editable, busy, save, updateKernel, importSnapshot, snapshotVersion }: { body: Resource | Version["body"]; data: AgentConfigResponse; resource: Resource; editable: boolean; busy: boolean; save: (update: AgentConfigUpdateRequest) => Promise<AgentConfigResponse | null>; updateKernel: (reset: boolean) => Promise<void>; importSnapshot: (snapshot: unknown) => Promise<void>; snapshotVersion: string }) {
  const [name, setName] = useState(body.name);
  const [description, setDescription] = useState(body.description);
  const [kernelAction, setKernelAction] = useState<"update" | "reset" | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<unknown | null>(null);
  const [importError, setImportError] = useState("");
  useEffect(() => { setName(body.name); setDescription(body.description); }, [body.name, body.description]);
  return <div className="space-y-4">
    <Input size="sm" label={S.common.name} value={name} disabled={!editable} onChange={event => setName(event.target.value)} />
    <Textarea label={S.agent.description} size="sm" rows={3} value={description} disabled={!editable} onChange={event => setDescription(event.target.value)} />
    {editable && <div className="flex items-center gap-2"><Button size="sm" variant="primary" disabled={busy || (!name.trim()) || (name === body.name && description === body.description)} onClick={() => void save({ config: { name: name.trim(), description: description.trim() } })}>{S.common.save}</Button><Button size="sm" disabled={busy || (name === body.name && description === body.description)} onClick={() => { setName(body.name); setDescription(body.description); }}>{S.common.reset}</Button></div>}
    <section className="border-t border-gray-200 pt-4 dark:border-gray-800"><div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><p className="text-sm font-medium">{S.agent.stateTitle}</p><div className="flex shrink-0 items-center gap-2"><a href={`/api/control/admin/resources/${encodeURIComponent(resource.id)}/snapshot?version=${encodeURIComponent(snapshotVersion)}`} download className={SNAPSHOT_BUTTON_CLASS}>{S.agent.exportSnapshot}</a>{editable && <label className={`${SNAPSHOT_BUTTON_CLASS} ${busy ? "pointer-events-none opacity-60" : ""}`}><HiddenFileInput accept=".json,application/json" disabled={busy} onChange={event => { const file=event.target.files?.[0];event.target.value="";if(!file)return;setImportError("");if(file.size>1024*1024){setImportError("内置配置快照不能超过 1 MB。");return;}void file.text().then(text=>{setPendingSnapshot(JSON.parse(text));}).catch(()=>setImportError("快照 JSON 格式无效。")); }} />{S.agent.importSnapshot}</label>}</div></div><div className="mt-3 space-y-3"><div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">配置状态</p><p className="mt-0.5 font-mono text-sm font-semibold">{resource.published ? "已发布" : "待发布"}</p></div><div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">{S.agent.stateDir}</p><div className="flex items-start gap-1.5"><span className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{data.stateDir || "内置目录暂不可用"}</span>{data.stateDir && <CopyButton text={data.stateDir} label={S.agent.copyStateDir} size="sm" className="shrink-0" />}</div></div></div>{importError && <p role="alert" className="mt-2 text-xs text-red-600">{importError}</p>}</section>
    <section className="border-t border-gray-200 pt-4 dark:border-gray-800"><div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><p className="text-sm font-medium">{S.agent.kernelTitle}</p><div className="flex shrink-0 items-center gap-2"><Button size="sm" disabled={!editable || busy || !data.config.kernelOutdated} onClick={() => setKernelAction("update")}>{S.agent.kernelUpdateAction}</Button><Button size="sm" variant="danger" disabled={!editable || busy} onClick={() => setKernelAction("reset")}>{S.agent.resetConfigAction}</Button></div></div><p className="mt-2.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm"><span className="font-mono font-semibold">{data.config.kernelVersion ?? S.agent.kernelLegacy}</span><span className="text-xs text-gray-500 dark:text-gray-400">· {data.config.kernelOutdated ? `最新 ${data.config.kernelLatest}` : S.agent.kernelUpToDate}</span></p></section>
    <ConfirmModal open={kernelAction !== null} title={kernelAction === "reset" ? S.agent.resetConfigAction : S.agent.kernelUpdateAction} tone="primary" busy={busy} confirmLabel={kernelAction === "reset" ? S.agent.resetConfigAction : S.agent.kernelUpdateAction} cancelLabel={S.common.cancel} onClose={() => setKernelAction(null)} onConfirm={() => { void updateKernel(kernelAction === "reset").then(() => setKernelAction(null)); }}><p className="text-sm">{kernelAction === "reset" ? "将智能体的提示词、运行参数和工具恢复为内置当前内核默认值。" : "将未覆盖的配置补齐为内置当前内核默认值，并保留已配置的内容。"}</p></ConfirmModal>
    <ConfirmModal open={pendingSnapshot !== null} title={S.agent.importSnapshot} tone="primary" busy={busy} confirmLabel={S.agent.importSnapshot} cancelLabel={S.common.cancel} onClose={() => setPendingSnapshot(null)} onConfirm={() => { if(pendingSnapshot!==null)void importSnapshot(pendingSnapshot).then(()=>setPendingSnapshot(null)); }}><p className="text-sm">导入内置公开配置快照将替换当前配置；记忆和密钥不在快照内。</p></ConfirmModal>
  </div>;
}

function CentralPrivateEntries({ resourceId, kind }: { resourceId: string; kind: "memory" | "vault" }) {
  const [scope, setScope] = useState<"user" | "project">("user");
  const [projectId, setProjectId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/control/private/agents/${encodeURIComponent(resourceId)}/${kind}`;
  const validScope = scope === "user" || /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(projectId);
  const load = useCallback(async () => { if (!validScope) { setEntries([]); return; } const query = new URLSearchParams({ scope, ...(scope === "project" ? { projectId } : {}) }); const result = await controlRequest(`${path}?${query}`); setEntries(result.entries); }, [path, scope, projectId, validScope]);
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "读取失败")); }, [load]);
  const act = async (method: "PUT" | "DELETE", entryName: string, entryValue?: string) => { setBusy(true); setError(""); try { await controlRequest(path, method, { scope, ...(scope === "project" ? { projectId } : {}), name: entryName, ...(entryValue === undefined ? {} : { value: entryValue }) }); await load(); setName(""); setValue(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); } finally { setBusy(false); } };
  return <div className="space-y-4"><div className="flex flex-wrap gap-3 text-sm"><label><input type="radio" checked={scope === "user"} onChange={() => setScope("user")} /> 用户范围</label><label><input type="radio" checked={scope === "project"} onChange={() => setScope("project")} /> 项目范围</label></div>{scope === "project" && <Input size="sm" label="项目 ID" value={projectId} onChange={event => setProjectId(event.target.value)} />}
    <div className="overflow-x-auto overflow-y-clip rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"><table className="w-full min-w-[420px] text-left text-sm"><thead><tr className="border-b border-gray-200 bg-gray-50/80 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900"><th className="px-3 py-2.5">{kind === "vault" ? "密钥" : "记忆"}</th><th className="px-3 py-2.5">{kind === "vault" ? "值" : "内容"}</th><th className="px-3 py-2.5" /></tr></thead><tbody>{entries.map(entry => <tr key={entry.name} className="border-b border-gray-100 last:border-b-0"><td className="px-3 py-2 font-mono text-xs">{entry.name}</td><td className="px-3 py-2 text-xs text-gray-500">{kind === "vault" ? "••••••" : entry.value}</td><td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(`删除「${entry.name}」？`)) void act("DELETE", entry.name); }}>删除</Button></td></tr>)}</tbody></table>{entries.length === 0 && <p className="p-3 text-sm text-gray-500">暂无数据</p>}</div>
    <Input size="sm" label={kind === "vault" ? "密钥名称" : "记忆名称"} value={name} onChange={event => setName(event.target.value)} />{kind === "vault" ? <Input size="sm" label="密钥值" type="password" value={value} onChange={event => setValue(event.target.value)} /> : <Textarea size="sm" label="记忆内容" rows={6} value={value} onChange={event => setValue(event.target.value)} />}
    <Button size="sm" variant="primary" disabled={busy || !validScope || !name.trim()} onClick={() => void act("PUT", name.trim(), value)}>保存</Button>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}
