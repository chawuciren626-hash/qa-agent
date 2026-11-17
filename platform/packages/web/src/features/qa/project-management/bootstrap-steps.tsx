/**
 * 建档五步的展示件（抽屉与环境页共用一份，避免两处文案/配色漂移）。
 *
 * 只负责"把服务端给的五步画出来"：没有任何按时间推进的逻辑——每个字都来自
 * Python `@@step` 的真实上报，前端不替程序补进度。
 */
import type { BootstrapStep } from "./types";

/** 五步的固定说明（与 Python 的 STEP_NAMES 对应；文案只解释"这步在做什么"）。 */
export const STEP_HINTS: Record<number, string> = {
  1: "DNS → TCP → HTTP 三次探测，确认站点活着、字符集能解。",
  2: "首页 + 最多 12 个 JS bundle（单文件 2MB、总量 8MB 硬上限）。",
  3: "从 4 类来源提路由，并把 /order/123 归一化为 /order/:id。",
  4: "找密码框与相邻字段、识别验证码形态、探 OpenAPI、扫危险文案。",
  5: "写 maps/<env>/ 下的 pages、apis、login 与建档报告。",
};

const DOT: Record<BootstrapStep["status"], string> = {
  idle: "",
  running: "",
  done: "✓",
  failed: "✕",
};

export function msText(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 已落定步数 / 百分比（"完成"与"走到一半失败"都算落定，进度条不会停在中间骗人）。 */
export function stepProgress(steps: BootstrapStep[]): { settled: number; percent: number } {
  const settled = steps.filter((step) => step.status === "done" || step.status === "failed").length;
  return { settled, percent: steps.length === 0 ? 0 : Math.round((settled / steps.length) * 100) };
}

/** 进度条：宽度只跟随已落定步数，不做按时间的补间。 */
export function StepBar({ steps, failed }: { steps: BootstrapStep[]; failed?: boolean }) {
  const { percent } = stepProgress(steps);
  return (
    <div className="qpm-bar" aria-hidden="true">
      <span className={`qpm-bar-fill${failed ? " is-fail" : ""}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** 单步一行：左侧圆点（数字/✓/✕），右侧名称 + 状态 + 结论。 */
export function StepRow({ step }: { step: BootstrapStep }) {
  const hint = STEP_HINTS[step.index];
  const meta =
    step.status === "running" ? "进行中…"
      : step.status === "done" ? `已完成${step.ms === null ? "" : ` · ${msText(step.ms)}`}`
        : step.status === "failed" ? `失败${step.ms === null ? "" : ` · ${msText(step.ms)}`}`
          : "等待";
  return (
    <li className={`qpm-step is-${step.status}`}>
      <span className="qpm-step-dot" aria-hidden="true">{DOT[step.status] || step.index}</span>
      <div className="qpm-step-main">
        <div className="qpm-step-top">
          <span className="qpm-step-name">{step.name}</span>
          <span className="qpm-step-meta">{meta}</span>
        </div>
        {/* 结论优先：程序报了什么就显示什么；没报就退回这步在做什么的说明。 */}
        <div className="qpm-step-body">{step.detail ?? hint}</div>
      </div>
    </li>
  );
}

export function StepRows({ steps }: { steps: BootstrapStep[] }) {
  return <ol className="qpm-steps">{steps.map((step) => <StepRow key={step.index} step={step} />)}</ol>;
}
