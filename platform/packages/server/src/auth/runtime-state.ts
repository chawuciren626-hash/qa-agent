/**
 * The auth values that belong to the PROCESS, not to the App built on top of it.
 *
 * Auth policy — who may set a password, how long a session lasts, how logins are throttled —
 * is business behaviour and lives in the platform, so it ships by push. But a couple of values
 * must outlive a push while still dying at a restart: the first-login link a boot printed is
 * compared verbatim at redemption, so a swap that forgot it would strand whoever is holding
 * the link the console shows, and the local API token was written to `<root>/api-token` at
 * boot — a swap that forgot it would 401 every CLI and every command subprocess still
 * holding the file's value.
 *
 * That is the state layer of the four-layer model (packages/hmr/README.md): a runtime resource the
 * platform claims, riding across swaps and never across restarts. The holder is deliberately
 * a plain mutable bag rather than a service — it carries no behaviour to go stale, so a
 * platform newer than its runtime can still use one an older runtime published.
 */
export interface AccountClientGate {
  beginInvocation(identity: import('./invocation-authorization.js').InvocationIdentity, resource: import('./invocation-authorization.js').InvocationResource, operation: import('./invocation-authorization.js').InvocationOperation, constraints?: import('./invocation-authorization.js').InvocationConstraints): Promise<import('./invocation-authorization.js').InvocationLease>;
  uploadKnowledgeCopy(payload: import('../services/qa-knowledge-receiver.js').KnowledgeCopyPayload): Promise<{ remoteRef: string }>;
  removeKnowledgeCopy(userId: string, input: { projectId: string; uploadId: string }): Promise<{ remoteRef: string; deleted: true }>;
  close(): void;
  authorizeSessionInvocation(projectId: string, agentId: string, sessionId: string): Promise<void>;
  authorizeInvocation(identity: import("./invocation-authorization.js").InvocationIdentity, resource: import("./invocation-authorization.js").InvocationResource, operation: import("./invocation-authorization.js").InvocationOperation, constraints?: import("./invocation-authorization.js").InvocationConstraints): Promise<import("./invocation-authorization.js").AuthorizationDecision>;
  authorizeUserPath(userId:string,path:string,method:string,requestBody?:string):Promise<void>;
  accepts(token: string): boolean;
  validate(token: string): Promise<void>;
  validateUser(userId: string): Promise<void>;
  resolveRoleBundle(userId: string, agentId: string): Promise<unknown | null>;
  listSharedRoleIds(userId: string): Promise<string[]>;
  pinPublishedSession(userId: string, projectId: string, agentId: string, sessionId: string): Promise<boolean>;
  resolvePinnedDefinition(projectId: string, agentId: string, sessionId: string, parentSessionId?: string): Promise<import("./published-bundle-cache.js").CachedSharedAgentDefinition | null>;
  /**
   * B3 状态登记（客户端开始测试前置闸）：平台镜像任务开工前经本地 sync worker 登记服务端；
   * 返回 null = 未配置同步（不拦截，单机模式直接开工）。抛错 = 登记
   * 失败（离线/冲突），调用方转 409 拦截提示。
   */
  registerPlatformTaskState(userId: string, serverLinkId: string, status: string): Promise<{ applied: boolean; status: string; revision: number; reason: string | null } | null>;
}
import type { Opaque } from "@prismshadow/penguin-core/kernel";
export interface AuthRuntimeState {
  localExecution?: Opaque<"LocalExecutionRuntime", import("../services/local-execution-runtime.js").LocalExecutionRuntime>;
  centralAssistant?: Pick<import("../http/central-assistant.js").CentralAssistant, "definition">;
  accountClient?: AccountClientGate;
  /** The first-login link this boot printed, or null before one was minted. */
  firstLoginToken: string | null;
  /**
   * This boot's local API token (auth/api-token.ts), installed by the startup assembly.
   * Null in constructions that never minted one — they simply never authenticate a Bearer
   * header.
   */
  apiToken: string | null;
}

export function newAuthRuntimeState(): AuthRuntimeState {
  return { firstLoginToken: null, apiToken: null };
}
