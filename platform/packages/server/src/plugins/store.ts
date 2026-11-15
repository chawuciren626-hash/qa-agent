import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { compatible, extractPackage, parsePluginManifest, packageDigest, UnsafePackageError, verifyExecutables, type PluginManifest } from "./package.js";
import { loadTrustPolicy, verifyPublisher, type TrustPolicy } from "./trust.js";

export type PluginTrustState = "verified" | "pending";
export type PluginStatus = "enabled" | "pending_verification";

export interface StoredPluginVersion {
  pluginId: string;
  version: string;
  packageSha256: string;
  publisher: string;
  trustState: PluginTrustState;
  status: PluginStatus;
  manifest: PluginManifest;
  executableHashes: Record<string, string>;
  installedAt: string;
}

export type InstallStatus = "enabled" | "pending_verification" | "incompatible" | "rejected";

export interface InstallResult {
  status: InstallStatus;
  pluginId?: string;
  version?: string;
  activeVersion?: string;
  packageSha256?: string;
  trustState?: PluginTrustState;
  reason?: string;
  detail?: string;
}

export interface PluginStoreDeps {
  dataRoot: string;
  serverVersion: string;
  trust?: TrustPolicy;
  now?: () => number;
}

export class PluginAccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`${message} [${code}]`);
    this.name = "PluginAccessError";
  }
}

/** Local trusted-plugin store: verified packages activate atomically, old versions stay while pinned. */
export class TrustedPluginStore {
  private readonly root: string;
  private readonly serverVersion: string;
  private readonly trust: TrustPolicy;
  private readonly now: () => number;
  private installQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: DatabaseSync, deps: PluginStoreDeps) {
    this.root = path.join(deps.dataRoot, "trusted-plugins");
    this.serverVersion = deps.serverVersion;
    this.trust = deps.trust ?? loadTrustPolicy(deps.dataRoot);
    this.now = deps.now ?? (() => Date.now());
    this.db.exec(`CREATE TABLE IF NOT EXISTS trusted_plugin_versions (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      package_sha256 TEXT NOT NULL,
      publisher TEXT NOT NULL,
      trust_state TEXT NOT NULL,
      status TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      executable_hashes_json TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, version)
    )`);
    this.db.exec("CREATE TABLE IF NOT EXISTS trusted_plugin_state (plugin_id TEXT PRIMARY KEY, active_version TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_session_pins (
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (session_id, plugin_id)
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS plugin_session_pins_version ON plugin_session_pins(plugin_id, version)");
  }

  async install(archiveBase64: string): Promise<InstallResult> {
    const pending = this.installQueue.then(() => this.installOne(archiveBase64));
    this.installQueue = pending.catch(() => undefined);
    return pending;
  }

  private async installOne(archiveBase64: string): Promise<InstallResult> {
    if (typeof archiveBase64 !== "string" || archiveBase64.length > 40_000_000) return { status: "rejected", reason: "package_too_large", detail: "插件包过大。" };
    let bytes: Buffer;
    try { bytes = Buffer.from(archiveBase64, "base64"); } catch { return { status: "rejected", reason: "package_invalid", detail: "插件包编码无效。" }; }
    if (bytes.length === 0) return { status: "rejected", reason: "package_invalid", detail: "插件包为空。" };
    const staging = path.join(this.root, `.staging-${randomUUID()}`);
    let files: Record<string, Uint8Array>;
    try { files = await extractPackage(bytes, staging); }
    catch (error) { await fs.rm(staging, { recursive: true, force: true }); return reject(error); }

    let manifest: PluginManifest;
    try {
      const manifestBytes = files["plugin-manifest.json"];
      if (!manifestBytes) throw new UnsafePackageError("manifest_missing", "插件包缺少 plugin-manifest.json。");
      manifest = parsePluginManifest(Buffer.from(manifestBytes).toString("utf8"));
      const digest = packageDigest(files);
      if (digest !== manifest.packageSha256) throw new UnsafePackageError("package_hash_mismatch", "插件包哈希与清单不一致。");
      if (!compatible(this.serverVersion, manifest)) {
        await fs.rm(staging, { recursive: true, force: true });
        return { status: "incompatible", pluginId: manifest.id, version: manifest.version, packageSha256: manifest.packageSha256, reason: "host_version_incompatible", detail: "插件要求的宿主版本与当前版本不兼容。" };
      }
      await verifyExecutables(staging, manifest);
    } catch (error) { await fs.rm(staging, { recursive: true, force: true }); return reject(error); }

    const prior = this.getVersion(manifest.id, manifest.version);
    if (prior && prior.packageSha256 !== manifest.packageSha256) {
      await fs.rm(staging, { recursive: true, force: true });
      return { status: 'rejected', reason: 'version_content_conflict', detail: '同一插件版本不得替换为不同内容。' };
    }
    const trust = verifyPublisher(manifest, this.trust);
    if (!trust.trusted) {
      const pending = path.join(this.root, manifest.id, `pending-${manifest.version}-${randomUUID()}`);
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.rename(staging, pending).catch(async () => { await fs.cp(staging, pending, { recursive: true }); await fs.rm(staging, { recursive: true, force: true }); });
      const executableHashes = manifest.executables.reduce<Record<string, string>>((all, item) => ({ ...all, [item.path]: item.sha256 }), {});
      try {
        this.db.prepare("INSERT OR IGNORE INTO trusted_plugin_versions VALUES (?,?,?,?,?,?,?,?,?)").run(
          manifest.id, manifest.version, manifest.packageSha256, manifest.publisher, "pending", "pending_verification",
          JSON.stringify(manifest), JSON.stringify(executableHashes), new Date(this.now()).toISOString(),
        );
      } catch (error) {
        await fs.rm(pending, { recursive: true, force: true });
        throw error;
      }
      return { status: "pending_verification", pluginId: manifest.id, version: manifest.version, packageSha256: manifest.packageSha256, trustState: "pending", reason: trust.reason, detail: "发布者未受信任，插件已保存但不会执行。" };
    }

    const existing = this.getVersion(manifest.id, manifest.version);
    if (existing?.status === "enabled") {
      await fs.rm(staging, { recursive: true, force: true });
      return { status: "enabled", pluginId: manifest.id, version: manifest.version, activeVersion: this.activeVersion(manifest.id) ?? existing.version, packageSha256: existing.packageSha256, trustState: "verified" };
    }

    const final = path.join(this.root, manifest.id, manifest.version);
    await fs.mkdir(path.dirname(final), { recursive: true });
    await fs.rename(staging, final).catch(async () => { await fs.cp(staging, final, { recursive: true }); await fs.rm(staging, { recursive: true, force: true }); });
    const executableHashes = manifest.executables.reduce<Record<string, string>>((all, item) => ({ ...all, [item.path]: item.sha256 }), {});
    const installedAt = new Date(this.now()).toISOString();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("INSERT INTO trusted_plugin_versions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id, version) DO UPDATE SET package_sha256=excluded.package_sha256,publisher=excluded.publisher,trust_state=excluded.trust_state,status=excluded.status,manifest_json=excluded.manifest_json,executable_hashes_json=excluded.executable_hashes_json,installed_at=excluded.installed_at").run(
        manifest.id, manifest.version, manifest.packageSha256, manifest.publisher, "verified", "enabled",
        JSON.stringify(manifest), JSON.stringify(executableHashes), installedAt,
      );
      this.db.prepare("INSERT INTO trusted_plugin_state VALUES (?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET active_version=excluded.active_version,updated_at=excluded.updated_at").run(manifest.id, manifest.version, installedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      await fs.rm(final, { recursive: true, force: true });
      throw error;
    }
    return { status: "enabled", pluginId: manifest.id, version: manifest.version, activeVersion: manifest.version, packageSha256: manifest.packageSha256, trustState: "verified" };
  }

  activeVersion(pluginId: string): string | null {
    const row = this.db.prepare("SELECT active_version FROM trusted_plugin_state WHERE plugin_id=?").get(pluginId);
    return row ? String(row.active_version) : null;
  }

  getVersion(pluginId: string, version: string): StoredPluginVersion | null {
    const row = this.db.prepare("SELECT * FROM trusted_plugin_versions WHERE plugin_id=? AND version=?").get(pluginId, version);
    return row ? hydrateVersion(row) : null;
  }

  listVersions(pluginId?: string): StoredPluginVersion[] {
    const rows = pluginId
      ? this.db.prepare("SELECT * FROM trusted_plugin_versions WHERE plugin_id=? ORDER BY installed_at DESC").all(pluginId)
      : this.db.prepare("SELECT * FROM trusted_plugin_versions ORDER BY installed_at DESC").all();
    return rows.map(hydrateVersion);
  }

  /** Sessions pin the active version once; later updates never change an existing pin. */
  pinSession(sessionId: string, pluginId: string, force = false): StoredPluginVersion {
    const pinned = this.getSessionPin(sessionId, pluginId);
    if (pinned && !force) return pinned;
    const active = this.activeVersion(pluginId);
    if (!active) throw new PluginAccessError(409, "plugin_not_installed", "插件尚未启用。");
    const version = this.getVersion(pluginId, active);
    if (!version || version.status !== "enabled" || version.trustState !== "verified") throw new PluginAccessError(403, "plugin_not_trusted", "插件未通过信任校验。");
    this.db.prepare("INSERT INTO plugin_session_pins VALUES (?,?,?,?) ON CONFLICT(session_id, plugin_id) DO UPDATE SET version=excluded.version,pinned_at=excluded.pinned_at").run(sessionId, pluginId, active, new Date(this.now()).toISOString());
    return version;
  }

  getSessionPin(sessionId: string, pluginId: string): StoredPluginVersion | null {
    const row = this.db.prepare("SELECT version FROM plugin_session_pins WHERE session_id=? AND plugin_id=?").get(sessionId, pluginId);
    return row ? this.getVersion(pluginId, String(row.version)) : null;
  }

  resolveForSession(sessionId: string, pluginId: string): StoredPluginVersion | null {
    const pinned = this.getSessionPin(sessionId, pluginId);
    if (pinned) return pinned;
    const active = this.activeVersion(pluginId);
    return active ? this.getVersion(pluginId, active) : null;
  }

  pinCount(pluginId: string, version: string): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM plugin_session_pins WHERE plugin_id=? AND version=?").get(pluginId, version);
    return Number(row?.n ?? 0);
  }

  releaseSession(sessionId: string): number {
    const changes = this.db.prepare("DELETE FROM plugin_session_pins WHERE session_id=?").run(sessionId);
    return Number(changes.changes);
  }

  /** Only unpinned, inactive, non-running old versions are deleted. */
  async cleanup(pluginId: string, hasRunningProcesses: (version: string) => boolean = () => false): Promise<string[]> {
    const active = this.activeVersion(pluginId);
    const removed: string[] = [];
    for (const version of this.listVersions(pluginId)) {
      if (version.version === active || this.pinCount(pluginId, version.version) > 0 || hasRunningProcesses(version.version)) continue;
      if (version.status !== "enabled") continue;
      await fs.rm(path.join(this.root, pluginId, version.version), { recursive: true, force: true });
      this.db.prepare("DELETE FROM trusted_plugin_versions WHERE plugin_id=? AND version=?").run(pluginId, version.version);
      removed.push(version.version);
    }
    return removed;
  }

  /** Tool-level permission check runs at execution time; a manifest grant is not a session grant. */
  authorizeTool(sessionId: string | undefined, pluginId: string, toolName: string, grantedPermissions: readonly string[]): StoredPluginVersion {
    const active = this.activeVersion(pluginId);
    const version = sessionId ? this.resolveForSession(sessionId, pluginId) : active ? this.getVersion(pluginId, active) : null;
    if (!version) {
      const pending = this.listVersions(pluginId).find(item => item.status === "pending_verification");
      if (pending) throw new PluginAccessError(403, "plugin_not_trusted", "插件未通过信任校验。");
      throw new PluginAccessError(409, "plugin_not_installed", "插件尚未启用。");
    }
    if (version.status !== "enabled" || version.trustState !== "verified") throw new PluginAccessError(403, "plugin_not_trusted", "插件未通过信任校验。");
    const tool = version.manifest.tools.find(item => item.name === toolName);
    if (!tool) throw new PluginAccessError(404, "tool_not_found", "插件没有声明此工具。");
    const granted = new Set(grantedPermissions);
    for (const permission of tool.permissions) {
      if (!granted.has(permission)) throw new PluginAccessError(403, "permission_not_granted", `工具缺少授权：${permission}`);
    }
    return version;
  }
}

function hydrateVersion(row: Record<string, unknown>): StoredPluginVersion {
  return {
    pluginId: String(row.plugin_id), version: String(row.version), packageSha256: String(row.package_sha256),
    publisher: String(row.publisher), trustState: String(row.trust_state) as PluginTrustState,
    status: String(row.status) as PluginStatus, manifest: JSON.parse(String(row.manifest_json)),
    executableHashes: JSON.parse(String(row.executable_hashes_json)), installedAt: String(row.installed_at),
  };
}

function reject(error: unknown): InstallResult {
  if (error instanceof UnsafePackageError) return { status: "rejected", reason: error.code, detail: error.message };
  return { status: "rejected", reason: "install_failed", detail: "插件包无法安装。" };
}
