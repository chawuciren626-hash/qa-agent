/**
 * G4 / P6：「同一个测试点」在跨批次时还是同一条。
 *
 * 三件以前做不到、现在必须做到的事：
 *   1. 两个批次的同一件事认成同一个测试点（uid 稳定），且**可调项**（风险等级）不影响身份；
 *   2. 缺陷能挂到测试点上，跨批次复现时归属求并集，不会"换个批次就断了"；
 *   3. 覆盖率能按 uid 跨批次去重看出"这个点上次什么结论"，而不是每个批次各算各的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("G4 测试点稳定身份", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let workspace = "";
  const project = "uid_owner-sandbox";
  const base = `/api/projects/${project}/agents/qa`;
  const session = "session-uid";

  const json = async (res: Response) => (await res.json()) as Json;
  const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code;

  const writeRunManifest = async (runId: string) => {
    const file = path.join(workspace, session, "output", "runs", runId, "manifest.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ manifest_version: 3, run_id: runId, status: "completed" }));
  };

  const createDocument = async () => {
    const res = await owner.post(`${base}/documents`, {
      title: "登录需求", format: "markdown", content: "# 登录\n连续 5 次验证码错误后锁定账号。"
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Json;
  };
  const createRule = async (documentId: string) => {
    const res = await owner.post(`${base}/knowledge/rules`, {
      title: "验证码锁定",
      statement: "连续 5 次验证码错误后锁定账号 15 分钟。",
      sourceRefs: [{ type: "document", documentId, revision: 1 }]
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Json;
  };

  /**
   * 同一份设计，只把「可调项」当参数：风险等级（不该改身份）与描述（该改身份）。
   * `casePoint` 用来模拟下一轮把某个用例挪到另一个测试点下（真实会发生：设计被重排）。
   */
  const buildDesign = (documentId: string, ruleId: string, options: { risk2?: string; description3?: string; casePoint?: { CASE_001?: string; CASE_002?: string } } = {}) => {
    const documentRef = { type: "document", documentId, revision: 1 };
    const ruleRef = { type: "rule", ruleId, version: 1 };
    return {
      source: { type: "run", path: "design/test_points.json" },
      points: [
        {
          id: "TP-001", module: "登录", feature: "验证码锁定", description: "连续 5 次错误后锁定 15 分钟",
          risk: "高", coverageType: ["异常"], evidenceRefs: [documentRef, ruleRef],
          source: "analysis/requirement_analysis.md", sourceLocator: "R-001", executionLayer: "ui"
        },
        {
          id: "TP-002", module: "登录", feature: "登录提示", description: "登录失败提示剩余次数",
          risk: options.risk2 ?? "中", coverageType: ["正常"], evidenceRefs: [documentRef]
        },
        {
          id: "TP-003", module: "登录", feature: "审计", description: options.description3 ?? "锁定事件写入审计日志",
          risk: "低", coverageType: ["异常"], evidenceRefs: [ruleRef]
        }
      ],
      cases: [
        {
          caseId: "CASE-001", title: "锁定账号", priority: "P0", type: "异常",
          preconditions: ["账号已注册"], testData: { attempts: 5 }, steps: ["连续输入错误验证码 5 次"],
          expected: "账号锁定 15 分钟", automationFeasible: true,
          relatedTestPoint: options.casePoint?.CASE_001 ?? "TP-001",
          evidenceRefs: [ruleRef], designContract: { basis: [], assumptions: [], data_checks: [] }
        },
        {
          caseId: "CASE-002", title: "锁定后登录", priority: "P1", type: "异常",
          preconditions: ["账号已锁定"], testData: {}, steps: ["使用正确验证码登录"],
          expected: "提示账号已锁定", automationFeasible: true,
          relatedTestPoint: options.casePoint?.CASE_002 ?? "TP-001",
          evidenceRefs: [documentRef], designContract: { basis: [], assumptions: [], data_checks: [] }
        },
        {
          caseId: "CASE-003", title: "失败次数提示", priority: "P2", type: "正常",
          preconditions: [], testData: {}, steps: ["输入一次错误验证码"],
          expected: "提示剩余 4 次", automationFeasible: true, relatedTestPoint: "TP-002",
          evidenceRefs: [documentRef], designContract: { basis: [], assumptions: [], data_checks: [] }
        }
      ]
    };
  };

  const design = async (runId: string, body: Json) => {
    const res = await owner.post(`${base}/tasks/${session}/runs/${runId}/design`, body);
    expect(res.status, await res.clone().text()).toBe(201);
    // 写接口只回 {created, batch}；要看算出来的身份得读一次设计
    const read = await owner.get(`${base}/tasks/${session}/runs/${runId}/design`);
    expect(read.status, await read.clone().text()).toBe(200);
    return (await read.json()) as Json;
  };

  const coverageOf = async (runId: string) => {
    const res = await owner.get(`${base}/tasks/${session}/runs/${runId}/coverage`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Json;
  };

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, "uid_owner")).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    workspace = path.join(app.root, "qa-uid-workspace");
    await fs.mkdir(workspace, { recursive: true });
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(
      ((sessionId: string) => sessionId === session
        ? { projectId: project, agentId: "test_agent", sessionId, workspace: path.join(workspace, session) }
        : undefined) as never
    );
    for (const runId of ["run-a1", "run-a2", "run-dup", "run-b1", "run-b2"]) await writeRunManifest(runId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("同一件事在两批里算出同一个 uid；改风险等级不换身份，改描述就换", async () => {
    const document = await createDocument();
    const rule = await createRule(document.document.documentId);

    const first = await design("run-a1", { expectedRevision: 0, ...buildDesign(document.document.documentId, rule.ruleId) });
    const firstUids = Object.fromEntries((first.points as Json[]).map((point) => [point.pointKey, point.pointUid]));
    expect(firstUids["TP-001"]).toMatch(/^[0-9a-f]{32}$/);

    // 第二轮：TP-002 的风险等级从「中」调到「低」，TP-003 的描述改了两个字
    const second = await design("run-a2", {
      expectedRevision: 0,
      ...buildDesign(document.document.documentId, rule.ruleId, { risk2: "低", description3: "锁定事件写入审计日志（含操作者）" })
    });
    const secondUids = Object.fromEntries((second.points as Json[]).map((point) => [point.pointKey, point.pointUid]));
    expect(secondUids["TP-001"]).toBe(firstUids["TP-001"]);
    // 风险等级是设计过程的可调项：调它不该让历史执行结果与缺陷归属全部断开
    expect(secondUids["TP-002"]).toBe(firstUids["TP-002"]);
    // 描述变了就是另一个测试点：宁可多一条，也不误合并
    expect(secondUids["TP-003"]).not.toBe(firstUids["TP-003"]);

    // 同一批次里两条描述完全相同的测试点：拒绝，让人合并，而不是悄悄建两条
    const duplicate = await owner.post(`${base}/tasks/${session}/runs/run-dup/design`, {
      expectedRevision: 0,
      source: { type: "run", path: "design/test_points.json" },
      points: [
        { id: "TP-001", module: "登录", feature: "审计", description: "锁定事件写入审计日志", risk: "低", coverageType: ["异常"], evidenceRefs: [{ type: "rule", ruleId: rule.ruleId, version: 1 }] },
        { id: "TP-002", module: "登录", feature: "审计", description: "锁定事件写入审计日志  ", risk: "中", coverageType: ["异常"], evidenceRefs: [{ type: "rule", ruleId: rule.ruleId, version: 1 }] }
      ],
      cases: []
    });
    expect(duplicate.status).toBe(400);
    expect(await errorCode(duplicate)).toBe("duplicate_point");
  });

  it("缺陷挂到测试点上并跨批次求并集；覆盖率按 uid 跨批次去重", async () => {
    const document = await createDocument();
    const rule = await createRule(document.document.documentId);
    const first = await design("run-b1", { expectedRevision: 0, ...buildDesign(document.document.documentId, rule.ruleId) });
    const firstUids = Object.fromEntries((first.points as Json[]).map((point) => [point.pointKey, point.pointUid]));

    const failure = { type: "execution", sessionId: session, runId: "run-b1", evidencePath: "execution/lock-failed.png" };
    const ingested = await owner.post(`${base}/tasks/${session}/runs/run-b1/results`, {
      expectedRevision: 1, invocationId: "inv-b1",
      results: [
        { caseId: "CASE-001", status: "failed", reason: "第 5 次后仍可登录", evidenceRefs: [failure] },
        { caseId: "CASE-002", status: "passed" }
      ]
    });
    expect(ingested.status, await ingested.clone().text()).toBe(201);

    // 第一轮覆盖率：本次之前没有历史，所以 history 全零；项目级 3 个点，只有 TP-001 真跑过
    const firstCoverage = await coverageOf("run-b1");
    expect(firstCoverage.identity).toEqual({
      distinctPoints: 3, executedPoints: 1, neverExecutedPoints: 2, untrackedPoints: 0, reusedPoints: 0, newPoints: 3
    });
    const firstPoint = firstCoverage.points.find((point: Json) => point.pointKey === "TP-001");
    expect(firstPoint).toMatchObject({ pointUid: firstUids["TP-001"], status: "failed" });
    // 「本次运行」不算历史：否则 lastRunId 永远等于当前 run，等于没回答"上一轮跑过没有"
    expect(firstPoint.history).toEqual({ runs: 0, executedRuns: 0, lastRunId: null, lastStatus: null, defects: 0 });

    const defect = await owner.post(`${base}/defects`, {
      sessionId: session, runId: "run-b1",
      title: "验证码锁定未生效", category: "product_defect", confidence: "medium",
      severity: "Major", priority: "P1", expectedResult: "锁定 15 分钟", actualResult: "仍可登录",
      relatedCases: ["CASE-001"], evidenceRefs: [failure]
    });
    expect(defect.status, await defect.clone().text()).toBe(201);
    expect((await defect.json() as Json).defect.relatedPoints).toEqual([firstUids["TP-001"]]);

    // 第二轮：设计被重排——CASE-001 挪到 TP-002 下；同一个失败再次出现
    const second = await design("run-b2", {
      expectedRevision: 0,
      ...buildDesign(document.document.documentId, rule.ruleId, { casePoint: { CASE_001: "TP-002" } })
    });
    const secondUids = Object.fromEntries((second.points as Json[]).map((point) => [point.pointKey, point.pointUid]));
    const failure2 = { type: "execution", sessionId: session, runId: "run-b2", evidencePath: "execution/lock-failed.png" };
    expect((await owner.post(`${base}/tasks/${session}/runs/run-b2/results`, {
      expectedRevision: 1, invocationId: "inv-b2",
      results: [{ caseId: "CASE-001", status: "failed", reason: "第 5 次后仍可登录", evidenceRefs: [failure2] }]
    })).status).toBe(201);

    const again = await owner.post(`${base}/defects`, {
      sessionId: session, runId: "run-b2",
      title: "验证码锁定未生效", category: "product_defect", confidence: "medium",
      severity: "Major", priority: "P1", expectedResult: "锁定 15 分钟", actualResult: "仍可登录",
      relatedCases: ["CASE-001"], evidenceRefs: [failure2]
    });
    // 归并到既有缺陷：不新建（200），只补一条 occurrence
    expect(again.status, await again.clone().text()).toBe(200);
    const merged = (await again.json()) as Json;
    expect(merged).toMatchObject({ created: false, occurrenceAdded: true });
    // 并集而不是覆盖：只记第一次会把"这条缺陷影响哪几个测试点"永久截断。
    // 比集合不比顺序——归属是集合，顺序没有语义。
    expect([...merged.defect.relatedPoints].sort()).toEqual([firstUids["TP-001"], secondUids["TP-002"]].sort());

    // 第二轮覆盖率：同一批测试点被认成旧的（reused=3），TP-001 记着上一轮是 failed
    const secondCoverage = await coverageOf("run-b2");
    expect(secondCoverage.identity).toEqual({
      distinctPoints: 3, executedPoints: 2, neverExecutedPoints: 1, untrackedPoints: 0, reusedPoints: 3, newPoints: 0
    });
    expect(secondCoverage.points.find((point: Json) => point.pointKey === "TP-001")).toMatchObject({
      pointUid: firstUids["TP-001"],
      status: "untested",
      history: { runs: 1, executedRuns: 1, lastRunId: "run-b1", lastStatus: "failed", defects: 1 }
    });
    // TP-003 两轮都设计过，但一次都没跑：这就是"覆盖率里的假绿"来源，必须能看见
    expect(secondCoverage.points.find((point: Json) => point.pointKey === "TP-003").history).toMatchObject({
      runs: 1, executedRuns: 0, lastRunId: "run-b1", lastStatus: null
    });
  });
});
