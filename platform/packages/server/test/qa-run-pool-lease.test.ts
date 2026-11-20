/**
 * 资源池租约的**强制执行点**（§6.3）。
 *
 * 在此之前，`qa_pool_leases` 表、`acquirePoolSlot` / `releasePoolSlot` / `poolStatus` 都写好了，
 * 但唯一调用方是测试自己——闸门在，没人过闸。后果不是"少一个功能"：Android 只有 1-2 台、
 * 小程序 1-2 个，两个 run 抢同一台设备会双双出现"偶发失败"，而偶发失败会被判成 flaky
 * （P7 的三分归因刚把 flaky 做成一个正经结论，误判会被放大）。
 *
 * 这里钉住四条语义，少一条这个闸就是假的：
 *   ① 同池第二个 run 拿不到槽位 → 409，不排队、不忙等；
 *   ② 结束后归还，下一个立刻能用（不必等 TTL）；
 *   ③ **不声明池则不受管**——池是物理事实，猜一个（比如默认 web）会把纯 API 的 run 也卡住；
 *   ④ 登记失败（run_id 拼错）也要归还，否则一次手误白占一台设备到 TTL 到期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

type Json = Record<string, any>;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("资源池租约", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let base = "";
  const user = "pool_lease_owner";
  const project = `${user}-sandbox`;
  const session = "session-pool";

  const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code;
  const startRun = (runId: string, pool?: string) =>
    owner.post(`${base}/task-records/${session}/runs`, {
      runId,
      kind: "execution",
      ...(pool ? { resourcePool: pool } : {}),
      dispatch: { plan: `plans/${runId}.yaml` },
    });
  const finishRun = (runId: string) =>
    owner.post(`${base}/task-records/${session}/runs/${runId}/finish`, {
      facts: { runId, status: "passed" },
      manifestPath: `${session}/output/runs/${runId}/manifest.json`,
      manifestSha256: `sha256:${"a".repeat(64)}`,
      counts: { passed: 1 },
    });

  beforeEach(async () => {
    app = await createTestApp();
    owner = apiClient(app.app, (await provisionUser(app.app, user)).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    base = `/api/projects/${project}/agents/qa`;
    vi.spyOn(app.deps.sessionsRepo, "findById").mockImplementation(
      ((sessionId: string) => sessionId === session
        ? { projectId: project, agentId: "test_agent", sessionId, workspace: `${app.root}/pool-ws` }
        : undefined) as never,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.cleanup();
  });

  it("同池第二个 run 被拒，结束后归还，第三个能起来", async () => {
    const first = await startRun("run-p1", "web");
    expect(first.status, await first.clone().text()).toBe(201);
    expect(((await first.json()) as Json).lease).toMatchObject({ slot: 0 });

    const blocked = await startRun("run-p2", "web");
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as Json;
    expect(blockedBody.error?.code).toBe("pool_full");
    // 报出是谁占着、什么时候到期，否则用户只知道"跑不了"
    expect(blockedBody.error?.message).toContain("run-p1");

    // 未声明池的 run 不受管：池是物理事实，不能靠猜
    expect((await startRun("run-api-1")).status).toBe(201);

    expect((await finishRun("run-p1")).status).toBe(200);
    expect((await startRun("run-p3", "web")).status).toBe(201);
  });

  it("登记失败（run_id 重复）要把槽位还回去", async () => {
    expect((await startRun("run-dup", "web")).status).toBe(201);

    const duplicate = await startRun("run-dup", "web");
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("run_exists");

    // 关键：上面那次 409 先占了槽位、登记失败后又还回来了，紧接着的 run 必须能起来。
    // 不还的话，一次手误就要等 TTL 到期才能再跑，而人只会看到"资源池满了"却不知道原因。
    expect((await startRun("run-next", "web")).status).toBe(201);
  });

  it("acquire 顺手清掉过期租约残行（含容量缩小后 slot 超界的那些，G6 最小实体）", async () => {
    const { QaTaskRunRegistry } = await import("../src/services/qa-task-run-registry.js");
    const registry = new (QaTaskRunRegistry as unknown as new (db: unknown) => {
      acquirePoolSlot(input: { projectId: string; pool: string; runId: string; capacity?: number }): { slot: number } | null;
    })(app.deps.db);

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const seed = app.deps.db.prepare("INSERT INTO qa_pool_leases(pool, slot, project_id, holder_run_id, lease_until, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
    seed.run("web", 0, "other-project", "run-old-alive", future, past, past);   // 有效租约：不能动
    seed.run("web", 5, "other-project", "run-expired-tail", past, past, past);  // 过期 + 超出当前容量：清掉

    const acquired = registry.acquirePoolSlot({ projectId: project, pool: "web", runId: "run-g6", capacity: 2 });
    expect(acquired).not.toBeNull();

    const rows = app.deps.db.prepare("SELECT slot, holder_run_id FROM qa_pool_leases WHERE pool='web' ORDER BY slot").all() as { slot: number; holder_run_id: string }[];
    // 有效租约保留；超容量槽的过期残行已被清理，不会永远留在表里。
    expect(rows.some(row => row.holder_run_id === "run-old-alive")).toBe(true);
    expect(rows.some(row => row.holder_run_id === "run-expired-tail")).toBe(false);
  });
});
