import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CentralAgentPrivateStore } from "../src/http/central-agent-private-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("central Agent private entries", () => {
  it("persists a sealed key, prevents cross-scope reads, and refuses startup after losing the key", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "central-agent-private-"));
    roots.push(root);
    const db = new DatabaseSync(path.join(root, "data.db"));
    const agent = "a".repeat(36);
    const alice = { userId: "alice", projectId: "qa" };
    try {
      const first = new CentralAgentPrivateStore(db, root);
      first.put(agent, alice, "memory", "notes", "personal context");
      first.put(agent, alice, "vault", "token", "secret-value");
      const second = new CentralAgentPrivateStore(db, root);
      expect(second.list(agent, alice, "memory")[0]).toMatchObject({ value: "personal context" });
      expect(second.list(agent, { userId: "bob", projectId: "qa" }, "memory")).toEqual([]);
      expect(second.list(agent, { userId: "alice", projectId: "other" }, "memory")).toEqual([]);
      expect(second.list(agent, alice, "vault")[0]).toMatchObject({ name: "token" });
      expect(JSON.stringify(second.list(agent, alice, "vault"))).not.toContain("secret-value");
      expect(readFileSync(path.join(root, "data.db")).toString()).not.toContain("secret-value");
      unlinkSync(path.join(root, "central-agent-private.key"));
      expect(() => new CentralAgentPrivateStore(db, root)).toThrow("missing");
    } finally { db.close(); }
  });
});
