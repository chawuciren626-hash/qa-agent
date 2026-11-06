import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { sessionScratchpadDir } from "@prismshadow/penguin-core";
import { apiClient, createTestApp, provisionUser, type TestApp } from "./helpers.js";
import { prepareQaTaskContext } from "../src/services/qa-task-context.js";
import { currentSelection, selectionDirectory } from "../src/services/qa-skill-selection.js";

const projectId = "context_owner-sandbox";
const sessionId = "task-context-session";
const agentId = "test_agent";
const userId = "context_owner";
const base = `/api/projects/${projectId}/agents/qa`;
const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, content]) => [name, strToU8(content)])
))).toString("base64");

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("QA task dispatch context", () => {
  let app: TestApp;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("reads pinned evidence and supplies a personal Skill for one accepted round", async () => {
    app = await createTestApp();
    const owner = apiClient(app.app, (await provisionUser(app.app, userId)).cookie);
    expect((await owner.post("/api/projects", { projectId })).status).toBe(201);
    vi.spyOn(app.deps.sessionsRepo, "findById").mockReturnValue({ projectId, agentId } as never);
    const doc = await owner.post(`${base}/documents`, { title: "登录要求", content: "旧版：五次失败锁定十五分钟。" });
    expect(doc.status).toBe(201);
    const documentId = ((await doc.json()) as { document: { documentId: string } }).document.documentId;
    const rule = await owner.post(`${base}/knowledge/rules`, { title: "锁定时长", statement: "原规则：十五分钟。" });
    expect(rule.status).toBe(201);
    const ruleId = ((await rule.json()) as { ruleId: string }).ruleId;
    // Legacy/admin-only selections remain readable after the user entry is closed.
    app.deps.db.prepare("UPDATE users SET is_admin=1 WHERE user_id=?").run(userId);
    const personal = `${base}/personal-resources`;
    const imported = await owner.post(personal, { kind: "skill", dataBase64: zip({
      "SKILL.md": "---\nname: round-guide\ndescription: round guidance\n---\nRead references/guide.md first.",
      "references/guide.md": "Only for this round."
    }) });
    expect(imported.status).toBe(201);
    const resourceId = ((await imported.json()) as { id: string }).id;
    const selected = await owner.post(`${personal}/selection`, {
      sessionId, agentId, resources: [{ resourceId }], roundKey: "first-round"
    });
    expect(selected.status).toBe(201);
    const selectionId = ((await selected.json()) as { selection: { selectionId: string } }).selection.selectionId;
    const contextInput = {
      db: app.deps.db, root: app.root, projectId, agentId, sessionId, userId,
      findSession: (id: string) => id === sessionId ? { projectId, agentId } : null,
      requestText: "检查登录要求"
    };
    const first = await prepareQaTaskContext(contextInput);
    expect(first.selectionId).toBe(selectionId);
    expect(first.text).toContain("旧版：五次失败锁定十五分钟。");
    expect(first.text).toContain("原规则：十五分钟。");
    expect(first.text).toContain("默认测试 Skill 仍有效");
    const scratch = sessionScratchpadDir(app.root, projectId, agentId, sessionId);
    expect(await fs.readFile(path.join(scratch, "personal-skills", selectionId, "round-guide", "references", "guide.md"), "utf8"))
      .toBe("Only for this round.");
    expect(await fs.readFile(path.join(scratch, "personal-skills", selectionId, "round-guide", "SKILL.md"), "utf8"))
      .toContain("name: round-guide");

    expect((await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 1, content: "新版：锁定三十分钟。" })).status).toBe(200);
    expect((await owner.post(`${base}/knowledge/rules/${ruleId}/revise`, { expectedVersion: 1, statement: "新规则：三十分钟。" })).status).toBe(200);
    await first.consumeSelection();
    const dir = selectionDirectory(app.root, createHash("sha256").update(userId).digest("hex"), projectId);
    expect(await currentSelection({ dir, sessionId, agentId })).toBeNull();
    const next = await prepareQaTaskContext(contextInput);
    expect(next.selectionId).toBeNull();
    expect(next.text).toContain("旧版：五次失败锁定十五分钟。");
    expect(next.text).toContain("原规则：十五分钟。");
    expect(next.text).not.toContain("新版：锁定三十分钟。");
    expect(next.text).not.toContain("新规则：三十分钟。");
    expect(next.text).not.toContain("本轮个人 Skill（selection");
  });
});
