/**
 * 判据 1 的收口：**声称跑过的报告，必须追得到执行开始的那一刻**。
 *
 * 这条断言的意义不是"多一道校验"，而是把两件一直被混为一谈的事分开：
 *   - run 目录里的 `manifest.json` 说明"这次运行存在过"（`create-run` 就写了）；
 *   - `execution/execution-state.json` / 执行锁 说明"执行真的开始了"（执行器写的）。
 * 只有后者能让报告回答"什么时候开始跑的"，也只有它区分得开"跑完了"与"一直在等"。
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;
const hashOf = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("运行痕迹与报告追溯", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let workspace = "";
  const project = "trace_route_owner-sandbox";
  const base = `/api/projects/${project}/agents/qa`;
  const session = "session-trace";
  const runId = "run-trace-1";

  const json = async (res: Response) => (await res.json()) as Json;
  const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code;

  const runDir = () => path.join(workspace, session, "output", "runs", runId);
  const writeRunFile = async (relative: string, content: string) => {
    const file = path.join(runDir(), relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return hashOf(content);
  };

  const designPayload = () => ({
    expectedRevision: 0,
    source: { type: "run", path: "design/test_points.json" },
    points: [{
      id: "TP-001", module: "登录", feature: "验证码锁定", description: "连续 5 次错误后锁定 15 分钟",
      risk: "高", coverageType: ["异常"],
      evidenceRefs: [{ type: "document", documentId: documentId!, revision: 1 }]
    }],
    cases: [{
      caseId: "CASE-001", title: "锁定账号", priority: "P0", type: "异常",
      preconditions: ["账号已注册"], testData: { attempts: 5 }, steps: ["连续输入错误验证码 5 次"],
      expected: "账号锁定 15 分钟", automationFeasible: true, relatedTestPoint: "TP-001",
      evidenceRefs: [{ type: "document", documentId: documentId!, revision: 1 }],
      designContract: { basis: [], assumptions: [], data_checks: [] }
    }]
  });
  let documentId: string | null = null;

  /** 执行器写到一半崩了：发起记录在、锁还在、持锁进程已经没了。 */
  const writeCrashedExecution = async () => {
    const invocationId = randomUUID();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const execution = path.join(runDir(), "execution");
    await fs.mkdir(path.join(execution, "attempts"), { recursive: true });
    // 发起记录比执行开始早：真实顺序就是"先调用命令，执行器才开始写自己的痕迹"
    await fs.writeFile(path.join(execution, "dispatch.json"), JSON.stringify({
      version: 1, run_id: runId, session_id: session, host: "test-host",
      dispatched_at: new Date(Date.parse(startedAt) - 2 * 60 * 1000).toISOString(),
      owner_pid: process.pid, headed: false,
    }));
    await fs.writeFile(path.join(execution, "execution-state.json"), JSON.stringify({
      version: 2, run_id: runId, invocation_id: invocationId, status: "running", phase: "playwright",
      started_at: startedAt, updated_at: new Date().toISOString()
    }));
    const dead = spawnSync(process.execPath, ["-e", ""]);
    await fs.writeFile(path.join(execution, "execution.lock.json"), JSON.stringify({
      version: 1, run_id: runId, invocation_id: invocationId, host: "test-host",
      owner_pid: dead.pid ?? 999999, started_at: startedAt, children: []
    }));
    return startedAt;
  };

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, "trace_route_owner")).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    workspace = path.join(app.root, "qa-trace-route-workspace");
    await fs.mkdir(workspace, { recursive: true });
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(
      ((sessionId: string) => sessionId === session
        ? { projectId: project, agentId: "test_agent", sessionId, workspace: path.join(workspace, session) }
        : undefined) as never
    );
    await writeRunFile("manifest.json", JSON.stringify({ manifest_version: 3, run_id: runId, status: "in_progress" }));
    const document = await owner.post(`${base}/documents`, {
      title: "登录需求", format: "markdown", content: "# 登录\n连续 5 次验证码错误后锁定账号。"
    });
    expect(document.status, await document.clone().text()).toBe(201);
    documentId = ((await document.json()) as Json).document.documentId;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("报告称跑过却没有执行痕迹就拒发；补上痕迹后能追到发起时刻", async () => {
    const designed = await owner.post(`${base}/tasks/${session}/runs/${runId}/design`, designPayload());
    expect(designed.status, await designed.clone().text()).toBe(201);
    const failure = { type: "execution", sessionId: session, runId, evidencePath: "execution/failure.png" };
    const results = await owner.post(`${base}/tasks/${session}/runs/${runId}/results`, {
      expectedRevision: 1, invocationId: "inv-trace",
      results: [{ caseId: "CASE-001", status: "failed", reason: "第 5 次后仍可登录", evidenceRefs: [failure] }]
    });
    expect(results.status, await results.clone().text()).toBe(201);
    const html = await writeRunFile("report/report-task.html", "<html><body>report</body></html>");
    const screenshot = await writeRunFile("execution/failure.png", "png-bytes");
    const request = {
      expectedDesignRevision: 1, htmlPath: "report/report-task.html", htmlSha256: html,
      conclusion: "failed", untested: [],
      evidence: [{ label: "锁定失败截图", ref: failure, path: "execution/failure.png", sha256: screenshot }],
      limitations: ["仅验证锁定场景"]
    };

    const untraced = await owner.post(`${base}/tasks/${session}/runs/${runId}/report-index`, request);
    expect(untraced.status, await untraced.clone().text()).toBe(400);
    expect(await errorCode(untraced)).toBe("report_untraced");

    // 痕迹接口此时如实回答：登记过、目录里有这次运行、执行还没开始
    const before = (await json(await owner.get(`${base}/task-records/${session}/runs/${runId}/trace`))) as Json;
    expect(before).toMatchObject({ registered: true, trace: { present: true, startedAt: null, stalled: false } });
    expect(before.trace.execution).toMatchObject({ attempts: 0, locked: false, state: null });

    const startedAt = await writeCrashedExecution();
    const crashed = (await json(await owner.get(`${base}/task-records/${session}/runs/${runId}/trace`))) as Json;
    expect(crashed.trace.startedAt).toBe(startedAt);
    // 发起事实跟着出来：被调用过（早于执行开始 2 分钟）、归属这个会话
    expect(crashed.trace.dispatch).toMatchObject({
      dispatchedAt: new Date(Date.parse(startedAt) - 2 * 60 * 1000).toISOString(),
      sessionId: session,
    });
    // 锁在、进程不在：不用等 30 分钟阈值，这就是"跑到一半死了"
    expect(crashed.trace.execution).toMatchObject({ locked: true, pidStatus: "dead", orphaned: true });
    expect(crashed.trace.stalled).toBe(true);
    expect(crashed.trace.stalledReason).toContain("持锁进程已退出");

    const published = await owner.post(`${base}/tasks/${session}/runs/${runId}/report-index`, request);
    expect(published.status, await published.clone().text()).toBe(201);
    // 发起行现在带的是执行器写下的时刻，不是"平台第一次看见这次运行"的时间
    const run = (await json(await owner.get(`${base}/task-records/${session}/runs/${runId}`))) as Json;
    expect(run.run.startedAt).toBe(startedAt);
  });
});
