/** Central identity only. Project contents, preferences and model credentials never cross this bridge. */
import { requestModule } from "./module-access.js";
import { applyPublicResource, previewPublicAgentUpdate } from "./public-resource-apply.js";
import { PublishedBundleCache } from "./published-bundle-cache.js";
import { SharedAgentSessionPins } from "./shared-agent-session-pins.js";
import { localAdapterHash } from "./trusted-local-adapters.js";
import { localAgentId, type ResolvedPublishedBundle } from "./published-bundle.js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./middleware.js";
import { cookieOptions, sessionCookieName, sessionCookies, bearerToken } from "./middleware.js";
import { sessionTokenHash } from "../db/repos/auth-sessions.js";
import type { Auth, AuthSessions, Admin, Users } from "../mechanisms/identity.js";
import type { ServerConfig } from "../config.js";
import type { UserInfo } from "../api/types.js";
import type { LiveStreams } from "./live-streams.js";
import { HttpError } from "../http/errors.js";
import { toUserInfo } from "./service.js";
import { AccountCookieSeal } from "./account-cookie-seal.js";
import { InvocationGuard, type AuthorizationDecision, type InvocationConstraints, type InvocationIdentity, type InvocationLease, type InvocationOperation, type InvocationResource } from "./invocation-authorization.js";
import { PublishedResourceSync, type CatalogBundleItem } from "./resource-sync.js";
import { TaskContentSnapshotStore } from "./task-content-snapshot.js";

export interface AccountClientConfig { origin: string; ownerUserId: string }
export function readAccountClientConfig(root: string, env: NodeJS.ProcessEnv): AccountClientConfig | undefined {
  const file = path.join(root, "account-center.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
  const raw = env.AITEST_ACCOUNT_CENTER_ORIGIN ?? saved.origin;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("Invalid account center origin");
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Account center requires an HTTPS origin (HTTP allowed on loopback only)");
  const owner = env.AITEST_ACCOUNT_CENTER_OWNER ?? saved.ownerUserId;
  if (typeof owner !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(owner)) throw new Error("Account center ownerUserId must explicitly name the existing local administrator");
  return { origin: url.origin, ownerUserId: owner };
}

type Binding = { remote: UserInfo; localId: string; cookie: string; expires: number; modules?:string[]; menuKeys?:string[]; resourceIds?:string[] };
type Deps = { config: ServerConfig; db: DatabaseSync; auth: () => Auth; sessions: () => AuthSessions; users: () => Users; admin: () => Admin; streams: () => LiveStreams; fetch?: typeof fetch; localRequest?: (userId:string,request:Request)=>Promise<Response> };
export class AccountClient {
  private readonly sessions = new Map<string, Binding>();
  private readonly checks = new Map<Binding, Promise<void>>();
  private readonly creating = new Map<string, Promise<string>>();
  private readonly provisionalCookies = new Map<string, string>();
  private readonly shellClaims = new Set<string>();
  private readonly cfg: AccountClientConfig;
  private readonly cookieSeal: AccountCookieSeal;
  private readonly publishedPins: SharedAgentSessionPins;
  private readonly guard: InvocationGuard;
  private readonly resourceSync: PublishedResourceSync;
  private readonly snapshots: TaskContentSnapshotStore;
  constructor(private readonly deps: Deps) {
    this.cfg = deps.config.accountClient!;
    this.publishedPins = new SharedAgentSessionPins(deps.db, deps.config.root);
    this.guard = new InvocationGuard({ db: deps.db, fetchPolicy: (userId, signal) => this.fetchAccessPolicy(userId, signal) });
    this.resourceSync = new PublishedResourceSync({
      db: deps.db, dataRoot: deps.config.root, engineRoot: process.env.AITEST_ENGINE_ROOT,
      fetchBundles: (userId, signal) => this.fetchResolvedBundles(userId, signal),
    });
    this.snapshots = new TaskContentSnapshotStore(deps.db, deps.config.root);
    // Explicit binding, including the center origin: changing servers cannot adopt another person's files.
    deps.db.exec("CREATE TABLE IF NOT EXISTS account_center_bindings (origin TEXT NOT NULL, remote_id TEXT NOT NULL, local_id TEXT NOT NULL UNIQUE, PRIMARY KEY(origin, remote_id))");
    // The local session cookie survives an app restart. Keep its central proof alongside the
    // already durable local auth_sessions row, then revalidate it with the center on first use.
    // This table lives only in the private local data root, never in project exports.
    deps.db.exec("CREATE TABLE IF NOT EXISTS account_center_sessions (token_hash TEXT PRIMARY KEY, origin TEXT NOT NULL, local_id TEXT NOT NULL, remote_json TEXT NOT NULL, central_cookie TEXT NOT NULL, expires_at TEXT NOT NULL)");
    deps.db.exec("CREATE TABLE IF NOT EXISTS central_private_project_scopes (local_user_id TEXT NOT NULL, project_id TEXT NOT NULL, scope_id TEXT NOT NULL UNIQUE, PRIMARY KEY(local_user_id,project_id))");
    const encryptedRowsExist = Boolean(deps.db.prepare("SELECT 1 AS found FROM account_center_sessions WHERE central_cookie LIKE 'enc:v1:%' LIMIT 1").get());
    this.cookieSeal = new AccountCookieSeal(deps.config.root, encryptedRowsExist);
    const previous = deps.db.prepare("SELECT origin FROM account_center_bindings LIMIT 1").get();
    if (previous && previous.origin !== this.cfg.origin) throw new Error("Account center changed: explicit local data migration required");
    const now = Date.now();
    for (const row of deps.db.prepare("SELECT s.token_hash, s.origin, s.local_id, s.remote_json, s.central_cookie, s.expires_at, a.user_id AS auth_user, a.expires_at AS auth_expires FROM account_center_sessions s LEFT JOIN auth_sessions a ON a.token_hash=s.token_hash").all()) {
      const hash = String(row.token_hash);
      const storedCookie = String(row.central_cookie);
      const cookie = AccountCookieSeal.isSealed(storedCookie) ? this.cookieSeal.open(storedCookie) : storedCookie;
      try {
        const remote = JSON.parse(String(row.remote_json)) as UserInfo;
        const expires = Date.parse(String(row.expires_at));
        const authExpires = Date.parse(String(row.auth_expires ?? ""));
        const localId = String(row.local_id);
        const bound = deps.db.prepare("SELECT local_id FROM account_center_bindings WHERE origin=? AND remote_id=?").get(this.cfg.origin, remote.userId);
        if (row.origin !== this.cfg.origin || row.auth_user !== localId || bound?.local_id !== localId ||
          !deps.users().findById(localId) || !remote.userId || typeof remote.isAdmin !== "boolean" ||
          !/^penguin_session=[^;\s]+$/.test(cookie) ||
          !Number.isFinite(expires) || expires <= now || !Number.isFinite(authExpires) || authExpires <= now) throw Error("stale session");
        if (!AccountCookieSeal.isSealed(storedCookie)) deps.db.prepare("UPDATE account_center_sessions SET central_cookie=? WHERE token_hash=?")
          .run(this.cookieSeal.seal(cookie), hash);
        this.sessions.set(hash, { remote, localId, cookie, expires: Math.min(expires, authExpires) });
        this.resourceSync.start(localId);
      } catch { deps.db.prepare("DELETE FROM account_center_sessions WHERE token_hash=?").run(hash); }
    }
  }
  accepts(token: string): boolean {
    const binding = this.sessions.get(sessionTokenHash(token));
    return !!binding && binding.expires > Date.now();
  }
  private drop(hash: string, binding: Binding) {
    this.guard.cancelUser(binding.localId);
    this.resourceSync.stop(binding.localId);
    this.sessions.delete(hash);
    this.deps.db.prepare("DELETE FROM account_center_sessions WHERE token_hash=?").run(hash);
    this.deps.sessions().delete(hash);
    this.deps.streams().endForUser(binding.localId);
  }
  private async remote(endpoint: string, method = "GET", body?: unknown, binding?: Binding, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(this.cfg.origin + endpoint, {
        method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", ...(binding ? { cookie: binding.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HttpError(503, "account_center_unavailable", "服务端不可用，请联系管理员"); }
    if (response.status !== 204 && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
      throw new HttpError(503, "account_center_unavailable", "服务端不可用，请联系管理员");
    return response;
  }
  async validate(token: string): Promise<void> {
    const hash = sessionTokenHash(token), binding = this.sessions.get(hash);
    if (!binding || binding.expires <= Date.now()) throw new HttpError(401, "unauthorized", "请登录服务端账号。");
    let check = this.checks.get(binding);
    if (!check) {
      check = (async () => {
        const response = await this.remote("/api/me", "GET", undefined, binding);
        if (response.status === 401 || response.status === 403) { this.drop(hash, binding); throw new HttpError(401, "unauthorized", "账号登录已失效，请重新登录。"); }
        if (!response.ok) throw new HttpError(503, "account_center_unavailable", "账号中心无法验证登录，请稍后重试。");
        const { user } = await response.json() as { user: UserInfo & { disabled?: boolean } };
        if (user.userId !== binding.remote.userId || user.isAdmin !== binding.remote.isAdmin || user.disabled) { this.drop(hash, binding); throw new HttpError(401, "unauthorized", "账号权限已变化，请重新登录。"); }
        const access=await this.remote("/api/control/access","GET",undefined,binding);
        if(!access.ok) throw new HttpError(503,"permissions_unavailable","无法读取服务端权限，请稍后重试。");
        const policy=await access.json() as {modules?:string[];menuKeys?:string[];resourceIds?:string[]};
        binding.modules=policy.modules??[]; binding.menuKeys=policy.menuKeys??[]; binding.resourceIds=policy.resourceIds??[];
        const renewed = response.headers.getSetCookie().find(v => v.startsWith("penguin_session="));
        if (renewed) binding.cookie = renewed.split(";")[0]!;
        binding.expires = Date.now() + this.deps.config.authSessionTtlMs;
        this.deps.db.prepare("UPDATE account_center_sessions SET central_cookie=?, expires_at=? WHERE token_hash=?")
          .run(this.cookieSeal.seal(binding.cookie), new Date(binding.expires).toISOString(), hash);
      })().finally(() => this.checks.delete(binding));
      this.checks.set(binding, check);
    }
    await check;
  }
  async validateUser(localId: string): Promise<void> {
    // Socket frames identify a user; the socket itself is separately tied to its login token.
    const found = [...this.sessions.entries()].find(([, b]) => b.localId === localId && b.expires > Date.now());
    if (!found) throw new HttpError(401, "unauthorized", "请重新登录。");
    for (const [, binding] of this.sessions) {
      if (binding.localId !== localId || binding.expires <= Date.now()) continue;
      try { await this.checkBinding(binding); return; } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401) throw error;
      }
    }
    throw new HttpError(401,"unauthorized","登录已失效。");
  }
  /** Resolve the current central role once for a new local task; no project data is sent. */
  async listSharedRoleIds(localId: string): Promise<string[]> {
    const provisional=this.provisionalCookies.get(localId);
    if(!provisional)await this.validateUser(localId);
    const binding=[...this.sessions.values()].find(item=>item.localId===localId&&item.expires>Date.now()) ??
      (provisional ? {cookie:provisional} as Binding : undefined);
    if(!binding)throw new HttpError(401,"unauthorized","请重新登录。");
    const response=await this.remote("/api/control/catalog/roles/resolved","GET",undefined,binding);
    if(!response.ok)throw new HttpError(503,"resource_catalog_unavailable","无法读取共享智能体目录。");
    const parsed=await response.json() as {bundles?: ({agentId:string}&ResolvedPublishedBundle)[]};
    if(!Array.isArray(parsed.bundles))throw new HttpError(503,"resource_catalog_invalid","共享智能体目录无效。");
    const cache=new PublishedBundleCache(this.deps.config.root);
    const ready:string[]=[];
    for(const item of parsed.bundles){
      const executionAgentId=localAgentId(item.agentId);
      const bundle=await cache.store(localId,item);
      const definition=await cache.definition(localId,bundle.bundleHash);
      if(definition.agentId!==executionAgentId)throw new HttpError(503,"resource_catalog_invalid","共享智能体目录与定义不一致。");
      const required=executionAgentId==="default_agent"?["qa-default-entry","goal"]:executionAgentId==="test_agent"?["qa-delegation-guard"]:["qa-stage-boundary"];
      if (!process.env.AITEST_ENGINE_ROOT) continue;
      if (!(await Promise.all(required.map(async name => {
        const adapter=definition.localAdapters.find(entry=>entry.name===name);
        return adapter && adapter.hash===await localAdapterHash(process.env.AITEST_ENGINE_ROOT!,name);
      }))).every(Boolean)) continue;
      ready.push(executionAgentId);
    }
    return ready;
  }
  async resolveRoleBundle(localId: string, agentId: string): Promise<ResolvedPublishedBundle | null> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)) throw new HttpError(400,"invalid_agent_id","智能体标识无效。");
    await this.validateUser(localId);
    const binding=[...this.sessions.values()].find(b=>b.localId===localId&&b.expires>Date.now());
    if(!binding)throw new HttpError(401,"unauthorized","请重新登录。");
    const listing=await this.remote("/api/control/catalog/roles","GET",undefined,binding);
    if(!listing.ok)throw new HttpError(503,"resource_catalog_unavailable","无法读取共享智能体目录。");
    const parsed=await listing.json() as {roles?:{agentId:string;resourceId:string}[]};
    const matches=(parsed.roles??[]).filter(role=>localAgentId(role.agentId)===agentId);
    if(matches.length===0)return null;
    if(matches.length!==1)throw new HttpError(409,"duplicate_shared_role","共享智能体标识重复。");
    const result=await this.remote(`/api/control/catalog/${encodeURIComponent(matches[0]!.resourceId)}/resolved`,"GET",undefined,binding);
    if(!result.ok)throw new HttpError(503,"resource_bundle_unavailable","无法读取共享智能体定义。");
    const cache=new PublishedBundleCache(this.deps.config.root);
    const bundle=await cache.store(localId,await result.json());
    await cache.materializeSkills(localId,bundle.bundleHash);
    return bundle;
  }
  async pinPublishedSession(userId: string, projectId: string, agentId: string, sessionId: string): Promise<boolean> {
    await this.validateUser(userId);
    const binding=[...this.sessions.values()].find(item=>item.localId===userId&&item.expires>Date.now());
    if(!binding)throw new HttpError(401,"unauthorized","请重新登录。");
    await this.resourceSync.kick(userId);
    const publication = this.resourceSync.status(userId).publication;
    if (!publication) throw new HttpError(503, "resource_catalog_unverified", "尚无通过校验的服务端发布。");
    const cache = new PublishedBundleCache(this.deps.config.root);
    const entries: { agentId: string; bundleHash: string }[] = [];
    for (const item of publication.agents) {
      const definition = await cache.definition(userId, item.bundleHash);
      if (definition.agentId !== localAgentId(item.agentId)) throw new HttpError(503, "resource_catalog_invalid", "共享智能体目录与定义不一致。");
      entries.push({ agentId: item.agentId, bundleHash: item.bundleHash });
    }
    const selected=entries.find(entry=>entry.agentId===agentId);
    if(!selected)return false;
    await this.publishedPins.catalog(sessionId,userId,entries);
    await this.publishedPins.pin({ userId, projectId, agentId, sessionId, bundleHash: selected.bundleHash });
    return true;
  }
  async resolvePinnedDefinition(projectId: string, agentId: string, sessionId: string, parentSessionId?: string) {
    const existing = await this.publishedPins.resolve(sessionId, projectId, agentId);
    const definition=existing??(parentSessionId&&this.publishedPins.get(parentSessionId)
      ?await this.publishedPins.inherit(parentSessionId,sessionId,projectId,agentId):null);
    if(!definition)return null;
    await this.authorizeSessionInvocation(projectId, agentId, sessionId);
    const pin=this.publishedPins.get(sessionId);
    if(!pin)throw Error("Shared Agent session pin is missing");
    await this.validateUser(pin.userId);
    const binding=[...this.sessions.values()].find(item=>item.localId===pin.userId&&item.expires>Date.now());
    if(!binding)throw new HttpError(401,"unauthorized","请重新登录服务端账号。");
    const base=`/api/control/private/agents/${encodeURIComponent(definition.resourceId)}/memory`;
    const [user,project]=await Promise.all([
      this.remote(base,"GET",undefined,binding),
      this.remote(`${base}?scope=project&projectId=${encodeURIComponent(this.privateProjectScope(pin.userId,projectId))}`,"GET",undefined,binding),
    ]);
    if(!user.ok||!project.ok)throw new HttpError(503,"central_memory_unavailable","无法读取服务端 Agent 记忆。");
    const parse=async(response:Response):Promise<[string,string][]>=>{
      const data=await response.json() as {entries?:{name:unknown;value:unknown}[]};
      if(!Array.isArray(data.entries)||data.entries.length>100||data.entries.some(entry=>typeof entry.name!=="string"||typeof entry.value!=="string"))throw Error("Invalid central Agent memory response");
      return data.entries.map(entry=>[entry.name as string,entry.value as string]);
    };
    const memory=new Map([...(await parse(user)),...(await parse(project))]);
    if(JSON.stringify(Object.fromEntries(memory)).length>256_000)throw Error("Central Agent memory exceeds the runtime limit");
    const decision=await this.guard.authorizeInvocation({userId:pin.userId,projectId,agentId,sessionId},{kind:"session",id:sessionId,bundleHash:definition.bundleHash},"resume",{requireFresh:true});
    if(!decision.allowed)throw new HttpError(403,decision.reasonCode,decision.message);
    const contentSnapshot=await this.snapshots.capture(definition,{userId:pin.userId,projectId,sessionId,engineRoot:process.env.AITEST_ENGINE_ROOT});
    return {...definition,memoryInstructions:JSON.stringify(Object.fromEntries(memory)),contentSnapshotId:contentSnapshot.snapshotId};
  }
  /** Re-read grants for the fixed bundle, including dependencies, on every model/tool call. */
  async authorizeSessionInvocation(projectId: string, agentId: string, sessionId: string): Promise<void> {
    const pin = this.publishedPins.get(sessionId);
    if (!pin) throw new HttpError(403, "session_unpinned", "此会话尚未绑定已验证的服务端发布，请创建新任务。");
    if (pin.projectId !== projectId || pin.agentId !== agentId) throw new HttpError(403, "session_forbidden", "会话归属不匹配。");
    const identity = { userId: pin.userId, projectId, agentId, sessionId };
    const ownership = await this.guard.authorizeInvocation(identity, { kind: "session", id: sessionId }, "resume");
    if (!ownership.allowed) throw new HttpError(403, ownership.reasonCode, ownership.message);
    const bundle = await new PublishedBundleCache(this.deps.config.root).load(pin.userId, pin.bundleHash);
    const policy = await this.fetchAccessPolicy(pin.userId, AbortSignal.timeout(5000));
    if (!policy.isAdmin && !policy.modules.includes("chat")) throw new HttpError(403, "module_forbidden", "任务执行权限已收回。");
    if (bundle.resources.some(resource => !policy.resourceIds.includes(resource.id))) {
      this.guard.cancelUser(pin.userId);
      throw new HttpError(403, "resource_revoked", "此任务所用资源已下架或授权已收回。");
    }
  }
  /** Per-invocation authorization used by sessions, connectors and plugin tools. */
  async authorizeInvocation(identity: InvocationIdentity, resource: InvocationResource, operation: InvocationOperation, constraints: InvocationConstraints = {}): Promise<AuthorizationDecision> {
    return this.guard.authorizeInvocation(identity, resource, operation, constraints);
  }
  async beginInvocation(identity: InvocationIdentity, resource: InvocationResource, operation: InvocationOperation, constraints: InvocationConstraints = {}): Promise<InvocationLease> {
    return this.guard.beginInvocation(identity, resource, operation, constraints);
  }
  resourceSyncStatus(userId: string) {
    return this.resourceSync.status(userId);
  }
  resourceSyncStart(userId: string) {
    return this.resourceSync.start(userId);
  }
  taskContentSnapshot(sessionId: string) {
    return this.snapshots.getBySession(sessionId);
  }
  close(): void {
    this.guard.close();
    this.resourceSync.close();
  }
  async uploadKnowledgeCopy(payload: import('../services/qa-knowledge-receiver.js').KnowledgeCopyPayload): Promise<{ remoteRef: string }> {
    const binding = await this.knowledgeBinding(payload.attributionUserId, payload.projectId);
    const response = await this.remote('/api/knowledge-receiver/v1/copies', 'POST', { ...payload, attributionUserId: binding.remote.userId }, binding);
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, 'knowledge_upload_failed', '服务端资料接收失败，可稍后重试。'); }
    return await response.json() as { remoteRef: string };
  }
  async removeKnowledgeCopy(userId: string, input: { projectId: string; uploadId: string }): Promise<{ remoteRef: string; deleted: true }> {
    const binding = await this.knowledgeBinding(userId, input.projectId);
    const response = await this.remote('/api/knowledge-receiver/v1/copies/remove', 'POST', input, binding);
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, 'knowledge_delete_failed', '服务端副本删除未确认，可稍后重试。'); }
    return await response.json() as { remoteRef: string; deleted: true };
  }
  private async knowledgeBinding(userId: string, projectId: string) {
    await this.validateUser(userId);
    await this.authorizeUserPath(userId, `/api/projects/${encodeURIComponent(projectId)}/agents/qa/knowledge`, 'POST');
    const decision = await this.authorizeInvocation({ userId, projectId }, { kind: 'project', id: projectId }, 'write', { requireFresh: true });
    if (!decision.allowed) throw new HttpError(403, decision.reasonCode, '资料操作授权已失效。');
    const binding = [...this.sessions.values()].find(item => item.localId === userId && item.expires > Date.now());
    if (!binding) throw new HttpError(401, 'unauthorized', '请重新登录。');
    return binding;
  }
  private async fetchAccessPolicy(userId: string, signal: AbortSignal) {
    await this.validateUser(userId);
    const binding = [...this.sessions.values()].find(item => item.localId === userId && item.expires > Date.now());
    if (!binding) throw new HttpError(401, "unauthorized", "请重新登录。");
    const response = await this.remote("/api/control/access", "GET", undefined, binding, signal);
    if (!response.ok) throw new HttpError(503, "permissions_unavailable", "无法读取服务端权限。");
    const policy = await response.json() as { modules?: string[]; menuKeys?: string[]; resourceIds?: string[] };
    return { modules: policy.modules ?? [], menuKeys: policy.menuKeys ?? [], resourceIds: policy.resourceIds ?? [], isAdmin: binding.remote.isAdmin };
  }
  private async fetchResolvedBundles(userId: string, signal: AbortSignal): Promise<CatalogBundleItem[]> {
    await this.validateUser(userId);
    const binding = [...this.sessions.values()].find(item => item.localId === userId && item.expires > Date.now());
    if (!binding) throw new HttpError(401, "unauthorized", "请重新登录。");
    const response = await this.remote("/api/control/catalog/roles/resolved", "GET", undefined, binding, signal);
    if (!response.ok) throw new HttpError(503, "resource_catalog_unavailable", "无法读取共享智能体目录。");
    const parsed = await response.json() as { bundles?: ({ agentId: string } & ResolvedPublishedBundle)[] };
    if (!Array.isArray(parsed.bundles)) throw new HttpError(503, "resource_catalog_invalid", "共享智能体目录无效。");
    return parsed.bundles.map(item => ({ agentId: localAgentId(item.agentId), bundle: item }));
  }
  private async checkBinding(binding: Binding) {
    const response = await this.remote("/api/me", "GET", undefined, binding);
    if (response.status === 401 || response.status === 403) {
      for (const [hash,b] of this.sessions) if (b === binding) this.drop(hash,b);
      throw new HttpError(401,"unauthorized","登录已失效。");
    }
    if (!response.ok) throw new HttpError(503,"account_center_unavailable","账号中心无法验证登录。");
    const { user } = await response.json() as {user: UserInfo & {disabled?: boolean}};
    if (user.userId !== binding.remote.userId || user.isAdmin !== binding.remote.isAdmin || user.disabled) throw new HttpError(401,"unauthorized","账号权限已变化。");
  }
  async authorizeUserPath(localId:string,path:string,method:string,requestBody?:string):Promise<void>{
    const binding=[...this.sessions.values()].find(b=>b.localId===localId&&b.expires>Date.now());
    if(!binding)throw new HttpError(401,"unauthorized","请重新登录。");
    const access=await this.remote("/api/control/access","GET",undefined,binding);
    if(!access.ok)throw new HttpError(503,"permissions_unavailable","无法读取服务端权限。");
    const policy=await access.json() as {modules:string[];resourceIds:string[]};
    this.requireModule(binding,path,method,policy.modules??[]);
    this.requireManagedResources(path,method,policy.resourceIds??[],requestBody);
  }
  private requireManagedResources(path:string,method:string,allowed:string[],raw?:string){
    if(["GET","HEAD","OPTIONS","DELETE"].includes(method))return;
    const match=/^\/api\/projects\/([^/]+)\/(?:agents|sessions)/.exec(path);if(!match)return;
    if(!this.deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applied_public_resources'").get())return;
    const project=decodeURIComponent(match[1]!);let agent=/\/agents\/([^/]+)/.exec(path)?.[1];
    const session=/\/sessions\/([^/]+)/.exec(path)?.[1];
    const existing=session?this.deps.db.prepare("SELECT agent_id,provider FROM sessions WHERE session_id=? AND project_id=?").get(session,project):undefined;
    if(existing)agent=String(existing.agent_id);
    let data:any;try{data=raw?JSON.parse(raw):undefined;}catch{}
    agent=agent??data?.agentId;
    const refs=(raw??"")+" "+String(existing?.provider??"");
    for(const row of this.deps.db.prepare("SELECT resource_id,version,agent_id FROM applied_public_resources WHERE project_id=?").all(project)){
      const model="public_"+String(row.resource_id).replaceAll("-","").slice(0,12)+"_v"+row.version;
      if(((agent&&row.agent_id===agent)||refs.includes(model))&&!allowed.includes(String(row.resource_id)))throw new HttpError(403,"resource_revoked","此本地副本的公共资源已下架或授权已收回；已有任务和资料保留。");
    }
  }
  private requireModule(binding:Binding,path:string,method:string,modules=binding.modules??[]) {
    const key=requestModule(path,method);
    if(key&&key!=="models"&&!binding.remote.isAdmin&&!modules.includes(key))throw new HttpError(403,"module_forbidden","你没有此功能模块的权限。");
  }
  private privateProjectScope(userId:string,projectId:string):string {
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(projectId))throw new HttpError(400,"invalid_project_scope","项目范围无效。");
    const previous=this.deps.db.prepare("SELECT scope_id AS scopeId FROM central_private_project_scopes WHERE local_user_id=? AND project_id=?").get(userId,projectId) as {scopeId:string}|undefined;
    if(previous)return previous.scopeId;
    const candidate=`project_${randomBytes(16).toString("hex")}`;
    this.deps.db.prepare("INSERT OR IGNORE INTO central_private_project_scopes VALUES (?,?,?)").run(userId,projectId,candidate);
    return (this.deps.db.prepare("SELECT scope_id AS scopeId FROM central_private_project_scopes WHERE local_user_id=? AND project_id=?").get(userId,projectId) as {scopeId:string}).scopeId;
  }
  private async control(c:Context<AppEnv>):Promise<Response>{
    const held=this.held(c);if(!held)throw new HttpError(401,"unauthorized","请先登录。");
    await this.validate(held.token);
    const endpoint=c.req.path;
    if(endpoint.startsWith("/api/control/admin/")&&!held.binding.remote.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以访问管理后台。");
    if(endpoint==="/api/control/admin/plugin-categories"||endpoint==="/api/control/admin/plugin-categories/assign"||/^\/api\/control\/admin\/plugin-categories\/[a-z0-9_]+$/.test(endpoint)||/^\/api\/control\/admin\/plugin-categories\/assignment\/[a-zA-Z0-9_%.-]+$/.test(endpoint)){
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_plugin_categories(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL)");
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_plugin_category_assignments(plugin_key TEXT PRIMARY KEY,category_id TEXT NOT NULL)");
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_plugin_category_overrides(id TEXT PRIMARY KEY,name TEXT,deleted INTEGER NOT NULL DEFAULT 0)");
      if(endpoint==="/api/control/admin/plugin-categories"&&c.req.method==="GET")return c.json({categories:this.deps.db.prepare("SELECT id,name FROM admin_plugin_categories ORDER BY created_at,id").all(),overrides:this.deps.db.prepare("SELECT id,name,deleted FROM admin_plugin_category_overrides").all(),assignments:this.deps.db.prepare("SELECT plugin_key AS pluginKey,category_id AS categoryId FROM admin_plugin_category_assignments").all()});
      if(endpoint==="/api/control/admin/plugin-categories"&&c.req.method==="POST"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>key!=="name")||typeof body.name!=="string"||!body.name.trim()||body.name.trim().length>40)throw new HttpError(400,"invalid_plugin_category","分类名称无效。");
        const id="cat_"+randomBytes(6).toString("hex");
        try{this.deps.db.prepare("INSERT INTO admin_plugin_categories VALUES (?,?,?)").run(id,body.name.trim(),new Date().toISOString());}
        catch{throw new HttpError(409,"plugin_category_exists","分类名称已存在。");}
        return c.json({id,name:body.name.trim()},201);
      }
      if(endpoint==="/api/control/admin/plugin-categories/assign"&&c.req.method==="PUT"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>!["pluginKey","categoryId"].includes(key))||typeof body.pluginKey!=="string"||! /^(library|module):[^\s]{1,240}$/.test(body.pluginKey)||typeof body.categoryId!=="string"||! /^[a-z][a-z0-9_-]{0,63}$/.test(body.categoryId))throw new HttpError(400,"invalid_plugin_category_assignment","插件或分类无效。");
        if(body.categoryId.startsWith("cat_")&&!this.deps.db.prepare("SELECT 1 FROM admin_plugin_categories WHERE id=?").get(body.categoryId))throw new HttpError(404,"plugin_category_missing","分类不存在。");
        this.deps.db.prepare("INSERT INTO admin_plugin_category_assignments VALUES (?,?) ON CONFLICT(plugin_key) DO UPDATE SET category_id=excluded.category_id").run(body.pluginKey,body.categoryId);
        return c.json({ok:true});
      }
      const assignmentKey=/^\/api\/control\/admin\/plugin-categories\/assignment\/([a-zA-Z0-9_%.-]+)$/.exec(endpoint)?.[1];
      if(assignmentKey&&c.req.method==="DELETE"){
        this.deps.db.prepare("DELETE FROM admin_plugin_category_assignments WHERE plugin_key=?").run(decodeURIComponent(assignmentKey));
        return c.json({ok:true});
      }
      const categoryId=/^\/api\/control\/admin\/plugin-categories\/([a-z0-9_]+)$/.exec(endpoint)?.[1];
      if(categoryId&&c.req.method==="PUT"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>key!=="name")||typeof body.name!=="string"||!body.name.trim()||body.name.trim().length>40)throw new HttpError(400,"invalid_plugin_category","分类名称无效。");
        if(categoryId.startsWith("cat_")){
          const result=this.deps.db.prepare("UPDATE admin_plugin_categories SET name=? WHERE id=?").run(body.name.trim(),categoryId);
          if(!result.changes)throw new HttpError(404,"plugin_category_missing","分类不存在。");
        }else this.deps.db.prepare("INSERT INTO admin_plugin_category_overrides VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,deleted=0").run(categoryId,body.name.trim());
        return c.json({ok:true});
      }
      if(categoryId&&c.req.method==="DELETE"){
        if(this.deps.db.prepare("SELECT 1 FROM admin_plugin_category_assignments WHERE category_id=? LIMIT 1").get(categoryId))throw new HttpError(409,"plugin_category_not_empty","请先移走此分类下的全部插件。");
        if(categoryId.startsWith("cat_")){
          if(!this.deps.db.prepare("SELECT 1 FROM admin_plugin_categories WHERE id=?").get(categoryId))throw new HttpError(404,"plugin_category_missing","分类不存在。");
          this.deps.db.prepare("DELETE FROM admin_plugin_categories WHERE id=?").run(categoryId);
        }else this.deps.db.prepare("INSERT INTO admin_plugin_category_overrides VALUES (?,NULL,1) ON CONFLICT(id) DO UPDATE SET deleted=1").run(categoryId);
        return c.json({ok:true});
      }
      throw new HttpError(405,"method_not_allowed","不支持此操作。");
    }
    if(endpoint==="/api/control/admin/agent-stages"||endpoint==="/api/control/admin/agent-stages/assign"||/^\/api\/control\/admin\/agent-stages\/[a-z0-9_]+$/.test(endpoint)||/^\/api\/control\/admin\/agent-stages\/assignment\/[a-zA-Z0-9_-]+$/.test(endpoint)){
      const defaults=[
        ["common","通用","#64748b"],["req","需求分析","#7b61ff"],["design","测试设计","#0ea5a4"],
        ["case","用例生成","#2ea86e"],["web","Web 自动化","#e8833a"],["api","接口自动化","#d97706"],
        ["app","App 自动化","#8b5cf6"],["mini","小程序自动化","#07a35a"],["report","测试报告","#3b82d4"],
        ["defect","缺陷管理","#e8618c"],
      ];
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_agent_stages(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,builtin INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)");
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_agent_stage_assignments(agent_id TEXT PRIMARY KEY,stage_id TEXT NOT NULL)");
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_agent_stage_deleted(id TEXT PRIMARY KEY)");
      const seed=this.deps.db.prepare("INSERT OR IGNORE INTO admin_agent_stages VALUES (?,?,?,?,?)");
      for(const [id,name,color] of defaults)if(!this.deps.db.prepare("SELECT 1 FROM admin_agent_stage_deleted WHERE id=?").get(id!))seed.run(id!,name!,color!,1,"builtin");
      if(endpoint==="/api/control/admin/agent-stages"&&c.req.method==="GET")return c.json({stages:this.deps.db.prepare("SELECT id,name,color,builtin FROM admin_agent_stages ORDER BY builtin DESC,created_at,id").all(),assignments:this.deps.db.prepare("SELECT agent_id AS agentId,stage_id AS stageId FROM admin_agent_stage_assignments").all()});
      if(endpoint==="/api/control/admin/agent-stages"&&c.req.method==="POST"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>!["name","color"].includes(key))||typeof body.name!=="string"||!body.name.trim()||body.name.trim().length>40||typeof body.color!=="string"||!/^#[a-fA-F0-9]{6}$/.test(body.color))throw new HttpError(400,"invalid_stage","阶段名称或颜色无效。");
        const id="stage_"+randomBytes(6).toString("hex");
        try{this.deps.db.prepare("INSERT INTO admin_agent_stages VALUES (?,?,?,?,?)").run(id,body.name.trim(),body.color,0,new Date().toISOString());}
        catch{throw new HttpError(409,"stage_exists","阶段名称已存在。");}
        return c.json({id,name:body.name.trim(),color:body.color,builtin:0},201);
      }
      if(endpoint==="/api/control/admin/agent-stages/assign"&&c.req.method==="PUT"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>!["agentId","stageId"].includes(key))||typeof body.agentId!=="string"||! /^[a-zA-Z0-9_-]{1,100}$/.test(body.agentId)||typeof body.stageId!=="string"||!this.deps.db.prepare("SELECT 1 FROM admin_agent_stages WHERE id=?").get(body.stageId))throw new HttpError(400,"invalid_stage_assignment","阶段或智能体无效。");
        if(!this.deps.localRequest)throw new HttpError(503,"unavailable","本机服务未就绪。");
        const found=await this.deps.localRequest(held.binding.localId,new Request("http://localhost/api/projects/admin_agent_catalog/agents/"+body.agentId+"/config"));
        if(!found.ok)throw new HttpError(404,"agent_missing","管理员项目中找不到此智能体。");
        this.deps.db.prepare("INSERT INTO admin_agent_stage_assignments VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET stage_id=excluded.stage_id").run(body.agentId,body.stageId);
        return c.json({ok:true});
      }
      const editStageId=/^\/api\/control\/admin\/agent-stages\/([a-z0-9_]+)$/.exec(endpoint)?.[1];
      if(editStageId&&c.req.method==="PUT"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>!["name","color"].includes(key))||typeof body.name!=="string"||!body.name.trim()||body.name.trim().length>40||typeof body.color!=="string"||!/^#[a-fA-F0-9]{6}$/.test(body.color))throw new HttpError(400,"invalid_stage","阶段名称或颜色无效。");
        if(!this.deps.db.prepare("SELECT 1 FROM admin_agent_stages WHERE id=?").get(editStageId))throw new HttpError(404,"stage_missing","阶段不存在。");
        try{this.deps.db.prepare("UPDATE admin_agent_stages SET name=?,color=? WHERE id=?").run(body.name.trim(),body.color,editStageId);}
        catch{throw new HttpError(409,"stage_exists","阶段名称已存在。");}
        return c.json({ok:true});
      }
      const assignmentId=/^\/api\/control\/admin\/agent-stages\/assignment\/([a-zA-Z0-9_-]+)$/.exec(endpoint)?.[1];
      if(assignmentId&&c.req.method==="DELETE"){
        this.deps.db.prepare("DELETE FROM admin_agent_stage_assignments WHERE agent_id=?").run(assignmentId);
        return c.json({ok:true});
      }
      const stageId=/^\/api\/control\/admin\/agent-stages\/([a-z0-9_]+)$/.exec(endpoint)?.[1];
      if(stageId&&c.req.method==="DELETE"){
        const stage=this.deps.db.prepare("SELECT builtin FROM admin_agent_stages WHERE id=?").get(stageId);
        if(!stage)throw new HttpError(404,"stage_missing","阶段不存在。");
        if(this.deps.db.prepare("SELECT 1 FROM admin_agent_stage_assignments WHERE stage_id=? LIMIT 1").get(stageId))throw new HttpError(409,"stage_not_empty","请先移走此阶段下的全部智能体。");
        if(stage.builtin)this.deps.db.prepare("INSERT OR IGNORE INTO admin_agent_stage_deleted VALUES (?)").run(stageId);
        this.deps.db.prepare("DELETE FROM admin_agent_stages WHERE id=?").run(stageId);
        return c.json({ok:true});
      }
      throw new HttpError(405,"method_not_allowed","不支持此操作。");
    }
    if(endpoint==="/api/control/admin/agent-versions" || /^\/api\/control\/admin\/agent-versions\/[a-f0-9-]{36}$/.test(endpoint)){
      this.deps.db.exec("CREATE TABLE IF NOT EXISTS admin_agent_versions(resource_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,root_agent_id TEXT NOT NULL,published_agent_id TEXT NOT NULL,draft_agent_id TEXT NOT NULL,published_version INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)");
      if(c.req.method==="DELETE"){
        const resourceId=endpoint.slice("/api/control/admin/agent-versions/".length);
        const row=this.deps.db.prepare("SELECT published_version AS publishedVersion FROM admin_agent_versions WHERE resource_id=?").get(resourceId);
        if(!row)throw new HttpError(404,"version_missing","版本记录不存在。");
        if(row.publishedVersion)throw new HttpError(409,"version_published","已发布版本记录不能删除。");
        this.deps.db.prepare("DELETE FROM admin_agent_versions WHERE resource_id=?").run(resourceId);
        return c.json({ok:true});
      }
      if(endpoint==="/api/control/admin/agent-versions"&&c.req.method==="GET")return c.json({versions:this.deps.db.prepare("SELECT resource_id AS resourceId,project_id AS projectId,root_agent_id AS rootAgentId,published_agent_id AS publishedAgentId,draft_agent_id AS draftAgentId,published_version AS publishedVersion FROM admin_agent_versions WHERE project_id=?").all("admin_agent_catalog")});
      if(endpoint==="/api/control/admin/agent-versions"&&c.req.method==="PUT"){
        const body=await c.req.json() as Record<string,unknown>;
        if(!body||Object.keys(body).some(key=>!["resourceId","rootAgentId","publishedAgentId","draftAgentId","publishedVersion"].includes(key))||
          typeof body.resourceId!=="string"||! /^[a-f0-9-]{36}$/.test(body.resourceId)||
          typeof body.rootAgentId!=="string"||! /^[a-zA-Z0-9_-]{1,100}$/.test(body.rootAgentId)||
          typeof body.publishedAgentId!=="string"||! /^[a-zA-Z0-9_-]{0,100}$/.test(body.publishedAgentId)||
          typeof body.draftAgentId!=="string"||! /^[a-zA-Z0-9_-]{0,100}$/.test(body.draftAgentId)||
          !Number.isInteger(body.publishedVersion)||Number(body.publishedVersion)<0)throw new HttpError(400,"invalid_agent_version","智能体版本记录无效。");
        this.deps.db.prepare("INSERT INTO admin_agent_versions VALUES (?,?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET published_agent_id=excluded.published_agent_id,draft_agent_id=excluded.draft_agent_id,published_version=excluded.published_version,updated_at=excluded.updated_at")
          .run(body.resourceId,"admin_agent_catalog",body.rootAgentId,body.publishedAgentId,body.draftAgentId,Number(body.publishedVersion),new Date().toISOString());
        return c.json({ok:true});
      }
      throw new HttpError(405,"method_not_allowed","不支持此操作。");
    }
    const archiveId=/^\/api\/control\/archive\/([a-z0-9-]+)$/.exec(endpoint)?.[1];
    if(archiveId&&c.req.method==="GET"){
      const response=await this.remote("/api/control/catalog/"+archiveId,"GET",undefined,held.binding);
      if(!response.ok)return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
      const bundle=await response.json() as {resources:import("../http/control-plane.js").PublicResource[]};
      const resource=bundle.resources.find(item=>item.id===archiveId&&item.kind==="skills");
      if(!resource?.payload.archiveBase64)throw new HttpError(404,"archive_missing","此资源没有完整技能包。");
      return new Response(Buffer.from(String(resource.payload.archiveBase64),"base64"),{headers:{"content-type":"application/zip","content-disposition":`attachment; filename="skill-${archiveId}-v${resource.version}.zip"`,"cache-control":"no-store"}});
    }
    if(endpoint==="/api/control/applied"&&c.req.method==="GET"){
      const projectId=c.req.query("projectId");
      if(!projectId||!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId))throw new HttpError(400,"invalid_target","项目标识无效。");
      if(!this.deps.localRequest)throw new HttpError(503,"unavailable","本机服务未就绪。");
      const response=await this.deps.localRequest(held.binding.localId,new Request("http://localhost/api/projects"));
      if(!response.ok)throw new HttpError(403,"project_forbidden","无法读取此项目。");
      const result=await response.json() as {projects:{projectId:string}[]};
      if(!result.projects.some(project=>project.projectId===projectId))throw new HttpError(403,"project_forbidden","不能读取其他用户的项目。");
      const exists=this.deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applied_public_resources'").get();
      const applied=exists?this.deps.db.prepare("SELECT resource_id AS resourceId,version,agent_id AS agentId FROM applied_public_resources WHERE project_id=?").all(projectId):[];
      return c.json({applied});
    }
    if((endpoint==="/api/control/apply"||endpoint==="/api/control/apply/preview")&&c.req.method==="POST"){
      const body=await c.req.json();
      if(!body||Object.keys(body).some(k=>!["resourceId","projectId","agentId","resolutions"].includes(k))||
        typeof body.resourceId!=="string"||! /^[a-f0-9-]{36}$/.test(body.resourceId)||
        typeof body.projectId!=="string"||! /^[a-zA-Z0-9_-]{1,100}$/.test(body.projectId)||
        (body.agentId!==undefined&&(typeof body.agentId!=="string"||! /^[a-zA-Z0-9_-]{1,100}$/.test(body.agentId)))||
        (body.resolutions!==undefined&&(!body.resolutions||typeof body.resolutions!=="object"||Array.isArray(body.resolutions)||Object.entries(body.resolutions).some(([key,value])=>!["name","description","prompt","agentsMd","maxTurns"].includes(key)||!["local","published"].includes(String(value))))))throw new HttpError(400,"invalid_fields","仅允许本机应用目标和差异处理字段。");
      const response=await this.remote("/api/control/catalog/"+encodeURIComponent(body.resourceId),"GET",undefined,held.binding);
      if(!response.ok)return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
      const bundle=await response.json() as {resources:import("../http/control-plane.js").PublicResource[]};
      if(!this.deps.localRequest)throw new HttpError(503,"unavailable","本机应用服务未就绪。");
      const dispatch=(request:Request)=>this.deps.localRequest!(held.binding.localId,request);
      if(endpoint.endsWith("/preview"))return c.json(await previewPublicAgentUpdate(this.deps.db,body,bundle.resources,dispatch));
      return c.json(await applyPublicResource(this.deps.db,body,bundle.resources,dispatch));
    }
    if(endpoint==="/api/control/agent-template/apply"&&c.req.method==="POST"){
      const body=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
      if(!body||Object.keys(body).some(key=>!["resourceId","projectId","kind","name","startAt","enabled"].includes(key))||
        typeof body.resourceId!=="string"||!/^[a-f0-9-]{36}$/.test(body.resourceId)||
        typeof body.projectId!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(body.projectId)||
        !["schedule","api"].includes(String(body.kind)))throw new HttpError(400,"invalid_template_request","模板应用请求无效。");
      if(!this.deps.localRequest)throw new HttpError(503,"unavailable","本机应用服务未就绪。");
      const response=await this.remote(`/api/control/catalog/${body.resourceId}/resolved`,"GET",undefined,held.binding);
      if(!response.ok)throw new HttpError(response.status as 400,"template_unavailable","中央 Agent 模板不可用。");
      const bundle=await new PublishedBundleCache(this.deps.config.root).store(held.binding.localId,await response.json());
      const agent=bundle.resources[0];
      const agentId=agent?.payload.agentId;
      if(agent?.id!==body.resourceId||agent.kind!=="agents"||typeof agentId!=="string"||!/^[a-z][a-z0-9_-]*$/.test(agentId))throw new HttpError(409,"invalid_template","中央 Agent 没有可用的本地标识。");
      const appliedTable=this.deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='applied_public_resources'").get();
      const applied=appliedTable?this.deps.db.prepare("SELECT agent_id AS agentId FROM applied_public_resources WHERE project_id=? AND resource_id=? ORDER BY version DESC LIMIT 1").get(body.projectId,body.resourceId) as {agentId:string}|undefined:undefined;
      const localTargetAgentId=applied?.agentId||localAgentId(agentId);
      let pathToLocal:string, payload:Record<string,unknown>;
      if(body.kind==="schedule"){
        if(typeof body.name!=="string"||typeof body.startAt!=="string"||body.enabled!==true||!Number.isFinite(Date.parse(body.startAt))||Date.parse(body.startAt)<=Date.now())throw new HttpError(400,"invalid_template_request","请选择模板并提供未来的启动时间。");
        const templates=Array.isArray(agent.payload.scheduleTemplates)?agent.payload.scheduleTemplates as Record<string,unknown>[]:[];
        const selected=templates.find(item=>item.name===body.name);
        if(!selected)throw new HttpError(404,"template_missing","定时任务模板不存在。");
        pathToLocal=`/api/projects/${encodeURIComponent(body.projectId)}/agents/${encodeURIComponent(localTargetAgentId)}/schedules`;
        payload={name:selected.name,prompt:selected.prompt,enabled:true,startAt:body.startAt,...(selected.period===undefined?{}:{period:selected.period})};
      }else{
        if(body.name!==undefined||body.startAt!==undefined||body.enabled!==undefined)throw new HttpError(400,"invalid_template_request","Agent API 模板请求包含无关字段。");
        if(!agent.payload.apiTemplate)throw new HttpError(404,"template_missing","Agent API 模板不存在。");
        pathToLocal=`/api/projects/${encodeURIComponent(body.projectId)}/agents/${encodeURIComponent(localTargetAgentId)}/api`;
        payload=agent.payload.apiTemplate as Record<string,unknown>;
      }
      this.requireModule(held.binding,pathToLocal,body.kind==="schedule"?"POST":"PUT");
      const local=await this.deps.localRequest(held.binding.localId,new Request("http://localhost"+pathToLocal,{method:body.kind==="schedule"?"POST":"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}));
      return new Response(await local.text(),{status:local.status,headers:{"content-type":"application/json"}});
    }
    const centralAgentAdmin=/^\/api\/control\/admin\/(agent-cards|agent-defaults|resources\/[a-f0-9-]{36}\/(storage|snapshot|kernel-update|versions\/[1-9]\d*\/resolved))$/.test(endpoint);
    const centralPrivate=/^\/api\/control\/private\/agents\/[a-f0-9-]{36}\/(memory|vault)$/.test(endpoint);
    const centralSkills=/^\/api\/control\/skills\/(catalog|admin(?:\/[a-f0-9-]{36}(?:\/export)?)?|categories(?:\/assign|\/assignment\/[a-z0-9_-]+|\/[a-z0-9_]+)?)$/.test(endpoint);
    const valid=(centralSkills && ["GET","POST","PUT","DELETE"].includes(c.req.method)) ||
      (c.req.method==="GET"&&/^\/api\/control\/(access|catalog(?:\/roles(?:\/resolved)?|\/[a-z0-9-]+(?:\/resolved)?)?|admin\/(resources(?:\/[a-z0-9-]+\/history)?|agent-groups|permissions\/[a-z][a-z0-9_]*|roles|menus|audit))$/.test(endpoint)) ||
      (["POST","PUT"].includes(c.req.method)&&/^\/api\/control\/admin\/(resources(?:\/validate|\/[a-z0-9-]+(?:\/(publish|withdraw|rollback|validate|copy))?)?|agent-groups(?:\/assign|\/[a-z0-9_]+)?|permissions\/[a-z][a-z0-9_]*|roles(?:\/[a-f0-9-]{36})?|role-members\/[a-z][a-z0-9_]*|menus)$/.test(endpoint)) ||
      (c.req.method==="DELETE"&&/^\/api\/control\/admin\/(resources\/[a-z0-9-]+(?:\/copy)?|agent-groups\/[a-z0-9_]+|roles\/[a-f0-9-]{36})$/.test(endpoint)) ||
      (centralAgentAdmin && (c.req.method==="GET" || (c.req.method==="POST" && /\/(snapshot|kernel-update)$/.test(endpoint)))) ||
      (centralPrivate && ["GET","PUT","DELETE"].includes(c.req.method));
    if(!valid)throw new HttpError(404,"not_found","未知管理接口。");
    const url=new URL(c.req.url);
    let requestBody=c.req.method==="GET"?undefined:await c.req.json();
    if(centralPrivate){
      if(c.req.method==="GET"&&url.searchParams.get("scope")==="project")url.searchParams.set("projectId",this.privateProjectScope(held.binding.localId,url.searchParams.get("projectId")??""));
      if(c.req.method!=="GET"&&requestBody?.scope==="project")requestBody={...requestBody,projectId:this.privateProjectScope(held.binding.localId,String(requestBody.projectId??""))};
    }
    const response=await this.remote(endpoint+url.search,c.req.method,requestBody,held.binding);
    if(response.ok && c.req.method==="GET" && /^\/api\/control\/catalog\/[a-f0-9-]{36}\/resolved$/.test(endpoint)) {
      const bundle=await new PublishedBundleCache(this.deps.config.root).store(held.binding.localId,await response.json());
      return c.json(bundle);
    }
    return new Response(response.status===204?null:await response.text(),{status:response.status,headers:{"content-type":response.headers.get("content-type")??"application/json",...(response.headers.has("content-disposition")?{"content-disposition":response.headers.get("content-disposition")!}:{})}});
  }
  private async localUser(remote: UserInfo, centralCookie: string): Promise<string> {
    const pending = this.creating.get(remote.userId);
    if (pending) return pending;
    const create = (async () => {
      const db = this.deps.db;
      const existing = db.prepare("SELECT local_id FROM account_center_bindings WHERE origin=? AND remote_id=?").get(this.cfg.origin,remote.userId);
      if (existing) {
        if (existing.local_id === "admin" && (!remote.isAdmin || remote.userId !== this.cfg.ownerUserId)) throw new HttpError(403,"owner_admin_required","中央账号不能认领本机管理员资料。");
        return existing.local_id as string;
      }
      const owner = remote.userId === this.cfg.ownerUserId;
      if (owner && !remote.isAdmin) throw new HttpError(403,"owner_admin_required","绑定的本机管理员必须具有中央管理员权限。");
      const id = owner ? "admin" : "acct_" + createHash("sha256").update(this.cfg.origin + "\n" + remote.userId).digest("hex").slice(0,24);
      if (!owner) {
        if (this.deps.users().findById(id)) throw new HttpError(409,"local_identity_collision","本地身份冲突，不能自动认领已有数据。");
        this.provisionalCookies.set(id,centralCookie);
        try { await this.deps.admin().createUser(id, randomBytes(32).toString("base64url")); }
        finally { this.provisionalCookies.delete(id); }
        // A local unusable random password is never a second sign-in credential.
        const row = this.deps.users().findById(id)!;
        this.deps.users().updatePassword(id,row.passwordHash,false);
        this.deps.users().updateProfile(id,{displayName:remote.userId});
      }
      db.prepare("INSERT INTO account_center_bindings(origin,remote_id,local_id) VALUES (?,?,?)").run(this.cfg.origin,remote.userId,id);
      return id;
    })().finally(() => this.creating.delete(remote.userId));
    this.creating.set(remote.userId,create); return create;
  }
  private held(c: Context<AppEnv>): {token:string; binding:Binding} | null {
    for (const {token} of sessionCookies(getCookie(c),c.req.url)) {
      const binding = this.sessions.get(sessionTokenHash(token));
      if (binding && binding.expires > Date.now()) return {token,binding};
    }
    return null;
  }
  private async login(c: Context<AppEnv>) {
    const body = await c.req.json() as Record<string,unknown>;
    if (Object.keys(body).some(k => !["userId","password"].includes(k)) || typeof body.userId !== "string" || typeof body.password !== "string" || body.userId.length > 32 || body.password.length > 128) throw new HttpError(400,"invalid_credentials","请输入有效的账号和密码。");
    const response = await this.remote("/api/auth/login","POST",body);
    if (!response.ok) return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
    const {user} = await response.json() as {user:UserInfo};
    const cookie = response.headers.getSetCookie().find(v=>v.startsWith("penguin_session="))?.split(";")[0];
    if (!cookie || !/^[a-z][a-z0-9_]{1,31}$/.test(user.userId)) throw new HttpError(502,"invalid_account_center","账号中心响应无效。");
    if(c.req.path==="/api/auth/admin-login"&&!user.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以登录管理后台。");
    const localId=await this.localUser(user,cookie);
    const shell = getCookie(c,"aitest_shell");
    const via = shell && this.shellClaims.has(shell) ? "desktop" : "password";
    const {token}=this.deps.sessions().issue({userId:localId,via,now:new Date(),ttlMs:this.deps.config.authSessionTtlMs});
    this.sessions.set(sessionTokenHash(token),{remote:user,localId,cookie,expires:Date.now()+this.deps.config.authSessionTtlMs});
    this.deps.db.prepare("INSERT INTO account_center_sessions(token_hash,origin,local_id,remote_json,central_cookie,expires_at) VALUES (?,?,?,?,?,?)")
      .run(sessionTokenHash(token),this.cfg.origin,localId,JSON.stringify(user),this.cookieSeal.seal(cookie),new Date(Date.now()+this.deps.config.authSessionTtlMs).toISOString());
    setCookie(c,sessionCookieName(c.req.url,c.req.header("origin")!==undefined),token,cookieOptions(c,this.deps.config.authSessionTtlMs,this.deps.config.trustProxy));
    this.resourceSync.start(localId);
    const info=toUserInfo(this.deps.users().findById(localId)!);
    return c.json({user:{...info,passwordIsInitial:false}});
  }
  middleware(redeemDesktop: (token:string)=>boolean): MiddlewareHandler<AppEnv> {
    const cap=bodyLimit({maxSize:8192});
    return async (c,next) => {
      const pathname=c.req.path;
      if(pathname.startsWith("/api/control/")) return bodyLimit({maxSize:2*1024*1024})(c,async()=>{c.res=await this.control(c);});
      if (pathname==="/api/account-client/config") return c.json({enabled:true,origin:this.cfg.origin});
      const proxy=pathname.startsWith("/api/account-client/api/");
      const endpoint=proxy ? pathname.slice("/api/account-client".length) : pathname;
      if (["/api/auth/admin-login","/api/auth/login","/api/auth/register","/api/auth/logout"].includes(endpoint) || proxy) {
        return cap(c,async()=>{ c.res=await this.identityRoute(c,endpoint,next); });
      }
      if (pathname==="/api/auth/claim") {
        if (redeemDesktop(c.req.query("token")??"")) {
          const marker=randomBytes(24).toString("base64url"); this.shellClaims.add(marker);
          setCookie(c,"aitest_shell",marker,cookieOptions(c,this.deps.config.authSessionTtlMs,false));
        }
        return c.redirect("/login",302);
      }
      // Local API credentials belong to the machine/ongoing agents, never sent to the center.
      if (bearerToken(c.req.header("authorization"))!==null) return next();
      const protectedPath=pathname.startsWith("/api/") || pathname.startsWith("/server/");
      if (!protectedPath || pathname==="/api/install") return next();
      const held=this.held(c);
      if (!held) throw new HttpError(401,"unauthorized","请登录服务端账号。");
      await this.validate(held.token);
      if (pathname==="/api/account-client/status") return c.json({enabled:true,origin:this.cfg.origin,sync:this.resourceSync.status(held.binding.localId)});
      this.requireModule(held.binding,pathname,c.req.method);
      this.requireManagedResources(pathname,c.req.method,held.binding.resourceIds??[],["POST","PUT","PATCH"].includes(c.req.method)?await c.req.raw.clone().text():undefined);
      if (pathname==="/api/me/password" || pathname.startsWith("/api/admin/users")) return this.identityRoute(c,pathname,next);
      await next();
      if (pathname==="/api/me" && c.res.ok) {
        const body=await c.res.json() as Record<string,unknown> & {user:UserInfo};
        c.res=c.json({...body,accountClient:true,modulePermissions:held.binding.modules??[],centralUser:held.binding.remote,user:{...body.user,modulePermissions:held.binding.modules??[],menuKeys:held.binding.menuKeys??[],passwordIsInitial:false,displayName:body.user.displayName??held.binding.remote.userId}});
      }
    };
  }
  private async identityRoute(c: Context<AppEnv>, endpoint:string, next:()=>Promise<void>): Promise<Response> {
    const method=c.req.method;
    if (["/api/auth/login","/api/auth/admin-login"].includes(endpoint) && method==="POST") return this.login(c);
    const held=this.held(c);
    if (endpoint==="/api/auth/logout" && method==="POST") {
      if (held) { this.drop(sessionTokenHash(held.token),held.binding); await this.remote(endpoint,"POST",{},held.binding).catch(()=>{}); }
      for (const {name} of sessionCookies(getCookie(c),c.req.url)) deleteCookie(c,name,{path:"/"});
      return c.body(null,204);
    }
    const publicRoute=(endpoint==="/api/auth/registration" && method==="GET") || (endpoint==="/api/auth/register" && method==="POST");
    if (!publicRoute) {
      if (!held) throw new HttpError(401,"unauthorized","请登录服务端账号。");
      await this.validate(held.token);
    }
    const allowed=publicRoute || (method==="GET" && ["/api/me","/api/admin/users"].includes(endpoint)) ||
      (method==="PUT" && endpoint==="/api/me/password") || (method==="POST" && ["/api/me/sessions/revoke","/api/admin/users"].includes(endpoint)) ||
      (method==="PUT" && /^\/api\/admin\/users\/[a-z][a-z0-9_]{1,31}\/status$/.test(endpoint)) ||
      (method==="POST" && /^\/api\/admin\/users\/[a-z][a-z0-9_]{1,31}\/(password|sessions\/revoke)$/.test(endpoint));
    if (!allowed) throw new HttpError(404,"not_found","账号桥接仅提供身份接口。");
    if (endpoint.startsWith("/api/admin/") && !held?.binding.remote.isAdmin) throw new HttpError(403,"admin_required","仅管理员可管理账号。");
    const body=method==="GET" ? undefined : await c.req.json();
    if (body !== undefined) {
      const keys=endpoint.endsWith("/status") ? ["disabled"] : endpoint==="/api/me/password" ? ["oldPassword","newPassword"] : endpoint.endsWith("/password") ? ["password"] : ["/api/auth/register","/api/admin/users"].includes(endpoint) ? ["userId","password"] : [];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k=>!keys.includes(k))) throw new HttpError(400,"invalid_account_fields","只允许发送账号字段。");
    }
    const response=await this.remote(endpoint,method,body,held?.binding);
    if (response.ok && held && (endpoint==="/api/me/password" || endpoint==="/api/me/sessions/revoke")) this.drop(sessionTokenHash(held.token),held.binding);
    return new Response(response.status===204?null:await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
  }
}
