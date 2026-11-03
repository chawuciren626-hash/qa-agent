import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { apiClient, createTestApp, loginAdmin, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;
const hashOf = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("Q3 quality traceability", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let admin: ReturnType<typeof apiClient>;
  let workspace = "";
  let otherWorkspace = "";
  const project = "trace_owner-sandbox";
  const otherProject = "trace_owner-other";
  const base = `/api/projects/${project}/agents/qa`;
  const otherBase = `/api/projects/${otherProject}/agents/qa`;
  const sessionDefinitions: Record<string, { projectId: string; agentId: string }> = {
    "session-task": { projectId: project, agentId: "test_agent" },
    "session-next": { projectId: project, agentId: "test_agent" },
    "session-other": { projectId: otherProject, agentId: "test_agent" }
  };

  const json = async (res: Response) => (await res.json()) as Json;
  const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code;

  const createDocument = async (client = owner, target = base, body: Json = {}) => {
    const res = await client.post(`${target}/documents`, {
      title: "登录需求",
      format: "markdown",
      content: "# 登录\n连续 5 次验证码错误后锁定账号。",
      ...body
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Json;
  };
  const createRule = async (documentId: string, target = base) => {
    const res = await owner.post(`${target}/knowledge/rules`, {
      title: "验证码锁定",
      statement: "连续 5 次验证码错误后锁定账号 15 分钟。",
      sourceRefs: [{ type: "document", documentId, revision: 1 }]
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Json;
  };

  const designPayload = (documentId: string, ruleId: string) => {
    const documentRef = { type: "document", documentId, revision: 1 };
    const ruleRef = { type: "rule", ruleId, version: 1 };
    return {
      expectedRevision: 0,
      source: { type: "run", path: "design/test_points-task.json" },
      points: [
        {
          id: "TP-001", module: "登录", feature: "验证码锁定", description: "连续 5 次错误后锁定 15 分钟",
          risk: "高", coverageType: ["异常"], evidenceRefs: [documentRef, ruleRef],
          source: "analysis/requirement_analysis.md", sourceLocator: "R-001", executionLayer: "ui"
        },
        {
          id: "TP-002", module: "登录", feature: "登录提示", description: "登录失败提示剩余次数",
          risk: "中", coverageType: ["正常"], evidenceRefs: [documentRef]
        },
        {
          id: "TP-003", module: "登录", feature: "审计", description: "锁定事件写入审计日志",
          risk: "低", coverageType: ["异常"], evidenceRefs: [ruleRef]
        }
      ],
      cases: [
        {
          caseId: "CASE-001", title: "锁定账号", priority: "P0", type: "异常",
          preconditions: ["账号已注册"], testData: { attempts: 5 }, steps: ["连续输入错误验证码 5 次"],
          expected: "账号锁定 15 分钟", automationFeasible: true, relatedTestPoint: "TP-001",
          evidenceRefs: [ruleRef], designContract: { basis: [], assumptions: [], data_checks: [] }
        },
        {
          caseId: "CASE-002", title: "锁定后登录", priority: "P1", type: "异常",
          preconditions: ["账号已锁定"], testData: {}, steps: ["使用正确验证码登录"],
          expected: "提示账号已锁定", automationFeasible: true, relatedTestPoint: "TP-001",
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

  const importDesign = async (client = owner, target = base, sessionId = "session-task", runId = "run-main", body?: Json) => {
    const document = await createDocument(owner, target);
    const rule = await createRule(document.document.documentId, target);
    const res = await client.post(`${target}/tasks/${sessionId}/runs/${runId}/design`, body ?? designPayload(document.document.documentId, rule.ruleId));
    expect(res.status, await res.clone().text()).toBe(201);
    return { document, rule, body: (await res.json()) as Json };
  };

  const executionRef = (runId: string, evidencePath = "execution/failure.png") =>
    ({ type: "execution", sessionId: "session-task", runId, evidencePath });

  const writeRunFile = async (root: string, sessionId: string, runId: string, relative: string, content: string) => {
    const file = path.join(root, sessionId, "output", "runs", runId, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return hashOf(content);
  };
  const writeRunManifest = async (root: string, sessionId: string, runId: string, declaredRunId = runId) => {
    const file = path.join(root, sessionId, "output", "runs", runId, "manifest.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ manifest_version: 3, run_id: declaredRunId, status: "completed" }));
  };

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, "trace_owner")).cookie);
    member = apiClient(app.app, (await provisionUser(app.app, "trace_member")).cookie);
    outsider = apiClient(app.app, (await provisionUser(app.app, "trace_outsider")).cookie);
    admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    expect((await owner.post("/api/projects", { projectId: otherProject })).status).toBe(201);
    expect((await owner.post(`/api/projects/${project}/members`, { userId: "trace_member" })).status).toBe(201);
    workspace = path.join(app.root, "qa-trace-workspace");
    otherWorkspace = path.join(app.root, "qa-trace-other-workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(otherWorkspace, { recursive: true });
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(
      ((sessionId: string) => {
        const found = sessionDefinitions[sessionId];
        if (!found) return undefined;
        return {
          ...found,
          sessionId,
          workspace: found.projectId === project ? path.join(workspace, sessionId) : path.join(otherWorkspace, sessionId)
        };
      }) as never
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("keeps design evidence traceable and isolated, and exposes only immutable batches", async () => {
    const document = await createDocument();
    const rule = await createRule(document.document.documentId);
    const payload = designPayload(document.document.documentId, rule.ruleId);
    const created = await owner.post(`${base}/tasks/session-task/runs/run-main/design`, payload);
    expect(created.status, await created.clone().text()).toBe(201);
    const first = (await created.json()) as Json;
    expect(first.created).toBe(true);
    expect(first.batch).toMatchObject({
      projectId: project, sessionId: "session-task", runId: "run-main", revision: 1,
      status: "open", testPointCount: 3, testCaseCount: 3, createdBy: "trace_owner"
    });
    expect(first.batch.contentHash).toMatch(/^sha256:/);

    // Members read the design and evidence references; outsiders and other projects do not.
    const read = await member.get(`${base}/tasks/session-task/runs/run-main/design`);
    expect(read.status).toBe(200);
    const design = (await read.json()) as Json;
    expect(design.points[0]).toMatchObject({
      pointKey: "TP-001", risk: "high", riskLabel: "高"
    });
    expect(design.points[0].evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "document", documentId: document.document.documentId, revision: 1 }),
      expect.objectContaining({ type: "rule", ruleId: rule.ruleId, version: 1 })
    ]));
    expect(design.cases[0]).toMatchObject({ caseKey: "CASE-001", relatedPoint: "TP-001" });
    expect((await outsider.get(`${base}/tasks/session-task/runs/run-main/design`)).status).toBe(404);
    expect((await owner.get(`${otherBase}/tasks/session-task/runs/run-main/design`)).status).toBe(404);

    // A design cannot smuggle evidence from another project or reference an unknown point.
    const foreign = await createDocument(owner, otherBase, { title: "其它项目", content: "别的项目资料" });
    const foreignRef = { type: "document", documentId: foreign.document.documentId, revision: 1 };
    const badEvidence = await owner.post(`${base}/tasks/session-task/runs/run-foreign/design`, {
      ...payload,
      points: [{ ...payload.points[0], evidenceRefs: [foreignRef] }],
      cases: []
    });
    expect(badEvidence.status).toBe(400);
    expect(await errorCode(badEvidence)).toBe("invalid_design");
    const badPoint = await owner.post(`${base}/tasks/session-task/runs/run-badpoint/design`, {
      ...payload,
      cases: [{ ...payload.cases[0], relatedTestPoint: "TP-999" }]
    });
    expect(badPoint.status).toBe(400);
    expect(await errorCode(badPoint)).toBe("invalid_design");

    // Repeating identical content is idempotent, while changed content appends a revision.
    const repeated = await owner.post(`${base}/tasks/session-task/runs/run-main/design`, payload);
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as Json).created).toBe(false);
    const changed = await owner.post(`${base}/tasks/session-task/runs/run-main/design`, {
      ...payload,
      expectedRevision: 1,
      points: payload.points.map((point) => point.id === "TP-003" ? { ...point, description: "锁定事件写入审计日志（含操作者）" } : point)
    });
    expect(changed.status, await changed.clone().text()).toBe(201);
    expect((await changed.json() as Json).batch.revision).toBe(2);
    const history = (await json(await member.get(`${base}/tasks/session-task/runs/run-main/design/history`)) as Json).batches;
    expect(history.map((item: Json) => item.revision)).toEqual([2, 1]);

    // Members may import run artifacts; admins who do not own the project may not write.
    const memberDesign = await member.post(`${base}/tasks/session-next/runs/run-member/design`, payload);
    expect(memberDesign.status, await memberDesign.clone().text()).toBe(201);
    expect((await admin.post(`${base}/tasks/session-task/runs/run-admin/design`, payload)).status).toBe(403);
  });

  it("never counts skipped, blocked or missing results as passed", async () => {
    const { body, document, rule } = await importDesign();
    expect(body.batch.revision).toBe(1);
    const failed = await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1,
      invocationId: "inv-1",
      results: [
        { caseId: "CASE-001", status: "passed" },
        {
          caseId: "CASE-002", status: "failed", reason: "锁定后仍然登录成功",
          evidenceRefs: [executionRef("run-main")]
        }
      ]
    });
    expect(failed.status, await failed.clone().text()).toBe(201);
    const ingested = (await failed.json()) as Json;
    expect(ingested).toMatchObject({ idempotent: false, designRevision: 1, stored: 2 });
    expect(ingested.coverage).toMatchObject({
      counts: {
        points: 3, cases: 3, coveredPoints: 2, uncoveredPoints: 1,
        executed: 2, passed: 1, failed: 1, skipped: 0, blocked: 0, untestedCases: 1
      },
      gate: { qualityGate: "blocked", conclusion: "failed", allPassed: false, complete: false }
    });
    expect(ingested.coverage.untested).toEqual(expect.arrayContaining([
      { kind: "case", id: "CASE-003", reason: "本次运行未执行" },
      { kind: "point", id: "TP-003", reason: "无关联用例" }
    ]));
    expect(ingested.coverage.points.find((point: Json) => point.pointKey === "TP-001")).toMatchObject({
      status: "failed", coveredBy: ["CASE-001", "CASE-002"],
      caseCounts: { passed: 1, failed: 1, skipped: 0, blocked: 0, notRun: 0 }
    });
    expect(ingested.coverage.points.find((point: Json) => point.pointKey === "TP-003")).toMatchObject({
      status: "untested", untestedReason: "无关联用例"
    });

    // Same invocation is idempotent; a design change after execution is refused.
    const repeated = await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-1",
      results: [{ caseId: "CASE-001", status: "passed" }]
    });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as Json).idempotent).toBe(true);
    // A design change after execution is refused even when the evidence is valid.
    const frozen = await owner.post(`${base}/tasks/session-task/runs/run-main/design`, {
      ...designPayload(document.document.documentId, rule.ruleId),
      expectedRevision: 1,
      points: [{
        id: "TP-009", module: "登录", feature: "审计", description: "补充审计字段", risk: "低",
        evidenceRefs: [{ type: "document", documentId: document.document.documentId, revision: 1 }]
      }],
      cases: []
    });
    expect(frozen.status).toBe(409);
    expect(await errorCode(frozen)).toBe("design_frozen");

    // Unknown cases and failures without evidence are rejected.
    const unknown = await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-bad", results: [{ caseId: "CASE-999", status: "passed" }]
    });
    expect(unknown.status).toBe(400);
    expect(await errorCode(unknown)).toBe("unknown_case");
    const noEvidence = await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-bad", results: [{ caseId: "CASE-001", status: "failed" }]
    });
    expect(noEvidence.status).toBe(400);
    expect(await errorCode(noEvidence)).toBe("invalid_result");
    expect((await admin.post(`${base}/tasks/session-task/runs/run-main/results`, { expectedRevision: 1, invocationId: "inv-admin", results: [] })).status).toBe(403);
    expect((await owner.get(`${otherBase}/tasks/session-task/runs/run-main/coverage`)).status).toBe(404);

    // A newer invocation adds the missing result without erasing the failure.
    const completed = await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-2", results: [{ caseId: "CASE-003", status: "passed" }]
    });
    expect(completed.status, await completed.clone().text()).toBe(201);
    const nextCoverage = (await completed.json() as Json).coverage;
    expect(nextCoverage.counts).toMatchObject({ executed: 3, passed: 2, failed: 1, untestedCases: 0 });
    expect(nextCoverage.gate).toMatchObject({ qualityGate: "blocked", conclusion: "failed", allPassed: false });
  });

  it("tracks a project defect from discovery through confirmation, repair, retest and close", async () => {
    const { document, rule } = await importDesign();
    expect(document.document.documentId).toBeTruthy();
    expect(rule.ruleId).toBeTruthy();
    const failure = executionRef("run-main");
    await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-fail",
      results: [
        { caseId: "CASE-001", status: "failed", reason: "第 5 次后仍可登录", evidenceRefs: [failure] },
        { caseId: "CASE-002", status: "passed" }
      ]
    });
    const discovered = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-main",
      title: "验证码锁定未生效", category: "product_defect", confidence: "medium",
      severity: "Major", priority: "P1", expectedResult: "锁定 15 分钟", actualResult: "仍可登录",
      relatedCases: ["CASE-001"], evidenceRefs: [failure]
    });
    expect(discovered.status, await discovered.clone().text()).toBe(201);
    const first = (await discovered.json()) as Json;
    expect(first).toMatchObject({ created: true, occurrenceAdded: true, defect: {
      status: "draft", revision: 1, eventCount: 1, relatedCases: ["CASE-001"], originRunId: "run-main"
    } });
    const defectId = first.defect.defectId as string;
    const fingerprint = first.defect.fingerprint as string;
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const forged = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-main", fingerprint: "sha256:" + "a".repeat(64),
      title: "验证码锁定未生效", category: "product_defect", expectedResult: "锁定 15 分钟",
      actualResult: "仍可登录", relatedCases: ["CASE-001"], evidenceRefs: [failure]
    });
    expect(forged.status).toBe(400);
    expect(await errorCode(forged)).toBe("invalid_defect");
    expect(((await json(await owner.get(`${base}/defects?sessionId=session-task`))) as Json).defects).toHaveLength(1);
    expect(((await json(await owner.get(`${base}/defects?sessionId=other-session`))) as Json).defects).toHaveLength(0);

    // A defect must be backed by a real failed case, not a passed one.
    const passedCase = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-main",
      title: "错误缺陷", category: "product_defect", relatedCases: ["CASE-002"], evidenceRefs: [failure]
    });
    expect(passedCase.status).toBe(400);
    expect(await errorCode(passedCase)).toBe("invalid_defect");

    // The same fingerprint aggregates across runs; the same run/case is idempotent.
    const same = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-main", fingerprint,
      title: "验证码锁定未生效", category: "product_defect",
      expectedResult: "锁定 15 分钟", actualResult: "仍可登录",
      relatedCases: ["CASE-001"], evidenceRefs: [failure]
    });
    expect(same.status).toBe(200);
    expect((await same.json() as Json)).toMatchObject({ created: false, occurrenceAdded: false });
    const secondDesign = await owner.post(`${base}/tasks/session-task/runs/run-second/design`, designPayload(document.document.documentId, rule.ruleId));
    expect(secondDesign.status).toBe(201);
    await member.post(`${base}/tasks/session-task/runs/run-second/results`, {
      expectedRevision: 1, invocationId: "inv-second",
      results: [{ caseId: "CASE-001", status: "failed", reason: "复现", evidenceRefs: [executionRef("run-second")] }]
    });
    const recurred = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-second", fingerprint,
      title: "验证码锁定未生效", category: "product_defect",
      expectedResult: "锁定 15 分钟", actualResult: "仍可登录",
      relatedCases: ["CASE-001"], evidenceRefs: [executionRef("run-second")]
    });
    expect(recurred.status).toBe(200);
    expect((await recurred.json() as Json)).toMatchObject({ created: false, occurrenceAdded: true });
    const afterRecurrence = await json(await owner.get(`${base}/defects/${defectId}`)) as Json;
    expect(afterRecurrence.defect).toMatchObject({ revision: 2, eventCount: 2 });
    expect(afterRecurrence.events.map((event: Json) => event.action)).toEqual(["discovered", "observed"]);

    // Only the owner confirms; a member or non-owner admin is refused.
    const confirmBody = { expectedRevision: 2, category: "product_defect", severity: "Critical", reason: "截图与日志均确认" };
    expect((await member.post(`${base}/defects/${defectId}/confirm`, confirmBody)).status).toBe(403);
    expect((await admin.post(`${base}/defects/${defectId}/confirm`, confirmBody)).status).toBe(403);
    const confirmed = await owner.post(`${base}/defects/${defectId}/confirm`, confirmBody);
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await confirmed.json() as Json).defect).toMatchObject({ status: "confirmed", revision: 3, eventCount: 3, severity: "Critical" });

    // Repair is a declaration with evidence; it does not close the defect.
    const fixed = await owner.post(`${base}/defects/${defectId}/fix`, {
      expectedRevision: 3, reason: "已修复锁定逻辑", evidenceRefs: [failure]
    });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    expect((await fixed.json() as Json).defect).toMatchObject({ status: "fixed", revision: 4, eventCount: 4 });

    // A retest without case results cannot close the defect.
    expect((await owner.post(`${base}/tasks/session-task/runs/run-retest-1/design`, designPayload(document.document.documentId, rule.ruleId))).status).toBe(201);
    const incomplete = await owner.post(`${base}/defects/${defectId}/retest`, {
      expectedRevision: 4, retestSessionId: "session-task", retestRunId: "run-retest-1"
    });
    expect(incomplete.status).toBe(409);
    expect(await errorCode(incomplete)).toBe("retest_incomplete");

    // A failed retest returns the defect to confirmed.
    await member.post(`${base}/tasks/session-task/runs/run-retest-1/results`, {
      expectedRevision: 1, invocationId: "inv-retest-1",
      results: [{ caseId: "CASE-001", status: "failed", reason: "修复未生效", evidenceRefs: [executionRef("run-retest-1", "execution/retest-failed.png")] }]
    });
    const failedRetest = await owner.post(`${base}/defects/${defectId}/retest`, {
      expectedRevision: 4, retestSessionId: "session-task", retestRunId: "run-retest-1", note: "修复后复测仍失败"
    });
    expect(failedRetest.status, await failedRetest.clone().text()).toBe(201);
    expect((await failedRetest.json() as Json)).toMatchObject({
      idempotent: false,
      defect: { status: "confirmed", revision: 5, eventCount: 5 },
      retest: { result: "failed", runId: "run-retest-1" }
    });

    // Repair again, then an independent all-passed retest closes it.
    await owner.post(`${base}/defects/${defectId}/fix`, { expectedRevision: 5, reason: "再次修复", evidenceRefs: [failure] });
    await owner.post(`${base}/tasks/session-task/runs/run-retest-2/design`, designPayload(document.document.documentId, rule.ruleId));
    await member.post(`${base}/tasks/session-task/runs/run-retest-2/results`, {
      expectedRevision: 1, invocationId: "inv-retest-2", results: [{ caseId: "CASE-001", status: "passed" }]
    });
    const closed = await owner.post(`${base}/defects/${defectId}/retest`, {
      expectedRevision: 6, retestSessionId: "session-task", retestRunId: "run-retest-2", note: "关联用例全部通过"
    });
    expect(closed.status, await closed.clone().text()).toBe(201);
    expect((await closed.json() as Json)).toMatchObject({
      idempotent: false, defect: { status: "closed", revision: 7, eventCount: 7 }, retest: { result: "passed" }
    });
    const repeatedRetest = await owner.post(`${base}/defects/${defectId}/retest`, {
      expectedRevision: 7, retestSessionId: "session-task", retestRunId: "run-retest-2"
    });
    expect(repeatedRetest.status).toBe(200);
    expect((await repeatedRetest.json() as Json).idempotent).toBe(true);

    // A new retest failure reopens a closed defect.
    await owner.post(`${base}/tasks/session-task/runs/run-retest-3/design`, designPayload(document.document.documentId, rule.ruleId));
    await member.post(`${base}/tasks/session-task/runs/run-retest-3/results`, {
      expectedRevision: 1, invocationId: "inv-retest-3",
      results: [{ caseId: "CASE-001", status: "failed", reason: "再次出现", evidenceRefs: [executionRef("run-retest-3")] }]
    });
    const closedRecurrence = await member.post(`${base}/defects`, {
      sessionId: "session-task", runId: "run-retest-3", fingerprint,
      title: "验证码锁定未生效", category: "product_defect", expectedResult: "锁定 15 分钟",
      actualResult: "仍可登录", relatedCases: ["CASE-001"], evidenceRefs: [executionRef("run-retest-3")]
    });
    expect(closedRecurrence.status).toBe(409);
    expect(await errorCode(closedRecurrence)).toBe("defect_status_conflict");
    const reopened = await owner.post(`${base}/defects/${defectId}/retest`, {
      expectedRevision: 7, retestSessionId: "session-task", retestRunId: "run-retest-3"
    });
    expect(reopened.status, await reopened.clone().text()).toBe(201);
    expect((await reopened.json() as Json).defect).toMatchObject({ status: "confirmed", revision: 8, eventCount: 8 });

    const detail = await json(await owner.get(`${base}/defects/${defectId}`)) as Json;
    expect(detail.events.map((event: Json) => event.action)).toEqual([
      "discovered", "observed", "confirmed", "fixed", "retested", "fixed", "retested", "reopened"
    ]);
    for (let index = 1; index < detail.events.length; index++) {
      expect(detail.events[index].prevEventHash).toBe(detail.events[index - 1].eventHash);
      expect(detail.events[index].eventHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(detail.occurrences).toHaveLength(2);
    expect(detail.retests).toHaveLength(3);
    expect((await outsider.get(`${base}/defects/${defectId}`)).status).toBe(404);
    expect((await owner.get(`${otherBase}/defects/${defectId}`)).status).toBe(404);
  });

  it("does not silently merge a new observation into a rejected defect", async () => {
    await importDesign();
    const failure = executionRef("run-main");
    await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-rejected",
      results: [{ caseId: "CASE-001", status: "failed", reason: "仍可登录", evidenceRefs: [failure] }]
    });
    const body = { sessionId: "session-task", runId: "run-main", title: "锁定失败", category: "needs_review",
      expectedResult: "账号锁定", actualResult: "仍可登录", relatedCases: ["CASE-001"], evidenceRefs: [failure] };
    const first = await member.post(`${base}/defects`, body);
    expect(first.status).toBe(201);
    const defect = (await first.json() as Json).defect;
    const rejected = await owner.post(`${base}/defects/${defect.defectId}/reject`, { expectedRevision: 1, reason: "不是产品问题" });
    expect(rejected.status).toBe(200);
    const repeated = await member.post(`${base}/defects`, body);
    expect(repeated.status).toBe(200); // Same observation remains idempotent.
    const document = await createDocument();
    const rule = await createRule(document.document.documentId);
    const nextDesign = await owner.post(`${base}/tasks/session-task/runs/run-next/design`, designPayload(document.document.documentId, rule.ruleId));
    expect(nextDesign.status).toBe(201);
    await member.post(`${base}/tasks/session-task/runs/run-next/results`, {
      expectedRevision: 1, invocationId: "inv-next",
      results: [{ caseId: "CASE-001", status: "failed", reason: "仍可登录", evidenceRefs: [executionRef("run-next")] }]
    });
    const recurrence = await member.post(`${base}/defects`, { ...body, runId: "run-next", evidenceRefs: [executionRef("run-next")] });
    expect(recurrence.status).toBe(409);
    expect(await errorCode(recurrence)).toBe("defect_status_conflict");
    const detail = await json(await owner.get(`${base}/defects/${defect.defectId}`)) as Json;
    expect(detail.events.map((event: Json) => event.action)).toEqual(["discovered", "rejected"]);
    expect(detail.occurrences).toHaveLength(1);
  });

  it("indexes report evidence and refuses reports that overstate partial or failed execution", async () => {
    const { document, rule } = await importDesign();
    const failure = executionRef("run-main");
    await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-report",
      results: [
        { caseId: "CASE-001", status: "passed" },
        { caseId: "CASE-002", status: "failed", reason: "锁定后仍可登录", evidenceRefs: [failure] }
      ]
    });
    const html = await writeRunFile(workspace, "session-task", "run-main", "report/report-task.html", "<html><body>report</body></html>");
    const screenshot = await writeRunFile(workspace, "session-task", "run-main", "execution/failure.png", "png-bytes");
    const evidence = [{
      label: "锁定失败截图", ref: failure, path: "execution/failure.png", sha256: screenshot
    }];
    const untested = [
      { kind: "case", id: "CASE-003", reason: "本次运行未执行" },
      { kind: "point", id: "TP-003", reason: "无关联用例" }
    ];
    const request = {
      expectedDesignRevision: 1, htmlPath: "report/report-task.html", htmlSha256: html,
      conclusion: "failed", evidence, untested, limitations: ["仅验证登录锁定场景"]
    };
    const noManifest = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, request);
    expect(noManifest.status).toBe(400);
    expect(await errorCode(noManifest)).toBe("report_run_invalid");
    await writeRunManifest(workspace, "session-task", "run-main", "run-forged");
    const forgedManifest = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, request);
    expect(forgedManifest.status).toBe(400);
    expect(await errorCode(forgedManifest)).toBe("report_run_invalid");
    await writeRunManifest(workspace, "session-task", "run-main");
    expect(await json(await owner.get(`${base}/tasks/session-task/runs/run-main/report-index`)))
      .toMatchObject({ report: null, stale: false });

    // Publication is owner-only.
    expect((await member.post(`${base}/tasks/session-task/runs/run-main/report-index`, request)).status).toBe(403);
    expect((await admin.post(`${base}/tasks/session-task/runs/run-main/report-index`, request)).status).toBe(403);
    const overstated = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, { ...request, conclusion: "passed" });
    expect(overstated.status).toBe(400);
    expect(await errorCode(overstated)).toBe("report_overstates_results");
    const incomplete = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, { ...request, untested: [] });
    expect(incomplete.status).toBe(400);
    expect(await errorCode(incomplete)).toBe("report_untested_incomplete");
    const wrongHtml = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, { ...request, htmlSha256: "sha256:" + "c".repeat(64) });
    expect(wrongHtml.status).toBe(400);
    expect(await errorCode(wrongHtml)).toBe("report_artifact_missing");
    const wrongEvidence = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, evidence: [{ ...evidence[0], sha256: "sha256:" + "d".repeat(64) }]
    });
    expect(wrongEvidence.status).toBe(400);
    expect(await errorCode(wrongEvidence)).toBe("report_artifact_missing");
    const foreignRunEvidence = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, evidence: [{ label: "其他运行", ref: executionRef("run-other") }]
    });
    expect(foreignRunEvidence.status).toBe(400);
    expect(await errorCode(foreignRunEvidence)).toBe("invalid_report");
    const foreignSessionEvidence = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, evidence: [{ label: "其他任务", ref: { type: "execution", sessionId: "session-next", runId: "run-main", evidencePath: "execution/failure.png" } }]
    });
    expect(foreignSessionEvidence.status).toBe(400);
    expect(await errorCode(foreignSessionEvidence)).toBe("invalid_report");
    const mismatchedEvidencePath = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, evidence: [{ ...evidence[0], path: "report/report-task.html", sha256: html }]
    });
    expect(mismatchedEvidencePath.status).toBe(400);
    expect(await errorCode(mismatchedEvidencePath)).toBe("invalid_report");
    const traversal = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, { ...request, htmlPath: "../secret.html" });
    expect(traversal.status).toBe(400);
    expect(await errorCode(traversal)).toBe("invalid_report");

    const created = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, request);
    expect(created.status, await created.clone().text()).toBe(201);
    const first = (await created.json()) as Json;
    expect(first.report).toMatchObject({
      revision: 1, status: "published", conclusion: "failed", qualityGate: "blocked",
      htmlPath: "report/report-task.html", htmlSha256: html,
      counts: { cases: 3, executed: 2, passed: 1, failed: 1, untestedCases: 1 },
      coverage: { pointCoverage: 2 / 3, caseExecution: 2 / 3, passRate: 0.5, allPassed: false }
    });
    expect(first.report.untested).toEqual(untested);
    expect(first.report.evidence[0]).toMatchObject({ label: "锁定失败截图", path: "execution/failure.png", sha256: screenshot });
    expect(first.report.resultsFingerprint).toMatch(/^sha256:/);
    const read = await json(await member.get(`${base}/tasks/session-task/runs/run-main/report-index`)) as Json;
    expect(read).toMatchObject({ stale: false, report: { reportId: first.report.reportId } });

    // New results make the old report stale; a second report supersedes it.
    await member.post(`${base}/tasks/session-task/runs/run-main/results`, {
      expectedRevision: 1, invocationId: "inv-report-2", results: [{ caseId: "CASE-003", status: "passed" }]
    });
    expect((await json(await owner.get(`${base}/tasks/session-task/runs/run-main/report-index`)) as Json).stale).toBe(true);
    const revised = await owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, untested: [{ kind: "point", id: "TP-003", reason: "无关联用例" }]
    });
    expect(revised.status, await revised.clone().text()).toBe(201);
    expect((await revised.json() as Json).report.revision).toBe(2);
    const history = (await json(await owner.get(`${base}/tasks/session-task/runs/run-main/report-index/history`)) as Json).reports;
    expect(history.map((item: Json) => item.revision)).toEqual([2, 1]);
    expect(history[0].status).toBe("published");
    expect(history[1].status).toBe("superseded");
    const concurrent = await Promise.all([0, 1].map(() => owner.post(`${base}/tasks/session-task/runs/run-main/report-index`, {
      ...request, untested: [{ kind: "point", id: "TP-003", reason: "无关联用例" }]
    })));
    expect(concurrent.map((response) => response.status)).toEqual([201, 201]);
    const revisions = (await json(await owner.get(`${base}/tasks/session-task/runs/run-main/report-index/history`)) as Json)
      .reports.map((item: Json) => item.revision);
    expect(revisions).toEqual([4, 3, 2, 1]);

    // A complete all-passed run can be reported as passed.
    await owner.post(`${base}/tasks/session-task/runs/run-pass/design`, {
      expectedRevision: 0,
      points: [{
        id: "TP-001", module: "登录", feature: "锁定", description: "锁定账号", risk: "高",
        coverageType: ["正常"], evidenceRefs: [{ type: "document", documentId: document.document.documentId, revision: 1 }]
      }],
      cases: [{
        caseId: "CASE-001", title: "锁定账号", priority: "P0", preconditions: [], steps: ["输入 5 次错误验证码"],
        expected: "锁定", automationFeasible: true, relatedTestPoint: "TP-001",
        evidenceRefs: [{ type: "rule", ruleId: rule.ruleId, version: 1 }]
      }]
    });
    await member.post(`${base}/tasks/session-task/runs/run-pass/results`, {
      expectedRevision: 1, invocationId: "inv-pass", results: [{ caseId: "CASE-001", status: "passed" }]
    });
    const passHtml = await writeRunFile(workspace, "session-task", "run-pass", "report/report-pass.html", "<html>pass</html>");
    await writeRunManifest(workspace, "session-task", "run-pass");
    const passEvidence = await writeRunFile(workspace, "session-task", "run-pass", "execution/pass.json", "{\"status\":\"passed\"}");
    const passReport = await owner.post(`${base}/tasks/session-task/runs/run-pass/report-index`, {
      expectedDesignRevision: 1, htmlPath: "report/report-pass.html", htmlSha256: passHtml,
      conclusion: "passed",
      evidence: [{
        label: "执行结果", ref: { type: "execution", sessionId: "session-task", runId: "run-pass", evidencePath: "execution/pass.json" },
        path: "execution/pass.json", sha256: passEvidence
      }],
      untested: []
    });
    expect(passReport.status, await passReport.clone().text()).toBe(201);
    expect((await passReport.json() as Json).report).toMatchObject({
      conclusion: "passed", qualityGate: "informational", counts: { executed: 1, passed: 1, failed: 0, untestedCases: 0 }
    });
  });

  it("creates Q3 tables and isolates records per project", async () => {
    const tables = (app.deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qa_%'").all() as { name: string }[])
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "qa_design_batches", "qa_test_points", "qa_test_cases", "qa_case_results",
      "qa_defects", "qa_defect_occurrences", "qa_defect_events", "qa_retests", "qa_report_indexes"
    ]));
    const { body } = await importDesign(owner, otherBase, "session-other", "run-other");
    expect(body.batch.projectId).toBe(otherProject);
    expect((await owner.get(`${base}/tasks/session-other/runs/run-other/design`)).status).toBe(404);
    expect((await owner.get(`${otherBase}/tasks/session-other/runs/run-other/design`)).status).toBe(200);
    expect((await outsider.get(`${otherBase}/tasks/session-other/runs/run-other/design`)).status).toBe(404);
  });

  it("keeps results separate when two projects use the same run and case keys", async () => {
    await importDesign(owner, base, "session-task", "run-shared");
    await importDesign(owner, otherBase, "session-other", "run-shared");
    const first = await owner.post(`${base}/tasks/session-task/runs/run-shared/results`, {
      expectedRevision: 1, invocationId: "first-project", results: [{ caseId: "CASE-001", status: "passed" }]
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await owner.post(`${otherBase}/tasks/session-other/runs/run-shared/results`, {
      expectedRevision: 1, invocationId: "second-project", results: [{ caseId: "CASE-001", status: "blocked", reason: "测试环境不可用" }]
    });
    expect(second.status, await second.clone().text()).toBe(201);
    const mainResults = await json(await owner.get(`${base}/tasks/session-task/runs/run-shared/results`));
    const otherResults = await json(await owner.get(`${otherBase}/tasks/session-other/runs/run-shared/results`));
    expect(mainResults.results).toMatchObject([{ caseKey: "CASE-001", status: "passed" }]);
    expect(otherResults.results).toMatchObject([{ caseKey: "CASE-001", status: "blocked" }]);
  });
});
