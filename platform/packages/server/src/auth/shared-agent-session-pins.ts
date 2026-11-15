import type { DatabaseSync } from "node:sqlite";
import { PublishedBundleCache, type CachedSharedAgentDefinition } from "./published-bundle-cache.js";

export interface SharedAgentSessionPin {
  sessionId: string;
  projectId: string;
  agentId: string;
  userId: string;
  bundleHash: string;
}

/** Local, immutable version pins. The central service receives no project or session data. */
export class SharedAgentSessionPins {
  private readonly cache: PublishedBundleCache;
  constructor(private readonly db: DatabaseSync, dataRoot: string) {
    this.cache = new PublishedBundleCache(dataRoot);
    db.exec("CREATE TABLE IF NOT EXISTS shared_agent_session_pins (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, local_user_id TEXT NOT NULL, bundle_hash TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS shared_agent_session_catalog (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, local_user_id TEXT NOT NULL, bundle_hash TEXT NOT NULL, PRIMARY KEY(session_id,agent_id))");
  }

  async pin(value: SharedAgentSessionPin): Promise<CachedSharedAgentDefinition> {
    const definition = await this.cache.definition(value.userId, value.bundleHash);
    if (definition.agentId !== value.agentId) throw Error("Shared Agent pin role mismatch");
    const prior = this.get(value.sessionId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(value)) throw Error("Shared Agent session pin is immutable");
      return definition;
    }
    this.db.prepare("INSERT INTO shared_agent_session_pins VALUES (?,?,?,?,?)").run(value.sessionId, value.projectId, value.agentId, value.userId, value.bundleHash);
    return definition;
  }

  get(sessionId: string): SharedAgentSessionPin | null {
    const row = this.db.prepare("SELECT session_id,project_id,agent_id,local_user_id,bundle_hash FROM shared_agent_session_pins WHERE session_id=?").get(sessionId);
    if (!row) return null;
    return { sessionId: String(row.session_id), projectId: String(row.project_id), agentId: String(row.agent_id), userId: String(row.local_user_id), bundleHash: String(row.bundle_hash) };
  }

  async catalog(sessionId: string, userId: string, bundles: readonly { agentId: string; bundleHash: string }[]): Promise<void> {
    for (const item of bundles) {
      const definition = await this.cache.definition(userId, item.bundleHash);
      if (definition.agentId !== item.agentId) throw Error("Shared Agent catalog role mismatch");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of bundles) {
        const prior = this.db.prepare("SELECT local_user_id,bundle_hash FROM shared_agent_session_catalog WHERE session_id=? AND agent_id=?").get(sessionId, item.agentId);
        if (prior && (prior.local_user_id !== userId || prior.bundle_hash !== item.bundleHash)) throw Error("Shared Agent session catalog is immutable");
        this.db.prepare("INSERT OR IGNORE INTO shared_agent_session_catalog VALUES (?,?,?,?)").run(sessionId, item.agentId, userId, item.bundleHash);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async inherit(parentSessionId: string, sessionId: string, projectId: string, agentId: string): Promise<CachedSharedAgentDefinition> {
    const parent = this.get(parentSessionId);
    if (!parent || parent.projectId !== projectId) throw Error("Shared Agent parent session is unavailable");
    const rows = this.db.prepare("SELECT agent_id,bundle_hash FROM shared_agent_session_catalog WHERE session_id=?").all(parentSessionId);
    const selected = rows.find(row => row.agent_id === agentId);
    if (!selected) throw Error("Shared Agent child role was not in the parent's catalog snapshot");
    await this.catalog(sessionId, parent.userId, rows.map(row => ({ agentId: String(row.agent_id), bundleHash: String(row.bundle_hash) })));
    return this.pin({ sessionId, projectId, agentId, userId: parent.userId, bundleHash: String(selected.bundle_hash) });
  }

  async resolve(sessionId: string, projectId: string, agentId: string): Promise<CachedSharedAgentDefinition | null> {
    const pin = this.get(sessionId);
    if (!pin) return null;
    if (pin.projectId !== projectId || pin.agentId !== agentId) throw Error("Shared Agent session pin coordinates mismatch");
    const definition = await this.cache.definition(pin.userId, pin.bundleHash);
    if (definition.agentId !== agentId) throw Error("Shared Agent session pin role mismatch");
    return definition;
  }
}
