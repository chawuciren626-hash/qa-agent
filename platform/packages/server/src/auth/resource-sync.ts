import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { localAdapterHash } from "./trusted-local-adapters.js";
import { PublishedBundleCache, type CachedSharedAgentDefinition } from "./published-bundle-cache.js";
import type { ResolvedPublishedBundle } from "./published-bundle.js";

export interface CatalogBundleItem {
  agentId: string;
  bundle: unknown;
}

export type ResourceUpdateState = "idle" | "syncing" | "current" | "update_failed" | "offline" | "closed";

export interface ResourceSyncStatus {
  state: ResourceUpdateState;
  connection: "online" | "offline" | "unknown";
  /** The publication actually enabled locally. Kept when an update fails. */
  publication: {
    setHash: string;
    verifiedAt: string;
    agents: { agentId: string; resourceId: string; version: number; bundleHash: string }[];
  } | null;
    update: {
    state: ResourceUpdateState;
    errorCode?: string;
    message?: string;
  };
  /** Which Agents can still run from the last verified publication while offline. */
  offlineUsable: { agentId: string; version: number }[];
  lastVerifiedAt?: string;
  checkedAt?: string;
}

export interface ResourceSyncDeps {
  db: DatabaseSync;
  dataRoot: string;
  fetchBundles: (userId: string, signal: AbortSignal) => Promise<CatalogBundleItem[]>;
  serverVersion?: string;
  engineRoot?: string;
  intervalMs?: number;
  now?: () => number;
}

const MAX_AGE_MS = 1_000;

/**
 * Reconciles the central publication without refetching during UI renders. Verification is
 * all-or-nothing: a failed download, hash mismatch or incompatible adapter keeps the last
 * verified publication usable and explains what happened.
 */
export class PublishedResourceSync {
  private readonly db: DatabaseSync;
  private readonly cache: PublishedBundleCache;
  private readonly fetchBundles: (userId: string, signal: AbortSignal) => Promise<CatalogBundleItem[]>;
  private readonly serverVersion: string;
  private readonly engineRoot?: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(status: ResourceSyncStatus) => void>();
  private closed = false;

  constructor(deps: ResourceSyncDeps) {
    this.db = deps.db;
    this.cache = new PublishedBundleCache(deps.dataRoot);
    this.fetchBundles = deps.fetchBundles;
    this.serverVersion = deps.serverVersion ?? "0.2.17";
    this.engineRoot = deps.engineRoot;
    this.intervalMs = deps.intervalMs ?? 5 * 60_000;
    this.now = deps.now ?? (() => Date.now());
    this.db.exec(`CREATE TABLE IF NOT EXISTS published_resource_state (
      user_id TEXT PRIMARY KEY,
      connection_state TEXT NOT NULL,
      update_state TEXT NOT NULL,
      set_hash TEXT,
      bundles_json TEXT NOT NULL,
      last_verified_at TEXT,
      error_code TEXT,
      error_message TEXT,
      checked_at TEXT NOT NULL
    )`);
  }

  /** Login/restore: verify the publication immediately and keep it fresh in the background. */
  start(userId: string): ResourceSyncStatus {
    if (this.closed) return this.status(userId);
    if (!this.timers.has(userId)) {
      const timer = setInterval(() => { void this.kick(userId); }, this.intervalMs);
      timer.unref?.();
      this.timers.set(userId, timer);
    }
    void this.kick(userId);
    return this.status(userId);
  }

  stop(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearInterval(timer);
    this.timers.delete(userId);
    this.controllers.get(userId)?.abort();
    this.controllers.delete(userId);
    this.jobs.delete(userId);
  }

  /** Coalesced: concurrent UI renders share one in-flight reconcile. */
  kick(userId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.jobs.get(userId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(userId, controller);
    try { this.setState(userId, { connection: this.status(userId).connection, state: "syncing" }); } catch {
      this.controllers.delete(userId);
      return Promise.resolve();
    }
    const job = this.reconcile(userId, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.jobs.get(userId) === job) this.jobs.delete(userId);
        if (this.controllers.get(userId) === controller) this.controllers.delete(userId);
        this.emit(userId);
      });
    this.jobs.set(userId, job);
    return job;
  }

  /** Pure read: a UI render never triggers a network download. */
  status(userId: string): ResourceSyncStatus {
    const row = this.db.prepare("SELECT * FROM published_resource_state WHERE user_id=?").get(userId);
    if (!row) return { state: "idle", connection: "unknown", publication: null, update: { state: "idle" }, offlineUsable: [] };
    const agents = JSON.parse(String(row.bundles_json)) as { agentId: string; resourceId: string; version: number; bundleHash: string }[];
    const updateState = String(row.update_state) as ResourceUpdateState;
    const setHash = row.set_hash === null ? null : String(row.set_hash);
    return {
      state: updateState,
      connection: String(row.connection_state) as "online" | "offline" | "unknown",
      publication: setHash ? { setHash, verifiedAt: String(row.last_verified_at ?? row.checked_at), agents } : null,
      update: {
        state: updateState,
        ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
        ...(row.error_message === null ? {} : { message: String(row.error_message) }),
      },
      // Cached content does not grant offline execution: fresh authorization is required.
      offlineUsable: [],
      ...(row.last_verified_at === null ? {} : { lastVerifiedAt: String(row.last_verified_at) }),
      checkedAt: String(row.checked_at),
    };
  }

  subscribe(listener: (status: ResourceSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancels in-flight downloads and background checks; no timer survives a closed client. */
  close(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const timer of this.timers.values()) clearInterval(timer);
    this.controllers.clear();
    this.timers.clear();
    this.jobs.clear();
    this.listeners.clear();
  }

  get timerCount(): number {
    return this.timers.size;
  }

  private async reconcile(userId: string, signal: AbortSignal): Promise<void> {
    let items: CatalogBundleItem[];
    try {
      items = await this.fetchBundles(userId, signal);
    } catch (error) {
      if (signal.aborted || this.closed) return;
      this.markFailure(userId, "catalog_unavailable", "无法连接资源目录，继续使用上次验证的发布。", "offline");
      return;
    }
    if (signal.aborted || this.closed) return;

    const verified: { agentId: string; resourceId: string; version: number; bundleHash: string; definition: CachedSharedAgentDefinition; bundle: ResolvedPublishedBundle }[] = [];
    const seen = new Set<string>();
    try {
      for (const item of items) {
        if (typeof item.agentId !== "string" || seen.has(item.agentId)) throw new SyncError("catalog_invalid", "资源目录重复或无效。");
        seen.add(item.agentId);
        const bundle = await this.cache.store(userId, item.bundle);
        const definition = await this.cache.definition(userId, bundle.bundleHash);
        if (definition.agentId !== item.agentId) throw new SyncError("catalog_invalid", "资源目录与定义不一致。");
        await this.checkAdapters(definition);
        this.checkCompatibility(bundle, definition);
        verified.push({ agentId: item.agentId, resourceId: bundle.rootId, version: bundle.versions[0]!.version, bundleHash: bundle.bundleHash, definition, bundle });
        if (signal.aborted || this.closed) return;
      }
    } catch (error) {
      if (signal.aborted || this.closed) return;
      const code = error instanceof SyncError ? error.code : "verification_failed";
      const message = error instanceof SyncError ? error.message : "发布内容校验失败，继续使用上次验证的发布。";
      this.markFailure(userId, code, message, "update_failed");
      return;
    }

    const setHash = publicationSetHash(verified.map(item => item.bundleHash));
    const now = new Date(this.now()).toISOString();
    this.persist(userId, "online", "current", setHash,
      JSON.stringify(verified.map(({ agentId, resourceId, version, bundleHash }) => ({ agentId, resourceId, version, bundleHash }))),
      now, null, null, now);
    this.emit(userId);
  }

  private async checkAdapters(definition: CachedSharedAgentDefinition): Promise<void> {
    if (!this.engineRoot) return;
    for (const adapter of definition.localAdapters) {
      if (adapter.hash !== await localAdapterHash(this.engineRoot, adapter.name)) {
        throw new SyncError("adapter_incompatible", `本地适配器与已发布版本不兼容：${adapter.name}`);
      }
    }
  }

  private checkCompatibility(bundle: ResolvedPublishedBundle, definition: CachedSharedAgentDefinition): void {
    const modelRef = bundle.resources[0]?.payload.modelResource;
    if (modelRef !== undefined) {
      const model = bundle.resources.find(resource => resource.kind === "models" && resource.id === modelRef);
      if (!model) throw new SyncError("model_incompatible", "发布中引用的模型不存在。");
      const revision = model.payload.modelRevision;
      if (revision !== undefined && typeof revision !== "string") throw new SyncError("model_incompatible", "模型修订无效。");
    }
    for (const resource of bundle.resources.filter(item => item.kind === "plugins")) {
      if (resource.payload.source === "upstream-library" || !definition) throw new SyncError("plugin_incompatible", "共享插件需要本地兼容运行时。");
      const range = resource.payload.minHostVersion;
      if (range !== undefined && (typeof range !== "string" || !versionAtLeast(this.serverVersion, range))) {
        throw new SyncError("plugin_incompatible", "插件要求的宿主版本高于当前版本。");
      }
    }
  }

  private markFailure(userId: string, code: string, message: string, state: "offline" | "update_failed"): void {
    const previous = this.db.prepare("SELECT * FROM published_resource_state WHERE user_id=?").get(userId);
    const connection = state === "offline" ? "offline" : "online";
    this.persist(userId, connection, state, previous?.set_hash === undefined || previous.set_hash === null ? null : String(previous.set_hash),
      previous?.bundles_json === undefined || previous.bundles_json === null ? "[]" : String(previous.bundles_json), previous?.last_verified_at === undefined || previous.last_verified_at === null ? null : String(previous.last_verified_at),
      code, message, new Date(this.now()).toISOString());
    this.emit(userId);
  }

  private setState(userId: string, value: { state: ResourceUpdateState; connection: "online" | "offline" | "unknown" }): void {
    const previous = this.status(userId);
    this.persist(userId, value.connection === "unknown" ? previous.connection : value.connection, value.state,
      previous.publication?.setHash ?? null,
      JSON.stringify(previous.publication?.agents ?? []), previous.lastVerifiedAt ?? null,
      previous.update.errorCode ?? null, previous.update.message ?? null, new Date(this.now()).toISOString());
  }

  private persist(userId: string, connection: string, state: string, setHash: string | null, bundles: string, verifiedAt: string | null, errorCode: string | null, errorMessage: string | null, checkedAt: string): void {
    this.db.prepare(`INSERT INTO published_resource_state VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET connection_state=excluded.connection_state, update_state=excluded.update_state,
      set_hash=excluded.set_hash, bundles_json=excluded.bundles_json, last_verified_at=excluded.last_verified_at,
      error_code=excluded.error_code, error_message=excluded.error_message, checked_at=excluded.checked_at`)
      .run(userId, connection, state, setHash, bundles, verifiedAt, errorCode, errorMessage, checkedAt);
  }

  private emit(userId: string): void {
    try {
      const status = this.status(userId);
      for (const listener of this.listeners) listener(status);
    } catch { /* client closed while a background reconcile was finishing */ }
  }
}

export function publicationSetHash(bundleHashes: readonly string[]): string {
  const value = createHash("sha256").update(bundleHashes.slice().sort().join("\n")).digest("hex");
  return `sha256:${value}`;
}

function versionAtLeast(version: string, min: string): boolean {
  const left = version.split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = min.replace(/^>=?/, "").trim().split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) > (right[i] ?? 0)) return true;
    if ((left[i] ?? 0) < (right[i] ?? 0)) return false;
  }
  return true;
}

class SyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SyncError";
  }
}
