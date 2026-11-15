import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AccountCookieSeal } from "../auth/account-cookie-seal.js";
import type { InvocationIdentity, InvocationLease } from "../auth/invocation-authorization.js";
import { Agent, fetch } from 'undici';
import { guardedLookup, checkCallbackUrl } from '../taskexchange/ssrf.js';

export type ConnectorKind = "local-test" | "http";
export type ConnectorExecutionLocation = "local" | "server";
export type ConnectorTransportScope = "loopback" | "project" | "external";
export type ConnectorAuthorization = "authorized" | "pending" | "revoked";

export interface ConnectorRecord {
  connectorId: string;
  ownerUserId: string;
  projectId?: string;
  name: string;
  kind: ConnectorKind;
  executionLocation: ConnectorExecutionLocation;
  /** Where the call actually goes. Never contains a credential. */
  recipient: string;
  transportScope: ConnectorTransportScope;
  authorization: ConnectorAuthorization;
  enabled: boolean;
  credentialSet: boolean;
  credentialFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorCredentialSummary {
  set: boolean;
  fingerprint?: string;
  updatedAt?: string;
}

export interface ConnectorInvokeRequest {
  toolName: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  permissions?: readonly string[];
}

export interface ConnectorInvokeResult {
  auditId: string;
  decisionId: string;
  output: unknown;
}

export interface ConnectorTransportContext {
  connector: ConnectorRecord;
  toolName: string;
  payload: Record<string, unknown>;
  credential: string | null;
  signal: AbortSignal;
}

export type ConnectorTransport = (context: ConnectorTransportContext) => Promise<unknown>;

export interface ConnectorAuthorizer {
  beginInvocation(identity: InvocationIdentity, resource: { kind: "connectors"; id: string }, operation: "tool", constraints: { timeoutMs?: number; deadlineAt?: number; toolName?: string; permissions?: readonly string[] }): Promise<InvocationLease>;
}

export interface ConnectorServiceDeps {
  db: DatabaseSync;
  dataRoot: string;
  authorizer: ConnectorAuthorizer;
  transports?: Record<string, ConnectorTransport>;
  now?: () => number;
}

export class ConnectorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

/**
 * Connector registry and controlled proxy. Entries record where the call executes and who holds
 * the credential; tokens live only in the sealed vault and never reach configs, traces or echoes.
 */
export class ConnectorService {
  private readonly db: DatabaseSync;
  private readonly authorizer: ConnectorAuthorizer;
  private readonly vault: ConnectorCredentialVault;
  private readonly transports: Record<string, ConnectorTransport>;
  private readonly now: () => number;
  private readonly active = new Map<string, Set<AbortController>>();

  constructor(deps: ConnectorServiceDeps) {
    this.db = deps.db;
    this.authorizer = deps.authorizer;
    this.vault = new ConnectorCredentialVault(deps.db, deps.dataRoot);
    this.now = deps.now ?? (() => Date.now());
    this.transports = { ...defaultTransports, ...deps.transports };
    this.db.exec(`CREATE TABLE IF NOT EXISTS connectors (
      connector_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      execution_location TEXT NOT NULL,
      recipient TEXT NOT NULL,
      transport_scope TEXT NOT NULL,
      authorization TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      credential_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS connectors_owner ON connectors(owner_user_id, project_id)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS connector_audit (
      audit_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT,
      tool_name TEXT NOT NULL,
      execution_location TEXT NOT NULL,
      recipient TEXT NOT NULL,
      transport_scope TEXT NOT NULL,
      decision_id TEXT,
      outcome TEXT NOT NULL,
      reason TEXT,
      duration_ms INTEGER NOT NULL,
      credential_fingerprint TEXT,
      fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  create(ownerUserId: string, input: { name: string; kind?: ConnectorKind; projectId?: string; recipient?: string; transportScope?: ConnectorTransportScope; executionLocation?: ConnectorExecutionLocation }): ConnectorRecord {
    const name = input.name?.trim();
    if (!name || name.length > 80) throw new ConnectorError(400, "invalid_connector_name", "连接器名称无效。");
    if (input.projectId && !this.projectAccess(ownerUserId, input.projectId)) throw new ConnectorError(403, "project_forbidden", "无权使用此项目。");
    const kind = input.kind ?? "local-test";
    if (!['local-test', 'http'].includes(kind)) throw new ConnectorError(400, 'invalid_kind', '连接器类型无效。');
    const location = process.env.AITEST_ACCOUNT_CENTER === '1' ? 'server' : 'local';
    if (input.executionLocation && input.executionLocation !== location) throw new ConnectorError(400, 'execution_location_mismatch', '连接器必须在配置它的服务上执行。');
    if (kind === "local-test" && (input.transportScope ?? "loopback") !== "loopback") throw new ConnectorError(400, "invalid_transport_scope", "本地测试连接器只能使用本机回环范围。");
    const recipient = input.recipient ?? (kind === "local-test" ? "local-echo" : "");
    if (!recipient || recipient.length > 240) throw new ConnectorError(400, "invalid_recipient", "连接目标无效。");
    if (kind === "local-test" && !this.transports[recipient]) throw new ConnectorError(400, "unknown_transport", "本地连接器没有可用的测试传输。");
    const id = `conn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const at = new Date(this.now()).toISOString();
    this.db.prepare("INSERT INTO connectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, ownerUserId, input.projectId ?? null, name, kind,
      location, recipient, input.transportScope ?? (kind === "local-test" ? "loopback" : "external"),
      "pending", 0, null, at, at,
    );
    return this.get(ownerUserId, id);
  }

  update(ownerUserId: string, connectorId: string, input: { name?: string; recipient?: string; transportScope?: ConnectorTransportScope; enabled?: boolean }): ConnectorRecord {
    const current = this.get(ownerUserId, connectorId);
    const name = input.name?.trim() ?? current.name;
    if (!name || name.length > 80) throw new ConnectorError(400, "invalid_connector_name", "连接器名称无效。");
    const recipient = input.recipient ?? current.recipient;
    if (current.kind === "local-test" && !this.transports[recipient]) throw new ConnectorError(400, "unknown_transport", "本地连接器没有可用的测试传输。");
    const enabled = input.enabled ?? current.enabled;
    if (enabled && current.authorization !== "authorized") throw new ConnectorError(409, "connector_not_authorized", "连接器尚未完成授权。");
    this.db.prepare("UPDATE connectors SET name=?,recipient=?,transport_scope=?,enabled=?,updated_at=? WHERE connector_id=? AND owner_user_id=?").run(
      name, recipient, input.transportScope ?? current.transportScope, enabled ? 1 : 0, new Date(this.now()).toISOString(), connectorId, ownerUserId,
    );
    if (!enabled || recipient !== current.recipient) for (const controller of this.active.get(connectorId) ?? []) controller.abort();
    return this.get(ownerUserId, connectorId);
  }

  /** Credentials only live in the sealed vault; the connector record keeps a fingerprint. */
  setCredential(ownerUserId: string, connectorId: string, secret: string): ConnectorCredentialSummary {
    this.get(ownerUserId, connectorId);
    if (typeof secret !== "string" || !secret.trim() || secret.length > 100_000) throw new ConnectorError(400, "invalid_credential", "凭据无效。");
    const fingerprint = this.vault.set(connectorId, secret.trim());
    this.db.prepare("UPDATE connectors SET credential_fingerprint=?,authorization='authorized',updated_at=? WHERE connector_id=?").run(fingerprint, new Date(this.now()).toISOString(), connectorId);
    return { set: true, fingerprint, updatedAt: new Date(this.now()).toISOString() };
  }

  credential(ownerUserId: string, connectorId: string): ConnectorCredentialSummary {
    this.get(ownerUserId, connectorId);
    return this.vault.summary(connectorId);
  }

  revoke(ownerUserId: string, connectorId: string): ConnectorRecord {
    const current = this.get(ownerUserId, connectorId);
    this.db.prepare("UPDATE connectors SET authorization='revoked',enabled=0,updated_at=? WHERE connector_id=?").run(new Date(this.now()).toISOString(), connectorId);
    for (const controller of this.active.get(connectorId) ?? []) controller.abort();
    void current;
    return this.get(ownerUserId, connectorId);
  }

  list(ownerUserId: string, projectId?: string): ConnectorRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM connectors WHERE owner_user_id=? AND project_id=? ORDER BY created_at,connector_id").all(ownerUserId, projectId)
      : this.db.prepare("SELECT * FROM connectors WHERE owner_user_id=? ORDER BY created_at,connector_id").all(ownerUserId);
    return rows.map(row => this.hydrate(row));
  }

  get(ownerUserId: string, connectorId: string): ConnectorRecord {
    const row = this.db.prepare("SELECT * FROM connectors WHERE connector_id=?").get(connectorId);
    if (!row) throw new ConnectorError(404, "connector_missing", "连接器不存在。");
    if (String(row.owner_user_id) !== ownerUserId) throw new ConnectorError(403, "connector_forbidden", "此连接器不可由此身份访问。");
    return this.hydrate(row);
  }

  delete(ownerUserId: string, connectorId: string): void {
    this.get(ownerUserId, connectorId);
    this.db.prepare("DELETE FROM connectors WHERE connector_id=?").run(connectorId);
    this.vault.delete(connectorId);
  }

  /**
   * One controlled call: authorization lease, re-check before dispatch, timeout/cancel, sealed
   * credential resolution at the last moment, and a redacted audit row in every outcome.
   */
  async invoke(identity: InvocationIdentity, connectorId: string, request: ConnectorInvokeRequest): Promise<ConnectorInvokeResult> {
    const started = this.now();
    const connector = this.get(identity.userId, connectorId);
    if (identity.projectId && connector.projectId && identity.projectId !== connector.projectId) throw new ConnectorError(403, "cross_project", "连接器属于其他项目。");
    if (!connector.enabled || connector.authorization !== "authorized") throw new ConnectorError(409, "connector_not_authorized", "连接器未启用或授权已收回。");
    const toolName = request.toolName?.trim();
    if (!toolName || toolName.length > 120 || !/^[a-zA-Z0-9_.-]+$/.test(toolName)) throw new ConnectorError(400, "invalid_tool", "工具名无效。");
    const payload = request.payload ?? {};
    if (JSON.stringify(payload).length > 64_000) throw new ConnectorError(400, "payload_too_large", "请求内容过大。");
    const timeoutMs = Math.min(60_000, Math.max(1_000, request.timeoutMs ?? 10_000));
    const transport = this.transports[connector.recipient] ?? (connector.kind === 'http' ? httpTransport : undefined);
    if (!transport) throw new ConnectorError(409, "unsupported_transport", "当前构建不支持此连接目标。");

    const lease = await this.authorizer.beginInvocation(
      identity, { kind: "connectors", id: connector.connectorId }, "tool",
      { timeoutMs, deadlineAt: started + timeoutMs, toolName, ...(request.permissions ? { permissions: request.permissions } : {}) },
    );
    if (!lease.decision.allowed) {
      lease.release();
      this.audit(connector, toolName, lease.decision.decisionId, "denied", lease.decision.reasonCode, started, payload);
      throw new ConnectorError(403, lease.decision.reasonCode, lease.decision.message);
    }
    const controller = new AbortController();
    const active = this.active.get(connectorId) ?? new Set<AbortController>();
    active.add(controller); this.active.set(connectorId, active);
    let timedOut = false;
    const onLeaseAbort = () => controller.abort();
    lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    try {
      const rechecked = await lease.confirm();
      if (!rechecked.allowed) {
        this.audit(connector, toolName, rechecked.decisionId, "denied", rechecked.reasonCode, started, payload);
        throw new ConnectorError(403, rechecked.reasonCode, rechecked.message);
      }
      if (controller.signal.aborted) throw new ConnectorError(499, "invocation_cancelled", "调用已取消。");
      const current = this.get(identity.userId, connectorId);
      if (!current.enabled || current.authorization !== 'authorized' || current.recipient !== connector.recipient || current.credentialFingerprint !== connector.credentialFingerprint)
        throw new ConnectorError(403, 'connector_changed', '连接器配置或授权已变化。');
      const credential = this.vault.get(connector.connectorId);
      const output = await transport({ connector, toolName, payload, credential, signal: controller.signal });
      if (controller.signal.aborted || lease.cancelled) throw new ConnectorError(499, 'invocation_cancelled', '调用已取消。');
      const auditId = this.audit(connector, toolName, rechecked.decisionId, "success", null, started, payload);
      return { auditId, decisionId: rechecked.decisionId, output: sanitize(output, credential) };
    } catch (error) {
      if (timedOut) {
        this.audit(connector, toolName, lease.decision.decisionId, "timeout", "connector_timeout", started, payload);
        throw new ConnectorError(504, "connector_timeout", "连接器调用超时。");
      }
      if (controller.signal.aborted || lease.cancelled) {
        this.audit(connector, toolName, lease.decision.decisionId, "cancelled", "invocation_cancelled", started, payload);
        throw new ConnectorError(499, "invocation_cancelled", "调用已取消。");
      }
      if (error instanceof ConnectorError) throw error;
      this.audit(connector, toolName, lease.decision.decisionId, "error", "transport_failed", started, payload);
      throw new ConnectorError(502, "transport_failed", "连接器调用失败。");
    } finally {
      clearTimeout(timer);
      lease.signal.removeEventListener("abort", onLeaseAbort);
      lease.release();
      active.delete(controller); if (!active.size) this.active.delete(connectorId);
    }
  }

  auditLog(ownerUserId: string, connectorId?: string): Record<string, unknown>[] {
    const rows = connectorId
      ? this.db.prepare("SELECT * FROM connector_audit WHERE user_id=? AND connector_id=? ORDER BY created_at DESC").all(ownerUserId, connectorId)
      : this.db.prepare("SELECT * FROM connector_audit WHERE user_id=? ORDER BY created_at DESC").all(ownerUserId);
    return rows.map(row => ({ ...row, fields_json: JSON.parse(String(row.fields_json)) }));
  }

  private audit(connector: ConnectorRecord, toolName: string, decisionId: string, outcome: string, reason: string | null, started: number, payload: Record<string, unknown>): string {
    const auditId = randomUUID();
    const fields = Object.fromEntries(Object.keys(payload).slice(0, 40).map(key => [key, SENSITIVE.test(key) ? "[redacted]" : typeof payload[key]]));
    this.db.prepare("INSERT INTO connector_audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      auditId, connector.connectorId, connector.ownerUserId, connector.projectId ?? null, toolName,
      connector.executionLocation, connector.recipient, connector.transportScope, decisionId, outcome, reason,
      Math.max(0, this.now() - started), connector.credentialFingerprint ?? null, JSON.stringify(fields), new Date(this.now()).toISOString(),
    );
    return auditId;
  }

  private projectAccess(userId: string, projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM projects WHERE project_id=? AND owner_user_id=? UNION SELECT 1 AS found FROM project_members WHERE project_id=? AND user_id=? LIMIT 1").get(projectId, userId, projectId, userId));
  }

  private hydrate(row: Record<string, unknown>): ConnectorRecord {
    return {
      connectorId: String(row.connector_id), ownerUserId: String(row.owner_user_id),
      ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
      name: String(row.name), kind: String(row.kind) as ConnectorKind,
      executionLocation: String(row.execution_location) as ConnectorExecutionLocation,
      recipient: String(row.recipient), transportScope: String(row.transport_scope) as ConnectorTransportScope,
      authorization: String(row.authorization) as ConnectorAuthorization, enabled: Boolean(row.enabled),
      credentialSet: row.credential_fingerprint !== null,
      ...(row.credential_fingerprint === null ? {} : { credentialFingerprint: String(row.credential_fingerprint) }),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}

const httpTransport: ConnectorTransport = async ({ connector, toolName, payload, credential, signal }) => {
  const url = new URL(connector.recipient);
  // A local user's explicit connector endpoint may be on their company network.
  // Service-side connectors retain the default public-address boundary.
  const allowed = new Set(connector.executionLocation === 'local' ? [url.hostname] : []);
  if (!checkCallbackUrl(url.toString(), { allowedHosts: allowed }).ok) throw new ConnectorError(403, 'recipient_refused', '连接目标不符合地址策略。');
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowed), timeout: 10_000 } });
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', dispatcher, signal,
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify({ tool: toolName, payload }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Connector response failed'); }
    const reader = response.body?.getReader();
    if (!reader) return null;
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
        if (size > 64_000) throw new Error('Connector response too large'); chunks.push(chunk.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel(); }
  } finally { await dispatcher.destroy(); }
};

/** Secrets at rest reuse the account-center AES-GCM sealing primitive with a dedicated key file. */
export class ConnectorCredentialVault {
  private readonly seal: AccountCookieSeal;
  constructor(private readonly db: DatabaseSync, root: string) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS connector_credentials (
      connector_id TEXT PRIMARY KEY,
      sealed_value TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const hasRows = Boolean(this.db.prepare("SELECT 1 AS found FROM connector_credentials LIMIT 1").get());
    this.seal = new AccountCookieSeal(root, hasRows, "connector-credential.key");
  }
  set(connectorId: string, secret: string): string {
    const fingerprint = `sha256:${createHash("sha256").update(secret).digest("hex")}`;
    this.db.prepare("INSERT INTO connector_credentials VALUES (?,?,?,?) ON CONFLICT(connector_id) DO UPDATE SET sealed_value=excluded.sealed_value,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at").run(
      connectorId, this.seal.seal(secret), fingerprint, new Date().toISOString(),
    );
    return fingerprint;
  }
  get(connectorId: string): string | null {
    const row = this.db.prepare("SELECT sealed_value FROM connector_credentials WHERE connector_id=?").get(connectorId);
    return row ? this.seal.open(String(row.sealed_value)) : null;
  }
  summary(connectorId: string): ConnectorCredentialSummary {
    const row = this.db.prepare("SELECT fingerprint,updated_at FROM connector_credentials WHERE connector_id=?").get(connectorId);
    return row ? { set: true, fingerprint: String(row.fingerprint), updatedAt: String(row.updated_at) } : { set: false };
  }
  delete(connectorId: string): void {
    this.db.prepare("DELETE FROM connector_credentials WHERE connector_id=?").run(connectorId);
  }
}

const SENSITIVE = /authorization|token|password|secret|api[_-]?key|credential|cookie/i;

const defaultTransports: Record<string, ConnectorTransport> = {
  /** Isolated loopback test transport: no network, no external account. */
  "local-echo": async ({ payload, signal }) => {
    if (signal.aborted) throw Error("aborted");
    return { echo: payload };
  },
};

export function sanitize(value: unknown, secret: string | null, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return secret && value.includes(secret) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(item => sanitize(item, secret, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[redacted]" : sanitize(item, secret, depth + 1)]));
  }
  return value;
}
