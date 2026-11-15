import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("U2 contract preparation", () => {
  it("creates an auditable mission, confirms its Oracle, links a case and freezes a complete envelope", async () => {
    const app: TestApp = await createTestApp();
    try {
      const owner = apiClient(app.app, (await provisionUser(app.app, "u2_owner")).cookie);
      const member = apiClient(app.app, (await provisionUser(app.app, "u2_member")).cookie);
      const project = "u2_owner-sandbox";
      const base = `/api/projects/${project}/agents/qa/u2`;
      expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
      expect((await owner.post(`/api/projects/${project}/members`, { userId: "u2_member" })).status).toBe(201);

      const missionRes = await member.post(`${base}/missions`, {
        title: "登录锁定试点",
        objective: "验证系统可以区分已知缺陷、正常点与不可判定点。",
        scope: { inScope: ["web-login"], outOfScope: ["performance"] },
        risks: ["账号污染", "测试数据残留"],
        authorization: { grantedBy: "待确认" },
        deliverables: { report: true, evidenceIndex: true }
      });
      expect(missionRes.status, await missionRes.clone().text()).toBe(201);
      const mission = (await missionRes.json()) as Json;
      expect(mission.status).toBe("draft");
      expect(mission.oracleCount).toBe(0);

      const oracleRes = await member.post(`${base}/missions/${mission.missionId}/oracles`, {
        oracleKey: "ORACLE-LOGIN-LOCK",
        capability: "验证码错误后账号锁定",
        statement: "连续 5 次验证码错误后，账号锁定 15 分钟。",
        sourceType: "requirement",
        sourceRef: "requirements/login.md#lock",
        sourceHash: sha("login lock requirement"),
        evidenceRefs: [{ type: "external", system: "Requirements", externalId: "REQ-LOGIN-LOCK", url: "http://127.0.0.1/requirements/login#lock" }]
      });
      expect(oracleRes.status, await oracleRes.clone().text()).toBe(201);
      const oracle = (await oracleRes.json()) as Json;
      expect(oracle.status).toBe("unconfirmed");

      // A member may draft the link, but only the owner can turn the Oracle into confirmed basis.
      expect((await member.post(`${base}/oracles/${oracle.oracleId}/confirm`, { reason: "产品负责人已确认" })).status).toBe(403);
      const confirmedRes = await owner.post(`${base}/oracles/${oracle.oracleId}/confirm`, { reason: "需求原文与业务确认一致", evidenceRefs: [{ type: "external", system: "Requirements", externalId: "REQ-LOGIN-LOCK" }] });
      expect(confirmedRes.status, await confirmedRes.clone().text()).toBe(200);
      const confirmed = (await confirmedRes.json()) as Json;
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.confirmationReason).toBe("需求原文与业务确认一致");

      const linkRes = await member.post(`${base}/missions/${mission.missionId}/case-links`, {
        oracleId: oracle.oracleId,
        pointKey: "TP-LOGIN-LOCK",
        caseKey: "CASE-LOGIN-LOCK",
        relation: "validates"
      });
      expect(linkRes.status, await linkRes.clone().text()).toBe(201);

      const envelope = {
        label: "web-chromium-local",
        targetRef: "http://127.0.0.1/login",
        targetVersion: "candidate-2026.11.13",
        carrier: "web",
        osName: "Windows 11",
        accountRole: "ordinary_user",
        agentId: "test_agent",
        agentBundleHash: sha("test_agent bundle"),
        skills: { "login-flow": sha("login-flow skill") },
        plugins: {},
        model: { provider: "local", modelId: "glm-5.3-flash" },
        connectors: {},
        backend: "local_browser",
        authorizationState: "online",
        resourceSetHash: sha("published resource set"),
        dataState: { users: ["u2-lock-user"], initialState: "clean" },
        cleanupPlan: { deleteUsers: ["u2-lock-user"], verify: true }
      };
      const envelopeRes = await member.post(`${base}/missions/${mission.missionId}/envelopes`, envelope);
      expect(envelopeRes.status, await envelopeRes.clone().text()).toBe(201);
      const draftEnvelope = (await envelopeRes.json()) as Json;
      expect(draftEnvelope.status).toBe("draft");
      expect(draftEnvelope.identityHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const blockedRes = await owner.post(`${base}/envelopes/${draftEnvelope.envelopeId}/freeze`, {});
      expect(blockedRes.status).toBe(409);
      expect(((await blockedRes.json()) as Json).error?.code).toBe("envelope_freeze_blocked");

      // Envelopes are immutable planning snapshots in this preparation endpoint: create a
      // completed clone to prove the freeze gate itself, without executing a test.
      const completedRes = await member.post(`${base}/missions/${mission.missionId}/envelopes`, {
        ...envelope,
        label: "web-chromium-local-verified",
        actualVersion: envelope.targetVersion
      });
      expect(completedRes.status).toBe(201);
      const completed = (await completedRes.json()) as Json;
      const freezeRes = await owner.post(`${base}/envelopes/${completed.envelopeId}/freeze`, {});
      expect(freezeRes.status, await freezeRes.clone().text()).toBe(200);
      expect(((await freezeRes.json()) as Json).status).toBe("frozen");

      const attemptRes = await member.post(`${base}/missions/${mission.missionId}/attempts`, {
        envelopeId: completed.envelopeId,
        envelopeIdentityHash: completed.identityHash,
        executor: "playwright-cli"
      });
      expect(attemptRes.status, await attemptRes.clone().text()).toBe(201);
      const attempt = (await attemptRes.json()) as Json;
      expect(attempt.attemptStatus).toBe("running");
      expect(attempt.caseCount).toBe(1);

      const finishRes = await owner.post(`${base}/attempts/${attempt.attemptId}/finish`, {
        result: "failed",
        attemptStatus: "completed",
        cleanupState: "clean",
        observedSummary: "登录与入口通过；提交请求失败且未创建用户。",
        metrics: { cases: 1, defects: 2 },
        defectRefs: ["U2-DEF-001", "U2-DEF-002"],
        envelopeIdentityHash: completed.identityHash,
        evidence: [{ label: "执行结果", path: "output/u2-pilot-execution.json", sha256: sha("execution result") }],
        cases: [{
          caseKey: "CASE-LOGIN-LOCK",
          status: "failed",
          observed: "目标接口失败，未创建业务记录。",
          failureClass: "product_defect",
          defectRefs: ["U2-DEF-001"],
          evidence: [{ label: "失败证据", path: "output/failure.json", sha256: sha("failure") }]
        }]
      });
      expect(finishRes.status, await finishRes.clone().text()).toBe(200);
      const finished = (await finishRes.json()) as Json;
      expect(finished.result).toBe("failed");
      expect(finished.attemptStatus).toBe("completed");
      expect(finished.envelopeIdentityMatches).toBe(true);

      const cancellationAttemptRes = await member.post(`${base}/missions/${mission.missionId}/attempts`, {
        envelopeId: completed.envelopeId,
        envelopeIdentityHash: completed.identityHash,
        executor: "fault-drill"
      });
      expect(cancellationAttemptRes.status, await cancellationAttemptRes.clone().text()).toBe(201);
      const cancellationAttempt = (await cancellationAttemptRes.json()) as Json;
      const cancellationBase = base.replace("/agents/qa/u2", "/agents/qa/u3");
      const cancellationRes = await member.post(`${cancellationBase}/attempts/${cancellationAttempt.attemptId}/cancellations`, {
        kind: "fault_injection",
        propagation: { browser: "sent", model: "not_applicable", tool: "not_applicable", wsl: "not_applicable", callback: "not_applicable" },
        notes: "浏览器崩溃注入触发取消"
      });
      expect(cancellationRes.status, await cancellationRes.clone().text()).toBe(201);
      const cancellation = (await cancellationRes.json()) as Json;
      expect(cancellation.status).toBe("requested");

      const faultRes = await member.post(`${cancellationBase}/attempts/${cancellationAttempt.attemptId}/fault-injections`, {
        caseAttemptId: cancellationAttempt.cases[0].attemptCaseId,
        kind: "browser_crash",
        state: "injected",
        expectedEffect: "浏览器进程树退出，用例阻断，不产生业务写入。",
        cleanupState: "unknown"
      });
      expect(faultRes.status).toBe(201);

      const processRes = await member.post(`${cancellationBase}/cancellations/${cancellation.cancellationId}/process-verifications`, {
        targetKind: "browser",
        target: "chromium-tree",
        verificationMethod: "Windows process tree snapshot before/after",
        beforeAlive: true,
        afterAlive: false,
        exitCode: 1,
        state: "terminated",
        evidence: [{ label: "进程快照", path: "output/process-tree.json", sha256: sha("process tree") }]
      });
      expect(processRes.status, await processRes.clone().text()).toBe(201);

      const acknowledgedRes = await owner.post(`${cancellationBase}/cancellations/${cancellation.cancellationId}/acknowledge`, {
        propagation: { browser: "acknowledged", model: "not_applicable", tool: "not_applicable", wsl: "not_applicable", callback: "not_applicable" },
        residualState: "clean",
        evidence: [{ label: "无业务副作用", path: "output/no-write.json", sha256: sha("no write") }]
      });
      expect(acknowledgedRes.status, await acknowledgedRes.clone().text()).toBe(200);
      expect(((await acknowledgedRes.json()) as Json).status).toBe("acknowledged");

      const faultRecovered = await owner.patch(`${cancellationBase}/fault-injections/${((await faultRes.json()) as Json).injectionId}`, {
        state: "recovered",
        observedEffect: "浏览器进程树已退出，无业务写入。",
        cleanupState: "clean",
        evidence: [{ label: "恢复证据", path: "output/recovery.json", sha256: sha("recovery") }]
      });
      expect(faultRecovered.status).toBe(200);

      const cancelledFinish = await owner.post(`${base}/attempts/${cancellationAttempt.attemptId}/finish`, {
        result: "blocked",
        attemptStatus: "blocked",
        cleanupState: "clean",
        observedSummary: "浏览器崩溃注入后取消传播完成；用例保持阻断，未重复业务写入。",
        envelopeIdentityHash: completed.identityHash,
        evidence: [{ label: "取消演练", path: "output/cancellation-drill.json", sha256: sha("cancellation") }],
        cases: cancellationAttempt.cases.map((item: Json) => ({ caseKey: item.caseKey, status: "blocked", observed: "浏览器故障演练阻断。" }))
      });
      expect(cancelledFinish.status, await cancelledFinish.clone().text()).toBe(200);
      const mismatchStart = await member.post(`${base}/missions/${mission.missionId}/attempts`, {
        envelopeId: completed.envelopeId,
        envelopeIdentityHash: sha("different environment")
      });
      expect(mismatchStart.status).toBe(409);
      expect(((await mismatchStart.json()) as Json).error?.code).toBe("envelope_identity_mismatch");
      const u3Base = base.replace("/agents/qa/u2", "/agents/qa/u3");
      const u3 = `${u3Base}/attempts/${attempt.attemptId}`;
      const caseAttemptId = attempt.cases[0].attemptCaseId;
      const blockerEffect = await member.post(`${u3}/side-effects`, {
        caseAttemptId,
        kind: "business_write",
        target: "POST /unresolved-write",
        idempotencyKey: "unresolved-write",
        state: "unknown",
        cleanupState: "unknown",
        evidence: [{ label: "未知写入", path: "output/unknown.json", sha256: sha("unknown") }]
      });
      expect(blockerEffect.status).toBe(201);
      const blockedRestart = await member.post(`${base}/missions/${mission.missionId}/attempts`, {
        envelopeId: completed.envelopeId,
        envelopeIdentityHash: completed.identityHash
      });
      expect(blockedRestart.status).toBe(409);
      expect(((await blockedRestart.json()) as Json).error?.code).toBe("environment_not_clean");
      await owner.patch(`${u3Base}/side-effects/${((await blockerEffect.json()) as Json).effectId}`, {
        state: "not_created",
        cleanupState: "not_required",
        evidence: [{ label: "人工确认未创建", path: "output/manual-verify.json", sha256: sha("manual verify") }]
      });
      const checkpointRes = await member.post(`${u3}/checkpoints`, {
        caseAttemptId,
        ordinal: 1,
        kind: "step",
        label: "用例完成检查点",
        status: "recorded",
        payload: { result: "failed", persisted: false },
        evidence: [{ label: "失败证据", path: "output/failure.json", sha256: sha("failure") }]
      });
      expect(checkpointRes.status, await checkpointRes.clone().text()).toBe(201);

      const unknownEffectRes = await member.post(`${u3}/side-effects`, {
        caseAttemptId,
        kind: "business_write",
        target: "POST /group/user/create",
        idempotencyKey: "u2-add-user-attempt",
        state: "unknown",
        cleanupState: "unknown",
        evidence: [{ label: "网络失败", path: "output/failure.json", sha256: sha("network failure") }]
      });
      expect(unknownEffectRes.status).toBe(201);
      const unknownEffect = (await unknownEffectRes.json()) as Json;
      let safety = await owner.get(`${u3Base}/attempts/${attempt.attemptId}/safety`);
      expect(((await safety.json()) as Json).cleanup.ready).toBe(false);

      const resolvedEffect = await owner.patch(`${u3Base}/side-effects/${unknownEffect.effectId}`, {
        state: "not_created",
        cleanupState: "not_required",
        evidence: [{ label: "只读搜索为空", path: "output/search.json", sha256: sha("search empty") }]
      });
      expect(resolvedEffect.status, await resolvedEffect.clone().text()).toBe(200);
      safety = await owner.get(`${u3Base}/attempts/${attempt.attemptId}/safety`);
      expect(((await safety.json()) as Json).cleanup.ready).toBe(true);

      const partialCoverage = await member.post(`${u3}/checkpoints`, {
        caseAttemptId,
        ordinal: 2,
        kind: "step",
        label: "接口覆盖九层门禁",
        status: "recorded",
        payload: {},
        interfaceCoverage: {
          routeKey: "user-create",
          method: "POST",
          path: "/gateway-admin/v2/apiGateway/manage/group/user/create",
          routeDocumented: true,
          contractVersion: "v2",
          sourceRef: "api/user-create.md",
          executed: true,
          requestValid: true,
          structureAsserted: true,
          businessAsserted: false,
          riskBranch: false,
          cleanupVerified: true,
          result: "passed"
        }
      });
      expect(partialCoverage.status).toBe(409);
      const coverageRes = await member.post(`${u3}/checkpoints`, {
        caseAttemptId,
        ordinal: 3,
        kind: "step",
        label: "接口九层覆盖通过",
        status: "recorded",
        payload: {},
        evidence: [{ label: "九层覆盖", path: "output/coverage.json", sha256: sha("coverage") }],
        interfaceCoverage: {
          routeKey: "user-create",
          method: "POST",
          path: "/gateway-admin/v2/apiGateway/manage/group/user/create",
          routeDocumented: true,
          contractVersion: "v2",
          sourceRef: "api/user-create.md",
          executed: true,
          requestValid: true,
          structureAsserted: true,
          businessAsserted: true,
          riskBranch: true,
          cleanupVerified: true,
          result: "passed",
          evidence: [{ label: "九层覆盖", path: "output/coverage.json", sha256: sha("coverage") }]
        }
      });
      expect(coverageRes.status, await coverageRes.clone().text()).toBe(201);
      expect((((await coverageRes.json()) as Json).interfaceCoverage as Json).coverageLevel).toBe(9);
      const detailRes = await owner.get(`${base}/missions/${mission.missionId}`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as Json;
      expect(detail.confirmedOracleCount).toBe(1);
      expect(detail.links).toHaveLength(1);
      expect(detail.envelopes).toHaveLength(2);
    } finally {
      await app.cleanup();
    }
  });
});
