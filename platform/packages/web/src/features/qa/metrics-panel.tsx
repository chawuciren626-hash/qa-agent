// A3：项目维度指标面板。所有指标只从已校验的运行记录（run）聚合计算，
// 不做任何推断；缺陷按运行求和，与项目视图缺陷清单同一口径
// （同一缺陷可能跨运行重复，见项目视图顶部说明）。
import { DEFECT_SEVERITY_LABELS, DEFECT_SEVERITY_ORDER, severitySummary } from "./quality-traceability-model";
import "./metrics-panel.css";

export type MetricsRun = { caseCount?: number; executed?: number; passed?: number; failed?: number; defects?: { severity?: string }[] };
export type MetricsTask = { runs: MetricsRun[] };

export function projectMetrics(tasks: MetricsTask[]) {
  const runs = tasks.flatMap(task => task.runs);
  const caseTotal = runs.reduce((sum, run) => sum + (run.caseCount ?? 0), 0);
  const executed = runs.reduce((sum, run) => sum + (run.executed ?? 0), 0);
  const passed = runs.reduce((sum, run) => sum + (run.passed ?? 0), 0);
  const failed = runs.reduce((sum, run) => sum + (run.failed ?? 0), 0);
  const severity = severitySummary(runs.flatMap(run => run.defects ?? []));
  // 高严重度 = 阻断（Blocker）+ 严重（Critical）；unknown/未记录不计入高严重度，但单独展示。
  const highSeverity = severity.levels.Blocker + severity.levels.Critical;
  const passRate = executed > 0 ? Math.round((passed / executed) * 100) : null;
  return { caseTotal, executed, passed, failed, passRate, severity, highSeverity };
}

const distributionText = (severity: ReturnType<typeof severitySummary>) =>
  DEFECT_SEVERITY_ORDER
    .filter(level => level !== "unknown" && severity.levels[level] > 0)
    .map(level => `${DEFECT_SEVERITY_LABELS[level]} ${severity.levels[level]}`)
    .concat([
      severity.unknown > 0 ? `未评估 ${severity.unknown}` : "",
      severity.unrecorded > 0 ? `未记录 ${severity.unrecorded}` : "",
    ].filter(Boolean))
    .join(" · ") || "暂无缺陷";

export function QaMetricsPanel({ tasks }: { tasks: MetricsTask[] }) {
  const metrics = projectMetrics(tasks);
  return <section className="qp-metrics" aria-label="项目指标">
    <div className="qp-metric"><strong>{metrics.caseTotal}</strong><small>用例总数（设计）</small></div>
    <div className="qp-metric"><strong>{metrics.executed}</strong><small>已执行记录（通过 {metrics.passed} · 失败 {metrics.failed}）</small></div>
    <div className="qp-metric"><strong>{metrics.passRate === null ? "—" : `${metrics.passRate}%`}</strong><small>{metrics.passRate === null ? "通过率（暂无执行记录）" : "通过率（按已执行记录）"}</small></div>
    <div className="qp-metric"><strong className={metrics.highSeverity > 0 ? "qp-metric-high-value" : undefined}>{metrics.highSeverity}</strong><small>高严重度缺陷（阻断 + 严重）</small></div>
    <div className="qp-metric qp-metric-wide"><strong>{metrics.severity.total}</strong><small>缺陷总数 · 严重度分布：{distributionText(metrics.severity)}</small></div>
  </section>;
}
