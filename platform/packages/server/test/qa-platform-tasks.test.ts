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
      priority: "high",
    });
    expect(created.status).toBe(201);
    const task = ((await created.json()) as Json).task as Json;
    expect(task).toMatchObject({ source: "local", status: "ready", priority: "high" });
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

    // 本地任务全量编辑
    const local = await owner.post(`${base}/platform-tasks/local`, {
      title: "旧标题",
      description: "",
      priority: "low",
    });
    const localId = ((await local.json()) as Json).task.id as string;
    const re = await owner.post(`${base}/platform-tasks/${localId}/edit`, {
      title: "新标题",
      description: "新描述",
      priority: "high",
    });
    const localUpdated = ((await re.json()) as Json).updated as Json;
    expect(localUpdated).toMatchObject({ title: "新标题", priority: "high" });
  });

  it("TLQ-1 闸：pending_analysis 禁止开始测试；分析完成后放行并创建真实会话", async () => {
    const body = (await (await list()).json()) as Json;
    const pending = body.items.find((i: Json) => i.status === "pending_analysis") as Json;

    const blocked = await owner.post(`${base}/platform-tasks/${pending.id}/start`, {});
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("analysis_required");

    // 分析（T2 重试语义）：pending → ready，summary 回填 demo 来源
    const analyzed = await owner.post(`${base}/platform-tasks/${pending.id}/analyze`, {});
    expect(analyzed.status).toBe(200);
    const after = ((await analyzed.json()) as Json) as Json;
    expect(after.updated.status).toBe("ready");
    expect(after.summary.source).toBe("demo");

    // 创建真实测试工作会话（依赖注入 mock，不真启智能体）
    const spySession = vi
      .spyOn(app.deps.sessionService, "createSession")
      .mockResolvedValue({ sessionId: "session-pt-1" } as never);
    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([
      { agentId: "default_agent" },
    ] as never);

    const started = await owner.post(`${base}/platform-tasks/${pending.id}/start`, {});
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as Json;
    expect(startBody).toMatchObject({ sessionId: "session-pt-1", previousStatus: "ready" });
    expect(startBody.task.status).toBe("in_progress");
    expect(startBody.task.mainSessionId).toBe("session-pt-1");
    expect(spySession).toHaveBeenCalledTimes(1);

    // 详情测试进展段带出会话绑定
    const d = (await (await detail(pending.id)).json()) as Json;
    expect(d.progress.mainSessionId).toBe("session-pt-1");
    expect(d.progress.runs).toEqual([]);
  });

  it("本地任务不分析即可开始（T5）；AI 分析是可选增强，status 保持 ready", async () => {
    const local = await owner.post(`${base}/platform-tasks/local`, {
      title: "登录页文案核对",
      description: "核对各失败场景的提示文案",
      priority: "low",
    });
    const id = ((await local.json()) as Json).task.id as string;

    vi.spyOn(app.deps.agentService, "listAgents").mockResolvedValue([
      { agentId: "default_agent" },
    ] as never);
    vi.spyOn(app.deps.sessionService, "createSession").mockResolvedValue({
      sessionId: "session-pt-2",
    } as never);

    const started = await owner.post(`${base}/platform-tasks/${id}/start`, {});
    expect(started.status).toBe(200);
    expect(((await started.json()) as Json).task.status).toBe("in_progress");

    // 分析是可选增强：另一个本地任务先分析再开始，summary 基于需求描述生成
    const second = await owner.post(`${base}/platform-tasks/local`, {
      title: "导出明细税号字段",
      description: "导出明细需要新增税号字段并验证格式",
      priority: "medium",
    });
    const id2 = ((await second.json()) as Json).task.id as string;
    const analyzed = await owner.post(`${base}/platform-tasks/${id2}/analyze`, {});
    const body = ((await analyzed.json()) as Json) as Json;
    expect(body.updated.status).toBe("ready");
    expect(body.summary.suggested_priority).toBe("medium");
    expect(body.summary.source).toBe("demo");
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
