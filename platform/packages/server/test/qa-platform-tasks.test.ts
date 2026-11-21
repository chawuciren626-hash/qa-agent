/**
 * 平台任务列表（TL-1/TL-3 切片）：演示种子、来源双轨、T4 编辑边界、TLQ-1 开始测试闸、
 * T2 分析触发语义、T5 本地任务可选分析、终止封存。
 *
 * 口径钉住六条，少一条这个模块就是摆设：
 *   ① 首次列表触发演示种子（source_system='demo'），重复请求不重复种；
 *   ② 本地任务与平台任务在同一列表视图共存，来源徽章由 source 字段承载；
 *   ③ 平台任务编辑只动补充字段（local_title_note / local_test_focus_note），包快照不可变；
 *   ④ TLQ-1：pending_analysis 的平台任务开始测试被拒（409 analysis_required），分析完成后放行；
 *   ⑤ 本地任务开始测试不强制分析（T5），AI 分析是可选增强；
 *   ⑥ 状态变更全部落 last_action_json 审计。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("平台任务列表", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let base = "";
  const user = "ptask_owner";
  const project = `${user}-sandbox`;

  const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code;
  const list = () => owner.get(`${base}/platform-tasks`);
  const detail = (id: string) => owner.get(`${base}/platform-tasks/${id}`);

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, user)).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    base = `/api/projects/${project}/agents/qa`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("首次列表触发演示种子，重复请求不重复种；counts 与条目状态齐全", async () => {
    const first = await list();
    expect(first.status).toBe(200);
    const body = (await first.json()) as Json;
    expect(body.demoSeeded).toBe(true);
    expect(body.items).toHaveLength(5);
    expect(body.counts).toMatchObject({
      pending_analysis: 1,
      ready: 1,
      in_progress: 1,
      impact_pending: 1,
      result_returned: 1,
    });
    // 排序：状态分组优先（pending_analysis 最前），同级内 updated_at 降序
    expect(body.items[0].status).toBe("pending_analysis");

    const second = await list();
    expect(((await second.json()) as Json).demoSeeded).toBe(false);
  });

  it("本地任务与平台任务共存于同一列表视图，来源由 source 承载（T5）", async () => {
    const created = await owner.post(`${base}/platform-tasks/local`, {
      title: "导入模板边界值回归",
      description: "批量导入模板的表头校验与边界值需要回归确认。",
    });
    expect(created.status).toBe(201);
    const task = ((await created.json()) as Json).task as Json;
    expect(task).toMatchObject({ source: "local", status: "ready" });
    expect(task.id).toMatch(/^qlt-/);
    // 本地任务没有平台字段
    expect(task.packageVersion).toBeNull();
    expect(task.sourceUrl).toBe("");

    const body = (await (await list()).json()) as Json;
    const mine = body.items.find((i: Json) => i.id === task.id) as Json;
    expect(mine).toBeTruthy();
    expect(mine.taskNo).toBe(task.id);
    // 创建即开始测试的候选（T5：无 TLQ-1 前置）
    expect(body.counts.ready).toBe(2);
  });

  it("平台任务编辑只动补充字段，本地任务编辑是全量字段（T4）", async () => {
    const body = (await (await list()).json()) as Json;
    const platform = body.items.find((i: Json) => i.source === "platform") as Json;

    const edited = await owner.post(`${base}/platform-tasks/${platform.id}/edit`, {
      localTitleNote: "v3 新增批量导入开关，重点核对",
      localTestFocusNote: "登录态多标签页同步行为必须覆盖",
    });
    expect(edited.status).toBe(200);
    const updated = ((await edited.json()) as Json).updated as Json;
    expect(updated.edited).toBe(true);

    const d = (await (await detail(platform.id)).json()) as Json;
    expect(d.task.localTitleNote).toContain("批量导入开关");
    expect(d.task.localTestFocusNote).toContain("多标签页");

    // 本地任务全量编辑（优先级不再由表单收集，保持 DB 默认）
    const local = await owner.post(`${base}/platform-tasks/local`, {
      title: "旧标题",
      description: "",
    });
    const localId = ((await local.json()) as Json).task.id as string;
    const re = await owner.post(`${base}/platform-tasks/${localId}/edit`, {
      title: "新标题",
      description: "新描述",
    });
    const localUpdated = ((await re.json()) as Json).updated as Json;
    expect(localUpdated).toMatchObject({ title: "新标题", priority: "medium" });
  });

  it("TLQ-1 闸：pending_analysis 禁止开始测试；预分析回写完成后放行并原地升级会话", async () => {
    const body = (await (await list()).json()) as Json;
    const pending = body.items.find((i: Json) => i.status === "pending_analysis") as Json;

    const blocked = await owner.post(`${base}/platform-tasks/${pending.id}/start`, {});
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("analysis_required");

    // 分析（T2 总控预分析）：登记 running 并发简报即返回，结论走 analysis-result 回写
    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([
      { agentId: "test_agent" },
    ] as never);
    const spySession = vi
      .spyOn(app.deps.sessionService, "createSession")
      .mockResolvedValue({ sessionId: "session-pt-1" } as never);
    // 会话查证同步 mock：开始测试"原地升级"判断按 projectId 命中
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(((sessionId: string) =>
      sessionId === "session-pt-1" ? { sessionId, projectId: project } : null) as never);
    vi.spyOn(app.deps.manager, "startTask").mockResolvedValue({ sessionId: "session-pt-1", queued: false } as never);

    const analyzed = await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});
    expect(analyzed.status).toBe(200);
    const after = ((await analyzed.json()) as Json) as Json;
    expect(after.analysisState).toBe("running");
    expect(after.sessionId).toBe("session-pt-1");
    expect(after.summary).toBeNull();

    // 回写前的开始测试仍被挡（running ≠ 分析完成）
    const blockedWhileRunning = await owner.post(`${base}/platform-tasks/${pending.id}/start`, {});
    expect(blockedWhileRunning.status).toBe(409);

    const written = await owner.post(`${base}/platform-tasks/${pending.id}/analysis-result`, {
      session_id: "session-pt-1",
      summary: {
        requirement_points: ["登录优化涉及验证码与记住密码两条链路"],
        suggested_test_scope: ["验证码错误重试", "记住密码跨会话"],
        suggested_priority: "high",
        priority_reason: "登录是核心入口",
        risks: [],
        open_questions: [],
      },
    });
    expect(written.status).toBe(200);
    const writeBody = ((await written.json()) as Json) as Json;
    expect(writeBody.summary.source).toBe("requirement_analysis");
    expect(writeBody.updated.status).toBe("ready");

    // 重复回写被拒（非 running）
    const replay = await owner.post(`${base}/platform-tasks/${pending.id}/analysis-result`, { summary: { requirement_points: ["x"] } });
    expect(replay.status).toBe(409);

    // 开始测试：分析会话原地升级（不新建会话），开工指令经 manager.startTask 注入
    const started = await owner.post(`${base}/platform-tasks/${pending.id}/start`, {});
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as Json;
    expect(startBody).toMatchObject({ sessionId: "session-pt-1", previousStatus: "ready" });
    expect(startBody.task.status).toBe("in_progress");
    expect(startBody.task.mainSessionId).toBe("session-pt-1");
    // 分析会话原地升级：createSession 只在预分析时调用过 1 次，start 不再新建
    expect(spySession).toHaveBeenCalledTimes(1);

    // 详情测试进展段带出会话绑定
    const d = (await (await detail(pending.id)).json()) as Json;
    expect(d.progress.mainSessionId).toBe("session-pt-1");
    expect(d.progress.runs).toEqual([]);
  });

  it("预分析进行中重复触发被拒；会话空闲未回写时自动调和为 failed 并可重试", async () => {
    const body = (await (await list()).json()) as Json;
    const pending = body.items.find((i: Json) => i.status === "pending_analysis") as Json;
    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([{ agentId: "test_agent" }] as never);
    vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({ sessionId: "session-pt-9" } as never);
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(((id: string) =>
      id === "session-pt-9" ? { sessionId: id, projectId: project } : null) as never);
    vi.spyOn(app.deps.manager, "startTask").mockResolvedValue({ sessionId: "session-pt-9", queued: false } as never);

    await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});

    // 会话仍在执行（running）：重复 analyze 409 analysis_in_progress
    vi.spyOn(app.deps.manager, "statusOf").mockReturnValue("running");
    const busy = await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});
    expect(busy.status).toBe(409);
    expect(await errorCode(busy)).toBe("analysis_in_progress");

    // 会话已空闲但没等到回写：调和为 failed 放行重试；本次重新派发回 running（同会话续跑）
    vi.spyOn(app.deps.manager, "statusOf").mockReturnValue("idle");
    const retried = await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});
    expect(retried.status).toBe(200);
    expect((((await retried.json()) as Json) as Json).analysisState).toBe("running");
    const d = (await (await detail(pending.id)).json()) as Json;
    expect(d.task.analysisState).toBe("running");
    expect(d.task.analysisSessionId).toBe("session-pt-9");
  });

  it("简报发送失败：analysis_state 落 failed 并返回 409，可重试", async () => {
    const body = (await (await list()).json()) as Json;
    const pending = body.items.find((i: Json) => i.status === "pending_analysis") as Json;
    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([{ agentId: "test_agent" }] as never);
    vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({ sessionId: "session-pt-10" } as never);
    vi.spyOn(app.deps.manager, "startTask").mockRejectedValue(new Error("runtime gone"));

    const failed = await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});
    expect(failed.status).toBe(409);
    expect(await errorCode(failed)).toBe("analysis_dispatch_failed");
    const d = (await (await detail(pending.id)).json()) as Json;
    expect(d.task.analysisState).toBe("failed");
    expect(d.task.analysisError).toContain("runtime gone");
    expect(d.task.analysisSessionId).toBe("session-pt-10");
  });

  it("本地任务不分析即可开始（T5）；开始测试创建新会话并注入开工指令", async () => {
    const local = await owner.post(`${base}/platform-tasks/local`, {
      title: "登录页文案核对",
      description: "核对各失败场景的提示文案",
    });
    const id = ((await local.json()) as Json).task.id as string;

    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([
      { agentId: "test_agent" },
    ] as never);
    const spySession = vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({
      sessionId: "session-pt-2",
    } as never);
    const spyDispatch = vi.spyOn(app.deps.manager, "startTask").mockResolvedValue({
      sessionId: "session-pt-2",
      queued: false,
    } as never);

    const started = await owner.post(`${base}/platform-tasks/${id}/start`, {});
    expect(started.status).toBe(200);
    expect(((await started.json()) as Json).task.status).toBe("in_progress");
    expect(spySession).toHaveBeenCalledTimes(1);
    expect(spyDispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spyDispatch.mock.calls[0]?.[1])).toContain("登录页文案核对");
  });

  it("AI 分析（同步模型通道）：合法 JSON 以 requirement_analysis 落库；答非所问回退 demo 并带 degraded", async () => {
    const { QaPlatformTaskService } = await import("../src/services/qa-platform-task-service.js");
    const created = await owner.post(`${base}/platform-tasks/local`, {
      title: "订单导出边界回归",
      description: "导出大文件的分页边界与字段完整性需要回归。",
      envBaseUrl: "http://portal.example.com",
      account: "qa_user",
    });
    const id = ((await created.json()) as Json).task.id as string;

    // 同步模型通道只在 runtime 未注入时走（service 直连）；HTTP 层恒走总控预分析
    const svc = new QaPlatformTaskService(app.deps.db as never, {
      completeOnce: async (_projectId, prompt, opts) => {
        expect(opts?.maxTokens).toBe(2000);
        expect(prompt).toContain("订单导出边界回归");
        expect(prompt).toContain("http://portal.example.com");
        expect(prompt).toContain("qa_user");
        return {
          ok: true,
          text: [
            "```json",
            JSON.stringify({
              requirement_points: ["大文件导出分页边界", "导出字段完整性"],
              suggested_test_scope: ["分页参数边界值", "字段缺失校验"],
              suggested_priority: "high",
              priority_reason: "核心导出链路，边界易碎",
              risks: ["导出超时"],
              open_questions: ["最大行数上限"],
            }),
            "```",
          ].join("\n"),
        };
      },
    });
    const good = await svc.analyze({ projectId: project, userId: user, id });
    expect(good.summary?.source).toBe("requirement_analysis");
    expect(good.summary?.suggested_priority).toBe("high");
    expect(good.summary?.requirement_points).toHaveLength(2);
    expect(good.degraded).toBeUndefined();
    const afterGood = (await (await detail(id)).json()) as Json;
    expect(afterGood.summary.source).toBe("requirement_analysis");
    expect(afterGood.summary.priority_reason).toContain("边界易碎");

    // 模型答非所问：回退 demo，degraded 带原因
    const svcJunk = new QaPlatformTaskService(app.deps.db as never, {
      completeOnce: async () => ({ ok: true, text: "我很乐意帮忙，但今天心情不好。" }),
    });
    const junk = await svcJunk.analyze({ projectId: project, userId: user, id });
    expect(junk.summary?.source).toBe("demo");
    expect(junk.degraded?.reason).toContain("JSON");

    // 模型调用失败：同样回退，原因透传
    const svcFail = new QaPlatformTaskService(app.deps.db as never, {
      completeOnce: async () => ({ ok: false, cause: "failed", error: "boom" }),
    });
    const failed = await svcFail.analyze({ projectId: project, userId: user, id });
    expect(failed.summary?.source).toBe("demo");
    expect(failed.degraded?.reason).toContain("boom");
  });

  it("测试环境URL选填：保存即匹配/登记项目环境，详情带回环境与账号", async () => {
    // 不带 URL：两列为 null，不登记环境
    const bare = await owner.post(`${base}/platform-tasks/local`, {
      title: "无环境任务",
      description: "没填环境 URL",
    });
    const bareId = ((await bare.json()) as Json).task.id as string;
    const bareDetail = (await (await detail(bareId)).json()) as Json;
    expect(bareDetail.task.envName).toBeNull();
    expect(bareDetail.task.envBaseUrl).toBeNull();

    // 带 URL：首次未命中 → 从 hostname 派生 env 名并登记（项目首个环境自动设默认，路径保留）
    const envUrl = "http://gateway-portal.example.com";
    const created = await owner.post(`${base}/platform-tasks/local`, {
      title: "带环境任务",
      description: "填了环境 URL 与登录账号",
      envBaseUrl: `${envUrl}/login`,
      account: "tester01",
    });
    expect(created.status).toBe(201);
    const task = ((await created.json()) as Json).task as Json;
    const taskDetail = (await (await detail(task.id)).json()) as Json;
    expect(taskDetail.task.envBaseUrl).toBe(`${envUrl}/login`);
    expect(taskDetail.task.account).toBe("tester01");
    const envName = taskDetail.task.envName as string;
    expect(envName).toBe("gateway-portal-example-com");

    const rows = app.deps.db
      .prepare(`SELECT env, base_url, is_default FROM project_environments WHERE project_id = ?`)
      .all(project) as Array<{ env: string; base_url: string; is_default: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ env: envName, base_url: `${envUrl}/login`, is_default: 1 });

    // 同主机不同路径再建任务：复用既有环境（不覆盖已登记地址、不重复登记）
    const again = await owner.post(`${base}/platform-tasks/local`, {
      title: "同环境第二任务",
      description: "主机相同，入口路径不同",
      envBaseUrl: `${envUrl}/other-path`,
    });
    const againDetail = (await (await detail(((await again.json()) as Json).task.id)).json()) as Json;
    expect(againDetail.task.envName).toBe(envName);
    expect(againDetail.task.envBaseUrl).toBe(`${envUrl}/other-path`);
    const rowsAfter = app.deps.db
      .prepare(`SELECT base_url FROM project_environments WHERE project_id = ? AND env = ?`)
      .get(project, envName) as { base_url: string };
    expect(rowsAfter.base_url).toBe(`${envUrl}/login`);
    const envCount = app.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM project_environments WHERE project_id = ?`)
      .get(project) as { n: number };
    expect(envCount.n).toBe(1);

    // 非法 URL 直接 400，不带病入库
    const bad = await owner.post(`${base}/platform-tasks/local`, {
      title: "坏环境任务",
      description: "URL 不合法",
      envBaseUrl: "ftp://not-http.example.com",
    });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("invalid_environment_url");
  });

  it("开始测试把任务环境绑进会话任务档案（qa_tasks.env）", async () => {
    const created = await owner.post(`${base}/platform-tasks/local`, {
      title: "环境绑定验证任务",
      description: "开始测试后 run 应能拿到被测地址",
      envBaseUrl: "http://bound-env.example.com",
    });
    const id = ((await created.json()) as Json).task.id as string;
    const envName = ((await (await detail(id)).json()) as Json).task.envName as string;

    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([
      { agentId: "test_agent" },
    ] as never);
    vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({
      sessionId: "session-pt-3",
    } as never);
    vi.spyOn(app.deps.manager, "startTask").mockResolvedValue({
      sessionId: "session-pt-3",
      queued: false,
    } as never);

    const started = await owner.post(`${base}/platform-tasks/${id}/start`, {});
    expect(started.status).toBe(200);
    const row = app.deps.db
      .prepare(`SELECT env, title, status FROM qa_tasks WHERE project_id = ? AND session_id = ?`)
      .get(project, "session-pt-3") as { env: string; title: string; status: string };
    expect(row).toMatchObject({ env: envName, title: "环境绑定验证任务", status: "active" });

    // 不带环境的本地任务：开始测试不建档（与改造前一致，环境由会话内后续补选）
    const bare = await owner.post(`${base}/platform-tasks/local`, {
      title: "无环境开始",
      description: "没填 URL",
    });
    const bareId = ((await bare.json()) as Json).task.id as string;
    vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({
      sessionId: "session-pt-4",
    } as never);
    await owner.post(`${base}/platform-tasks/${bareId}/start`, {});
    const bareRow = app.deps.db
      .prepare(`SELECT env FROM qa_tasks WHERE project_id = ? AND session_id = ?`)
      .get(project, "session-pt-4") as { env: string } | undefined;
    expect(bareRow).toBeUndefined();
  });

  it("终止封存：terminated 默认隐藏，includeTerminated 才可见；审计落 last_action_json", async () => {
    const body = (await (await list()).json()) as Json;
    const ready = body.items.find((i: Json) => i.status === "ready") as Json;

    const done = await owner.post(`${base}/platform-tasks/${ready.id}/terminate`, {
      reason: "等下一版本一并处理",
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as Json).updated.status).toBe("terminated");

    const hidden = (await (await list()).json()) as Json;
    expect(hidden.items.find((i: Json) => i.id === ready.id)).toBeUndefined();
    expect(hidden.counts.terminated).toBe(1);

    const shown = (await (
      await owner.get(`${base}/platform-tasks?includeTerminated=true`)
    ).json()) as Json;
    expect(shown.items.find((i: Json) => i.id === ready.id)).toBeTruthy();

    const audit = app.deps.db
      .prepare(`SELECT last_action_json FROM platform_task_links WHERE link_id = ?`)
      .get(ready.id) as { last_action_json: string };
    const action = JSON.parse(audit.last_action_json) as Json;
    expect(action).toMatchObject({ action: "terminate", user_id: user, reason: "等下一版本一并处理" });
  });
});
