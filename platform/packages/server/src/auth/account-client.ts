/** Central identity only. Project contents, preferences and model credentials never cross this bridge. */
import { requestModule } from "./module-access.js";
import { applyPublicResource } from "./public-resource-apply.js";
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

type Binding = { remote: UserInfo; localId: string; cookie: string; expires: number; modules?:string[]; resourceIds?:string[] };
type Deps = { config: ServerConfig; db: DatabaseSync; auth: () => Auth; sessions: () => AuthSessions; users: () => Users; admin: () => Admin; streams: () => LiveStreams; fetch?: typeof fetch; localRequest?: (userId:string,request:Request)=>Promise<Response> };
export class AccountClient {
  private readonly sessions = new Map<string, Binding>();
  private readonly checks = new Map<Binding, Promise<void>>();
  private readonly creating = new Map<string, Promise<string>>();
  private readonly shellClaims = new Set<string>();
  private readonly cfg: AccountClientConfig;
  constructor(private readonly deps: Deps) {
    this.cfg = deps.config.accountClient!;
    // Explicit binding, including the center origin: changing servers cannot adopt another person's files.
    deps.db.exec("CREATE TABLE IF NOT EXISTS account_center_bindings (origin TEXT NOT NULL, remote_id TEXT NOT NULL, local_id TEXT NOT NULL UNIQUE, PRIMARY KEY(origin, remote_id))");
    const previous = deps.db.prepare("SELECT origin FROM account_center_bindings LIMIT 1").get();
    if (previous && previous.origin !== this.cfg.origin) throw new Error("Account center changed: explicit local data migration required");
  }
  accepts(token: string): boolean {
    const binding = this.sessions.get(sessionTokenHash(token));
    return !!binding && binding.expires > Date.now();
  }
  private drop(hash: string, binding: Binding) {
    this.sessions.delete(hash);
    this.deps.sessions().delete(hash);
    this.deps.streams().endForUser(binding.localId);
  }
  private async remote(endpoint: string, method = "GET", body?: unknown, binding?: Binding): Promise<Response> {
    try {
      return await (this.deps.fetch ?? fetch)(this.cfg.origin + endpoint, {
        method, redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", ...(binding ? { cookie: binding.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HttpError(503, "account_center_unavailable", "账号中心暂时无法连接，请恢复连接后重试。本地资料和已有任务保留。"); }
  }
  async validate(token: string): Promise<void> {
    const hash = sessionTokenHash(token), binding = this.sessions.get(hash);
    if (!binding || binding.expires <= Date.now()) throw new HttpError(401, "unauthorized", "请登录中央账号。");
    let check = this.checks.get(binding);
    if (!check) {
      check = (async () => {
        const response = await this.remote("/api/me", "GET", undefined, binding);
        if (response.status === 401 || response.status === 403) { this.drop(hash, binding); throw new HttpError(401, "unauthorized", "账号登录已失效，请重新登录。"); }
        if (!response.ok) throw new HttpError(503, "account_center_unavailable", "账号中心无法验证登录，请稍后重试。");
        const { user } = await response.json() as { user: UserInfo & { disabled?: boolean } };
        if (user.userId !== binding.remote.userId || user.isAdmin !== binding.remote.isAdmin || user.disabled) { this.drop(hash, binding); throw new HttpError(401, "unauthorized", "账号权限已变化，请重新登录。"); }
        const access=await this.remote("/api/control/access","GET",undefined,binding);
        if(!access.ok) throw new HttpError(503,"permissions_unavailable","无法读取中央权限，请稍后重试。");
        const policy=await access.json() as {modules?:string[];resourceIds?:string[]};
        binding.modules=policy.modules??[]; binding.resourceIds=policy.resourceIds??[];
        const renewed = response.headers.getSetCookie().find(v => v.startsWith("penguin_session="));
        if (renewed) binding.cookie = renewed.split(";")[0]!;
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
    if(!access.ok)throw new HttpError(503,"permissions_unavailable","无法读取中央权限。");
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
  private async control(c:Context<AppEnv>):Promise<Response>{
    const held=this.held(c);if(!held)throw new HttpError(401,"unauthorized","请先登录。");
    await this.validate(held.token);
    const endpoint=c.req.path;
    if(endpoint.startsWith("/api/control/admin/")&&!held.binding.remote.isAdmin)throw new HttpError(403,"admin_required","仅管理员可以访问管理后台。");
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
    if(endpoint==="/api/control/apply"&&c.req.method==="POST"){
      const body=await c.req.json();
      if(!body||Object.keys(body).some(k=>!["resourceId","projectId","agentId"].includes(k)))throw new HttpError(400,"invalid_fields","仅允许本机应用目标字段。");
      const response=await this.remote("/api/control/catalog/"+encodeURIComponent(body.resourceId),"GET",undefined,held.binding);
      if(!response.ok)return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
      const bundle=await response.json() as {resources:import("../http/control-plane.js").PublicResource[]};
      if(!this.deps.localRequest)throw new HttpError(503,"unavailable","本机应用服务未就绪。");
      return c.json(await applyPublicResource(this.deps.db,body,bundle.resources,request=>this.deps.localRequest!(held.binding.localId,request)));
    }
    const valid=(c.req.method==="GET"&&/^\/api\/control\/(access|catalog(?:\/[a-z0-9-]+)?|admin\/(resources(?:\/[a-z0-9-]+\/history)?|permissions\/[a-z][a-z0-9_]*|audit))$/.test(endpoint)) ||
      (["POST","PUT"].includes(c.req.method)&&/^\/api\/control\/admin\/(resources(?:\/[a-z0-9-]+(?:\/(publish|withdraw))?)?|permissions\/[a-z][a-z0-9_]*)$/.test(endpoint)) ||
      (c.req.method==="DELETE"&&/^\/api\/control\/admin\/resources\/[a-z0-9-]+$/.test(endpoint));
    if(!valid)throw new HttpError(404,"not_found","未知管理接口。");
    const response=await this.remote(endpoint,c.req.method,c.req.method==="GET"?undefined:await c.req.json(),held.binding);
    return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json"}});
  }
  private async localUser(remote: UserInfo): Promise<string> {
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
        await this.deps.admin().createUser(id, randomBytes(32).toString("base64url"));
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
    const localId=await this.localUser(user);
    const shell = getCookie(c,"aitest_shell");
    const via = shell && this.shellClaims.has(shell) ? "desktop" : "password";
    const {token}=this.deps.sessions().issue({userId:localId,via,now:new Date(),ttlMs:this.deps.config.authSessionTtlMs});
    this.sessions.set(sessionTokenHash(token),{remote:user,localId,cookie,expires:Date.now()+this.deps.config.authSessionTtlMs});
    setCookie(c,sessionCookieName(c.req.url,c.req.header("origin")!==undefined),token,cookieOptions(c,this.deps.config.authSessionTtlMs,this.deps.config.trustProxy));
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
      if (!held) throw new HttpError(401,"unauthorized","请登录中央账号。");
      await this.validate(held.token);
      this.requireModule(held.binding,pathname,c.req.method);
      this.requireManagedResources(pathname,c.req.method,held.binding.resourceIds??[],["POST","PUT","PATCH"].includes(c.req.method)?await c.req.raw.clone().text():undefined);
      if (pathname==="/api/me/password" || pathname.startsWith("/api/admin/users")) return this.identityRoute(c,pathname,next);
      await next();
      if (pathname==="/api/me" && c.res.ok) {
        const body=await c.res.json() as Record<string,unknown> & {user:UserInfo};
        c.res=c.json({...body,accountClient:true,modulePermissions:held.binding.modules??[],centralUser:held.binding.remote,user:{...body.user,modulePermissions:held.binding.modules??[],passwordIsInitial:false,displayName:body.user.displayName??held.binding.remote.userId}});
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
      if (!held) throw new HttpError(401,"unauthorized","请登录中央账号。");
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
