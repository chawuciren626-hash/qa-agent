import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../src/http/errors.js";
import {
  activeSelectionReferences,
  cancelSelection,
  consumeSelection,
  createRoundSelection,
  currentSelection,
  getSelection,
  selectionDirectory,
  selectionSkillFiles,
  selectionView,
  skillResourceFingerprint,
} from "../src/services/qa-skill-selection.js";
import { makeTempRoot, removeTempRoot } from "./helpers.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");
let root: string;
let resourceDir: string;
let dir: string;

beforeEach(async () => {
  root = await makeTempRoot();
  resourceDir = path.join(root, ".qa-personal-resources", "userhash", "project-1");
  dir = selectionDirectory(root, "userhash", "project-1");
  await fs.mkdir(resourceDir, { recursive: true });
});
afterEach(async () => {
  await removeTempRoot(root);
});

async function writeResource(id: string, name: string, skills: { name: string; files: Record<string, string> }[], extra: Record<string, unknown> = {}) {
  const resource = { id, name, kind: "skill", version: 3, createdAt: "2026-11-02T00:00:00.000Z", skills, ...extra };
  await fs.writeFile(path.join(resourceDir, `${id}.json`), JSON.stringify(resource));
  return resource;
}

const sample = (name: string, body = "read references/example.md") => [
  {
    name,
    files: {
      "SKILL.md": b64(`---\nname: ${name}\ndescription: private guidance\n---\n${body}`),
      "references/example.md": b64(`${name} reference`),
    },
  },
];

async function create(picks: { resourceId: string; skills?: string[] }[], options: { sessionId?: string; agentId?: string; roundKey?: string; now?: number; ttlMs?: number; protectedNames?: Set<string> } = {}) {
  return createRoundSelection({
    dir,
    resourceDir,
    projectId: "project-1",
    userId: "alice",
    sessionId: options.sessionId ?? "session-1",
    agentId: options.agentId ?? "test_agent",
    picks,
    roundKey: options.roundKey,
    now: options.now,
    ttlMs: options.ttlMs,
    protectedNames: options.protectedNames,
  });
}

describe("round-scoped personal Skill selection", () => {
  it("pins version and content hash, snapshots files, and never copies into the agent", async () => {
    const resource = await writeResource("r1", "需求技能", sample("requirement-skill"));
    const expectedHash = skillResourceFingerprint(resource as never);
    const { selection, idempotent } = await create([{ resourceId: "r1", skills: ["requirement-skill"] }]);
    expect(idempotent).toBe(false);
    expect(selection.status).toBe("active");
    expect(selection.round).toBe(1);
    expect(selection.resources).toEqual([
      { resourceId: "r1", name: "需求技能", version: 3, contentHash: expectedHash, skills: ["requirement-skill"] },
    ]);
    expect(selection.skills[0]).toMatchObject({ name: "requirement-skill", resourceId: "r1", resourceVersion: 3 });
    expect(selection.skills[0]!.files.map((file) => file.path)).toEqual(["SKILL.md", "references/example.md"]);

    const view = selectionView(selection);
    expect(view.scope).toBe("round");
    expect(view).not.toHaveProperty("snapshotRoot");
    expect(JSON.stringify(view)).not.toContain(dir);

    const snapshot = path.join(dir, "snapshots", selection.id, "requirement-skill", "references", "example.md");
    expect(await fs.readFile(snapshot, "utf8")).toBe("requirement-skill reference");
    const files = await selectionSkillFiles({ dir, id: selection.id, skillName: "requirement-skill" });
    expect(files.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64").toString("utf8")])).toEqual([
      ["SKILL.md", expect.stringContaining("name: requirement-skill")],
      ["references/example.md", "requirement-skill reference"],
    ]);
    // Selection is a snapshot record; it must not write into project agent skills.
    await expect(fs.access(path.join(root, "project-1"))).rejects.toThrow();
  });

  it("keeps selections isolated by user/project directory and by session/agent target", async () => {
    await writeResource("r1", "需求技能", sample("requirement-skill"));
    const { selection } = await create([{ resourceId: "r1" }], { sessionId: "session-1", agentId: "test_agent" });
    expect((await currentSelection({ dir, sessionId: "session-1", agentId: "test_agent" }))?.id).toBe(selection.id);
    expect(await currentSelection({ dir, sessionId: "session-2", agentId: "test_agent" })).toBeNull();
    expect(await currentSelection({ dir, sessionId: "session-1", agentId: "other_agent" })).toBeNull();
    await expect(getSelection({ dir: selectionDirectory(root, "otherhash", "project-1"), id: selection.id })).rejects.toThrow(HttpError);
  });

  it("returns the same record for a repeated round key and rejects a conflicting one", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    await writeResource("r2", "技能二", sample("skill-two"));
    const first = await create([{ resourceId: "r1" }], { roundKey: "round-key-1" });
    const repeated = await create([{ resourceId: "r1" }], { roundKey: "round-key-1" });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.selection.id).toBe(first.selection.id);
    const conflict = await create([{ resourceId: "r2" }], { roundKey: "round-key-1" }).catch((error) => error);
    expect(conflict).toBeInstanceOf(HttpError);
    expect((conflict as HttpError).code).toBe("selection_conflict");
  });

  it("supersedes the previous active round and removes its snapshot", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    await writeResource("r2", "技能二", sample("skill-two"));
    const first = await create([{ resourceId: "r1" }]);
    const second = await create([{ resourceId: "r2" }]);
    expect(second.selection.round).toBe(2);
    expect((await getSelection({ dir, id: first.selection.id })).status).toBe("superseded");
    expect((await currentSelection({ dir, sessionId: "session-1", agentId: "test_agent" }))?.id).toBe(second.selection.id);
    await expect(fs.access(path.join(dir, "snapshots", first.selection.id))).rejects.toThrow();
    const stale = await consumeSelection({ dir, id: first.selection.id }).catch((error) => error);
    expect(stale).toBeInstanceOf(HttpError);
    expect((stale as HttpError).code).toBe("selection_not_active");
  });

  it("consumes once, keeps consumed records, and refuses cancellation after use", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    const { selection } = await create([{ resourceId: "r1" }]);
    const consumed = await consumeSelection({ dir, id: selection.id });
    expect(consumed.idempotent).toBe(false);
    expect(consumed.selection.status).toBe("consumed");
    expect(consumed.selection.consumedAt).toBeTruthy();
    expect((await consumeSelection({ dir, id: selection.id })).idempotent).toBe(true);
    expect(await currentSelection({ dir, sessionId: "session-1", agentId: "test_agent" })).toBeNull();
    const denied = await cancelSelection({ dir, id: selection.id }).catch((error) => error);
    expect(denied).toBeInstanceOf(HttpError);
    expect((denied as HttpError).code).toBe("selection_not_active");
    expect((await getSelection({ dir, id: selection.id })).status).toBe("consumed");
  });

  it("expires selections, drops the snapshot, and rejects file reads", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    const now = Date.parse("2026-11-02T00:00:00.000Z");
    const { selection } = await create([{ resourceId: "r1" }], { now, ttlMs: 1_000 });
    expect((await getSelection({ dir, id: selection.id, now: now + 2_000 })).status).toBe("expired");
    expect(await currentSelection({ dir, sessionId: "session-1", agentId: "test_agent", now: now + 2_000 })).toBeNull();
    const denied = await selectionSkillFiles({ dir, id: selection.id, skillName: "skill-one", now: now + 2_000 }).catch((error) => error);
    expect(denied).toBeInstanceOf(HttpError);
    expect((denied as HttpError).code).toBe("selection_not_active");
    await expect(fs.access(path.join(dir, "snapshots", selection.id))).rejects.toThrow();
    const expired = await consumeSelection({ dir, id: selection.id, now: now + 2_000 }).catch((error) => error);
    expect((expired as HttpError).code).toBe("selection_not_active");
  });

  it("cancels an active selection and releases the resource for deletion", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    const { selection } = await create([{ resourceId: "r1" }]);
    expect((await activeSelectionReferences({ dir, resourceId: "r1" })).map((item) => item.id)).toEqual([selection.id]);
    await cancelSelection({ dir, id: selection.id });
    expect(await activeSelectionReferences({ dir, resourceId: "r1" })).toEqual([]);
    await expect(getSelection({ dir, id: selection.id })).rejects.toThrow(HttpError);
    await expect(fs.access(path.join(dir, "snapshots", selection.id))).rejects.toThrow();
  });

  it("rejects protected names, duplicate skill names, missing skills, foreign kinds, and unsafe paths", async () => {
    await writeResource("r1", "内置", sample("qa-requirement"));
    const reserved = await create([{ resourceId: "r1" }], { protectedNames: new Set(["qa-requirement"]) }).catch((error) => error);
    expect(reserved).toBeInstanceOf(HttpError);
    expect((reserved as HttpError).code).toBe("protected_skill");

    await writeResource("r2", "重复一", sample("duplicate-skill"));
    await writeResource("r3", "重复二", sample("duplicate-skill"));
    const duplicated = await create([{ resourceId: "r2" }, { resourceId: "r3" }]).catch((error) => error);
    expect(duplicated).toBeInstanceOf(HttpError);
    expect((duplicated as HttpError).code).toBe("skill_selection_conflict");

    const missing = await create([{ resourceId: "r1", skills: ["no-such-skill"] }]).catch((error) => error);
    expect((missing as HttpError).code).toBe("skill_not_in_resource");

    await writeResource("r4", "模型", [], { kind: "model" });
    const kind = await create([{ resourceId: "r4" }]).catch((error) => error);
    expect((kind as HttpError).code).toBe("resource_kind_invalid");

    await writeResource("r5", "路径", [{ name: "unsafe", files: { "../escape.md": b64("x") } }]);
    const unsafe = await create([{ resourceId: "r5" }]).catch((error) => error);
    expect(unsafe).toBeInstanceOf(HttpError);
    expect((unsafe as HttpError).code).toBe("invalid_resource_file");
    await expect(fs.access(path.join(dir, "snapshots"))).rejects.toThrow();
  });

  it("reports a missing snapshot instead of returning partial files", async () => {
    await writeResource("r1", "技能一", sample("skill-one"));
    const { selection } = await create([{ resourceId: "r1" }]);
    await fs.rm(path.join(dir, "snapshots", selection.id), { recursive: true, force: true });
    const error = await selectionSkillFiles({ dir, id: selection.id, skillName: "skill-one" }).catch((item) => item);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("selection_snapshot_missing");
    expect((error as HttpError).status).toBe(410);
  });
});
