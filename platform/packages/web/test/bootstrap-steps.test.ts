// @vitest-environment jsdom
/**
 * 建档五步的展示：所有字都来自服务端上报，前端不补时间也不补进度。
 *
 * 钉住三件容易退化的行为：
 * - 没跑过的步骤写「等待」，不写「已完成」；
 * - 失败步骤显示程序原文的 detail，不是一句「出错了」；
 * - 进度条宽度只由已落定步数决定（5 步里 2 步落定 = 40%，不看耗时）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll } from "./helpers/dom";
import { StepBar, StepRows, stepProgress } from "../src/features/qa/project-management/bootstrap-steps";
import type { BootstrapStep } from "../src/features/qa/project-management/types";

afterEach(async () => { await unmountAll(); });

function step(index: number, name: string, status: BootstrapStep["status"], extra: Partial<BootstrapStep> = {}): BootstrapStep {
  return { index, name, status, ms: null, detail: null, facts: {}, ...extra };
}

describe("bootstrap steps", () => {
  it("shows 等待 for steps that were never reported, never 已完成", async () => {
    const steps = [
      step(1, "可达性探测", "done", { ms: 2400, detail: "HTTP 200" }),
      step(2, "抓取前端骨架", "running"),
      step(3, "提取路由", "idle"),
      step(4, "探测登录与接口", "idle"),
      step(5, "生成环境档案", "idle"),
    ];
    const { container: root } = await mount(h(StepRows, { steps }));
    const rows = [...root.querySelectorAll(".qpm-step")];
    expect(rows).toHaveLength(5);
    const metas = rows.map((row) => row.querySelector(".qpm-step-meta")?.textContent);
    expect(metas).toEqual(["已完成 · 2.4s", "进行中…", "等待", "等待", "等待"]);
    // 第 3 步没上报过任何结论：显示"这步在做什么"，而不是空白或 0。
    expect(rows[2]?.querySelector(".qpm-step-body")?.textContent).toContain("从 4 类来源提路由");
  });

  it("prints the program's own failure text instead of a generic error", async () => {
    const steps = [
      step(1, "可达性探测", "failed", { ms: 8400, detail: "ConnectionError: 连接被拒绝" }),
      step(2, "抓取前端骨架", "idle"),
      step(3, "提取路由", "idle"),
      step(4, "探测登录与接口", "idle"),
      step(5, "生成环境档案", "idle"),
    ];
    const { container: root } = await mount(h(StepRows, { steps }));
    const first = root.querySelectorAll(".qpm-step")[0];
    expect(first?.className).toContain("is-failed");
    expect(first?.querySelector(".qpm-step-meta")?.textContent).toBe("失败 · 8.4s");
    expect(first?.querySelector(".qpm-step-body")?.textContent).toBe("ConnectionError: 连接被拒绝");
  });

  it("sizes the bar by settled steps, not by elapsed time", async () => {
    const two = [step(1, "a", "done"), step(2, "b", "failed"), step(3, "c", "idle"), step(4, "d", "idle"), step(5, "e", "idle")];
    expect(stepProgress(two)).toEqual({ settled: 2, percent: 40 });
    const { container: root } = await mount(h(StepBar, { steps: two, failed: true }));
    const fill = root.querySelector(".qpm-bar-fill");
    expect(fill?.getAttribute("style")).toContain("width: 40%");
    expect(fill?.className).toContain("is-fail");
  });

  it("reports 0 settled for five untouched steps instead of a fake 20%", async () => {
    const idle = [1, 2, 3, 4, 5].map((index) => step(index, `s${index}`, "idle"));
    expect(stepProgress(idle)).toEqual({ settled: 0, percent: 0 });
  });
});
