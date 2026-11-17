/**
 * 环境探索资产与假设闭环。
 *
 * 重点验三件事：层覆盖不留残影；假设不进地图只有判定后才知道真假；判定 append 不覆盖
 * 旧结论（被推翻的旧结论决定断言放哪，丢了就再也拿不回来）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";

let test: TestApp | undefined;
afterEach(async () => { await test?.cleanup(); test = undefined; });

async function projectWithEnvironment() {
  test = await createTestApp();
  const admin = apiClient(test.app, (await loginAdmin(test.app)).cookie);
  const created = await admin.post("/api/projects/managed", {
    projectId: "kb_project", name: "探索资产项目",
    environment: { env: "test", baseUrl: "http://gateway.example.com" },
  });
  const { project } = await created.json() as { project: { projectId: string } };
  const base = `/api/projects/${project.projectId}/environments/test`;
  return { admin, projectId: project.projectId, base };
}

describe("environment knowledge", () => {
  it("starts empty with lastRound 0 instead of pretending a round happened", async () => {
    const { admin, base } = await projectWithEnvironment();
    const res = await admin.get(`${base}/knowledge`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      knowledge: { counts: Record<string, number>; lastRound: number };
      hypotheses: { total: number };
    };
    expect(body.knowledge.counts).toEqual({ module: 0, flow: 0, wall: 0, interface: 0 });
    expect(body.knowledge.lastRound).toBe(0);
    expect(body.hypotheses.total).toBe(0);
  });

  it("replaces one layer without touching the others, and drops entries that no longer exist", async () => {
    const { admin, base } = await projectWithEnvironment();
    await admin.put(`${base}/knowledge/module`, {
      round: 1,
      entries: [{ key: "退款", summary: "3 页" }, { key: "订单", summary: "4 页" }],
    });
    await admin.put(`${base}/knowledge/flow`, { round: 1, entries: [{ key: "L1", summary: "下单→支付" }] });

    const replaced = await admin.put(`${base}/knowledge/module`, {
      round: 2,
      entries: [{ key: "退款", summary: "5 页（含审核）" }],
    });
    expect(replaced.status).toBe(200);
    const knowledge = (await replaced.json() as { knowledge: {
      layers: { module: { key: string; summary: string; round: number }[]; flow: { key: string }[] };
      counts: Record<string, number>;
      lastRound: number;
    } }).knowledge;

    // 订单不再出现 → 这一轮它不成立了，不能留在地图里让下游跑到已下线的页面。
    expect(knowledge.layers.module.map(item => item.key)).toEqual(["退款"]);
    expect(knowledge.layers.module[0]).toMatchObject({ summary: "5 页（含审核）", round: 2 });
    expect(knowledge.layers.flow.map(item => item.key)).toEqual(["L1"]);
    expect(knowledge.counts).toMatchObject({ module: 1, flow: 1 });
    expect(knowledge.lastRound).toBe(2);
  });

  it("rejects duplicate keys inside one layer and unknown layer names", async () => {
    const { admin, base } = await projectWithEnvironment();
    const dup = await admin.put(`${base}/knowledge/module`, {
      round: 1, entries: [{ key: "退款" }, { key: "退款" }],
    });
    expect(dup.status).toBe(400);
    const badLayer = await admin.put(`${base}/knowledge/pages`, { round: 1, entries: [] });
    expect(badLayer.status).toBe(400);
    // 校验失败不能留下半层数据。
    const after = await admin.get(`${base}/knowledge`);
    expect((await after.json() as { knowledge: { lastRound: number } }).knowledge.lastRound).toBe(0);
  });

  it("creates a hypothesis closed by default and keeps it out of the map", async () => {
    const { admin, base } = await projectWithEnvironment();
    const res = await admin.post(`${base}/hypotheses`, {
      moduleKey: "退款",
      statement: "退款申请前必须存在一笔已支付订单",
      whyUnknown: "business",
      expectation: "进入 /refund/apply 应先出现选择订单步骤",
    });
    expect(res.status).toBe(201);
    const { hypothesis } = await res.json() as { hypothesis: {
      hypothesisId: string; status: string; allowSeed: boolean; verdicts: unknown[];
    } };
    // 造数会真写被测系统，默认必须是关的。
    expect(hypothesis).toMatchObject({ status: "open", allowSeed: false });
    expect(hypothesis.verdicts).toEqual([]);

    const knowledge = await admin.get(`${base}/knowledge`);
    const body = await knowledge.json() as { knowledge: { counts: Record<string, number> }; hypotheses: { open: number } };
    expect(body.knowledge.counts.module).toBe(0);
    expect(body.hypotheses.open).toBe(1);
  });

  it("appends verdicts instead of overwriting: a refuted conclusion stays readable after re-verification", async () => {
    const { admin, base } = await projectWithEnvironment();
    const created = await admin.post(`${base}/hypotheses`, {
      statement: "退款金额不可超过实付金额", whyUnknown: "business",
    });
    const { hypothesis } = await created.json() as { hypothesis: { hypothesisId: string } };
    const verdictPath = `${base}/hypotheses/${hypothesis.hypothesisId}/verdicts`;

    await admin.post(verdictPath, { round: 2, verdict: "refuted", evidence: "输入 999999 未拦，提交才提示" });
    const second = await admin.post(verdictPath, { round: 3, verdict: "verified", evidence: "提交后提示超出可退金额" });
    expect(second.status).toBe(201);
    const final = (await second.json() as { hypothesis: {
      status: string; verdicts: { round: number; verdict: string; evidence: string | null }[];
    } }).hypothesis;

    expect(final.status).toBe("verified");
    expect(final.verdicts.map(item => [item.round, item.verdict])).toEqual([[2, "refuted"], [3, "verified"]]);
    // 旧结论的"实际观察到什么"必须留着——它决定了断言该放在提交后而不是输入框。
    const [firstVerdict] = final.verdicts;
    expect(firstVerdict?.round).toBe(2);
    expect(firstVerdict?.evidence).toContain("999999");
  });

  it("summarises hypotheses by status so the header can say 2 待验", async () => {
    const { admin, base } = await projectWithEnvironment();
    const first = await admin.post(`${base}/hypotheses`, { statement: "A 假设" });
    const { hypothesis } = await first.json() as { hypothesis: { hypothesisId: string } };
    await admin.post(`${base}/hypotheses`, { statement: "B 假设" });
    await admin.post(`${base}/hypotheses/${hypothesis.hypothesisId}/verdicts`, { round: 1, verdict: "unreachable" });

    const res = await admin.get(`${base}/hypotheses`);
    const body = await res.json() as { summary: { open: number; unreachable: number; total: number } };
    expect(body.summary).toEqual({ open: 1, verified: 0, refuted: 0, unreachable: 1, total: 2 });

    const filtered = await admin.get(`${base}/hypotheses?status=open`);
    expect((await filtered.json() as { hypotheses: unknown[] }).hypotheses).toHaveLength(1);
  });

  it("404s when the environment does not exist, and denies a non-member", async () => {
    const { admin, projectId } = await projectWithEnvironment();
    const missing = await admin.get(`/api/projects/${projectId}/environments/prod/knowledge`);
    expect(missing.status).toBe(404);
    const outsider = apiClient(test!.app, (await provisionUser(test!.app, "kb_outsider")).cookie);
    const denied = await outsider.get(`/api/projects/${projectId}/environments/test/knowledge`);
    expect(denied.status).toBe(404);
  });
});
