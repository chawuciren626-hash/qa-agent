/**
 * The cross-project user-preference API (/api/me/memory-preferences) and the task-start
 * snapshot read route.
 *
 * Ownership is the session's, never the body's: a request cannot name another user. Import
 * validates the document (foreign owner, path-like id, destructive replace without confirm)
 * before writing, and the snapshot route returns metadata only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordUserPreferenceSnapshot,
  resolveUserPreferences,
} from "@prismshadow/penguin-core";
import type {
  MemorySnapshotInfo,
  ProjectCreateResponse,
  UserPreferenceDto,
  UserPreferenceExportDocument,
  UserPreferenceImportResponse,
  UserPreferenceSaveResponse,
  UserPreferencesResponse,
} from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
let apiA: ReturnType<typeof apiClient>;
let apiB: ReturnType<typeof apiClient>;
let apiC: ReturnType<typeof apiClient>;
let userAId: string;

async function errorOf(res: Response): Promise<{ code: string }> {
  return ((await res.json()) as { error: { code: string } }).error;
}

function save(api: ReturnType<typeof apiClient>, body: Record<string, unknown>) {
  return api.post("/api/me/memory-preferences", body);
}

beforeAll(async () => {
  t = await createTestApp();
  const a = await provisionUser(t.app, "prefs_a");
  const b = await provisionUser(t.app, "prefs_b");
  const c = await provisionUser(t.app, "prefs_c");
  userAId = a.user.userId;
  apiA = apiClient(t.app, a.cookie);
  apiB = apiClient(t.app, b.cookie);
  apiC = apiClient(t.app, c.cookie);
});
afterAll(async () => {
  await t.cleanup();
});

describe("user preference API", () => {
  it("saves explicitly for the authenticated user and never for an owner named in the body", async () => {
    const res = await save(apiA, {
      title: "Units",
      content: "Always use metric units.",
      ownerUserId: "someone-else",
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as UserPreferenceSaveResponse;
    expect(saved.entry.ownerUserId).toBe(userAId);
    expect(saved.entry.source).toBe("explicit_user_save");

    const mine = (await (await apiA.get("/api/me/memory-preferences")).json()) as UserPreferencesResponse;
    expect(mine.ownerUserId).toBe(userAId);
    expect(mine.entries.map((entry: UserPreferenceDto) => entry.title)).toEqual(["Units"]);

    const theirs = (await (await apiB.get("/api/me/memory-preferences")).json()) as UserPreferencesResponse;
    expect(theirs.entries).toHaveLength(0);
    expect(theirs.dir).not.toBe(mine.dir);
  });

  it("disables, edits with compare-and-set, and deletes", async () => {
    const created = (await (
      await save(apiA, { title: "Tone", content: "British English." })
    ).json()) as UserPreferenceSaveResponse;
    const id = created.entry.id;

    const disabled = await apiA.patch(`/api/me/memory-preferences/${id}`, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as UserPreferenceDto).disabled).toBe(true);

    const stale = await apiA.put(`/api/me/memory-preferences/${id}`, {
      title: "Tone",
      content: "American English.",
      expectedHash: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("preference_conflict");

    const fresh = (await (await apiA.get(`/api/me/memory-preferences/${id}`)).json()) as UserPreferenceDto;
    const updated = await apiA.put(`/api/me/memory-preferences/${id}`, {
      title: "Tone",
      content: "American English.",
      expectedHash: fresh.contentHash,
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as UserPreferenceSaveResponse).entry.content).toBe(
      "American English.",
    );

    expect((await apiA.delete(`/api/me/memory-preferences/${id}`)).status).toBe(204);
    expect((await apiA.get(`/api/me/memory-preferences/${id}`)).status).toBe(404);
  });

  it("refuses an import that names another owner and previews before writing", async () => {
    await save(apiC, { title: "Units", content: "Metric." });
    const doc = (await (
      await apiC.get("/api/me/memory-preferences/export")
    ).json()) as UserPreferenceExportDocument;
    expect(doc.format).toBe("penguin-user-preferences");
    expect(doc.entries).toHaveLength(1);

    const foreign = await apiB.post("/api/me/memory-preferences/import", {
      payload: doc,
      mode: "overwrite",
    });
    expect(foreign.status).toBe(409);
    expect((await errorOf(foreign)).code).toBe("ownership_mismatch");

    await save(apiC, { title: "Local", content: "Keep me." });
    const preview = await apiC.post("/api/me/memory-preferences/import", {
      payload: doc,
      mode: "replace",
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as UserPreferenceImportResponse;
    expect(plan.dryRun).toBe(true);
    expect(plan.removed).toHaveLength(1);
    expect(
      ((await (await apiC.get("/api/me/memory-preferences")).json()) as UserPreferencesResponse)
        .entries,
    ).toHaveLength(2);

    const noConfirm = await apiC.post("/api/me/memory-preferences/import", {
      payload: doc,
      mode: "replace",
    });
    expect(noConfirm.status).toBe(409);
    expect((await errorOf(noConfirm)).code).toBe("import_confirmation_required");

    const applied = await apiC.post("/api/me/memory-preferences/import", {
      payload: doc,
      mode: "replace",
      confirm: true,
    });
    expect(applied.status).toBe(200);
    expect(
      ((await (await apiC.get("/api/me/memory-preferences")).json()) as UserPreferencesResponse)
        .entries,
    ).toHaveLength(1);
  });

  it("rejects an unauthenticated caller", async () => {
    const anon = apiClient(t.app, "");
    const res = await anon.get("/api/me/memory-preferences");
    expect(res.status).toBe(401);
  });
});

describe("task-start snapshot route", () => {
  it("lists metadata-only snapshots for the Session", async () => {
    const createdRes = await apiA.post("/api/projects", {
      projectId: "prefs_a-snap",
      name: "snap",
    });
    expect(createdRes.status, await createdRes.clone().text()).toBe(201);
    const createdProject = (await createdRes.json()) as ProjectCreateResponse;
    const projectId = createdProject.project.projectId;
    const agentId = "snap_agent";
    expect(
      (await apiA.post(`/api/projects/${projectId}/agents`, { agentId })).status,
    ).toBe(201);

    const preferences = await resolveUserPreferences(t.root, userAId);
    expect(preferences).not.toBeNull();
    const sessionId = "session-2026-11-06-10-00-00-abcdef01";
    await recordUserPreferenceSnapshot({
      root: t.root,
      projectId,
      agentId,
      sessionId,
      ownerUserId: userAId,
      target: { provider: "deepseek", modelId: "deepseek-flash" },
      preferences: preferences!,
    });

    const res = await apiA.get(
      `/api/projects/${projectId}/agents/${agentId}/memory/snapshots?sessionId=${sessionId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; snapshots: MemorySnapshotInfo[] };
    expect(body.sessionId).toBe(sessionId);
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.ownerUserId).toBe(userAId);
    expect(body.snapshots[0]!.injection.entryCount).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("British English.");
  });
});

it('does not expose another project member personal-memory snapshot or session', async () => {
  const projectId = 'prefs_a-snap';
  const agentId = 'snap_agent';
  const memberId = ((await (await apiB.get('/api/me')).json()) as {user:{userId:string}}).user.userId;
  expect((await apiA.post(`/api/projects/${projectId}/members`, {userId:memberId})).status).toBe(201);
  const sid = 'session-2026-11-06-10-00-00-abcdef01';
  const res = await apiB.get(`/api/projects/${projectId}/agents/${agentId}/memory/snapshots?sessionId=${sid}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({snapshots:[]});
  t.deps.sessionsRepo.insert({sessionId:sid, projectId, agentId, ownerUserId:userAId, provider:'test', modelId:'test', workspace:t.root, approvalMode:'read-only', title:null, lastActiveAt:new Date().toISOString(), createdAt:new Date().toISOString()});
  expect((await apiB.get(`/api/sessions/${sid}`)).status).toBe(404);
});
