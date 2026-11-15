import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PublishedBundleCache, type CachedSharedAgentDefinition } from "./published-bundle-cache.js";
import { localAdapterHash } from "./trusted-local-adapters.js";

export interface TaskContentSnapshot {
  snapshotId: string;
  userId: string;
  projectId: string;
  sessionId?: string;
  taskId?: string;
  agentId: string;
  bundleHash: string;
  modelRevision: string;
  snapshot: {
    agent: { resourceId: string; version: number; contentHash: string };
    skills: { name: string; files: { path: string; sha256: string }[]; directoryHash: string }[];
    plugins: { resourceId: string; version: number; contentHash: string; name?: string; executableHash?: string }[];
    model: { resourceId: string; version: number; contentHash: string; revision: string } | null;
    capturedAt: string;
  };
  createdAt: string;
}

export interface SnapshotContext {
  userId: string;
  projectId: string;
  sessionId?: string;
  taskId?: string;
  engineRoot?: string;
}

/**
 * Records what a task actually ran with: the materialized Skill files, executable plugin files
 * and the model revision. Evidence hashes are computed from disk, not copied from the manifest.
 */
export class TaskContentSnapshotStore {
  private readonly cache: PublishedBundleCache;
  constructor(private readonly db: DatabaseSync, dataRoot: string) {
    this.cache = new PublishedBundleCache(dataRoot);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_content_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      agent_id TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, bundle_hash)
    )`);
  }

  async capture(definition: CachedSharedAgentDefinition, context: SnapshotContext): Promise<TaskContentSnapshot> {
    const existing = context.sessionId ? this.getBySession(context.sessionId) : null;
    if (existing && existing.bundleHash === definition.bundleHash) return existing;
    const bundle = await this.cache.load(context.userId, definition.bundleHash);
    const model = bundle.resources[0]?.payload.modelResource === undefined
      ? null
      : bundle.resources.find(resource => resource.kind === "models" && resource.id === bundle.resources[0]!.payload.modelResource) ?? null;
    const modelRevision = model ? `${model.payload.modelRevision ?? model.version}` : "none";
    const skills = [];
    for (const skill of definition.skills) {
      const files = await hashDirectory(skill.directory);
      skills.push({
        name: skill.name,
        files,
        directoryHash: `sha256:${createHash("sha256").update(files.map(file => `${file.path}\0${file.sha256}`).join("\n")).digest("hex")}`,
      });
    }
    const plugins = [];
    for (const resource of bundle.resources.filter(item => item.kind === "plugins")) {
      const adapter = definition.localAdapters.find(item => item.name === resource.payload.pluginName);
      const executableHash = adapter && context.engineRoot ? await localAdapterHash(context.engineRoot, adapter.name) : adapter?.hash;
      plugins.push({
        resourceId: resource.id, version: resource.version, contentHash: createHash("sha256").update(JSON.stringify(resource.payload)).digest("hex"),
        ...(typeof resource.payload.pluginName === "string" ? { name: resource.payload.pluginName } : {}),
        ...(executableHash ? { executableHash } : {}),
      });
    }
    const snapshot: TaskContentSnapshot = {
      snapshotId: randomUUID(),
      userId: context.userId,
      projectId: context.projectId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      agentId: definition.agentId,
      bundleHash: definition.bundleHash,
      modelRevision,
      snapshot: {
        agent: { resourceId: bundle.rootId, version: bundle.versions[0]!.version, contentHash: bundle.versions[0]!.contentHash },
        skills, plugins,
        model: model ? { resourceId: model.id, version: model.version, contentHash: createHash("sha256").update(JSON.stringify(model.payload)).digest("hex"), revision: modelRevision } : null,
        capturedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT OR IGNORE INTO task_content_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      snapshot.snapshotId, snapshot.userId, snapshot.projectId, snapshot.sessionId ?? null, snapshot.taskId ?? null,
      snapshot.agentId, snapshot.bundleHash, snapshot.modelRevision, JSON.stringify(snapshot.snapshot), snapshot.createdAt,
    );
    return this.getBySession(context.sessionId ?? "") ?? snapshot;
  }

  getBySession(sessionId: string): TaskContentSnapshot | null {
    if (!sessionId) return null;
    const row = this.db.prepare("SELECT * FROM task_content_snapshots WHERE session_id=? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1").get(sessionId);
    return row ? hydrate(row) : null;
  }
}

function hydrate(row: Record<string, unknown>): TaskContentSnapshot {
  return {
    snapshotId: String(row.snapshot_id),
    userId: String(row.user_id),
    projectId: String(row.project_id),
    ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
    ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
    agentId: String(row.agent_id),
    bundleHash: String(row.bundle_hash),
    modelRevision: String(row.model_revision),
    snapshot: JSON.parse(String(row.snapshot_json)),
    createdAt: String(row.created_at),
  };
}

async function hashDirectory(directory: string): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".published-complete") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw Error("Skill content contains a symbolic link");
      if (stat.isDirectory()) { await walk(target, relative); continue; }
      if (!stat.isFile()) continue;
      const hash = createHash("sha256").update(await fs.readFile(target)).digest("hex");
      result.push({ path: relative, sha256: `sha256:${hash}` });
    }
  };
  await walk(directory, "");
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
