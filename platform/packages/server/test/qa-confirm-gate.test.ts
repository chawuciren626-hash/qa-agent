import { describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;

/**
 * A3 三层确认卡点 + A4 报告审批（批次 5）。
 *
 * 验收口径：同一变更稳定选集在 regression-impact 测过；这里验证卡点纪律本身——
 * 风险强制不受省略、抽样同种子可复现、问题率超阈值退回全审、硬闸失败阻止批准、审批留审计。
 */
describe("QA confirm gate (A3/A4)", () => {
  const items = [
    { id: "REQ-201", type: "需求", text: "登录失败 5 次锁定 10 分钟", risk: "P0", changed: true },
    { id: "REQ-202", type: "需求", text: "支持短信验证码登录", risk: "money", changed: true },
    { id: "REQ-203", type: "需求", text: "密码强度提示文案", risk: "P2", changed: true },
    { id: "REQ-204", type: "需求", text: "账号命名规则不变", risk: "P1", changed: false },
    { id: "C-409", type: "用例", text: "多端同时在线踢出策略", risk: "unknown", changed: false },
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `C-5${String(i).padStart(2, "0")}`,
      type: "用例",
      text: `回归普通项 ${i + 1}`,
      risk: i % 3 === 0 ? "P1" : "P2",
      changed: false,
    })),
  ];

  async function setup() {
    const app: TestApp = await createTestApp();
    const owner = apiClient(app.app, (await provisionUser(app.app, "cfg_owner")).cookie);
    const project = "cfg_owner-sandbox";
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    return { app, owner, project, base: `/api/projects/${project}/agents/qa/confirm` };
  }

  async function createBatch(owner: ReturnType<typeof apiClient>, base: string, seed = "20261118") {
    const res = await owner.post(`${base}/batches`, { title: "登录模块改版确认", items, seed });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Json;
  }

  it("creates a batch with three-layer defaults: forced and diff items pending, unchanged normals inherited", async () => {
    const { app, owner, project, base } = await setup();
    try {
      const batch = await createBatch(owner, base);
      expect(batch.status).toBe("draft");
      expect(batch.items.filter((i: Json) => i.st === "todo").map((i: Json) => i.id))
        .toEqual(["REQ-201", "REQ-202", "REQ-203", "C-409"]);
      expect(batch.items.filter((i: Json) => i.st === "inherit").length).toBe(15);
      expect(batch.audit.length).toBe(1);
      expect(batch.audit[0].action).toBe("created");

      const view = (await (await owner.get(`${base}/batches/${batch.batchId}`)).json()) as Json;
      // 普通项池 14 ≥ 10：正常抽样而不是升级全审
      expect(view.smallBatch).toBe(false);
      expect(view.sampledIds.length).toBe(Math.ceil(14 * 0.1) >= 1 ? Math.max(1, Math.ceil(14 * 0.1)) : 1);
      expect(view.sampleFingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(view.stats.forceFull).toBe(3); // P0 + money + unknown（P1/P2 不强制）
      expect(view.stats.mustRemaining).toBe(4);
    } finally { await app.cleanup(); }
  });

  it("draws the same sample for the same seed, different list for another seed", async () => {
    const { app, owner, base } = await setup();
    try {
      const a = await createBatch(owner, base, "20261118");
      const b = await createBatch(owner, base, "20261118");
      const c = await createBatch(owner, base, "20261119");
      const va = (await (await owner.get(`${base}/batches/${a.batchId}`)).json()) as Json;
      const vb = (await (await owner.get(`${base}/batches/${b.batchId}`)).json()) as Json;
      const vc = (await (await owner.get(`${base}/batches/${c.batchId}`)).json()) as Json;
      expect(va.sampledIds).toEqual(vb.sampledIds);
      expect(va.sampleFingerprint).toBe(vb.sampleFingerprint);
      expect(vc.sampledIds).not.toEqual(va.sampledIds);
    } finally { await app.cleanup(); }
  });

  it("voids stale sampled passes on resample and audits it", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base, "seed-a");
      const view0 = (await (await owner.get(`${base}/batches/${batch.batchId}`)).json()) as Json;
      // 把抽中项全部标通过
      for (const id of view0.sampledIds) {
        expect((await owner.post(`${base}/batches/${batch.batchId}/items/${id}/review`, { decision: "pass" })).status).toBe(200);
      }
      // 换种子重抽
      const resampled = (await (await owner.post(`${base}/batches/${batch.batchId}/sample`, { seed: "seed-b" })).json()) as Json;
      expect(resampled.batch.seed).toBe("seed-b");
      // 旧名单有、新名单没有的项：旧「抽样通过」作废，回到待审
      const voided = (view0.sampledIds as string[]).filter((id: string) => !resampled.sampledIds.includes(id));
      for (const id of voided) {
        const item = resampled.batch.items.find((i: Json) => i.id === id);
        expect(item.st).toBe("todo");
      }
      const last = resampled.batch.audit.at(-1);
      expect(last.action).toBe("resampled");
      expect(last.note).toContain("seed-b");
    } finally { await app.cleanup(); }
  });

  it("blocks submit until every must-review item is disposed", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base);
      const blocked = await owner.post(`${base}/batches/${batch.batchId}/submit`, {});
      expect(blocked.status).toBe(409);
      const body = (await blocked.json()) as Json;
      expect(body.error.code).toBe("confirm_incomplete");

      // 处置全部必审项后送审成功
      for (const id of ["C-409", "REQ-201", "REQ-202", "REQ-203"]) {
        expect((await owner.post(`${base}/batches/${batch.batchId}/items/${id}/review`, { decision: "pass" })).status).toBe(200);
      }
      const ok = await owner.post(`${base}/batches/${batch.batchId}/submit`, {});
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(((await ok.json()) as Json).batch.status).toBe("reviewing");
    } finally { await app.cleanup(); }
  });

  it("hard gate blocks approval without execution evidence and records approve_blocked", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base);
      for (const id of ["C-409", "REQ-201", "REQ-202", "REQ-203"]) {
        await owner.post(`${base}/batches/${batch.batchId}/items/${id}/review`, { decision: "pass" });
      }
      await owner.post(`${base}/batches/${batch.batchId}/submit`, {});

      const noEvidence = await owner.post(`${base}/batches/${batch.batchId}/approve`, {});
      expect(noEvidence.status).toBe(409);
      const body = (await noEvidence.json()) as Json;
      expect(body.error.code).toBe("hard_gate_failed");
      expect(body.error.message).toContain("evidence_present");
      // 状态停在 reviewing，审计留 blocked
      const after = (await (await owner.get(`${base}/batches/${batch.batchId}`)).json()) as Json;
      expect(after.batch.status).toBe("reviewing");
      expect(after.batch.audit.at(-1).action).toBe("approve_blocked");
      expect(after.batch.audit.at(-1).gateFailures[0].gate).toBe("evidence_present");
    } finally { await app.cleanup(); }
  });

  it("blocks approval on partial replay, unstable and not_run cases; approves with clean evidence", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base);
      for (const id of ["C-409", "REQ-201", "REQ-202", "REQ-203"]) {
        await owner.post(`${base}/batches/${batch.batchId}/items/${id}/review`, { decision: "pass" });
      }
      await owner.post(`${base}/batches/${batch.batchId}/submit`, {});

      const partial = {
        executionEvidence: {
          replay: {
            status: "partial", stop_reason: "replay_budget_exhausted",
            per_case: [{ case_id: "C-1", verdict: "unstable" }, { case_id: "C-3", verdict: "not_run" }],
          },
        },
      };
      const blocked = await owner.post(`${base}/batches/${batch.batchId}/approve`, partial);
      expect(blocked.status).toBe(409);
      const message = ((await blocked.json()) as Json).error.message as string;
      for (const gate of ["replay_complete", "no_unstable_in_pass", "no_unexecuted_pass"]) {
        expect(message).toContain(gate);
      }

      const clean = {
        note: "批次 4 全量重放完成",
        executionEvidence: {
          replay: {
            status: "completed",
            per_case: [{ case_id: "C-1", verdict: "stable_passed" }, { case_id: "C-2", verdict: "stable_failed" }],
          },
        },
      };
      const ok = await owner.post(`${base}/batches/${batch.batchId}/approve`, clean);
      expect(ok.status, await ok.clone().text()).toBe(200);
      const approved = (await ok.json()) as Json;
      expect(approved.batch.status).toBe("approved");
      expect(approved.batch.audit.map((a: Json) => a.action)).toEqual(["created", "submitted", "approve_blocked", "approved"]);
      // seq 连续
      expect(approved.batch.audit.map((a: Json) => a.seq)).toEqual([1, 2, 3, 4]);
    } finally { await app.cleanup(); }
  });

  it("retro batch goes back to full review when sampled problem rate exceeds threshold", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base, "retro-seed");
      const view = (await (await owner.get(`${base}/batches/${batch.batchId}`)).json()) as Json;
      const sampled = view.sampledIds as string[];
      expect(sampled.length).toBeGreaterThanOrEqual(1);
      // 抽中项标一个「问题」→ 问题率 ≥ 1/n > 10%（n ≤ 2 时必然超阈；池 14 抽 2）
      await owner.post(`${base}/batches/${batch.batchId}/items/${sampled[0]}/review`, { decision: "problem" });
      const after = (await (await owner.get(`${base}/batches/${batch.batchId}`)).json()) as Json;
      if (sampled.length <= 10) {
        expect(after.retroToFull).toBe(true);
        expect(after.gates.map((g: Json) => g.gate)).toContain("sample_passed");
        // 退回全审期间抽中项的「通过」按待审算
        expect(after.mustDone).toBe(false);
        expect(after.stats.mustRemaining).toBeGreaterThan(0);
        // 送审被阻止
        expect((await owner.post(`${base}/batches/${batch.batchId}/submit`, {})).status).toBe(409);
      }
    } finally { await app.cleanup(); }
  });

  it("reject returns a reviewing batch to draft with a required reason", async () => {
    const { app, owner, base } = await setup();
    try {
      const batch = await createBatch(owner, base);
      for (const id of ["C-409", "REQ-201", "REQ-202", "REQ-203"]) {
        await owner.post(`${base}/batches/${batch.batchId}/items/${id}/review`, { decision: "pass" });
      }
      await owner.post(`${base}/batches/${batch.batchId}/submit`, {});
      expect((await owner.post(`${base}/batches/${batch.batchId}/reject`, {})).status).toBe(400);
      const rejected = (await (await owner.post(`${base}/batches/${batch.batchId}/reject`, { reason: "报告需补充重放指纹" })).json()) as Json;
      expect(rejected.batch.status).toBe("draft");
      expect(rejected.batch.audit.at(-1).action).toBe("rejected");
      // 退回后可重新送审
      expect((await owner.post(`${base}/batches/${batch.batchId}/submit`, {})).status).toBe(200);
    } finally { await app.cleanup(); }
  });

  it("rejects malformed items and duplicate ids", async () => {
    const { app, owner, base } = await setup();
    try {
      const dup = await owner.post(`${base}/batches`, {
        title: "重复编号", items: [
          { id: "C-1", type: "用例", text: "a", risk: "P1", changed: false },
          { id: "C-1", type: "用例", text: "b", risk: "P2", changed: false },
        ],
      });
      expect(dup.status).toBe(400);
      const badRisk = await owner.post(`${base}/batches`, {
        title: "风险档无效", items: [{ id: "C-1", type: "用例", text: "a", risk: "P9", changed: false }],
      });
      expect(badRisk.status).toBe(400);
      const empty = await owner.post(`${base}/batches`, { title: "空批次", items: [] });
      expect(empty.status).toBe(400);
    } finally { await app.cleanup(); }
  });
});
