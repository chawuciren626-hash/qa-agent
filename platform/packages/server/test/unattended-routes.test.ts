/**
 * Unattended routes over the real platform tree (batch 4): binding lifecycle (owner-only
 * writes, member reads, outsider 404), bind-time validation (no expired grant, ceiling
 * shape, schedule must exist), the run ledger listing, and cancellation through the API.
 * The app boots the real components — the routes test the wiring Codex will integrate,
 * with the local default authorizer in place.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiClient,
  createTestApp,
  provisionUser,
} from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { ProjectCreateResponse, ScheduleItem } from "../src/api/types.js";
import type {
  UnattendedBindingRow,
  UnattendedCoordinator,
  UnattendedRunRow,
} from "../src/runtime/unattended/types.js";

const FUTURE = "2099-01-01T09:00:00Z";

interface BindingsResponse {
  bindings: UnattendedBindingRow[];
}
interface RunsResponse {
  runs: UnattendedRunRow[];
}

describe("unattended api", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let projectId: string;
  let base: string;
  let taskId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_a");
    const b = await provisionUser(t.app, "member_b");
    const c = await provisionUser(t.app, "outsider_c");
    owner = apiClient(t.app, a.cookie);
    member = apiClient(t.app, b.cookie);
    outsider = apiClient(t.app, c.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner_a-unat", name: "unattended project" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    const schedulesBase = `/api/projects/${projectId}/agents/default_agent/schedules`;
    taskId = "nightly-check";
    const schedule = (await (
      await owner.post(schedulesBase, {
        name: taskId,
        prompt: "check the nightly build",
        enabled: true,
        startAt: FUTURE,
        period: "30m",
      })
    ).json()) as ScheduleItem;
    expect(schedule.name).toBe(taskId);
    base = `/api/projects/${projectId}/unattended`;
    expect(
      (await owner.post(`/api/projects/${projectId}/members`, { userId: "member_b" })).status,
    ).toBe(201);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  function coordinator(): UnattendedCoordinator {
    return t.deps.tree.api<UnattendedCoordinator>("SessionRuntimeModule", "UnattendedCoordinator");
  }

  it("PUT bind is owner-only; the device defaults to this machine's identity; GET lists it; DELETE removes it", async () => {
    const body = {
      permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
      publishSnapshot: { agentReleaseId: "rel-1" },
    };
    expect((await member.put(`${base}/bind/default_agent/${taskId}`, body)).status).toBe(403);
    expect((await outsider.put(`${base}/bind/default_agent/${taskId}`, body)).status).toBe(404);

    const created = await owner.put(`${base}/bind/default_agent/${taskId}`, body);
    expect(created.status).toBe(201);
    const binding = (await created.json()) as UnattendedBindingRow;
    expect(binding).toMatchObject({
      projectId,
      agentId: "default_agent",
      name: taskId,
      ownerUserId: "owner_a",
      grantId: expect.stringMatching(/^grant-/),
      grantExpiresAt: null,
      permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
      publishSnapshot: { agentReleaseId: "rel-1" },
    });
    // The device default is the data root's stable identity file.
    const identity = JSON.parse(
      await fs.readFile(path.join(t.root, "device-identity.json"), "utf8"),
    ) as { deviceId: string };
    expect(binding.deviceId).toBe(identity.deviceId);

    // Any member reads; an outsider gets 404 (the Project gate).
    const list = (await (await member.get(`${base}/bind/default_agent`)).json()) as BindingsResponse;
    expect(list.bindings.map((b) => b.name)).toEqual([taskId]);
    expect((await outsider.get(`${base}/bind/default_agent`)).status).toBe(404);

    expect((await member.delete(`${base}/bind/default_agent/${taskId}`)).status).toBe(403);
    expect((await owner.delete(`${base}/bind/default_agent/${taskId}`)).status).toBe(204);
    expect((await owner.delete(`${base}/bind/default_agent/${taskId}`)).status).toBe(404);
  });

  it("bind refuses: a missing schedule (404), an already-expired grant (400), a bad ceiling (400)", async () => {
    expect(
      (
        await owner.put(`${base}/bind/default_agent/no-such-task`, {
          permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner.put(`${base}/bind/default_agent/${taskId}`, {
          permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
          grantExpiresAt: "2020-01-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.put(`${base}/bind/default_agent/${taskId}`, {
          permissionCeiling: { allowedOperations: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.put(`${base}/bind/default_agent/${taskId}`, {
          permissionCeiling: { allowedOperations: ["schedule.dispatch"], unattendedApproval: "sudo" },
        })
      ).status,
    ).toBe(400);
    // Nothing landed.
    const list = (await (await owner.get(`${base}/bind/default_agent`)).json()) as BindingsResponse;
    expect(list.bindings).toEqual([]);
  });

  it("runs: a bound fire's ledger row is listed; cancellation through the API settles it; status filter works", async () => {
    (await owner.put(`${base}/bind/default_agent/${taskId}`, {
      permissionCeiling: { allowedOperations: ["schedule.dispatch"] },
    })).status;

    // Open a run the way the scheduler would at its next due slot.
    const { runId } = await coordinator().beginFire({
      projectId,
      agentId: "default_agent",
      name: taskId,
      slotMs: Date.parse(FUTURE),
    });
    const list = (await (await member.get(`${base}/runs`)).json()) as RunsResponse;
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      runId,
      name: taskId,
      status: "queued",
      ownerUserId: "owner_a",
    });

    // Member cancel is refused; owner cancel settles the run.
    expect(
      (await member.post(`${base}/runs/${runId}/cancel`, {})).status,
    ).toBe(403);
    const cancelled = await owner.post(`${base}/runs/${runId}/cancel`, { by: "owner_a" });
    expect(cancelled.status).toBe(200);
    const cancelBody = (await cancelled.json()) as {
      ok: boolean;
      status: string;
      run: UnattendedRunRow;
    };
    expect(cancelBody).toMatchObject({ ok: true, status: "cancelled" });
    expect(cancelBody.run.settledAt).not.toBeNull();

    // The listing sees the terminal status; the status filter narrows it.
    const all = (await (await member.get(`${base}/runs`)).json()) as RunsResponse;
    expect(all.runs.map((r) => r.status)).toEqual(["cancelled"]);
    const open = (await (await member.get(`${base}/runs?status=queued`)).json()) as RunsResponse;
    expect(open.runs).toEqual([]);
    // A bogus run id is 404; the Project gate keeps the outsider out entirely.
    expect((await owner.post(`${base}/runs/does-not-exist/cancel`, {})).status).toBe(404);
    const outsiderRuns = await outsider.get(`${base}/runs`);
    expect(outsiderRuns.status).toBe(404);
  });

  it("unbinding returns the task to legacy scheduling: the binding is dropped and its run refuses at the gate", async () => {
    (await owner.put(`${base}/bind/default_agent/${taskId}`, {
      permissionCeiling: { allowedOperations: ["something.else"] }, // schedule.dispatch is outside it
    })).status;
    // With the binding on, a fire cannot proceed (schedule.dispatch outside the ceiling).
    const { runId } = await coordinator().beginFire({
      projectId,
      agentId: "default_agent",
      name: taskId,
      slotMs: Date.parse(FUTURE),
    });
    expect((await coordinator().authorizeFire(runId)).proceed).toBe(false);
    // Unbind: the binding is gone (re-adding the file means re-binding, never stale-grant reuse).
    expect((await owner.delete(`${base}/bind/default_agent/${taskId}`)).status).toBe(204);
    // The already-open run still refuses (its binding reference is gone) — recorded, honest.
    expect((await coordinator().authorizeFire(runId)).proceed).toBe(false);
    expect(bindingsLeft()).toBe(0);
  });

  function bindingsLeft(): number {
    const row = t.deps.db
      .prepare("SELECT COUNT(*) AS n FROM unattended_bindings WHERE project_id = ?")
      .get(projectId) as { n: number };
    return row.n;
  }
});
