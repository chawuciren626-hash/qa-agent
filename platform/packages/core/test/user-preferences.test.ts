/**
 * Local user preferences: explicit-only writes, ownership isolation across users, injection
 * into the real assembled system prompt across Projects/Agents/Workspaces, disable/delete
 * taking effect on the next task, task-start snapshots, import validation, and path/symlink/
 * size refusals.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ID,
  USER_PREFERENCE_CONTENT_MAX_BYTES,
  USER_PREFERENCE_OWNER_FILENAME,
  UserPreferenceError,
  createAgent,
  deleteUserPreference,
  exportUserPreferences,
  importUserPreferences,
  listUserPreferenceSnapshots,
  listUserPreferences,
  resolveSessionMemory,
  resolveUserPreferences,
  saveUserPreference,
  setUserPreferenceDisabled,
  sha256Text,
  userPreferenceDirFor,
  userPreferencesRootDir,
} from "../src/index.js";
import { seedProject } from "./seeded-project.js";
import { stubProviderKeys } from "./provider-keys.js";

let root: string;
let workspaceA: string;
let workspaceB: string;
let restoreKeys: () => void;

const USER_A = "user-a";
const USER_B = "user-b";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-user-prefs-"));
  workspaceA = path.join(root, "workspaces", "alpha");
  workspaceB = path.join(root, "workspaces", "beta");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  restoreKeys = stubProviderKeys();
  await seedProject(root);
  await seedProject(root, "project-b");
});

afterEach(async () => {
  restoreKeys();
  await fs.rm(root, { recursive: true, force: true });
});

function sessionPrompt(session: { metaMessage: { payload: unknown } }): string {
  return (session.metaMessage.payload as { system_prompt: string }).system_prompt;
}

async function seedPreference(userId: string, title: string, content: string) {
  return (await saveUserPreference(root, userId, { title, content })).entry;
}

describe("explicit save and cross-project injection", () => {
  it("stores an explicitly saved preference per user and injects it into real sessions", async () => {
    const entry = await seedPreference(USER_A, "Units", "Always use metric units.");
    expect(entry.source).toBe("explicit_user_save");
    expect(entry.contentHash).toBe(sha256Text("Always use metric units."));
    expect(await listUserPreferences(root, USER_A)).toHaveLength(1);
    expect(await listUserPreferences(root, USER_B)).toHaveLength(0);

    const agentA = await createAgent({ root });
    const agentB = await createAgent({ root, projectId: "project-b" });
    const a1 = await agentA.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    const a2 = await agentB.createSession({ workspaceDir: workspaceB, ownerUserId: USER_A });
    const b1 = await agentA.createSession({ workspaceDir: workspaceA, ownerUserId: USER_B });
    try {
      // The assertion reads the prompt the model request was actually built with.
      for (const session of [a1, a2]) {
        const prompt = sessionPrompt(session);
        expect(prompt).toContain("## Local user preferences");
        expect(prompt).toContain("Always use metric units.");
        expect(prompt).toContain("not instructions");
      }
      expect(sessionPrompt(b1)).not.toContain("Always use metric units.");
      expect(sessionPrompt(b1)).not.toContain("## Local user preferences");
    } finally {
      a1.dispose();
      a2.dispose();
      b1.dispose();
    }
  });

  it("keeps two users, two projects, two agents and two workspaces isolated", async () => {
    await seedPreference(USER_A, "Tone", "Answer in British English.");
    await seedPreference(USER_B, "Tone", "Answer in American English.");

    const combos = [
      { userId: USER_A, projectId: DEFAULT_PROJECT_ID, agentId: "default_agent", ws: workspaceA, want: "British", avoid: "American" },
      { userId: USER_A, projectId: "project-b", agentId: "other_agent", ws: workspaceB, want: "British", avoid: "American" },
      { userId: USER_B, projectId: DEFAULT_PROJECT_ID, agentId: "other_agent", ws: workspaceB, want: "American", avoid: "British" },
      { userId: USER_B, projectId: "project-b", agentId: "default_agent", ws: workspaceA, want: "American", avoid: "British" },
    ];
    const sessions = [];
    try {
      for (const combo of combos) {
        const agent = await createAgent({
          root,
          projectId: combo.projectId,
          agentId: combo.agentId,
        });
        const session = await agent.createSession({
          workspaceDir: combo.ws,
          ownerUserId: combo.userId,
        });
        sessions.push(session);
        const prompt = sessionPrompt(session);
        expect(prompt).toContain(combo.want);
        expect(prompt).not.toContain(combo.avoid);
      }
    } finally {
      for (const session of sessions) session.dispose();
    }
  });

  it("stops injecting a disabled entry and stops injecting a deleted one on the next task", async () => {
    const entry = await seedPreference(USER_A, "Style", "Prefer short paragraphs.");
    const agent = await createAgent({ root });

    const before = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    expect(sessionPrompt(before)).toContain("Prefer short paragraphs.");
    before.dispose();

    await setUserPreferenceDisabled(root, USER_A, entry.id, true);
    expect(await listUserPreferences(root, USER_A)).toHaveLength(1); // disabling keeps it
    const disabled = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    expect(sessionPrompt(disabled)).not.toContain("Prefer short paragraphs.");
    disabled.dispose();

    await setUserPreferenceDisabled(root, USER_A, entry.id, false);
    const enabled = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    expect(sessionPrompt(enabled)).toContain("Prefer short paragraphs.");
    enabled.dispose();

    await deleteUserPreference(root, USER_A, entry.id);
    const deleted = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    expect(sessionPrompt(deleted)).not.toContain("Prefer short paragraphs.");
    deleted.dispose();
  });

  it("injects nothing for a session with no owner, and nothing when memory is disabled", async () => {
    await seedPreference(USER_A, "Units", "Always use metric units.");
    const agent = await createAgent({ root });
    const anonymous = await agent.createSession({ workspaceDir: workspaceA });
    expect(sessionPrompt(anonymous)).not.toContain("Always use metric units.");
    anonymous.dispose();

    const memory = await resolveSessionMemory({
      root,
      projectId: DEFAULT_PROJECT_ID,
      agentId: "default_agent",
      workspaceDir: workspaceA,
      enabled: false,
      userId: USER_A,
    });
    expect(memory?.userPreferences).toBeUndefined();
  });
});

describe("task-start snapshots", () => {
  it("records entry ids and hashes per session without a body, and later edits do not rewrite it", async () => {
    const first = await seedPreference(USER_A, "Units", "Always use metric units.");
    const agent = await createAgent({ root });
    const session = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    const sessionId = session.sessionId;
    const originalPrompt = sessionPrompt(session);
    session.dispose();

    const snapshots = await listUserPreferenceSnapshots(
      root,
      DEFAULT_PROJECT_ID,
      "default_agent",
      sessionId,
    );
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.ownerUserId).toBe(USER_A);
    expect(snapshot.scope).toBe("local_user_preference");
    expect(snapshot.target.provider).toBe("deepseek");
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([first.id]);
    expect(snapshot.entries[0]!.contentHash).toBe(sha256Text("Always use metric units."));
    expect(JSON.stringify(snapshot)).not.toContain("Always use metric units.");
    expect(snapshot.injection.blockBytes).toBeGreaterThan(0);

    // A later edit changes the next task, never the snapshot or the earlier task's prompt.
    await saveUserPreference(root, USER_A, {
      id: first.id,
      title: "Units",
      content: "Always use imperial units.",
      expectedHash: first.contentHash,
    });
    const next = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    expect(sessionPrompt(next)).toContain("Always use imperial units.");
    expect(sessionPrompt(next)).not.toContain("Always use metric units.");
    next.dispose();

    const unchanged = await listUserPreferenceSnapshots(
      root,
      DEFAULT_PROJECT_ID,
      "default_agent",
      sessionId,
    );
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]!.entries[0]!.contentHash).toBe(first.contentHash);
    expect(originalPrompt).toContain("Always use metric units.");
  });

  it("creates a fresh snapshot for a task that reads the changed preference set", async () => {
    const entry = await seedPreference(USER_A, "Units", "Always use metric units.");
    const agent = await createAgent({ root });
    const first = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    first.dispose();
    await setUserPreferenceDisabled(root, USER_A, entry.id, true);
    const second = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
    second.dispose();

    const firstSnaps = await listUserPreferenceSnapshots(
      root,
      DEFAULT_PROJECT_ID,
      "default_agent",
      first.sessionId,
    );
    const secondSnaps = await listUserPreferenceSnapshots(
      root,
      DEFAULT_PROJECT_ID,
      "default_agent",
      second.sessionId,
    );
    expect(firstSnaps[0]!.entries).toHaveLength(1);
    expect(secondSnaps[0]!.entries).toHaveLength(0);
    expect(secondSnaps[0]!.snapshotId).not.toBe(firstSnaps[0]!.snapshotId);
  });
});

describe("ownership and path safety", () => {
  it("rejects an owner marker that names another user", async () => {
    const dir = userPreferenceDirFor(root, USER_A);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, USER_PREFERENCE_OWNER_FILENAME),
      JSON.stringify({ schemaVersion: 1, userId: USER_B, createdAt: new Date().toISOString() }),
    );
    await expect(seedPreference(USER_A, "Tone", "British English.")).rejects.toMatchObject({
      code: "ownership_mismatch",
    });
    await expect(resolveUserPreferences(root, USER_A)).rejects.toMatchObject({
      code: "ownership_mismatch",
    });
    expect(userPreferencesRootDir(root)).toBe(path.join(root, ".local-users"));
  });

  it("rejects a traversal id and ignores non-file entries", async () => {
    await expect(
      saveUserPreference(root, USER_A, { id: "../evil", title: "x", content: "y" }),
    ).rejects.toBeInstanceOf(UserPreferenceError);
    await expect(resolveUserPreferences(root, " user-with-space")).rejects.toMatchObject({
      code: "invalid_user_id",
    });

    await seedPreference(USER_A, "Units", "Metric.");
    const dir = userPreferenceDirFor(root, USER_A);
    await fs.mkdir(path.join(dir, "nested-dir.json"), { recursive: true });
    expect(await listUserPreferences(root, USER_A)).toHaveLength(1);
  });

  it("refuses a symlinked preference directory", async () => {
    const dir = userPreferenceDirFor(root, USER_A);
    const target = path.join(root, "elsewhere");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    try {
      await fs.symlink(target, dir, "junction");
    } catch {
      return; // The platform does not allow the test to stage this attack.
    }
    await expect(seedPreference(USER_A, "Tone", "British English.")).rejects.toMatchObject({
      code: "ownership_mismatch",
    });
  });

  it("rejects an oversized preference body", async () => {
    await expect(
      seedPreference(USER_A, "Huge", "x".repeat(USER_PREFERENCE_CONTENT_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ code: "preference_limit" });
  });

  it("rejects an expected-hash mismatch instead of overwriting", async () => {
    const entry = await seedPreference(USER_A, "Units", "Metric.");
    await expect(
      saveUserPreference(root, USER_A, {
        id: entry.id,
        title: "Units",
        content: "Imperial.",
        expectedHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "preference_conflict" });
    expect((await listUserPreferences(root, USER_A))[0]!.content).toBe("Metric.");
  });
});

describe("import and export", () => {
  it("validates ownership and content versions before writing anything", async () => {
    await seedPreference(USER_A, "Units", "Metric.");
    const doc = await exportUserPreferences(root, USER_A);

    await expect(
      importUserPreferences(root, USER_B, doc, { mode: "overwrite" }),
    ).rejects.toMatchObject({ code: "ownership_mismatch" });
    expect(await listUserPreferences(root, USER_B)).toHaveLength(0);

    const tampered = {
      ...doc,
      entries: [{ ...doc.entries[0]!, id: "../escape" }],
    };
    await expect(importUserPreferences(root, USER_A, tampered)).rejects.toMatchObject({
      code: "import_invalid",
    });
  });

  it("previews without writing, applies idempotently, and requires confirmation for replace", async () => {
    await seedPreference(USER_A, "Units", "Metric.");
    const doc = await exportUserPreferences(root, USER_A);
    await seedPreference(USER_A, "Later", "Keep this local entry.");

    const dry = await importUserPreferences(root, USER_A, doc, { dryRun: true, mode: "replace" });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toHaveLength(1); // "Later" is not in the document
    expect(await listUserPreferences(root, USER_A)).toHaveLength(2);

    await expect(
      importUserPreferences(root, USER_A, doc, { mode: "replace" }),
    ).rejects.toMatchObject({ code: "import_confirmation_required" });
    expect(await listUserPreferences(root, USER_A)).toHaveLength(2);

    const replaced = await importUserPreferences(root, USER_A, doc, {
      mode: "replace",
      confirm: true,
    });
    expect(replaced.removed).toHaveLength(1);
    expect(await listUserPreferences(root, USER_A)).toHaveLength(1);

    const rerun = await importUserPreferences(root, USER_A, doc, { mode: "skip" });
    expect(rerun.added).toHaveLength(0);
    expect(rerun.skipped).toHaveLength(1);
    expect(await listUserPreferences(root, USER_A)).toHaveLength(1);
  });

  it("round-trips through export with an aggregate hash", async () => {
    await seedPreference(USER_A, "Units", "Metric.");
    const doc = await exportUserPreferences(root, USER_A);
    expect(doc.format).toBe("penguin-user-preferences");
    expect(doc.version).toBe(1);
    expect(doc.counts.entries).toBe(1);
    expect(doc.aggregateHash).toHaveLength(64);
    expect(doc.entries[0]!.ownerUserId).toBe(USER_A);
  });
});

it('injects local preferences into a published Agent without replacing its definition', async () => {
  await seedPreference(USER_A, 'Format', 'Use short numbered test steps.');
  const agent = await createAgent({ root, assembly: {
    publishedDefinition: async () => ({ bundleHash: 'sha256:' + 'a'.repeat(64), prompt: '{{MEMORY}}', agentsMd: 'Published test instructions', skills: [], pluginInstructions: [] }),
  } });
  const session = await agent.createSession({ workspaceDir: workspaceA, ownerUserId: USER_A });
  try {
    expect(sessionPrompt(session)).toContain('Use short numbered test steps.');
    expect(sessionPrompt(session)).toContain('sha256:' + 'a'.repeat(64));
  } finally { session.dispose(); }
});
