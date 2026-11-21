/**
 * MCP 服务管理（平台管理后台 `/mcp`）。
 *
 * 这是「插件市场 MCP 能力」的管理端入口：部署上有哪些 MCP 服务、连通与否、
 * 下发给了哪些 Agent，以及变更审计。布局照工具管理页（左统计 + 右卡片网格 + 弹窗），
 * 不同之处是卡片要回答四个问题——**stdio 还是 http、健康与否、工具有多少、下发到谁**。
 * 目录条目本身不改变任何 Agent；「下发」把条目写进 Agent 的 tools.mcpServers 才生效。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmModal, GlyphIcon, ICONS, Modal, PageFrame, PageHeader, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { apiErrorText } from "../../lib/api-error";
import * as api from "../../api/endpoints";
import "./admin-mcp-page.css";

export type McpServer = {
  name: string; transport: "stdio" | "http"; command: string; args: string[];
  env: Record<string, string>; url: string; headers: Record<string, string>;
  description: string; stageTags: string[]; enabled: boolean; source: "builtin" | "custom";
  tools: { name: string; description?: string }[] | null;
  lastTest: { at: string | null; ok: boolean | null; latencyMs: number | null };
  assignments: { projectId: string; agentId: string; assignedBy: string; assignedAt: string }[];
  createdAt: string; updatedAt: string;
};
type AuditEntry = { serverName: string; action: string; actor: string; detail: string; createdAt: string };
type ProjectOption = { projectId: string; name?: string };

const base = "/api/admin/mcp-servers";

const ACTION_LABEL: Record<string, string> = {
  create: "登记", update: "修改", enable: "启用", disable: "停用", delete: "删除",
  test_ok: "连通成功", test_fail: "连通失败", assign: "下发", unassign: "撤销下发",
};

/** 多行文本 → 参数列表：一行一个参数，# 开头的行当注释丢弃。 */
export function parseArgLines(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith("#"));
}

/** 多行文本 → 键值表：每行 KEY=VALUE；等号后允许为空，# 开头跳过。 */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

export function keyValuesToText(value: Record<string, string>): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join("\n");
}

export function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${ms} ms`;
}

/** 最近一次连通测试的一句话结论；从未测试是常态，不是失败。 */
export function testLabel(server: McpServer): string {
  if (server.lastTest.ok === null || server.lastTest.at === null) return "未测试";
  return server.lastTest.ok ? `连通 · ${formatLatency(server.lastTest.latencyMs)}` : "失败";
}

function ServerEditor({ entry, close, saved }: { entry: McpServer | null; close: () => void; saved: () => void }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(entry?.transport ?? "stdio");
  const [command, setCommand] = useState(entry?.command ?? "");
  const [argsText, setArgsText] = useState((entry?.args ?? []).join("\n"));
  const [envText, setEnvText] = useState(keyValuesToText(entry?.env ?? {}));
  const [url, setUrl] = useState(entry?.url ?? "");
  const [headersText, setHeadersText] = useState(keyValuesToText(entry?.headers ?? {}));
  const [description, setDescription] = useState(entry?.description ?? "");
  const [stageTags, setStageTags] = useState((entry?.stageTags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const valid = /^[a-zA-Z0-9_-]{1,64}$/.test(name) && (transport === "stdio" ? !!command.trim() : /^https?:\/\//.test(url.trim()));
  const save = async () => {
    if (!valid) return;
    setSaving(true); setError("");
    const body = {
      transport,
      command: command.trim(),
      args: parseArgLines(argsText),
      env: parseKeyValueLines(envText),
      url: url.trim(),
      headers: parseKeyValueLines(headersText),
      description: description.trim(),
      stageTags: stageTags.split(",").map(item => item.trim()).filter(Boolean),
    };
    try {
      if (entry) await controlRequest(`${base}/${encodeURIComponent(entry.name)}`, "PATCH", body);
      else await controlRequest(base, "POST", { ...body, name: name.trim() });
      toastSuccess(entry ? "MCP 服务已保存" : "MCP 服务已登记");
      saved();
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setSaving(false); }
  };
  return <Modal open title={entry ? `编辑 ${entry.name}` : "登记 MCP 服务"} onClose={close}
    footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={!valid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></>}>
    <div className="amcp-form">
      {error && <p role="alert" className="amcp-error">{error}</p>}
      <label>服务名（下发后即 Agent 侧条目名，创建后不可改）<input value={name} disabled={!!entry} maxLength={64} onChange={event => setName(event.target.value)} placeholder="如 my-team-tools" /></label>
      <label>传输<select value={transport} disabled={!!entry?.source.startsWith("builtin")} onChange={event => setTransport(event.target.value as "stdio" | "http")}>
        <option value="stdio">stdio — 本机子进程（配置/凭据不出本机）</option>
        <option value="http">http — Streamable HTTP 远程端点</option>
      </select></label>
      {transport === "stdio" ? <>
        <label>启动命令<input value={command} onChange={event => setCommand(event.target.value)} placeholder="如 node" /></label>
        <label>启动参数（一行一个）<textarea value={argsText} rows={3} spellCheck={false} onChange={event => setArgsText(event.target.value)} placeholder={"# 如：\nC:\\path\\to\\server.mjs"} /></label>
        <label>环境变量（一行一个 KEY=VALUE；${"{KEY}"} 引用由 Agent 密钥库在会话期解析）<textarea value={envText} rows={3} spellCheck={false} onChange={event => setEnvText(event.target.value)} placeholder={"API_KEY=..."} /></label>
      </> : <>
        <label>端点 URL<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://host/mcp" /></label>
        <label>请求头（一行一个 KEY=VALUE）<textarea value={headersText} rows={3} spellCheck={false} onChange={event => setHeadersText(event.target.value)} placeholder={"Authorization=Bearer ..."} /></label>
      </>}
      <label>说明<textarea value={description} rows={3} maxLength={2000} onChange={event => setDescription(event.target.value)} placeholder="它提供什么能力、何时该用" /></label>
      <label>阶段标签（逗号分隔，如 cross, execution）<input value={stageTags} onChange={event => setStageTags(event.target.value)} /></label>
    </div>
  </Modal>;
}

function TestDialog({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<{ ok: boolean; tools?: { name: string; description?: string }[]; latencyMs?: number; error?: string; vaultRefs?: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void controlRequest(`${base}/${encodeURIComponent(server.name)}/test`, "POST", {})
      .then(value => { if (active) setResult(value); })
      .catch(cause => { if (active) setResult({ ok: false, error: apiErrorText(cause) }); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [server.name]);
  return <Modal open title={`连通测试：${server.name}`} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="amcp-test">
      {busy ? <p role="status">正在连接并在本机执行 tools/list…</p> : result === null ? <p>无结果</p> : <>
        <p className={result.ok ? "amcp-ok" : "amcp-error"} role={result.ok ? "status" : "alert"}>
          {result.ok ? `连接成功 · ${formatLatency(result.latencyMs ?? null)}` : `连接失败：${result.error ?? "未知错误"}`}
        </p>
        {result.ok && <ul className="amcp-tools">{(result.tools ?? []).map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}</ul>}
        {result.ok && (result.tools ?? []).length === 0 && <p className="amcp-muted">服务在线，但没有暴露任何工具。</p>}
      </>}
    </div>
  </Modal>;
}

function AssignDialog({ server, close, done }: { server: McpServer; close: () => void; done: () => void }) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [agents, setAgents] = useState<{ agentId: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.listProjects().then(result => setProjects(result.projects as ProjectOption[])).catch(cause => setError(apiErrorText(cause)));
  }, []);
  useEffect(() => {
    setAgentId(""); setAgents([]);
    if (!projectId) return;
    void controlRequest(`/api/projects/${encodeURIComponent(projectId)}/agents`)
      .then(result => setAgents(result.agents as { agentId: string }[]))
      .catch(cause => setError(apiErrorText(cause)));
  }, [projectId]);
  const assign = async () => {
    if (!projectId || !agentId) return;
    setBusy(true); setError("");
    try {
      await controlRequest(`${base}/${encodeURIComponent(server.name)}/assign`, "POST", { projectId, agentId });
      toastSuccess(`已下发到 ${agentId}；该 Agent 的下一个模型上下文生效`);
      done();
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  const revoke = async (item: { projectId: string; agentId: string }) => {
    setBusy(true); setError("");
    try {
      await controlRequest(`${base}/${encodeURIComponent(server.name)}/unassign`, "POST", { projectId: item.projectId, agentId: item.agentId });
      toastSuccess(`已撤销 ${item.agentId} 的下发`);
      done();
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  return <Modal open title={`下发：${server.name}`} onClose={close}
    footer={<><Button onClick={close}>关闭</Button><Button variant="primary" disabled={!projectId || !agentId || busy} onClick={() => void assign()}>{busy ? "下发中…" : "下发"}</Button></>}>
    <div className="amcp-form">
      {error && <p role="alert" className="amcp-error">{error}</p>}
      {!server.enabled && <p role="alert" className="amcp-error">此服务已停用：请先启用再下发。</p>}
      <label>项目<select value={projectId} onChange={event => setProjectId(event.target.value)}>
        <option value="">选择项目</option>
        {projects.map(item => <option key={item.projectId} value={item.projectId}>{item.name || item.projectId}</option>)}
      </select></label>
      <label>Agent<select value={agentId} disabled={!projectId} onChange={event => setAgentId(event.target.value)}>
        <option value="">{projectId ? "选择 Agent" : "先选择项目"}</option>
        {agents.map(item => <option key={item.agentId} value={item.agentId}>{item.agentId}</option>)}
      </select></label>
      <h3>已下发（{server.assignments.length}）</h3>
      {server.assignments.length === 0 ? <p className="amcp-muted">尚未下发给任何 Agent。</p> : <ul className="amcp-assign">{server.assignments.map(item =>
        <li key={`${item.projectId}/${item.agentId}`}><span>{item.projectId}/{item.agentId}</span><small>{item.assignedAt.replace("T", " ").slice(0, 19)}</small>
          <button type="button" disabled={busy} onClick={() => void revoke(item)}>撤销</button></li>)}</ul>}
    </div>
  </Modal>;
}

export function AdminMcpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [enginePresent, setEnginePresent] = useState(true);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [testing, setTesting] = useState<McpServer | null>(null);
  const [assigning, setAssigning] = useState<McpServer | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await controlRequest(base);
      setServers(result.servers as McpServer[]);
      setAudit(result.audit as AuditEntry[]);
      setEnginePresent(result.engineRootPresent === true);
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => servers.filter(item =>
    !query.trim() || `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())), [servers, query]);
  const enabledCount = servers.filter(item => item.enabled).length;
  const assignmentCount = servers.reduce((sum, item) => sum + item.assignments.length, 0);
  const toolCount = servers.reduce((sum, item) => sum + (item.tools?.length ?? 0), 0);

  const toggle = async (server: McpServer) => {
    setBusy(true);
    try { await controlRequest(`${base}/${encodeURIComponent(server.name)}`, "PATCH", { enabled: !server.enabled }); await load(); toastSuccess(server.enabled ? "已停用" : "已启用"); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try { await controlRequest(`${base}/${encodeURIComponent(removing.name)}`, "DELETE"); setRemoving(null); await load(); toastSuccess("MCP 服务已删除"); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };

  return <PageFrame width="full" className="amcp-frame" contentClassName="amcp-content">
    <PageHeader title="MCP 服务" description="登记、连通测试、工具发现与下发装配：目录条目下发到 Agent 后才会进入 tools.mcpServers"
      actions={<Button variant="primary" onClick={() => setEditing("new")}>＋ 登记 MCP 服务</Button>} />
    {!enginePresent && <p role="status" className="amcp-warn">本机未配置 AITEST_ENGINE_ROOT：内置阶段工具出口不可用；远程 http 服务不受影响。</p>}
    <div className="amcp-stats">
      <div><strong>{servers.length}</strong><span>目录条目</span></div>
      <div><strong>{enabledCount}</strong><span>已启用</span></div>
      <div><strong>{assignmentCount}</strong><span>下发装配</span></div>
      <div><strong>{toolCount}</strong><span>发现工具</span></div>
      <p>「下发」把目录条目写进 Agent 的 tools.mcpServers（plugin=admin-catalog）；Agent 配置页手填的条目不经过这里，也不会出现在下发列表。</p>
    </div>
    <div className="amcp-results">
      <div className="amcp-results-head">
        <h2>目录</h2><span>{visible.length} 个服务</span>
        <input type="search" aria-label="搜索 MCP 服务" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称 / 说明" />
      </div>
      {loading ? <p className="amcp-empty">正在加载 MCP 服务目录…</p> : visible.length === 0 ? <p className="amcp-empty">没有匹配的 MCP 服务</p> : <div className="amcp-grid">
        {visible.map(item => <article key={item.name} className="amcp-card">
          <div className="amcp-card-top">
            <span className={`amcp-dot${item.enabled ? " on" : ""}`} title={item.enabled ? "已启用" : "已停用"} />
            <strong title={item.name}>{item.name}</strong>
            <span className="amcp-transport">{item.transport}</span>
            {item.source === "builtin" && <span className="amcp-badge">内置</span>}
          </div>
          <p className="amcp-desc" title={item.description}>{item.description || "（未填写说明）"}</p>
          <div className="amcp-facts">
            <span className={item.lastTest.ok === true ? "amcp-ok" : item.lastTest.ok === false ? "amcp-error" : "amcp-muted"}>{testLabel(item)}</span>
            <span>{item.tools ? `${item.tools.length} 个工具` : "未发现工具"}</span>
            <span>{item.assignments.length} 个 Agent</span>
            {item.stageTags.length > 0 && <span title={item.stageTags.join("、")}>{item.stageTags.join("/")}</span>}
          </div>
          <div className="amcp-card-actions">
            <button type="button" title={item.enabled ? "停用" : "启用"} aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`} disabled={busy} onClick={() => void toggle(item)}><GlyphIcon d={item.enabled ? ICONS.pause : ICONS.play} size={14} /></button>
            <button type="button" title="连通测试" aria-label={`连通测试 ${item.name}`} onClick={() => setTesting(item)}><GlyphIcon d={ICONS.plug} size={14} /></button>
            <button type="button" title="下发到 Agent" aria-label={`下发 ${item.name}`} onClick={() => setAssigning(item)}><GlyphIcon d={ICONS.download} size={14} /></button>
            <button type="button" title={item.source === "builtin" ? "内置出口不可编辑" : "编辑"} aria-label={`编辑 ${item.name}`} disabled={item.source === "builtin"} onClick={() => setEditing(item)}><GlyphIcon d={ICONS.pencil} size={14} /></button>
            <button type="button" title={item.source === "builtin" ? "内置出口不可删除" : "删除"} aria-label={`删除 ${item.name}`} disabled={item.source === "builtin"} onClick={() => setRemoving(item)}><GlyphIcon d={ICONS.trash} size={14} /></button>
          </div>
        </article>)}
      </div>}
      {error && <p role="alert" className="amcp-error">{error}</p>}
    </div>
    <section className="amcp-audit">
      <h2>最近变更</h2>
      {audit.length === 0 ? <p className="amcp-muted">暂无记录</p> : <ul className="amcp-audit-list">{audit.map((item, index) =>
        <li key={`${item.createdAt}-${index}`}><strong>{ACTION_LABEL[item.action] ?? item.action}</strong><code>{item.serverName}</code><span>{item.actor}</span>{item.detail && <span className="amcp-detail">{item.detail}</span>}<time>{item.createdAt.replace("T", " ").slice(0, 19)}</time></li>)}</ul>}
    </section>
    {editing !== null && <ServerEditor key={editing === "new" ? "new" : editing.name} entry={editing === "new" ? null : editing}
      close={() => setEditing(null)} saved={() => { setEditing(null); void load(); }} />}
    {testing && <TestDialog server={testing} onClose={() => { setTesting(null); void load(); }} />}
    {assigning && <AssignDialog server={assigning} close={() => setAssigning(null)} done={() => { setAssigning(null); void load(); }} />}
    <ConfirmModal open={!!removing} title={removing ? `删除 ${removing.name}` : ""} busy={busy}
      onClose={() => setRemoving(null)} onConfirm={() => void remove()} confirmLabel="删除" cancelLabel="取消">
      <p>删除目录条目不会改动任何 Agent；已下发的装配需先撤销（删除前会拒绝并提示）。</p>
    </ConfirmModal>
  </PageFrame>;
}
