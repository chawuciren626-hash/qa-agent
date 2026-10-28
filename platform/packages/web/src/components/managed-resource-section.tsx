import { useState } from "react";
import { Button } from "@prismshadow/penguin-ui";
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
  const agentId = fixedAgent ?? selectedAgent;
  const needsAgent = kind === "plugins" || kind === "skills";
  if (!enabled) return null;
  const visible = resources.filter(resource => resource.kind === kind);
  if (!visible.length && !error) return null;
  return <details className="mb-4 rounded-lg border border-[var(--border)] p-4">
    <summary className="cursor-pointer text-sm font-medium">管理员提供的{kind === "agents" ? "智能体模板" : kind === "models" ? "模型配置" : kind === "plugins" ? "插件" : "技能"} · {visible.length}</summary>
    <p className="my-3 text-sm opacity-70">来源：管理后台。获取后保存为本机副本，新版本需手动获取，不覆盖个人修改。上游组件仍使用本页原有的更新入口。</p>
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
            if (!currentProject || !confirm(`获取「${resource.name}」v${resource.version} 到当前本机项目？智能体和模型创建独立版本副本，技能和插件保留原格式；遇到同名内容会拒绝覆盖，请使用原有更新入口。模型密钥仍需在本机填写。`)) return;
            setBusy(true); setFailure(""); setMessage("");
            try {
              const result = await controlRequest("/api/control/apply", "POST", { resourceId: resource.id, projectId: currentProject.projectId, ...(needsAgent ? { agentId } : {}) });
              setMessage(result.message);
              await refresh(); await reloadAgents(); await onApplied?.();
            } catch (cause) { setFailure(cause instanceof Error ? cause.message : "获取失败"); }
            finally { setBusy(false); }
          }}>{current ? "已获取此版本" : localVersion ? "获取新版本副本" : "获取到本机"}</Button>
        </div>
        <p className="mt-2 text-sm opacity-70">{resource.description}</p>
        {kind === "skills" && !!resource.payload.archiveBase64 && <a className="mt-2 inline-block text-xs underline" href={`/api/control/archive/${encodeURIComponent(resource.id)}`}>下载原格式技能包（在原有技能页导入并确认更新）</a>}
        <details className="mt-2 text-xs"><summary>查看配置内容</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify({ ...resource.payload, ...(resource.payload.archiveBase64 ? { archiveBase64: "完整技能包，保留原有文件结构" } : {}) }, null, 2)}</pre></details>
      </section>;
    })}</div>
  </details>;
}
