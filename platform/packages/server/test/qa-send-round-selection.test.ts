/**
 * The shared send path (UI and API) supplies the round-scoped personal Skill and consumes the
 * selection only after the Task was accepted:
 *
 * - a successful send prepends the pinned round context and consumes the selection;
 * - a send that fails after that context was prepared leaves the selection active;
 * - the selection is keyed by Session and Agent, so another Session or Agent never reuses it.
 *
 * These are the send-path contracts T1/T2 depends on; the chooser UI is covered by the web
 * suite and the selection service by qa-skill-selection.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { AmspRecord } from "@prismshadow/penguin-core";
import { assistantText } from "@prismshadow/penguin-core";
import { createHash } from "node:crypto";
import { apiClient, createTestApp, provisionUser, waitFor, type TestApp } from "./helpers.js";
import { adoptSession, fakeSession, uniqueSessionId } from "./fixtures/session.js";
import type { RuntimeSession } from "../src/runtime/session-manager.js";
import { currentSelection, selectionDirectory } from "../src/services/qa-skill-selection.js";

const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, content]) => [name, strToU8(content)])
))).toString("base64");

function recordingSession(sessionId: string, runs: AmspRecord[][]): RuntimeSession {
  return fakeSession(sessionId, {
    async *run(input: AmspRecord[]) {
      runs.push(input);
      yield assistantText("done");
    },
  });
}

function promptText(input: AmspRecord[]): string {
  return input
    .map((message) => (message.payload as { text?: string }).text ?? "")
    .filter(Boolean)
    .join("\n");
}

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("QA task dispatch round selection", () => {
  let app: TestApp;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  async function setup(userId: string, agentId = "test_agent") {
    app = await createTestApp();
    const owner = apiClient(app.app, (await provisionUser(app.app, userId)).cookie);
    const projectId = `${userId}-sandbox`;
    expect((await owner.post("/api/projects", { projectId })).status).toBe(201);
    const personal = `/api/projects/${projectId}/agents/qa/personal-resources`;
    const imported = await owner.post(personal, {
      kind: "skill",
      dataBase64: zip({
        "SKILL.md": "---\nname: round-guide\ndescription: round guidance\n---\nRead references/guide.md first.",
        "references/guide.md": "Only for this round.",
      }),
    });
    expect(imported.status).toBe(201);
    const resourceId = ((await imported.json()) as { id: string }).id;
    const sessionId = uniqueSessionId();
    const runs: AmspRecord[][] = [];
    adoptSession(app.deps, recordingSession(sessionId, runs), {
      projectId,
      agentId,
      workspace: "/tmp/qa-round",
    });
    const dir = selectionDirectory(
      app.root,
      createHash("sha256").update(userId).digest("hex"),
      projectId,
    );
    return { owner, projectId, personal, resourceId, sessionId, runs, dir };
  }

  it("consumes the selection only after an accepted send", async () => {
    const { owner, personal, resourceId, sessionId, runs, dir } = await setup("round_accept");
    const selected = await owner.post(`${personal}/selection`, {
      sessionId,
      agentId: "test_agent",
      resources: [{ resourceId }],
      roundKey: "round-accept-1",
    });
    expect(selected.status).toBe(201);

    const sent = await owner.post(`/api/sessions/${sessionId}/tasks`, {
      input: [{ type: "text", text: "检查登录要求" }],
    });
    expect(sent.status).toBe(202);
    await waitFor(() => runs.length === 1);
    expect(promptText(runs[0]!)).toContain("本轮个人 Skill（selection");
    expect(await currentSelection({ dir, sessionId, agentId: "test_agent" })).toBeNull();
    expect(
      (await owner.get(`${personal}/selection?sessionId=${sessionId}&agentId=test_agent`)).status,
    ).toBe(200);
    expect(
      ((await (await owner.get(
        `${personal}/selection?sessionId=${sessionId}&agentId=test_agent`,
      )).json()) as { selection: unknown }).selection,
    ).toBeNull();
  });

  it("keeps the selection active when the send never starts", async () => {
    const { owner, personal, resourceId, sessionId, runs, dir } = await setup("round_failed");
    const selected = await owner.post(`${personal}/selection`, {
      sessionId,
      agentId: "test_agent",
      resources: [{ resourceId }],
    });
    expect(selected.status).toBe(201);

    // Prepared context, then the Task is refused: consumption sits after acceptance, so the
    // person can resend without choosing the same resources again.
    vi.spyOn(app.deps.manager, "startTask").mockRejectedValueOnce(new Error("dispatch failed"));
    const sent = await owner.post(`/api/sessions/${sessionId}/tasks`, {
      input: [{ type: "text", text: "检查登录要求" }],
    });
    expect(sent.status).toBe(500);
    expect(runs).toHaveLength(0);
    expect(await currentSelection({ dir, sessionId, agentId: "test_agent" })).not.toBeNull();
  });

  it("never reuses a selection in another Session or Agent", async () => {
    const { owner, projectId, personal, resourceId, sessionId, dir } = await setup("round_scope");
    const selected = await owner.post(`${personal}/selection`, {
      sessionId,
      agentId: "test_agent",
      resources: [{ resourceId }],
    });
    expect(selected.status).toBe(201);

    const otherSession = uniqueSessionId();
    const otherRuns: AmspRecord[][] = [];
    adoptSession(app.deps, recordingSession(otherSession, otherRuns), {
      projectId,
      agentId: "test_agent",
      workspace: "/tmp/qa-round",
    });
    const sentOther = await owner.post(`/api/sessions/${otherSession}/tasks`, {
      input: [{ type: "text", text: "检查登录要求" }],
    });
    expect(sentOther.status).toBe(202);
    await waitFor(() => otherRuns.length === 1);
    expect(promptText(otherRuns[0]!)).not.toContain("本轮个人 Skill");

    const otherAgentSession = uniqueSessionId();
    const agentRuns: AmspRecord[][] = [];
    adoptSession(app.deps, recordingSession(otherAgentSession, agentRuns), {
      projectId,
      agentId: "requirement_analysis_agent",
      workspace: "/tmp/qa-round",
    });
    const sentAgent = await owner.post(`/api/sessions/${otherAgentSession}/tasks`, {
      input: [{ type: "text", text: "检查登录要求" }],
    });
    expect(sentAgent.status).toBe(202);
    await waitFor(() => agentRuns.length === 1);
    expect(promptText(agentRuns[0]!)).not.toContain("本轮个人 Skill");

    // Neither stray send touched the original Session's round.
    expect(await currentSelection({ dir, sessionId, agentId: "test_agent" })).not.toBeNull();
  });
});
