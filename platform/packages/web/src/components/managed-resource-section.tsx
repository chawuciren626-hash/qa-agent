import { useState } from "react";
import { Button, Modal } from "@prismshadow/penguin-ui";
import { controlRequest } from "../api/control";
import { useProject } from "../state/project";
import { useManagedResources } from "../lib/use-managed-resources";
import { appliedVersion } from "../lib/managed-resources";
import type { ManagedKind } from "../lib/managed-resources";

/** An additional source within existing pages, never an upstream package updater. */
export function ManagedResourceSection({ kind, agentId: fixedAgent, onApplied }: {
  kind: ManagedKind; agentId?: string; onApplied?: () => void | Promise<void>;
}) {
  const { currentProject, agents, reloadAgents } = useProject();
  const { resources, applied, enabled, error, refresh } = useManagedResources();
  const [selectedAgent, setSelectedAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [agentPlan, setAgentPlan] = useState<{ resourceId: string; name: string; newInstall: boolean; agentId: string; fromVersion: number; toVersion: number; fields: { key: string; local: string | number | null; published: string | number | null; conflict: boolean }[] } | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, "local" | "published">>({});
  const agentId = fixedAgent ?? selectedAgent;
  const needsAgent = kind === "plugins" || kind === "skills";
  if (!enabled) return null;
  const visible = resources.filter(resource => resource.kind === kind);
  if (!visible.length && !error) return null;
  return <details className="mb-4 rounded-lg border border-[var(--border)] p-4">
    <summary className="cursor-pointer text-sm font-medium">管理员提供的{kind === "agents" ? "智能体模板" : kind === "models" ? "模型配置" : kind === "plugins" ? "插件" : "技能"} · {visible.length}</summary>
    <p className="my-3 text-sm opacity-70">来源：管理后台。新版本需手动获取；智能体、技能和插件保留本机副本，模型沿用上游供应商与模型 ID，密钥和个人地址仍留在本机。上游组件继续使用本页原有的更新入口。</p>
    {kind === "plugins" && <p className="mb-3 text-sm opacity-70">管理员发布的是上游插件名称与版本引用；安装复用本机已有插件库，升级继续使用原有插件市场。</p>}
    <div className="mb-3 flex flex-wrap gap-2">
      {needsAgent && !fixedAgent && <select aria-label="管理员配置的目标智能体" className="rounded border bg-transparent p-2 text-sm" value={selectedAgent} onChange={event => setSelectedAgent(event.target.value)}>
        <option value="">选择本机目标智能体</option>
        {agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.name || agent.agentId}</option>)}
      </select>}
      <Button size="sm" disabled={busy} onClick={() => void refresh()}>检查管理员发布版本</Button>
    </div>
    {(failure || error) && <p role="alert" className="mb-3 text-red-600">{failure || error}</p>}
    {message && <p role="status" className="mb-3 text-sm">{message}</p>}
    <div className="space-y-3">{visible.map(resource => {
      const localVersion = appliedVersion(resource, applied, needsAgent ? agentId : undefined);
      const current = localVersion >= resource.version;
      return <section key={resource.id} className="rounded border border-[var(--border)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">{resource.name}</strong><p className="text-xs opacity-70">管理员发布 v{resource.version}{localVersion ? ` · 已获取 v${localVersion}${current ? "" : " · 有新配置版本"}` : " · 尚未获取"}</p></div>
          <Button size="sm" disabled={busy || current || (needsAgent && !agentId)} onClick={async () => {
            if (!currentProject) return;
            if (kind === "agents") {
              setBusy(true); setFailure("");
              try {
                const plan = await controlRequest("/api/control/apply/preview", "POST", { resourceId: resource.id, projectId: currentProject.projectId });
                setResolutions({}); setAgentPlan({ ...plan, resourceId: resource.id, name: resource.name });
              } catch (cause) { setFailure(cause instanceof Error ? cause.message : "读取版本差异失败"); }
              finally { setBusy(false); }
              return;
            }
            if (!confirm(`获取「${resource.name}」v${resource.version} 到当前本机项目？模型会更新同一供应商和模型 ID 的公共元数据，保留本机密钥与地址；技能和插件不会覆盖个人修改。`)) return;
            setBusy(true); setFailure(""); setMessage("");
            try {
              const result = await controlRequest("/api/control/apply", "POST", { resourceId: resource.id, projectId: currentProject.projectId, ...(needsAgent ? { agentId } : {}) });
              setMessage(result.message);
              await refresh(); await reloadAgents(); await onApplied?.();
            } catch (cause) { setFailure(cause instanceof Error ? cause.message : "获取失败"); }
            finally { setBusy(false); }
          }}>{current ? "已获取此版本" : localVersion ? kind === "agents" ? "查看更新差异" : "获取新版本副本" : "获取到本机"}</Button>
        </div>
        <p className="mt-2 text-sm opacity-70">{resource.description}</p>
        {kind === "skills" && !!resource.payload.archiveBase64 && <a className="mt-2 inline-block text-xs underline" href={`/api/control/archive/${encodeURIComponent(resource.id)}`}>下载原格式技能包（在原有技能页导入并确认更新）</a>}
        <details className="mt-2 text-xs"><summary>查看配置内容</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify({ ...resource.payload, ...(resource.payload.archiveBase64 ? { archiveBase64: "完整技能包，保留原有文件结构" } : {}) }, null, 2)}</pre></details>
      </section>;
    })}</div>
    {agentPlan && <Modal open title={`${agentPlan.name} · v${agentPlan.fromVersion} → v${agentPlan.toVersion}`} onClose={() => { if (!busy) setAgentPlan(null); }} footer={<Button disabled={busy || agentPlan.fields.some(field => field.conflict && !resolutions[field.key])} onClick={async () => {
      if (!currentProject) return;
      setBusy(true); setFailure("");
      try {
        const result = await controlRequest("/api/control/apply", "POST", { resourceId: agentPlan.resourceId, projectId: currentProject.projectId, resolutions });
        setMessage(result.message); setAgentPlan(null); await refresh(); await reloadAgents(); await onApplied?.();
      } catch (cause) { setFailure(cause instanceof Error ? cause.message : "更新失败"); }
      finally { setBusy(false); }
    }}>{agentPlan.newInstall ? "添加到本机" : "备份并更新原智能体"}</Button>}>
      <p className="mb-3 text-sm">{agentPlan.newInstall ? "首次获取将创建本地智能体。" : `更新本地智能体 ${agentPlan.agentId}，不另建版本副本；更新前会保存本机配置备份。`}</p>
      {agentPlan.fields.filter(field => field.local !== field.published).map(field => <div key={field.key} className="mb-3 rounded border p-3 text-sm"><strong>{({name:"名称",description:"描述",prompt:"系统提示词",agentsMd:"AGENTS.md",maxTurns:"最大轮数"} as Record<string,string>)[field.key] || field.key}</strong><p className="mt-1 break-all">本机：{String(field.local ?? "未设置")}</p><p className="break-all">发布版：{String(field.published ?? "未设置")}</p>{field.conflict && <div className="mt-2 flex gap-4"><label><input type="radio" name={`resolve-${field.key}`} checked={resolutions[field.key] === "local"} onChange={() => setResolutions({ ...resolutions, [field.key]: "local" })} />保留本机</label><label><input type="radio" name={`resolve-${field.key}`} checked={resolutions[field.key] === "published"} onChange={() => setResolutions({ ...resolutions, [field.key]: "published" })} />采用发布版</label></div>}</div>)}
      {agentPlan.fields.every(field => field.local === field.published) && !agentPlan.newInstall && <p>受管理字段没有差异，可记录新版本。</p>}
    </Modal>}
  </details>;
}
