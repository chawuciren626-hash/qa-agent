/** Business state stays central. A desktop RuntimeSession is a reverse RPC proxy, never a VM fallback. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Hono } from "hono";
import { loadProjectConfig, providerConnectionShape, resolveEntryCredential } from "@prismshadow/penguin-core";
import type { AgentAssembly, AmspRecord, ApproveFn, SessionMetaMessage, ThinkingLevelName } from "@prismshadow/penguin-core";
import type { AppEnv } from "../auth/middleware.js";
import type { SessionRow } from "../db/repos/sessions.js";
import type { RuntimeSession, RunOpts } from "../runtime/session-manager.js";
import type { SessionIndex } from "../mechanisms/sessions.js";
import type { Settings } from "../mechanisms/settings.js";
import { HttpError } from "../http/errors.js";
import { readJson } from "../http/validate.js";
import { LocalExecutionBroker, type ExecutionClient } from "./local-execution-broker.js";
import { ADMIN_ASSISTANT_PROJECT_ID } from "../http/admin-management.js";

export interface ExecutionIdentity { clientId: string; proof: string }
export interface TransferFile { path: string; content: string }
export interface DetachedExecutionFrame {
  type: string;
  [key: string]: unknown;
}
type Coordinates = { sessionId: string; projectId: string; agentId: string; ownerUserId?: string | null; provider: string; modelId: string };
const inside = (base: string, target: string) => target.startsWith(path.resolve(base) + path.sep);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Plain files only. Never traverses symlinks, secrets, node_modules or another project's data. */
export async function executionFiles(base: string, prefix = "", maxBytes = 48 * 1024 * 1024): Promise<TransferFile[]> {
  const files: TransferFile[] = [];
  let bytes = 0;
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || ["node_modules", ".git", "vault", "vault.json", ".vault.json", ".vault.toml"].includes(entry.name)) continue;
      const rel = [relative, entry.name].filter(Boolean).join("/");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, rel);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES || (bytes += stat.size) > maxBytes) throw new Error("执行文件超出同步限额，请清理产物后重试");
        files.push({ path: prefix + rel, content: (await fs.readFile(file)).toString("base64") });
      }
    }
  }
  await walk(base, "");
  return files;
}

export class LocalExecutionRuntime {
  readonly broker: LocalExecutionBroker;
  private readonly provisional = new Map<string, Coordinates>();
  private readonly proxies = new Map<string, DesktopRuntimeSession>();
  private readonly seenEvents = new Set<string>();
  private readonly requests = new AsyncLocalStorage<{ userId: string; headers: Headers }>();
  private readonly controls = new Map<string, { id: string; sessionId: string; clientId: string; userId: string; operation: string; args: unknown }>();
  constructor(private readonly deps: { root: string; settings: Settings; sessions: SessionIndex; assembly: AgentAssembly }) {
    const read = (key: string) => { const value = deps.settings.get(key); return value ? JSON.parse(value) : null; };
    this.broker = new LocalExecutionBroker({
      get: id => read(`execution.session.${id}`),
      set: (id, value) => deps.settings.set(`execution.session.${id}`, JSON.stringify(value)),
      getClient: id => read(`execution.client.${id}`),
      setClient: (id, value) => deps.settings.set(`execution.client.${id}`, JSON.stringify(value)),
    });
  }
  identity(headers: Headers): ExecutionIdentity | undefined {
    const clientId = headers.get("x-aitest-execution-client");
    if (!clientId) return undefined;
    const proof = headers.get("x-aitest-execution-proof");
    if (!proof) throw new HttpError(409, "local_executor_required", "本机执行端尚未连接，请重新打开客户端");
    return { clientId, proof };
  }
  withRequest<T>(userId: string, headers: Headers, run: () => T): T { return this.requests.run({ userId, headers }, run); }
  currentIdentity(userId?: string): ExecutionIdentity | undefined {
    const current = this.requests.getStore();
    return current && current.userId === userId ? this.identity(current.headers) : undefined;
  }
  assertCurrent(sessionId: string): void {
    const current = this.requests.getStore();
    if (current) this.assertRequest(sessionId, current.userId, this.identity(current.headers));
    else if (this.broker.binding(sessionId)) this.broker.environment(sessionId);
  }
  inherit(parent: string, child: string): string | undefined {
    if (!this.broker.binding(parent)) return undefined;
    this.broker.inherit(parent, child);
    this.deps.settings.set(`execution.parent.${child}`, parent);
    return this.deps.sessions.findById(parent)?.workspace;
  }
  control(sessionId: string, operation: string, args: unknown): void {
    const binding = this.broker.binding(sessionId);
    if (!binding) return;
    this.broker.environment(sessionId);
    if (this.controls.size >= 256) throw new HttpError(429, "execution_control_limit", "本机控制请求过多，请稍后重试");
    const id = randomUUID();
    this.controls.set(id, { id, sessionId, ...binding, operation, args });
  }
  assertRequest(sessionId: string, userId: string, identity?: ExecutionIdentity): void {
    const binding = this.broker.binding(sessionId);
    if (identity && !binding && this.deps.sessions.findById(sessionId)?.projectId !== ADMIN_ASSISTANT_PROJECT_ID)
      throw new HttpError(409, "legacy_remote_session", "此历史会话在服务端创建，请新建会话使用本机执行环境；历史记录已保留");
    if (binding) {
      if (!identity || binding.userId !== userId || binding.clientId !== identity.clientId)
        throw new HttpError(409, "execution_session_bound", "请从创建此会话的原客户端继续执行");
      this.broker.authenticate(userId, identity.clientId, identity.proof);
      this.broker.environment(sessionId);
    }
  }
  async action(sessionId: string, userId: string, headers: Headers, operation: string, args: unknown): Promise<any> {
    this.assertRequest(sessionId, userId, this.identity(headers));
    const row = this.row(sessionId, userId);
    const proxy = this.proxies.get(sessionId) ?? await this.load(this.deps.sessions.findById(row.sessionId)!);
    if (!(proxy instanceof DesktopRuntimeSession)) throw new HttpError(409, "local_executor_required", "此操作需要原本机执行端");
    return proxy.call(operation, args);
  }
  private row(sessionId: string, userId: string): Coordinates {
    const row = this.deps.sessions.findById(sessionId) ?? this.provisional.get(sessionId);
    if (!row || row.ownerUserId !== userId || this.broker.binding(sessionId)?.userId !== userId)
      throw new HttpError(404, "session_not_found", "会话不存在或不属于当前用户");
    return row;
  }
  async load(row: SessionRow): Promise<RuntimeSession | null> {
    if (!this.broker.binding(row.sessionId)) return null;
    this.broker.environment(row.sessionId);
    const proxy = this.proxies.get(row.sessionId) ?? new DesktopRuntimeSession(this, { ...row, thinkingLevel: row.thinkingLevel ?? undefined });
    this.proxies.set(row.sessionId, proxy);
    await proxy.initialize();
    return proxy;
  }
  async create(args: Coordinates & { thinkingLevel?: ThinkingLevelName }, identity: ExecutionIdentity): Promise<DesktopRuntimeSession> {
    if (!args.ownerUserId) throw new Error("Desktop execution requires a signed-in user");
    if (args.projectId === ADMIN_ASSISTANT_PROJECT_ID) throw new HttpError(409, "admin_execution_placement", "管理员助手使用服务端管理工具，请从管理后台启动");
    this.broker.bind(args.sessionId, args.ownerUserId, identity.clientId, identity.proof);
    this.provisional.set(args.sessionId, args);
    const proxy = new DesktopRuntimeSession(this, args);
    try {
      await proxy.initialize();
      const mirror = path.join(this.deps.root, args.projectId, ".desktop-workspaces", args.sessionId);
      await fs.mkdir(mirror, { recursive: true });
      if (process.env.AITEST_ENGINE_ROOT) await fs.writeFile(path.join(mirror, ".qa-session.json"), JSON.stringify({
        version: 1, mode: "isolated", engine_root: process.env.AITEST_ENGINE_ROOT,
        workspace_root: path.dirname(mirror), session_root: mirror, session_id: args.sessionId, project_id: args.projectId,
        output_root: path.join(mirror, "output"), run_root: path.join(mirror, "output", "runs"),
      }));
      this.proxies.set(args.sessionId, proxy); return proxy;
    }
    finally { this.provisional.delete(args.sessionId); }
  }
  async bundle(row: Coordinates): Promise<unknown> {
    const cfg = await loadProjectConfig(this.deps.root, row.projectId);
    const models = cfg.models.flatMap(model => {
      const connection = resolveEntryCredential(model, providerConnectionShape(cfg.providers?.[model.provider]));
      const { api_key: _key, base_url: _base, ...safe } = model;
      if (!connection.baseUrl || !connection.clientType || !["openai-chat", "openai-responses", "ant-messages"].includes(connection.clientType)) return [];
      return [{ ...safe, client_type: connection.clientType }];
    });
    if (!models.some(model => model.provider === row.provider && model.model_id === row.modelId))
      throw new HttpError(409, "local_model_protocol", "本机执行要求所选模型明确配置地址及 openai-chat、openai-responses 或 ant-messages 协议");
    const files: TransferFile[] = [];
    const agents = path.join(this.deps.root, row.projectId, "agents");
    for (const entry of await fs.readdir(agents, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      files.push(...await executionFiles(path.join(agents, entry.name, "agent_state"), `agents/${entry.name}/agent_state/`));
      files.push(...await executionFiles(path.join(agents, entry.name, "scratchpad", row.sessionId), `agents/${entry.name}/scratchpad/${row.sessionId}/`));
    }
    return { ...row, requireLocalTrace: this.deps.sessions.findById(row.sessionId)?.hasTrace === true, root: this.deps.root, engine: process.env.AITEST_ENGINE_ROOT,
      projectConfig: { ...cfg, providers: {}, models, default_model: { provider: row.provider, model_id: row.modelId }, default_chat: { ...cfg.default_chat, workspace: undefined } }, files };
  }
  async *invoke(row: Coordinates, operation: string, args: unknown, signal?: AbortSignal, approve?: ApproveFn): AsyncGenerator<AmspRecord, unknown> {
    const proxy = this.proxies.get(row.sessionId);
    let result: unknown;
    for await (const event of this.broker.execute(row.sessionId, { operation, args, bundle: await this.bundle(row) }, signal)) {
      const frame = event as unknown as Record<string, any>;
      if (frame.type === "bridge_approval") {
        if (!approve) throw new Error("执行请求没有审批处理器");
        // Do not block consuming output while a parallel tool asks for approval.
        void approve(frame.toolCall).then(decision => this.broker.control(frame.jobId, { approvalId: frame.approvalId, decision }),
          () => this.broker.control(frame.jobId, { approvalId: frame.approvalId, decision: "deny" }));
      } else if (frame.type === "bridge_state") proxy?.update(frame.state);
      else if (frame.type === "bridge_result") result = frame.value;
      else if (frame.type === "bridge_file") await this.receiveFile(row, frame);
      else yield event;
    }
    return result;
  }

  /**
   * Run a non-chat task on the same local executor. This is intentionally detached from a
   * Session: environment exploration has no chat session but must still use the desktop's
   * Node/Python/browser and must never fall back to the VM process.
   */
  detached(userId: string, identity: ExecutionIdentity, operation: string, args: unknown,
    onFrame: (frame: DetachedExecutionFrame) => Promise<void> | void): {
    done: Promise<unknown>; answer: (value: string) => Promise<void>; abort: () => void;
  } {
    const sessionId = `detached-${randomUUID()}`;
    this.broker.bind(sessionId, userId, identity.clientId, identity.proof);
    const controller = new AbortController();
    const done = (async () => {
      let result: unknown;
      try {
        for await (const event of this.broker.execute(sessionId, { operation, args }, controller.signal)) {
          if ((event as any).type === "bridge_result") result = (event as any).value;
          await onFrame(event as unknown as DetachedExecutionFrame);
        }
        return { ok: true, error: null, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })();
    return {
      done,
      answer: async (value: string) => { this.broker.controlSession(sessionId, { type: "exploration_answer", answer: value }); },
      abort: () => {
        this.broker.controlSession(sessionId, { type: "exploration_abort" });
        controller.abort();
      },
    };
  }
  private async receiveFile(row: Coordinates, frame: Record<string, any>): Promise<void> {
    if (typeof frame.path !== "string" || typeof frame.content !== "string" || frame.content.length > 1024 * 1024 ||
      !Number.isSafeInteger(frame.offset) || frame.offset < 0 || frame.offset > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(frame.hash)) throw new Error("无效执行文件回执");
    const relative = frame.path;
    // Only this session's traces/scratchpad and its own workspace mirror are writable.
    const trace = new RegExp(`^agents/[a-zA-Z0-9_-]+/traces/\\d{4}-\\d{2}-\\d{2}/session-[a-zA-Z0-9_-]+_\\d+\\.jsonl$`);
    const scratch = /^agents\/[a-zA-Z0-9_-]+\/scratchpad\/(session-[a-zA-Z0-9_-]+)\//.exec(relative);
    if (!trace.test(relative) && !(scratch && (scratch[1] === row.sessionId || this.deps.settings.get(`execution.parent.${scratch[1]}`) === row.sessionId)) && !relative.startsWith("workspace/")) throw new Error("执行回执路径越界");
    const base = path.join(this.deps.root, row.projectId);
    const workspace = this.deps.sessions.findById(row.sessionId)?.workspace ?? path.join(base, ".desktop-workspaces", row.sessionId);
    const target = relative.startsWith("workspace/") ? path.resolve(workspace, relative.slice(10)) : path.resolve(base, relative);
    const allowedBase = relative.startsWith("workspace/") ? workspace : base;
    if (!inside(allowedBase, target) || relative.split(/[\\/]/).some(part => part === "..") || relative.includes(":")) throw new Error("执行回执路径越界");
    // Preserve the central mirror's own marker and shims; never execute uploaded files centrally.
    if (relative === "workspace/.qa-session.json") return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    let parent = target;
    while (inside(allowedBase, parent)) {
      const stat = await fs.lstat(parent).catch(() => null);
      if (stat?.isSymbolicLink()) throw new Error("执行回执不允许符号链接");
      parent = path.dirname(parent);
    }
    const temp = `${target}.bridge-upload-${frame.hash}`;
    if ((await fs.lstat(temp).catch(() => null))?.isSymbolicLink()) throw new Error("执行回执不允许符号链接");
    const bytes = Buffer.from(frame.content, "base64");
    if (frame.offset === 0) await fs.writeFile(temp, bytes, { mode: 0o600 });
    else {
      const stat = await fs.stat(temp);
      if (stat.size !== frame.offset) throw new Error("执行文件片段顺序无效");
      await fs.appendFile(temp, bytes);
    }
    if (frame.final) {
      const hash = createHash("sha256").update(await fs.readFile(temp)).digest("hex");
      if (hash !== frame.hash) throw new Error("执行文件校验失败");
      if (trace.test(relative)) {
        const records = (await fs.readFile(temp, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        let meta = records.find(record => record.type === "session_meta")?.payload;
        const traceId = path.basename(target).replace(/_\d+\.jsonl$/, "");
        // A rotated segment can start with request_begin. Authenticate it against this
        // same session's already accepted head, never against another session's metadata.
        if (!meta) for (const name of await fs.readdir(path.dirname(target))) {
          if (!name.startsWith(traceId + "_") || !/_\d+\.jsonl$/.test(name)) continue;
          const file = path.join(path.dirname(target), name);
          if (!(await fs.lstat(file)).isFile()) continue;
          const head = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(record => record.type === "session_meta");
          if (head) { meta = head.payload; break; }
        }
        const existing = this.deps.sessions.findById(traceId);
        const agentId = relative.split("/")[1];
        if (meta?.session_id !== traceId || meta.memory_owner_user_id !== row.ownerUserId ||
          (existing && (existing.ownerUserId !== row.ownerUserId || existing.projectId !== row.projectId || existing.agentId !== agentId)) ||
          (traceId === row.sessionId && agentId !== row.agentId) || (traceId !== row.sessionId && (meta.source !== "subagent" || this.deps.settings.get(`execution.parent.${traceId}`) !== row.sessionId)))
          throw new Error("子会话轨迹不属于本机任务");
      }
      await fs.rename(temp, target);
    }
  }
  routes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    const identity = (c: any) => {
      const value = this.identity(c.req.raw.headers);
      if (!value) throw new HttpError(403, "local_executor_required", "缺少执行端身份");
      this.broker.authenticate(c.var.user.userId, value.clientId, value.proof);
      return value;
    };
    app.post("/register", async c => {
      const body = await readJson(c);
      const id = this.identity(c.req.raw.headers);
      if (!id) throw new HttpError(403, "local_executor_required", "缺少执行端身份");
      this.broker.register(c.var.user.userId, id.proof, { ...body, clientId: id.clientId } as unknown as ExecutionClient);
      return c.json({ protocol: 1 });
    });
    app.post("/poll", async c => {
      const id = identity(c); const body = await readJson(c);
      const active = body.active;
      if (!Array.isArray(active) || active.length > 32 || active.some(v => typeof v !== "string")) throw new HttpError(400, "invalid_poll", "执行请求无效");
      if (Array.isArray(body.completedControls)) for (const key of body.completedControls) {
        const control = this.controls.get(String(key));
        if (control?.clientId === id.clientId && control.userId === c.var.user.userId) this.controls.delete(String(key));
      }
      const sessionControls = [...this.controls.values()].filter(control => control.clientId === id.clientId && control.userId === c.var.user.userId);
      return c.json({ ...this.broker.poll(c.var.user.userId, id.clientId, id.proof, active), sessionControls });
    });
    app.post("/events", async c => {
      identity(c); const body = await readJson(c);
      const row = this.row(String(body.sessionId), c.var.user.userId);
      this.assertRequest(row.sessionId, c.var.user.userId, this.identity(c.req.raw.headers));
      const event = body.event as any;
      if (!event || typeof body.eventId !== "string" || body.eventId.length > 64) throw new HttpError(400, "invalid_execution_event", "执行事件无效");
      if (this.seenEvents.has(body.eventId)) return c.json({ accepted: true });
      const proxy = this.proxies.get(row.sessionId);
      if (event.type === "file") await this.receiveFile(row, event.frame);
      else if (event.type === "state") proxy?.update(event.state);
      else if (event.type === "message") proxy?.backgroundMessage(event.message);
      else if (event.type === "notice") proxy?.backgroundNotices(event.messages);
      else throw new HttpError(400, "invalid_execution_event", "执行事件无效");
      this.seenEvents.add(body.eventId);
      if (this.seenEvents.size > 2048) this.seenEvents.delete(this.seenEvents.values().next().value!);
      return c.json({ accepted: true });
    });
    app.post("/approval", async c => {
      identity(c); const body = await readJson(c);
      const row = this.row(String(body.sessionId), c.var.user.userId);
      this.assertRequest(row.sessionId, c.var.user.userId, this.identity(c.req.raw.headers));
      const proxy = this.proxies.get(row.sessionId);
      return c.json({ decision: await proxy?.approve(body.toolCall as any) ?? "deny" });
    });
    app.post("/jobs/:jobId", async c => {
      const id = identity(c); const body = await readJson(c);
      this.broker.accept(c.var.user.userId, id.clientId, id.proof, c.req.param("jobId"), body as any);
      return c.json({ accepted: true });
    });
    app.post("/definition", async c => {
      identity(c); const body = await readJson(c);
      const root = this.row(String(body.rootSessionId), c.var.user.userId);
      this.assertRequest(root.sessionId, c.var.user.userId, this.identity(c.req.raw.headers));
      const agentId = String(body.agentId), sessionId = String(body.sessionId);
      if (!/^[a-zA-Z0-9_-]+$/.test(agentId) || !/^session-[a-zA-Z0-9_-]+$/.test(sessionId)) throw new HttpError(400, "invalid_execution_context", "执行上下文无效");
      await this.deps.assembly.authorizeTool?.({ projectId: root.projectId, agentId: root.agentId, sessionId: root.sessionId, toolName: "local_execution" });
      const resolved = await this.deps.assembly.publishedDefinition?.({ projectId: root.projectId, agentId, sessionId,
        ...(sessionId !== root.sessionId ? { parentSessionId: root.sessionId } : {}) }) ?? null;
      const definition = resolved ? structuredClone(resolved) : null;
      // A privileged central management MCP must never be exported to a normal executor.
      if (definition?.mcpServers?.some(server => server.name === "central_admin")) throw new HttpError(403, "admin_execution_placement", "管理工具仅允许服务端执行");
      if (sessionId !== root.sessionId) this.inherit(root.sessionId, sessionId);
      const resourceFiles: TransferFile[] = [];
      if (definition) {
        for (const skill of definition.skills) {
          const alias = `.bridge-resources/${createHash("sha256").update(skill.directory).digest("hex")}`;
          resourceFiles.push(...await executionFiles(skill.directory, alias + "/"));
          (skill as { directory: string }).directory = path.join(this.deps.root, root.projectId, alias);
        }
        for (const hook of definition.hookPackages ?? []) {
          const alias = `.bridge-resources/${createHash("sha256").update(hook.dir).digest("hex")}`;
          resourceFiles.push(...await executionFiles(hook.dir, alias + "/"));
          (hook as { dir: string }).dir = path.join(this.deps.root, root.projectId, alias);
        }
      }
      return c.json({ definition, resourceFiles });
    });
    app.post("/authorize", async c => {
      identity(c); const body = await readJson(c);
      const row = this.row(String(body.rootSessionId), c.var.user.userId);
      this.assertRequest(row.sessionId, c.var.user.userId, this.identity(c.req.raw.headers));
      await this.deps.assembly.authorizeTool?.({ projectId: row.projectId, agentId: row.agentId, sessionId: row.sessionId, toolName: String(body.toolName ?? "execution") });
      return c.json({ allowed: true });
    });
    app.post("/model/:sessionId/:provider/:modelId/*", async c => {
      identity(c);
      const row = this.row(c.req.param("sessionId"), c.var.user.userId);
      this.assertRequest(row.sessionId, c.var.user.userId, this.identity(c.req.raw.headers));
      await this.deps.assembly.authorizeTool?.({ projectId: row.projectId, agentId: row.agentId, sessionId: row.sessionId, toolName: "model_request" });
      const cfg = await loadProjectConfig(this.deps.root, row.projectId);
      const model = cfg.models.find(m => m.provider === c.req.param("provider") && m.model_id === c.req.param("modelId"));
      if (!model) throw new HttpError(403, "model_unavailable", "模型不可用");
      const connection = resolveEntryCredential(model, providerConnectionShape(cfg.providers?.[model.provider]));
      const tail = new URL(c.req.url).pathname.split(`/model/${encodeURIComponent(row.sessionId)}/`)[1]?.split("/").slice(2).join("/");
      if (!tail || !["chat/completions", "responses", "messages", "v1/chat/completions", "v1/responses", "v1/messages"].includes(tail) || !connection.baseUrl) throw new HttpError(400, "invalid_model_operation", "模型操作无效");
      const body = await c.req.json();
      if (body.model !== model.model_id) throw new HttpError(403, "model_mismatch", "模型与执行上下文不一致");
      const key = await this.deps.assembly.resolveModelApiKey?.({ projectId: row.projectId, agentId: row.agentId, sessionId: row.sessionId, provider: model.provider, modelId: model.model_id }) ?? connection.apiKey;
      const headers = new Headers({ "content-type": "application/json" });
      if (key) { headers.set("authorization", `Bearer ${key}`); headers.set("x-api-key", key); }
      headers.set("anthropic-version", "2023-06-01");
      const base = connection.baseUrl.replace(/\/$/, "");
      const suffix = base.endsWith("/v1") ? tail.replace(/^v1\//, "") : tail;
      const upstream = await fetch(`${base}/${suffix}`, { method: "POST", headers, body: JSON.stringify(body), signal: c.req.raw.signal, redirect: "error" });
      return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
    });
    return app;
  }
}

/** Local core owns tool/hook/subagent execution; this proxy owns no native processes. */
export class DesktopRuntimeSession implements RuntimeSession {
  readonly sessionId: string;
  provider: string;
  modelId: string;
  workspaceDir = "";
  metaMessage!: SessionMetaMessage;
  thinkingLevel?: ThinkingLevelName;
  private state: Record<string, any> = {};
  private noticeListener?: () => void;
  private messageListener?: (message: AmspRecord) => void;
  private backgroundListener?: () => void;
  private subagentListener?: () => void;
  private approvalFallback?: ApproveFn;
  private notices: AmspRecord[] = [];
  constructor(private readonly host: LocalExecutionRuntime, private readonly row: Coordinates & { thinkingLevel?: ThinkingLevelName }) {
    this.sessionId = row.sessionId; this.provider = row.provider; this.modelId = row.modelId; this.thinkingLevel = row.thinkingLevel;
  }
  update(state: Record<string, any>): void {
    this.state = state;
    if (state.provider) this.provider = state.provider;
    if (state.modelId) this.modelId = state.modelId;
    if (state.workspaceDir) this.workspaceDir = state.workspaceDir;
    if (state.metaMessage) this.metaMessage = state.metaMessage;
    this.backgroundListener?.(); this.subagentListener?.();
  }
  async initialize(): Promise<void> {
    const stream = this.host.invoke(this.row, "initialize", {});
    while (!(await stream.next()).done) { /* state is consumed by the host */ }
    // initialize happens before this proxy enters the registry
    const info = await this.call("state", {});
    this.update(info as Record<string, any>);
  }
  async call(operation: string, args: unknown, signal?: AbortSignal): Promise<any> {
    const stream = this.host.invoke(this.row, operation, args, signal);
    for (;;) { const next = await stream.next(); if (next.done) return next.value; }
  }
  run(messages: AmspRecord[], opts: RunOpts): AsyncGenerator<AmspRecord> {
    return this.host.invoke(this.row, "run", { messages, thinkingLevel: this.thinkingLevel }, opts.signal, opts.approve) as AsyncGenerator<AmspRecord>;
  }
  compact(opts: { signal: AbortSignal }): AsyncGenerator<AmspRecord> { return this.host.invoke(this.row, "compact", {}, opts.signal) as AsyncGenerator<AmspRecord>; }
  compactability(): any { return this.state.compactability ?? "empty"; }
  toolPermission(name: string): "r" | "rw" | undefined { return this.state.permissions?.[name]; }
  steer(messages: AmspRecord[]): boolean { this.host.control(this.sessionId, "steer", { messages }); return true; }
  skipReconnectWait(): boolean { this.host.control(this.sessionId, "retry", {}); return true; }
  hasPendingInput(): boolean { return this.state.hasPendingInput === true; }
  contextOpenPending(): boolean { return this.state.contextOpenPending === true; }
  generateTitle(args?: any): Promise<any> { return this.call("title", { material: args?.material }, args?.signal); }
  runUserPromptHook(name: string, prompt: string, extras?: Record<string, string | number | boolean>): Promise<any> { return this.call("hook", { name, prompt, extras }); }
  switchModel(opts: any): AsyncGenerator<AmspRecord, any> { return this.host.invoke(this.row, "switchModel", { provider: opts.provider, modelId: opts.modelId, mode: opts.mode }, opts.signal); }
  onBackgroundNotice(listener: () => void): void { this.noticeListener = listener; }
  onBackgroundMessage(listener: (message: AmspRecord) => void): void { this.messageListener = listener; }
  onBackgroundState(listener: () => void): void { this.backgroundListener = listener; }
  onSubagentState(listener: () => void): void { this.subagentListener = listener; }
  backgroundMessage(message: AmspRecord): void { this.messageListener?.(message); }
  backgroundNotices(messages: AmspRecord[]): void { this.notices.push(...messages); this.noticeListener?.(); }
  takeBackgroundNotices(): AmspRecord[] { return this.notices.splice(0); }
  hasPendingBackgroundNotices(): boolean { return this.notices.length > 0; }
  listBackgroundCommands(): any[] { return this.state.commands ?? []; }
  listBackgroundSubagents(): any[] { return this.state.subagents ?? []; }
  hasRunningBackgroundSubagents(): boolean { return this.state.runningSubagents === true; }
  setSubagentApprovalFallback(approve: ApproveFn): void { this.approvalFallback = approve; }
  approve(toolCall: Parameters<ApproveFn>[0]): ReturnType<ApproveFn> { return this.approvalFallback?.(toolCall) ?? Promise.resolve("deny"); }
  sendToBackgroundSubagent(sessionId: string, messages: AmspRecord[], opts?: any): Promise<any> { return this.call("subagentInput", { sessionId, messages, opts }); }
  abortBackgroundSubagentRun(sessionId: string): boolean {
    if (!this.listBackgroundSubagents().some(child => child.sessionId === sessionId)) return false;
    this.host.control(this.sessionId, "abortSubagent", { sessionId }); return true;
  }
  killBackgroundCommand(processId: string): boolean {
    if (!this.listBackgroundCommands().some(command => command.processId === processId)) return false;
    this.host.control(this.sessionId, "killCommand", { processId }); return true;
  }
  setBackgroundSubagentThinkingLevel(sessionId: string, level: ThinkingLevelName): boolean {
    this.host.control(this.sessionId, "subagentThinking", { sessionId, level }); return true;
  }
  dispose(): void { this.host.control(this.sessionId, "dispose", {}); }
}
