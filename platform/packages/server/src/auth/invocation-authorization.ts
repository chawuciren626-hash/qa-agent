import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Identity of the local caller. The current product has no tenant entity; tenantId is intentionally absent. */
export interface InvocationIdentity {
  userId: string;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  deviceId?: string;
}

export type InvocationResourceKind = "agents" | "skills" | "plugins" | "models" | "connectors" | "session" | "project";

export interface InvocationResource {
  kind: InvocationResourceKind;
  id: string;
  version?: number;
  bundleHash?: string;
}

export type InvocationOperation = "invoke" | "tool" | "read" | "write" | "resume";

export interface InvocationConstraints {
  requireFresh?: boolean;
  timeoutMs?: number;
  deadlineAt?: number;
  toolName?: string;
  permissions?: readonly string[];
}

/** The subset of the central access policy this local process is allowed to see. */
export interface CentralAccessPolicy {
  revision?: string;
  modules: readonly string[];
  menuKeys?: readonly string[];
  resourceIds: readonly string[];
  isAdmin?: boolean;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: AuthorizationReason;
  message: string;
  decisionId: string;
  userId: string;
  projectId?: string;
  sessionId?: string;
  resource: InvocationResource;
  operation: InvocationOperation;
  policyRevision: string;
  checkedAt: number;
  expiresAt: number;
  constraints: { timeoutMs?: number; deadlineAt?: number; toolName?: string; permissions?: string[] };
  usedCachedPolicy: boolean;
}

export type AuthorizationReason =
  | "allowed"
  | "identity_unknown"
  | "policy_unavailable"
  | "policy_invalid"
  | "resource_revoked"
  | "resource_not_found"
  | "cross_user_resource"
  | "project_forbidden"
  | "session_forbidden"
  | "connector_forbidden"
  | "permission_not_granted"
  | "decision_expired"
  | "invocation_cancelled";

export interface InvocationLease {
  decision: AuthorizationDecision;
  signal: AbortSignal;
  /** Re-check immediately before the controlled call actually leaves the process. */
  confirm(): Promise<AuthorizationDecision>;
  cancel(reason?: string): void;
  release(): void;
  cancelled: boolean;
}

export interface InvocationGuardDeps {
  db: DatabaseSync;
  /** Fetch a fresh central policy; must honour the abort signal. */
  fetchPolicy: (userId: string, signal: AbortSignal) => Promise<CentralAccessPolicy>;
  now?: () => number;
  decisionTtlMs?: number;
  maxCachedPolicyAgeMs?: number;
  randomId?: () => string;
}

const MAX_ID = 200;

interface CachedPolicy {
  policy: CentralAccessPolicy;
  fetchedAt: number;
}

const MANAGED_KINDS = new Set<InvocationResourceKind>(["agents", "skills", "plugins", "models"]);

/**
 * Per-invocation authorization for every controlled local call. A UI menu is not an
 * authorization boundary: old sessions, connectors and plugin tools all pass through here.
 */
export class InvocationGuard {
  private readonly db: DatabaseSync;
  private readonly fetchPolicy: (userId: string, signal: AbortSignal) => Promise<CentralAccessPolicy>;
  private readonly now: () => number;
  private readonly decisionTtlMs: number;
  private readonly maxCachedPolicyAgeMs: number;
  private readonly randomId: () => string;
  private readonly policies = new Map<string, CachedPolicy>();
  private readonly generations = new Map<string, number>();
  private closed = false;
  private readonly active = new Map<string, { userId: string; sessionId?: string; controller: AbortController; cancelled: boolean }>();

  constructor(deps: InvocationGuardDeps) {
    this.db = deps.db;
    this.fetchPolicy = deps.fetchPolicy;
    this.now = deps.now ?? (() => Date.now());
    this.decisionTtlMs = deps.decisionTtlMs ?? 5_000;
    this.maxCachedPolicyAgeMs = deps.maxCachedPolicyAgeMs ?? 5 * 60_000;
    this.randomId = deps.randomId ?? randomUUID;
    this.db.exec(`CREATE TABLE IF NOT EXISTS invocation_authorization_decisions (
      decision_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      reason_code TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      detail_json TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS invocation_authorization_decisions_user ON invocation_authorization_decisions(user_id, checked_at)");
  }

  /**
   * Authorize one invocation. Local ownership is checked before the network call; the central
   * policy is fetched fresh unless the caller explicitly accepts a recently verified policy.
   */
  async authorizeInvocation(
    identity: InvocationIdentity,
    resource: InvocationResource,
    operation: InvocationOperation,
    constraints: InvocationConstraints = {},
  ): Promise<AuthorizationDecision> {
    const decision = await this.evaluate(identity, resource, operation, constraints);
    this.record(decision);
    return decision;
  }

  /** Begin a cancellable call. Revocation after this point aborts the signal before dispatch. */
  async beginInvocation(
    identity: InvocationIdentity,
    resource: InvocationResource,
    operation: InvocationOperation,
    constraints: InvocationConstraints = {},
  ): Promise<InvocationLease> {
    const generation = this.generations.get(identity.userId) ?? 0;
    const decision = await this.authorizeInvocation(identity, resource, operation, constraints);
    if (!decision.allowed) throw new AuthorizationError(decision);
    if (this.closed || generation !== (this.generations.get(identity.userId) ?? 0)) {
      throw new AuthorizationError(this.denied(identity, resource, operation, constraints, "invocation_cancelled", "调用已被撤销。"));
    }
    const decisionId = `${decision.decisionId}:lease`;
    const controller = new AbortController();
    const entry = { userId: identity.userId, ...(identity.sessionId ? { sessionId: identity.sessionId } : {}), controller, cancelled: false };
    this.active.set(decisionId, entry);
    let released = false;
    const lease: InvocationLease = {
      decision,
      signal: controller.signal,
      get cancelled() { return entry.cancelled; },
      confirm: async () => {
        if (entry.cancelled || released) {
          const denied = this.denied(identity, resource, operation, constraints, "invocation_cancelled", "调用已被撤销。");
          this.record(denied);
          return denied;
        }
        if (decision.expiresAt <= this.now()) {
          const denied = this.denied(identity, resource, operation, constraints, "decision_expired", "授权快照已过期，请重新发起调用。");
          this.record(denied);
          return denied;
        }
        let rechecked = await this.evaluate(identity, resource, operation, {...constraints, requireFresh: true});
        if (entry.cancelled || released) rechecked = this.denied(identity, resource, operation, constraints, "invocation_cancelled", "调用已被撤销。");
        this.record(rechecked);
        if (!rechecked.allowed) { entry.cancelled = true; controller.abort(); }
        return rechecked;
      },
      cancel: () => {
        entry.cancelled = true;
        controller.abort();
      },
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(decisionId);
      },
    };
    return lease;
  }

  /** Account logout/binding revocation interrupts everything still owned by that user. */
  cancelUser(userId: string): void {
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    this.policies.delete(userId);
    for (const [id, entry] of this.active) {
      if (entry.userId !== userId) continue;
      entry.cancelled = true;
      entry.controller.abort();
      this.active.delete(id);
    }
  }

  cancelSession(sessionId: string): void {
    for (const [id, entry] of this.active) {
      if (entry.sessionId !== sessionId) continue;
      entry.cancelled = true;
      entry.controller.abort();
      this.active.delete(id);
    }
  }

  activeCount(userId?: string): number {
    let count = 0;
    for (const [, entry] of this.active) if (!userId || entry.userId === userId) count++;
    return count;
  }

  close(): void {
    this.closed = true;
    for (const [, entry] of this.active) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    this.active.clear();
    this.policies.clear();
  }

  history(userId: string, limit = 20): AuthorizationDecision[] {
    const rows = this.db.prepare("SELECT * FROM invocation_authorization_decisions WHERE user_id=? ORDER BY checked_at DESC, decision_id DESC LIMIT ?").all(userId, Math.max(1, Math.min(100, limit)));
    return rows.map(row => ({
      allowed: Boolean(row.allowed),
      reasonCode: String(row.reason_code) as AuthorizationReason,
      message: String((JSON.parse(String(row.detail_json)) as { message?: string }).message ?? ""),
      decisionId: String(row.decision_id),
      userId: String(row.user_id),
      ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
      resource: { kind: String(row.resource_kind) as InvocationResourceKind, id: String(row.resource_id) },
      operation: String(row.operation) as InvocationOperation,
      policyRevision: String(row.policy_revision),
      checkedAt: Date.parse(String(row.checked_at)),
      expiresAt: Date.parse(String(row.expires_at)),
      constraints: {},
      usedCachedPolicy: false,
    }));
  }

  private async evaluate(identity: InvocationIdentity, resource: InvocationResource, operation: InvocationOperation, constraints: InvocationConstraints): Promise<AuthorizationDecision> {
    if (this.closed) return this.denied(identity, resource, operation, constraints, "invocation_cancelled", "授权服务已关闭。");
    if (constraints.deadlineAt !== undefined && constraints.deadlineAt <= this.now()) return this.denied(identity, resource, operation, constraints, "decision_expired", "调用期限已过。");
    const generation = this.generations.get(identity.userId) ?? 0;
    const invalid = this.validate(identity, resource);
    if (invalid) return this.denied(identity, resource, operation, constraints, invalid.reason, invalid.message);
    if (resource.kind === "project" && (!this.projectAccess(identity.userId, resource.id) || (identity.projectId && identity.projectId !== resource.id))) {
      return this.denied(identity, resource, operation, constraints, "project_forbidden", "无权访问此项目。");
    }
    if (identity.sessionId && resource.kind !== "session") {
      const forbidden = this.sessionCheck(identity, identity.sessionId);
      if (forbidden) return this.denied(identity, resource, operation, constraints, forbidden, "会话归属不匹配。");
    }
    if (identity.projectId && resource.kind !== "session" && resource.kind !== "connectors" && !this.projectAccess(identity.userId, identity.projectId)) {
      return this.denied(identity, resource, operation, constraints, "project_forbidden", "无权访问此项目。");
    }
    if (resource.kind === "session") {
      const forbidden = this.sessionCheck(identity, resource.id);
      if (forbidden) return this.denied(identity, resource, operation, constraints, forbidden, "此会话属于其他用户或项目。");
    }
    if (resource.kind === "connectors") {
      const forbidden = this.connectorCheck(identity, resource.id);
      if (forbidden) return this.denied(identity, resource, operation, constraints, forbidden, "此连接器不可由此身份调用。");
    }

    const requireFresh = constraints.requireFresh ?? true;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(5_000, constraints.timeoutMs ?? 5_000)));
    let policy: CentralAccessPolicy | undefined;
    let usedCached = false;
    try {
      policy = await this.fetchPolicy(identity.userId, signal);
      if (!this.validPolicy(policy)) throw Error("Invalid central policy");
      if (this.closed || generation !== (this.generations.get(identity.userId) ?? 0)) return this.denied(identity, resource, operation, constraints, "invocation_cancelled", "调用已被撤销。");
      this.policies.set(identity.userId, { policy, fetchedAt: this.now() });
    } catch {
      const cached = this.policies.get(identity.userId);
      if (!requireFresh && cached && this.now() - cached.fetchedAt <= this.maxCachedPolicyAgeMs) {
        policy = cached.policy;
        usedCached = true;
      } else {
        return this.denied(identity, resource, operation, constraints, "policy_unavailable", requireFresh ? "无法获取最新授权，已拒绝调用。" : "无法获取授权且本地快照已过期，已拒绝调用。");
      }
    }

    if (this.closed || generation !== (this.generations.get(identity.userId) ?? 0)) return this.denied(identity, resource, operation, constraints, "invocation_cancelled", "调用已被撤销。");
    if (MANAGED_KINDS.has(resource.kind) && !policy!.resourceIds.includes(resource.id)) {
      return this.denied(identity, resource, operation, constraints, "resource_revoked", "此资源已下架或授权已收回。", usedCached);
    }
    return this.allowed(identity, resource, operation, constraints, policy!.revision ?? policyRevision(policy!), usedCached);
  }

  private validate(identity: InvocationIdentity, resource: InvocationResource): { reason: AuthorizationReason; message: string } | null {
    if (!identity.userId || identity.userId.length > MAX_ID || !resource.id || resource.id.length > MAX_ID) return { reason: "identity_unknown", message: "调用身份无效。" };
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(resource.id)) return { reason: "resource_not_found", message: "资源标识无效。" };
    if (identity.projectId && (identity.projectId.length > MAX_ID || !/^[a-zA-Z0-9_.-]{1,200}$/.test(identity.projectId))) return { reason: "project_forbidden", message: "项目标识无效。" };
    if (resource.version !== undefined && (!Number.isSafeInteger(resource.version) || resource.version < 1)) return { reason: "resource_not_found", message: "资源版本无效。" };
    return null;
  }

  private projectAccess(userId: string, projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM projects WHERE project_id=? AND owner_user_id=? UNION SELECT 1 AS found FROM project_members WHERE project_id=? AND user_id=? LIMIT 1").get(projectId, userId, projectId, userId));
  }

  private sessionCheck(identity: InvocationIdentity, sessionId: string): AuthorizationReason | null {
    const row = this.db.prepare("SELECT project_id,agent_id FROM sessions WHERE session_id=?").get(sessionId);
    const pin = this.db.prepare("SELECT local_user_id,project_id FROM shared_agent_session_pins WHERE session_id=?").get(sessionId);
    if (!row) {
      if (!pin) return "resource_not_found";
      if (identity.projectId && identity.projectId !== String(pin.project_id)) return "session_forbidden";
      return String(pin.local_user_id) === identity.userId ? null : "cross_user_resource";
    }
    const projectId = String(row.project_id);
    if (identity.projectId && identity.projectId !== projectId) return "session_forbidden";
    if (pin && String(pin.local_user_id) !== identity.userId) return "cross_user_resource";
    const knownProject = this.db.prepare("SELECT 1 AS found FROM projects WHERE project_id=?").get(projectId);
    if (knownProject) return this.projectAccess(identity.userId, projectId) ? null : "session_forbidden";
    return pin ? null : "session_forbidden";
  }

  private connectorCheck(identity: InvocationIdentity, connectorId: string): AuthorizationReason | null {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get();
    if (!table) return "resource_not_found";
    const row = this.db.prepare("SELECT owner_user_id,project_id FROM connectors WHERE connector_id=?").get(connectorId);
    if (!row) return "resource_not_found";
    if (String(row.owner_user_id) !== identity.userId) return "connector_forbidden";
    const projectId = row.project_id === null ? null : String(row.project_id);
    if (identity.projectId && projectId && identity.projectId !== projectId) return "connector_forbidden";
    const knownProject = projectId ? this.db.prepare("SELECT 1 AS found FROM projects WHERE project_id=?").get(projectId) : undefined;
    if (knownProject && !this.projectAccess(identity.userId, projectId!)) return "project_forbidden";
    return null;
  }

  private validPolicy(policy: unknown): policy is CentralAccessPolicy {
    if (!policy || typeof policy !== "object") return false;
    const value = policy as CentralAccessPolicy;
    return Array.isArray(value.modules) && value.modules.every(item => typeof item === "string") &&
      Array.isArray(value.resourceIds) && value.resourceIds.every(item => typeof item === "string") &&
      (value.isAdmin === undefined || typeof value.isAdmin === "boolean") &&
      (value.revision === undefined || typeof value.revision === "string");
  }

  private allowed(identity: InvocationIdentity, resource: InvocationResource, operation: InvocationOperation, constraints: InvocationConstraints, revision: string, usedCached: boolean): AuthorizationDecision {
    const now = this.now();
    const expiresAt = Math.min(now + this.decisionTtlMs, constraints.deadlineAt ?? Number.MAX_SAFE_INTEGER);
    return {
      allowed: true, reasonCode: "allowed", message: "允许调用", decisionId: this.randomId(),
      userId: identity.userId, ...(identity.projectId ? { projectId: identity.projectId } : {}),
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      resource, operation, policyRevision: revision, checkedAt: now, expiresAt,
      constraints: { ...(constraints.timeoutMs === undefined ? {} : { timeoutMs: constraints.timeoutMs }), ...(constraints.deadlineAt === undefined ? {} : { deadlineAt: constraints.deadlineAt }), ...(constraints.toolName ? { toolName: constraints.toolName } : {}), ...(constraints.permissions ? { permissions: [...constraints.permissions] } : {}) },
      usedCachedPolicy: usedCached,
    };
  }

  private denied(identity: InvocationIdentity, resource: InvocationResource, operation: InvocationOperation, constraints: InvocationConstraints, reason: AuthorizationReason, message: string, usedCached = false): AuthorizationDecision {
    const now = this.now();
    return {
      allowed: false, reasonCode: reason, message, decisionId: this.randomId(),
      userId: identity.userId, ...(identity.projectId ? { projectId: identity.projectId } : {}),
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      resource, operation, policyRevision: "unavailable", checkedAt: now, expiresAt: now,
      constraints: {}, usedCachedPolicy: usedCached,
    };
  }

  private record(decision: AuthorizationDecision): void {
    this.db.prepare("INSERT OR REPLACE INTO invocation_authorization_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      decision.decisionId, decision.userId, decision.projectId ?? null, decision.sessionId ?? null,
      decision.resource.kind, decision.resource.id, decision.operation, decision.allowed ? 1 : 0,
      decision.reasonCode, decision.policyRevision, new Date(decision.checkedAt).toISOString(),
      new Date(decision.expiresAt).toISOString(), JSON.stringify({ message: decision.message, usedCachedPolicy: decision.usedCachedPolicy, constraints: decision.constraints }),
    );
  }
}

export class AuthorizationError extends Error {
  constructor(readonly decision: AuthorizationDecision) {
    super(decision.message);
    this.name = "AuthorizationError";
  }
}

function policyRevision(policy: CentralAccessPolicy): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ modules: [...policy.modules].sort(), resourceIds: [...policy.resourceIds].sort(), isAdmin: Boolean(policy.isAdmin) })).digest("hex")}`;
}
