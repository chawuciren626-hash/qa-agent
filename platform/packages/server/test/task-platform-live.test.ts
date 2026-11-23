/**
 * 任务平台对接实弹验证（live smoke）——用真实 client 代码打真实任务平台。
 *
 * 与 qa-shared-project-defaults.test.ts 同款惯例：环境变量不齐则整组 skip，
 * 不进常规 CI。跑法：
 *   TASK_PLATFORM_BASE_URL=http://192.168.60.132:8000 \
 *   TASK_PLATFORM_API_KEY=<key> \
 *   vitest run test/task-platform-live.test.ts
 *
 * 覆盖：认证 / 产品线目录 / 事件游标 / 交接包校验 / 附件下载哈希 / 结果回传幂等。
 * 结果回传使用固定 result_id（aitest-live-smoke），任务平台幂等保证重复执行安全。
 */
import fs from "node:fs";
import { expect, it } from "vitest";

import {
  buildIdempotencyKey,
  looksLikeValidHandoffPackage,
  type HandoffEventDto,
  type HandoffPackage,
  type ProductLineDto,
  type TestResultPayload,
} from "../src/integrations/task-platform/contracts.js";
import {
  TaskPlatformClient,
  TaskPlatformApiError,
} from "../src/integrations/task-platform/client.js";

const BASE_URL = process.env.TASK_PLATFORM_BASE_URL ?? "";
const API_KEY = process.env.TASK_PLATFORM_API_KEY ?? "";
const hasTarget = BASE_URL !== "" && API_KEY !== "";

function makeClient(): TaskPlatformClient {
  return new TaskPlatformClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    maxAttempts: 1, // 实弹验证不做内部重试，失败即如实暴露
  });
}

/** 平台侧真实任务号（从事件流取第一个 initial_handoff）。 */
let cachedEvent: HandoffEventDto | null = null;
let cachedPackage: HandoffPackage | null = null;

it.skipIf(!hasTarget)("live: 认证失败凭据返回 401", async () => {
  const bad = new TaskPlatformClient({ baseUrl: BASE_URL, apiKey: "wrong-key", maxAttempts: 1 });
  try {
    await bad.fetchProductLines({ limit: 1 });
    throw new Error("期望 401，但请求成功了");
  } catch (error) {
    if (error instanceof TaskPlatformApiError) {
      expect(error.status).toBe(401);
      expect(error.retryable).toBe(false);
    } else {
      throw error;
    }
  }
});

it.skipIf(!hasTarget)("live: 产品线目录返回真实数据", async () => {
  const page = await makeClient().fetchProductLines({ limit: 5 });
  expect(page.items.length).toBeGreaterThan(0);
  const first: ProductLineDto = page.items[0]!;
  expect(first.product_line_id).toBeTruthy();
  expect(first.line_code).toBeTruthy();
  expect(Array.isArray(first.sections)).toBe(true);
});

it.skipIf(!hasTarget)("live: 事件游标可拉取（允许为空但有结构）", async () => {
  const page = await makeClient().fetchHandoffEvents({ limit: 10 });
  expect(Array.isArray(page.items)).toBe(true);
  expect(typeof page.has_more).toBe("boolean");
  if (page.items.length > 0) {
    cachedEvent = page.items[0]!;
    expect(cachedEvent.event_id).toBeTruthy();
    expect(["initial_handoff", "material_changed", "new_pm_round"]).toContain(cachedEvent.event_type);
    expect(cachedEvent.package_version).toBeGreaterThan(0);
  }
});

it.skipIf(!hasTarget)("live: 交接包读取并通过最小完整性校验", async () => {
  // 不依赖上一个用例的执行顺序：独立再拉一次事件
  const page = await makeClient().fetchHandoffEvents({ limit: 10 });
  const event = page.items.find(e => e.event_type === "initial_handoff") ?? page.items[0];
  if (!event) {
    console.warn("[live] 平台暂无交接事件，跳过包校验");
    return;
  }
  cachedEvent = event;
  const pkg = await makeClient().fetchHandoffPackage(event.task_id, event.package_version);
  expect(looksLikeValidHandoffPackage(pkg)).toBe(true);
  expect(pkg.task_no).toBe(event.task_no);
  expect(pkg.content_hash).toMatch(/^sha256:/);
  expect(pkg.product_lines.some(l => l.is_primary)).toBe(true); // D2：主产品线标记
  expect(pkg.flow.pm_round.pm_round_id).toBeTruthy();
  expect(Array.isArray(pkg.attachments)).toBe(true);
  cachedPackage = pkg;
});

it.skipIf(!hasTarget)("live: 附件下载（包内首附件）哈希一致或平台未提供哈希", async () => {
  if (!cachedPackage) {
    const page = await makeClient().fetchHandoffEvents({ limit: 10 });
    const event = page.items[0];
    if (!event) return;
    cachedPackage = await makeClient().fetchHandoffPackage(event.task_id, event.package_version);
  }
  const att = cachedPackage.attachments[0];
  if (!att) {
    console.warn("[live] 包内无附件，跳过下载校验");
    return;
  }
  const bytes = await makeClient().downloadAttachment(cachedPackage.task_id, att.attachment_id);
  expect(bytes.byteLength).toBeGreaterThan(0);
  // 平台侧有哈希时必须一致；无哈希（历史数据）时只验证可下载
  const expected = (att.sha256 ?? "").toLowerCase().replace(/^sha256:/, "");
  if (expected) {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    const actual = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    expect(actual).toBe(expected);
  }
});

it.skipIf(!hasTarget)("live: 结果回传首次 accepted + 重放 duplicate（幂等）", async () => {
  // 事件/包用例未跑时自行取数
  if (!cachedPackage) {
    const page = await makeClient().fetchHandoffEvents({ limit: 10 });
    const event = page.items[0];
    if (!event) {
      console.warn("[live] 平台暂无交接事件，跳过回传验证");
      return;
    }
    cachedEvent = event;
    cachedPackage = await makeClient().fetchHandoffPackage(event.task_id, event.package_version);
  }
  const pkg = cachedPackage!;
  // 幂等语义：同一 result_id 的载荷必须逐字节稳定（created_at=结果生成时间，不随重试变化）
  // created_at 固定（运行内重试载荷稳定）；result_id 按天派生避免撞历史运行
  const now = "2026-11-23T09:00:00+08:00";
  const payload: TestResultPayload = {
    schema_version: "1.0",
    source_system: "sbkj-taskassignment",
    tenant_id: pkg.tenant_id,
    task_id: pkg.task_id,
    pm_round_id: pkg.flow.pm_round.pm_round_id,
    package_version: pkg.package_version,
    package_hash: pkg.content_hash,
    project_id: "aitest-live-smoke",
    test_task_id: "aitest-live-smoke-link",
    session_id: "aitest-live-smoke-session",
    run_id: "aitest-live-smoke-run",
    result_id: `aitest-live-smoke-${new Date().toISOString().slice(0, 10)}`,
    result_version: 1,
    execution_status: "completed",
    test_verdict: "pass",
    started_at: now,
    finished_at: now,
    test_scope: { summary: "AITestHarness 实弹验证（自动）" },
    statistics: { total: 1, passed: 1, failed: 0, blocked: 0, not_executed: 0 },
    issues: [],
    summary: "AITestHarness 实弹验证：链路连通性检查，可在抽测页删除此记录",
    risks: [],
    evidence_index: [],
    created_at: now,
  };
  const client = makeClient();
  const key = buildIdempotencyKey(pkg.tenant_id, pkg.task_id, pkg.flow.pm_round.pm_round_id, payload.result_id);
  const first = await client.submitTestResult(pkg.task_id, payload, key);
  // 首次运行=accepted；脚本重跑时键已存在=duplicate（载荷稳定所以不 409）
  expect(["accepted", "duplicate"]).toContain(first.receive_status);
  const second = await client.submitTestResult(pkg.task_id, payload, key);
  expect(second.receive_status).toBe("duplicate");
});
