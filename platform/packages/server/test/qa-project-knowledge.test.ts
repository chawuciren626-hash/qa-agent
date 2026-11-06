import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import fs from "node:fs/promises";
import path from "node:path";
import { apiClient, createTestApp, loginAdmin, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const zip = (files: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])))).toString("base64");
const skill = (name: string) => `---\nname: ${name}\ndescription: Q2 snapshot guidance\n---\nUse the pinned dossier.`;

type Json = Record<string, any>;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("Q2 project knowledge", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let admin: ReturnType<typeof apiClient>;
  const project = "knowledge_owner-sandbox";
  const otherProject = "knowledge_owner-other";
  const base = `/api/projects/${project}/agents/qa`;
  const otherBase = `/api/projects/${otherProject}/agents/qa`;
  const sessions: Record<string, { projectId: string; agentId: string }> = {
    "session-task": { projectId: project, agentId: "test_agent" },
    "session-next": { projectId: project, agentId: "test_agent" },
    "session-other": { projectId: otherProject, agentId: "test_agent" },
    "session-elsewhere": { projectId: otherProject, agentId: "test_agent" }
  };

  const json = async (res: Response) => (await res.json()) as Json;
  const createDocument = async (client = owner, target = base, body: Json = {}) => {
    const res = await client.post(`${target}/documents`, {
      title: "登录需求",
      format: "markdown",
      content: "# 登录\n连续 5 次验证码错误后锁定账号。",
      ...body
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return json(res) as Promise<{ document: Json; content: string; revision: Json }>;
  };
  const createSessionFixture = () => {
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(
      ((sessionId: string) => {
        const found = sessions[sessionId];
        return found ? { ...found, sessionId } : undefined;
      }) as never
    );
  };

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, "knowledge_owner")).cookie);
    member = apiClient(app.app, (await provisionUser(app.app, "knowledge_member")).cookie);
    outsider = apiClient(app.app, (await provisionUser(app.app, "knowledge_outsider")).cookie);
    admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    expect((await owner.post("/api/projects", { projectId: otherProject })).status).toBe(201);
    expect((await owner.post(`/api/projects/${project}/members`, { userId: "knowledge_member" })).status).toBe(201);
    createSessionFixture();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("keeps document revisions immutable, searchable and isolated per project", async () => {
    const created = await createDocument();
    expect(created.document).toMatchObject({
      documentId: expect.stringMatching(/^doc-/),
      projectId: project,
      title: "登录需求",
      format: "markdown",
      status: "active",
      revision: 1,
      currentRevision: 1,
      createdBy: "knowledge_owner",
      updatedBy: "knowledge_owner"
    });
    expect(created.document.contentHash).toMatch(/^sha256:/);
    expect(created.revision).toMatchObject({ revision: 1, authorUserId: "knowledge_owner" });
    const documentId = created.document.documentId as string;

    // Members read; non-members and other projects do not.
    expect((await member.get(`${base}/documents`)).status).toBe(200);
    expect((await member.get(`${base}/documents/${documentId}`)).status).toBe(200);
    expect((await outsider.get(`${base}/documents/${documentId}`)).status).toBe(404);
    expect((await owner.get(`${otherBase}/documents/${documentId}`)).status).toBe(404);

    // Only the adjacent owner writes; an admin who does not own the project is refused.
    expect((await member.post(`${base}/documents`, { title: "x", content: "x" })).status).toBe(403);
    expect((await admin.post(`${base}/documents`, { title: "x", content: "x" })).status).toBe(403);

    // Revisions are append-only and stale writers conflict.
    expect((await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 2, content: "too late" })).status).toBe(409);
    const updated = await owner.put(`${base}/documents/${documentId}`, {
      expectedRevision: 1,
      content: "# 登录\n连续 5 次验证码错误后锁定账号 15 分钟。",
      changeNote: "补充锁定时长"
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as Json;
    expect(updatedBody.document).toMatchObject({ revision: 2, currentRevision: 2 });
    expect(updatedBody.revision).toMatchObject({ revision: 2, changeNote: "补充锁定时长" });

    const revisions = await json(await member.get(`${base}/documents/${documentId}/revisions`)) as Json;
    expect(revisions.revisions.map((item: Json) => item.revision)).toEqual([2, 1]);
    const firstRevision = await json(await member.get(`${base}/documents/${documentId}/revisions/1`)) as Json;
    expect(firstRevision.content).toContain("锁定账号。");
    expect(firstRevision.content).not.toContain("15 分钟");

    // Search reads the current revision only.
    const found = await json(await member.get(`${base}/documents?q=${encodeURIComponent("15 分钟")}`)) as Json;
    expect(found.documents.map((item: Json) => item.documentId)).toEqual([documentId]);
    const missed = await json(await member.get(`${base}/documents?q=${encodeURIComponent("锁定账号。")}`)) as Json;
    expect(missed.documents).toHaveLength(0);

    // Archiving keeps history readable and removes the document from the default list.
    expect((await owner.delete(`${base}/documents/${documentId}?expectedRevision=2`)).status).toBe(200);
    expect((await json(await owner.get(`${base}/documents`)) as Json).documents).toHaveLength(0);
    const all = await json(await owner.get(`${base}/documents?status=all`)) as Json;
    expect(all.documents[0]).toMatchObject({ status: "archived", revision: 3, currentRevision: 2 });
    expect((await owner.get(`${base}/documents/${documentId}`)).status).toBe(200);
    expect((await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 3, content: "no" })).status).toBe(409);
    expect((await owner.delete(`${base}/documents/${documentId}?expectedRevision=3`)).status).toBe(200);
  });

  it("imports only UTF-8 text formats and rejects unsupported files", async () => {
    const imported = await owner.post(`${base}/documents/import`, {
      filename: "notes/login.txt",
      dataBase64: Buffer.from("首次登录需绑定手机号。", "utf8").toString("base64")
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const body = (await imported.json()) as Json;
    expect(body.document).toMatchObject({ title: "login", format: "text", source: { type: "upload", filename: "login.txt" } });
    expect(body.content).toBe("首次登录需绑定手机号。");

    const pdf = await owner.post(`${base}/documents/import`, {
      filename: "requirements.pdf",
      dataBase64: Buffer.from("%PDF-1.4", "utf8").toString("base64")
    });
    expect(pdf.status).toBe(400);
    expect((await pdf.json() as Json).error.code).toBe("unsupported_document_format");

    const binary = await owner.post(`${base}/documents/import`, {
      filename: "broken.txt",
      dataBase64: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")
    });
    expect(binary.status).toBe(400);
    expect((await binary.json() as Json).error.code).toBe("unsupported_document_format");
  });

  it("lets any member propose evidence candidates but only the owner turns one into a rule", async () => {
    const document = await createDocument();
    const sourceRefs = [{ type: "document", documentId: document.document.documentId, revision: 1 }];
    const proposed = await member.post(`${base}/knowledge/candidates`, {
      title: "验证码锁定",
      statement: "连续 5 次验证码错误后锁定账号 15 分钟。",
      rationale: "需求文档。",
      sourceRefs
    });
    expect(proposed.status, await proposed.clone().text()).toBe(201);
    const candidate = (await proposed.json()) as Json;
    expect(candidate).toMatchObject({ status: "pending", revision: 1, createdBy: { type: "user", userId: "knowledge_member" } });
    expect((await json(await owner.get(`${base}/knowledge/rules`)) as Json).rules).toHaveLength(0);

    // Evidence must resolve inside this project.
    const foreign = await createDocument(owner, otherBase, { title: "其它项目", content: "别的项目资料" });
    const badEvidence = await member.post(`${base}/knowledge/candidates`, {
      title: "跨项目",
      statement: "不应通过",
      sourceRefs: [{ type: "document", documentId: foreign.document.documentId, revision: 1 }]
    });
    expect(badEvidence.status).toBe(400);
    expect((await badEvidence.json() as Json).error.code).toBe("invalid_candidate");

    // Public callers cannot claim Agent provenance, even with a real Session id.
    const wrongAgent = await member.post(`${base}/knowledge/candidates`, {
      title: "来源错误",
      statement: "不应通过",
      sourceRefs,
      createdBy: { type: "agent", agentId: "other_agent", sessionId: "session-task" }
    });
    expect(wrongAgent.status).toBe(403);
    const agentCandidate = await member.post(`${base}/knowledge/candidates`, {
      title: "Agent 观察",
      statement: "登录失败提示需明确剩余次数。",
      sourceRefs,
      createdBy: { type: "agent", agentId: "test_agent", sessionId: "session-task" }
    });
    expect(agentCandidate.status).toBe(403);
    expect((await agentCandidate.json() as Json).error.code).toBe("agent_origin_requires_runtime");

    // Review writes are owner-only.
    const candidateId = candidate.candidateId as string;
    expect((await member.put(`${base}/knowledge/candidates/${candidateId}`, { expectedRevision: 1, title: "改名" })).status).toBe(403);
    expect((await admin.post(`${base}/knowledge/candidates/${candidateId}/confirm`, { expectedRevision: 1 })).status).toBe(403);
    const edited = await owner.put(`${base}/knowledge/candidates/${candidateId}`, { expectedRevision: 1, statement: "连续 5 次验证码错误后锁定账号 15 分钟（含解锁方式）。" });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await edited.json() as Json).revision).toBe(2);
    expect((await owner.post(`${base}/knowledge/candidates/${candidateId}/confirm`, { expectedRevision: 1 })).status).toBe(409);

    const confirmed = await owner.post(`${base}/knowledge/candidates/${candidateId}/confirm`, { expectedRevision: 2 });
    expect(confirmed.status, await confirmed.clone().text()).toBe(201);
    const confirmedBody = (await confirmed.json()) as Json;
    expect(confirmedBody.idempotent).toBe(false);
    expect(confirmedBody.candidate).toMatchObject({ status: "accepted", confirmedRuleId: confirmedBody.rule.ruleId });
    expect(confirmedBody.rule).toMatchObject({
      status: "active",
      version: 1,
      sourceCandidateId: candidateId,
      confirmedBy: "knowledge_owner"
    });
    const repeated = await owner.post(`${base}/knowledge/candidates/${candidateId}/confirm`, { expectedRevision: 2 });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as Json).idempotent).toBe(true);
    expect((await json(await owner.get(`${base}/knowledge/rules`)) as Json).rules).toHaveLength(1);

    // Rejection is terminal for that candidate.
    const second = await member.post(`${base}/knowledge/candidates`, { title: "待拒绝", statement: "证据不足。", sourceRefs });
    const secondId = ((await second.json()) as Json).candidateId as string;
    expect((await owner.post(`${base}/knowledge/candidates/${secondId}/reject`, { expectedRevision: 1, reason: "证据不足" })).status).toBe(200);
    expect((await owner.post(`${base}/knowledge/candidates/${secondId}/confirm`, { expectedRevision: 2 })).status).toBe(409);
  });

  it("versions rules, pins old task snapshots, and refreshes only on explicit instruction", async () => {
    const document = await createDocument();
    const ruleResponse = await owner.post(`${base}/knowledge/rules`, {
      title: "默认锁定",
      statement: "验证码错误 5 次锁定 15 分钟。",
      sourceRefs: [{ type: "document", documentId: document.document.documentId, revision: 1 }],
      changeNote: "初始规则"
    });
    expect(ruleResponse.status, await ruleResponse.clone().text()).toBe(201);
    const rule = (await ruleResponse.json()) as Json;
    expect(rule).toMatchObject({ status: "active", version: 1, confirmedBy: "knowledge_owner" });
    expect((await member.post(`${base}/knowledge/rules`, { title: "x", statement: "x" })).status).toBe(403);

    const created = await owner.post(`${base}/tasks/session-task/context-snapshot`, {});
    expect(created.status, await created.clone().text()).toBe(201);
    const first = (await created.json()) as Json;
    expect(first.created).toBe(true);
    expect(first.snapshot).toMatchObject({ version: 1, agentId: "test_agent", amendment: null });
    expect(first.snapshot.documents).toEqual([
      expect.objectContaining({ documentId: document.document.documentId, revision: 1 })
    ]);
    expect(first.snapshot.rules).toEqual([expect.objectContaining({ ruleId: rule.ruleId, version: 1 })]);
    expect(first.snapshot.capabilities.personalSelection).toBeNull();
    expect(first.snapshot.capabilities.defaultSkills.length).toBeGreaterThan(0);
    const repeated = await owner.post(`${base}/tasks/session-task/context-snapshot`, {});
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as Json).snapshot.snapshotId).toBe(first.snapshot.snapshotId);

    // Later edits do not move the old task's pins.
    const documentId = document.document.documentId as string;
    expect((await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 1, content: "修订后的登录需求。" })).status).toBe(200);
    expect((await owner.post(`${base}/knowledge/rules/${rule.ruleId}/revise`, {
      expectedVersion: 1,
      statement: "验证码错误 5 次锁定 30 分钟。",
      changeNote: "调整时长"
    })).status).toBe(200);
    const newerDocument = await createDocument(owner, base, { title: "二次需求", content: "第二份资料。" });

    const oldSnapshot = await json(await member.get(`${base}/tasks/session-task/context-snapshot`)) as Json;
    expect(oldSnapshot.snapshot.documents).toEqual([expect.objectContaining({ documentId, revision: 1 })]);
    expect(oldSnapshot.snapshot.rules).toEqual([expect.objectContaining({ ruleId: rule.ruleId, version: 1 })]);

    // A new task starts from the latest active versions.
    const nextCreated = await owner.post(`${base}/tasks/session-next/context-snapshot`, {});
    const next = (await nextCreated.json()) as Json;
    expect(next.snapshot.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId, revision: 2 }),
      expect.objectContaining({ documentId: newerDocument.document.documentId, revision: 1 })
    ]));
    expect(next.snapshot.rules).toEqual([expect.objectContaining({ ruleId: rule.ruleId, version: 2 })]);

    // Refresh requires the explicit instruction, the current version, and a target.
    expect((await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, { expectedVersion: 1 })).status).toBe(400);
    expect((await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, { expectedVersion: 1, instruction: "按最新需求检查。" })).status).toBe(400);
    expect((await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, { expectedVersion: 99, instruction: "按最新需求检查。", all: true })).status).toBe(409);

    const refreshed = await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, {
      expectedVersion: 1,
      instruction: "按最新需求重新检查锁定规则。",
      documentIds: [documentId]
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const refreshedBody = (await refreshed.json()) as Json;
    expect(refreshedBody.snapshot.version).toBe(2);
    // A refresh pins only the targets named; unrelated later documents are not pulled in.
    expect(refreshedBody.snapshot.documents).toEqual([
      expect.objectContaining({ documentId, revision: 2 })
    ]);
    expect(refreshedBody.snapshot.rules).toEqual([expect.objectContaining({ ruleId: rule.ruleId, version: 1 })]);
    expect(refreshedBody.amendment).toMatchObject({
      instruction: "按最新需求重新检查锁定规则。",
      requestedByUserId: "knowledge_owner",
      documentIds: [documentId],
      ruleIds: [],
      reanalysisRequired: true
    });
    expect(refreshedBody.amendment.changes).toEqual([
      expect.objectContaining({ kind: "document", documentId, fromRevision: 1, toRevision: 2 })
    ]);

    // A refresh that changes nothing records the instruction with reanalysisRequired=false.
    const noop = await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, {
      expectedVersion: 2,
      instruction: "再次确认当前依据。",
      documentIds: [documentId]
    });
    expect(noop.status).toBe(200);
    const noopBody = (await noop.json()) as Json;
    expect(noopBody.amendment.reanalysisRequired).toBe(false);

    // Retiring the rule removes it from an all=true refresh and rejects an explicit target.
    expect((await owner.post(`${base}/knowledge/rules/${rule.ruleId}/retire`, { expectedVersion: 2 })).status).toBe(200);
    expect((await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, {
      expectedVersion: 3,
      instruction: "只读最新规则。",
      ruleIds: [rule.ruleId]
    })).status).toBe(409);
    const all = await owner.post(`${base}/tasks/session-task/context-snapshot/refresh`, {
      expectedVersion: 3,
      instruction: "全部按最新资料复核。",
      all: true
    });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as Json;
    expect(allBody.snapshot.version).toBe(4);
    expect(allBody.snapshot.rules).toHaveLength(0);
    expect(allBody.amendment.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "rule", ruleId: rule.ruleId, fromVersion: 1, toVersion: null })
    ]));

    const history = await json(await member.get(`${base}/tasks/session-task/context-snapshot/history`)) as Json;
    expect(history.snapshots.map((item: Json) => item.version)).toEqual([4, 3, 2, 1]);
    expect(history.snapshots[3].documents[0].revision).toBe(1);
    expect((await member.get(`${base}/tasks/session-elsewhere/context-snapshot`)).status).toBe(404);
    expect((await member.get(`${otherBase}/tasks/session-task/context-snapshot`)).status).toBe(404);
  });

  it("pins an administrator selection without copying it into the Agent", async () => {
    app.deps.db.prepare("UPDATE users SET is_admin=1 WHERE user_id=?").run("knowledge_owner");
    const personal = `/api/projects/${project}/agents/qa/personal-resources`;
    const imported = await owner.post(personal, {
      kind: "skill",
      dataBase64: zip({ "SKILL.md": skill("pinned-skill"), "references/check.md": "pinned guidance" })
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const resource = (await imported.json()) as Json;
    const selectionResponse = await owner.post(`${personal}/selection`, {
      sessionId: "session-task",
      agentId: "test_agent",
      resources: [{ resourceId: resource.id }],
      roundKey: "q2-snapshot"
    });
    expect(selectionResponse.status, await selectionResponse.clone().text()).toBe(201);
    const selection = ((await selectionResponse.json()) as Json).selection as Json;

    const created = await owner.post(`${base}/tasks/session-task/context-snapshot`, {});
    expect(created.status, await created.clone().text()).toBe(201);
    const snapshot = ((await created.json()) as Json).snapshot as Json;
    expect(snapshot.capabilities.personalSelection).toMatchObject({
      selectionId: selection.selectionId,
      resources: [expect.objectContaining({ resourceId: resource.id, version: 1, skills: ["pinned-skill"] })]
    });
    await expect(fs.access(path.join(app.root, project, "agents/test_agent/agent_state/skills/pinned-skill"))).rejects.toThrow();
    expect((await json(await owner.get(`${personal}/selection/${selection.selectionId}`)) as Json).status).toBe("active");
  });

  it("creates the Q2 tables through the migration and keeps project rows isolated", async () => {
    const tables = app.deps.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qa_%' ORDER BY name"
    ).all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "qa_document_revisions",
      "qa_documents",
      "qa_knowledge_candidates",
      "qa_project_rules",
      "qa_rule_versions",
      "qa_task_context_snapshots"
    ]));
    const own = await createDocument();
    const other = await createDocument(owner, otherBase, { title: "另一个项目", content: "另一个项目的资料" });
    expect((await json(await owner.get(`${otherBase}/documents`)) as Json).documents.map((item: Json) => item.documentId))
      .toEqual([other.document.documentId]);
    expect((await owner.get(`${base}/documents/${other.document.documentId}`)).status).toBe(404);
    expect((await owner.get(`${otherBase}/documents/${own.document.documentId}`)).status).toBe(404);
  });
});
