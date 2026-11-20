/**
 * 执行痕迹读模型（P4 判据 1 / 判据 4）。
 *
 * 这一层唯一的价值是**说的和真的发生过的一致**，所以测试钉的都是"容易说错"的地方：
 *   1. `stalled` 用最后一次活动判，不用 `started_at` 判——真机长跑 40 分钟是正常的；
 *   2. 锁在、进程不在是"跑到一半死了"的直接证据，不用等阈值；
 *   3. 缺文件、坏 JSON 都不抛——读不到本身就是要报告的事实。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRunTrace } from "../src/services/qa-run-trace.js";

const RUN = "run-trace-1";
const MINUTE = 60 * 1000;

let workspace = "";

const runDir = () => path.join(workspace, "output", "runs", RUN);

function writeFile(relative: string, value: unknown): void {
  const file = path.join(runDir(), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function writeManifest(status = "in_progress"): void {
  writeFile("manifest.json", { manifest_version: 3, run_id: RUN, status, baseline_hash: "a".repeat(64) });
}

function writeState(overrides: Record<string, unknown> = {}): string {
  const invocationId = randomUUID();
  writeFile("execution/execution-state.json", {
    version: 2, run_id: RUN, invocation_id: invocationId, status: "running", phase: "playwright",
    started_at: new Date(Date.now() - 5 * MINUTE).toISOString(),
    updated_at: new Date(Date.now() - MINUTE).toISOString(),
    ...overrides,
  });
  return invocationId;
}

function writeLock(pid: number, startedAt?: string): void {
  writeFile("execution/execution.lock.json", {
    version: 1, run_id: RUN, invocation_id: randomUUID(), host: "test-host", owner_pid: pid,
    started_at: startedAt ?? new Date(Date.now() - 5 * MINUTE).toISOString(), children: [],
  });
}

function writeDispatch(overrides: Record<string, unknown> = {}): void {
  writeFile("execution/dispatch.json", {
    version: 1, run_id: RUN, session_id: "session-2026-11-20-09-00-00-abcdef", host: "test-host",
    dispatched_at: new Date(Date.now() - 10 * MINUTE).toISOString(), owner_pid: process.pid, headed: false,
    ...overrides,
  });
}

/** 一个"已退出"的 pid：进程真的存在过，所以不是靠猜一个大数字来碰运气。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid ?? 999999;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qa-run-trace-"));
  fs.mkdirSync(runDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("readRunTrace", () => {
  it("没有 manifest 就不是一次运行：present=false，不抛", () => {
    expect(readRunTrace(workspace, RUN)).toMatchObject({ present: false, manifest: null, startedAt: null, stalled: false });
    expect(readRunTrace(workspace, "run-does-not-exist")).toMatchObject({ present: false });
    // 非法 run_id 直接当没有：不让路径拼接成为入口
    expect(readRunTrace(workspace, "../etc")).toMatchObject({ present: false });
  });

  it("只有 manifest：发起过但没开始执行，startedAt 为空", () => {
    writeManifest();
    const trace = readRunTrace(workspace, RUN);
    expect(trace).toMatchObject({ present: true, startedAt: null, stalled: false, stalledReason: null });
    expect(trace.manifest).toMatchObject({ status: "in_progress", manifestVersion: 3, baselineHash: "a".repeat(64) });
    expect(trace.manifest?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(trace.execution).toMatchObject({ attempts: 0, locked: false, state: null });
    expect(trace.dispatch).toBeNull();
  });

  it("dispatch 在、执行也在：两份事实都给出，startedAt 取执行开始而不是发起时刻", () => {
    writeManifest();
    writeDispatch();
    writeState();
    const trace = readRunTrace(workspace, RUN);
    expect(trace.dispatch).toMatchObject({
      dispatchedAt: expect.any(String), sessionId: "session-2026-11-20-09-00-00-abcdef",
      host: "test-host", ownerPid: process.pid,
    });
    // dispatch 写在执行开始之前，但 startedAt 是"执行开始"的刻度
    expect(trace.startedAt).not.toBe(trace.dispatch?.dispatchedAt);
    expect(trace.startedAt).not.toBeNull();
  });

  it("只有 dispatch、没有执行痕迹：发起了但执行器从没开始——startedAt 必须为空", () => {
    // 阴性对照：report_untraced 靠 startedAt 拦"报告说跑过、实际没跑"。
    // dispatch 若也能填 startedAt，执行器从没起来的报告就能混过这道闸。
    writeManifest();
    writeDispatch();
    const trace = readRunTrace(workspace, RUN);
    expect(trace.present).toBe(true);
    expect(trace.dispatch).toMatchObject({ dispatchedAt: expect.any(String), host: "test-host" });
    expect(trace.startedAt).toBeNull();
    expect(trace.execution).toMatchObject({ attempts: 0, locked: false, state: null });
    // 执行从未开始，谈不上"中断"
    expect(trace.stalled).toBe(false);
  });

  it("dispatch 坏掉、版本不对、run_id 不符：都按没读到处理，不冒充", () => {
    writeManifest();
    writeFile("execution/dispatch.json", "{坏掉的");
    expect(readRunTrace(workspace, RUN).dispatch).toBeNull();
    writeDispatch({ version: 2 });
    expect(readRunTrace(workspace, RUN).dispatch).toBeNull();
    writeDispatch({ run_id: "run-someone-else" });
    expect(readRunTrace(workspace, RUN).dispatch).toBeNull();
    // 时间字段坏掉：其余事实保留，时间给 null
    writeDispatch({ dispatched_at: "not-a-time" });
    const trace = readRunTrace(workspace, RUN);
    expect(trace.dispatch).toMatchObject({ dispatchedAt: null, host: "test-host" });
  });

  it("执行中且最近有活动：有开始时间，但不算中断", () => {
    writeManifest();
    const invocationId = writeState();
    writeLock(process.pid);
    const trace = readRunTrace(workspace, RUN);
    expect(trace.startedAt).not.toBeNull();
    expect(trace.execution).toMatchObject({
      invocationId, state: "running", phase: "playwright", locked: true, pidStatus: "alive", orphaned: false,
    });
    expect(trace.stalled).toBe(false);
  });

  it("长跑不误报：开始时间是 90 分钟前，但 2 分钟前还在活动", () => {
    const t0 = Date.now();
    writeManifest();
    writeState({ started_at: new Date(t0 - 90 * MINUTE).toISOString(), updated_at: new Date(t0 - 2 * MINUTE).toISOString() });
    const trace = readRunTrace(workspace, RUN, { now: t0 });
    // 用 started_at 判中断会把所有长跑都标成中断，人会因此不再信这个标记
    expect(trace.stalled).toBe(false);
    expect(trace.execution.lastActivityAt).toBe(new Date(t0 - 2 * MINUTE).toISOString());
    expect(trace.startedAt).toBe(new Date(t0 - 90 * MINUTE).toISOString());
  });

  it("未收尾且 31 分钟没有活动：判疑似中断，原因里带分钟数与阈值", () => {
    const t0 = Date.now();
    writeManifest();
    writeState({ updated_at: new Date(t0 - 31 * MINUTE).toISOString() });
    const trace = readRunTrace(workspace, RUN, { now: t0 });
    expect(trace.stalled).toBe(true);
    expect(trace.stalledReason).toContain("31 分钟前");
    expect(trace.stalledReason).toContain("阈值 30 分钟");
    expect(trace.staleAfterMs).toBe(30 * MINUTE);
  });

  it("锁在但持锁进程已退出：不用等阈值就是疑似中断", () => {
    writeManifest();
    writeState({ updated_at: new Date().toISOString() });
    writeLock(deadPid(), new Date(Date.now() - MINUTE).toISOString());
    const trace = readRunTrace(workspace, RUN);
    expect(trace.execution).toMatchObject({ locked: true, pidStatus: "dead", orphaned: true });
    expect(trace.stalled).toBe(true);
    expect(trace.stalledReason).toContain("持锁进程已退出");
  });

  it("正常收尾：锁已删、状态终态，不判中断", () => {
    const t0 = Date.now();
    writeManifest("completed");
    const invocationId = writeState({ status: "completed", phase: "finished", updated_at: new Date(t0 - 40 * MINUTE).toISOString() });
    const startedAt = new Date(t0 - 50 * MINUTE).toISOString();
    writeFile(`execution/attempts/${invocationId}/attempt.json`, {
      version: 1, run_id: RUN, invocation_id: invocationId, status: "completed",
      started_at: startedAt, finished_at: new Date(t0 - 40 * MINUTE).toISOString(), duration_ms: 10 * MINUTE,
    });
    const trace = readRunTrace(workspace, RUN, { now: t0 });
    expect(trace.execution).toMatchObject({ attempts: 1, locked: false, state: "completed" });
    expect(trace.execution.finishedAt).toBe(new Date(t0 - 40 * MINUTE).toISOString());
    // 收尾了就不谈中断，哪怕最后一次活动是 40 分钟前
    expect(trace.stalled).toBe(false);
    expect(trace.stalledReason).toBeNull();
  });

  it("坏 JSON 与非法 pid 都不抛，按未读到来处理", () => {
    writeManifest();
    writeFile("execution/execution-state.json", "{坏掉的 json");
    writeFile("execution/execution.lock.json", JSON.stringify({ owner_pid: "not-a-pid" }));
    const trace = readRunTrace(workspace, RUN);
    expect(trace.present).toBe(true);
    expect(trace.execution.state).toBeNull();
    // lock 解析成功但 pid 不合法：不判 alive/dead，也不冒充 orphaned
    expect(trace.execution.locked).toBe(true);
    expect(trace.execution.pidStatus).toBe("unknown");
    expect(trace.execution.orphaned).toBe(false);
  });

  it("manifest 坏掉：present 退回 false，不把半截解析当事实", () => {
    writeFile("manifest.json", "not json");
    expect(readRunTrace(workspace, RUN)).toMatchObject({ present: false, manifest: null });
  });

  it("多次尝试：attempts 计数，startedAt 取最早、finishedAt 取最晚", () => {
    const t0 = Date.now();
    writeManifest("completed");
    const first = randomUUID();
    const second = randomUUID();
    writeFile(`execution/attempts/${first}/attempt.json`, {
      version: 1, run_id: RUN, invocation_id: first, status: "failed",
      started_at: new Date(t0 - 60 * MINUTE).toISOString(), finished_at: new Date(t0 - 50 * MINUTE).toISOString(),
    });
    writeFile(`execution/attempts/${second}/attempt.json`, {
      version: 1, run_id: RUN, invocation_id: second, status: "completed",
      started_at: new Date(t0 - 40 * MINUTE).toISOString(), finished_at: new Date(t0 - 30 * MINUTE).toISOString(),
    });
    const trace = readRunTrace(workspace, RUN, { now: t0 });
    expect(trace.execution.attempts).toBe(2);
    expect(trace.startedAt).toBe(new Date(t0 - 60 * MINUTE).toISOString());
    expect(trace.execution.finishedAt).toBe(new Date(t0 - 30 * MINUTE).toISOString());
  });
});
