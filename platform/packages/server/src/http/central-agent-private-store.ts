/** Private Agent data lives outside immutable public resources. A project key is nested under
 * the authenticated account until the central service can verify cross-account project membership.
 */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PrivateAgentScope = { userId: string; projectId: string };
export type PrivateAgentKind = "memory" | "vault";

export class CentralAgentPrivateStore {
  private readonly key: Buffer;

  constructor(private readonly db: DatabaseSync, root?: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS central_agent_private_entries(
      resource_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(resource_id,user_id,project_id,kind,name)
    )`);
    if (!root) { this.key = randomBytes(32); return; }
    const file = path.join(root, "central-agent-private.key");
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!existing) {
      const hasRows = db.prepare("SELECT 1 FROM central_agent_private_entries LIMIT 1").get();
      if (hasRows) throw Error("Central Agent private encryption key is missing");
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(file, flags, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, randomBytes(32).toString("base64")); }
      finally { fs.closeSync(fd); }
    } else if (!existing.isFile() || existing.isSymbolicLink()) throw Error("Central Agent private key path is unsafe");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Central Agent private key path is unsafe");
    const encoded = fs.readFileSync(file, "utf8").trim();
    this.key = Buffer.from(encoded, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== encoded) throw Error("Invalid Central Agent private key");
  }

  private aad(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind, name: string): Buffer {
    return Buffer.from(JSON.stringify([resourceId, scope.userId, scope.projectId, kind, name]));
  }

  private seal(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind, name: string, value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(resourceId, scope, kind, name));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  private open(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind, name: string, encoded: string): string {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length < 28) throw Error("Invalid private Agent entry");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(this.aad(resourceId, scope, kind, name));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  list(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind) {
    const rows = this.db.prepare("SELECT name,ciphertext,updated_at FROM central_agent_private_entries WHERE resource_id=? AND user_id=? AND project_id=? AND kind=? ORDER BY name").all(resourceId, scope.userId, scope.projectId, kind) as { name: string; ciphertext: string; updated_at: string }[];
    return rows.map(row => ({ name: row.name, ...(kind === "memory" ? { value: this.open(resourceId, scope, kind, row.name, row.ciphertext) } : {}), updatedAt: row.updated_at }));
  }


  count(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM central_agent_private_entries WHERE resource_id=? AND user_id=? AND project_id=? AND kind=?")
      .get(resourceId, scope.userId, scope.projectId, kind) as { total: number };
    return Number(row.total);
  }

  put(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind, name: string, value: string) {
    this.db.prepare("INSERT INTO central_agent_private_entries VALUES (?,?,?,?,?,?,?) ON CONFLICT(resource_id,user_id,project_id,kind,name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at")
      .run(resourceId, scope.userId, scope.projectId, kind, name, this.seal(resourceId, scope, kind, name, value), new Date().toISOString());
  }

  delete(resourceId: string, scope: PrivateAgentScope, kind: PrivateAgentKind, name: string) {
    return this.db.prepare("DELETE FROM central_agent_private_entries WHERE resource_id=? AND user_id=? AND project_id=? AND kind=? AND name=?")
      .run(resourceId, scope.userId, scope.projectId, kind, name).changes > 0;
  }
}
