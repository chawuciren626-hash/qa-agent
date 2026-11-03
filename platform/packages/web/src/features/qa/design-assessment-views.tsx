/**
 * Read-only review surfaces for design complexity/confidence and report residual risk.
 *
 * The copy follows the handoff contract: complexity and risk are separate, a missing factor is
 * unknown (never low), a citation existing is not the same as its semantics being supported, and
 * "设计可执行" is not "产品测试通过". Nothing here writes results, confirms defects or publishes.
 */
import { useState } from "react";
import {
  assessmentLevelLabel,
  confidenceStatusLabel,
  dimensionStatusLabel,
  factorStatusLabel,
  residualCount,
  residualImpactLabel,
  residualRiskKindLabel,
  type AssessmentLevel,
  type CaseAssessment,
  type CaseDimension,
  type DesignAssessment,
  type PointAssessment,
  type ResidualRiskAssessment,
  type ResidualRiskItem,
} from "./design-assessment-model";
import type { DesignAssessmentData } from "./design-assessment-loader";

function Badge({ children, tone }: { children: React.ReactNode; tone?: "high" | "medium" | "low" | "unknown" }) {
  const color =
    tone === "high"
      ? "border-red-400 text-red-700"
      : tone === "medium"
        ? "border-amber-400 text-amber-700"
        : tone === "low"
          ? "border-emerald-400 text-emerald-700"
          : "border-[var(--border)] opacity-80";
  return <span className={`rounded border px-2 py-0.5 text-xs ${color}`}>{children}</span>;
}

function levelTone(level: AssessmentLevel): "high" | "medium" | "low" | "unknown" {
  return level;
}

function dimensionTone(status: CaseDimension["status"]): "high" | "medium" | "low" | "unknown" {
  if (status === "unsupported") return "high";
  if (status === "pending") return "medium";
  if (status === "supported") return "low";
  return "unknown";
}

function statusTone(status: CaseAssessment["status"]): "high" | "medium" | "low" | "unknown" {
  return status === "needs_revision" ? "high" : status === "pending_clarification" ? "medium" : "low";
}

function ReasonList({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-1 list-disc pl-5 text-xs opacity-80">
      {reasons.map((reason, index) => (
        <li key={`${index}-${reason}`}>{reason}</li>
      ))}
    </ul>
  );
}

function PointRow({ point }: { point: PointAssessment }) {
  return (
    <li className="rounded border border-[var(--border)] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{point.pointId}</strong>
        <span className="text-xs opacity-70">{point.title}</span>
        <Badge tone={levelTone(point.complexity)}>复杂度 {assessmentLevelLabel(point.complexity)}</Badge>
        <Badge tone={point.risk.level === "unknown" ? "unknown" : point.risk.level}>
          风险 {assessmentLevelLabel(point.risk.level)}
        </Badge>
      </div>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        {point.factors.map((factor) => (
          <div key={factor.key} className="rounded border border-[var(--border)] p-2">
            <span className="font-medium">{factor.label}</span> · {factorStatusLabel(factor.status)}
            <span className="block opacity-70">{factor.reason}</span>
            {factor.evidence.length > 0 && <span className="block opacity-60">证据：{factor.evidence.join("、")}</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs">
        <span className="opacity-70">风险判断依据：</span>
        {[
          ["业务影响", point.risk.basis.businessImpact],
          ["变更范围", point.risk.basis.changeScope],
          ["使用频率", point.risk.basis.usageFrequency],
          ["恢复难度", point.risk.basis.recoveryDifficulty],
        ].map(([label, value]) => (
          <span key={label} className="mr-3 whitespace-nowrap">
            {label} {value}
          </span>
        ))}
      </div>
      <ReasonList reasons={point.complexityReasons} />
    </li>
  );
}

function ConfidenceRow({ label, dimension }: { label: string; dimension: CaseDimension }) {
  return (
    <div className="rounded border border-[var(--border)] p-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{label}</span>
        <Badge tone={dimensionTone(dimension.status)}>{dimensionStatusLabel(dimension.status)}</Badge>
      </div>
      <ReasonList reasons={dimension.reasons} />
    </div>
  );
}

function CaseRow({ item }: { item: CaseAssessment }) {
  return (
    <li className="rounded border border-[var(--border)] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{item.caseId}</strong>
        <span className="text-xs opacity-70">{item.title}</span>
        <Badge tone={levelTone(item.complexity)}>执行复杂度 {assessmentLevelLabel(item.complexity)}</Badge>
        <Badge tone={statusTone(item.status)}>{confidenceStatusLabel(item.status)}</Badge>
      </div>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <ConfidenceRow label="预期依据" dimension={item.confidence.expectedBasis} />
        <ConfidenceRow label="设计有效性" dimension={item.confidence.designValidity} />
        <ConfidenceRow label="可执行性" dimension={item.confidence.executability} />
        <ConfidenceRow label="覆盖充分性" dimension={item.confidence.coverageSufficiency} />
      </div>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        {item.factors.map((factor) => (
          <div key={factor.key} className="rounded border border-[var(--border)] p-2">
            <span className="font-medium">{factor.label}</span> · {factorStatusLabel(factor.status)}
            <span className="block opacity-70">{factor.reason}</span>
          </div>
        ))}
      </div>
      {item.executionBlockers.length > 0 && (
        <p className="mt-2 text-xs text-red-700">执行阻断：{item.executionBlockers.join("；")}</p>
      )}
      {item.pendingClarifications.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">待业务澄清：{item.pendingClarifications.join("；")}</p>
      )}
      {item.unknowns.length > 0 && <p className="mt-1 text-xs opacity-70">未知：{item.unknowns.join("；")}</p>}
      <ReasonList reasons={item.complexityReasons.slice(0, 1)} />
    </li>
  );
}

export function DesignAssessmentView({
  assessment,
  data,
}: {
  assessment: DesignAssessment;
  data: DesignAssessmentData;
}) {
  const { summary } = assessment;
  const [pointFocus, setPointFocus] = useState<"all" | "high_risk" | "high_complexity" | "unknown">("all");
  const [caseFocus, setCaseFocus] = useState<"all" | "low_confidence" | "needs_revision" | "pending_clarification" | "high_risk">("all");
  const visiblePoints = assessment.points.filter((point) => {
    if (pointFocus === "high_risk") return point.risk.level === "high";
    if (pointFocus === "high_complexity") return point.complexity === "high";
    if (pointFocus === "unknown") return point.complexity === "unknown" || point.risk.level === "unknown";
    return true;
  });
  const visibleCases = assessment.cases.filter((item) => {
    if (caseFocus === "low_confidence") return item.status !== "executable";
    if (caseFocus === "needs_revision") return item.status === "needs_revision";
    if (caseFocus === "pending_clarification") return item.status === "pending_clarification";
    if (caseFocus === "high_risk") return item.pointRisk === "high" || item.complexity === "high";
    return true;
  });
  return (
    <section className="space-y-3 text-sm" aria-label="设计复杂度与可信度">
      <header>
        <h2 className="text-base font-medium">设计复杂度与可信度（只读）</h2>
        <p className="mt-1 text-xs opacity-70">
          复杂度与风险分开列出；等级由可观察因素决定，缺少事实显示“无法评估”，不按低风险处理。
          “设计可执行”只表示用例设计具备执行条件，不等于产品测试通过。
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge>模式 {data.mode === "task" ? "独立任务" : data.mode === "lifecycle" ? "生命周期" : "未知"}</Badge>
        <Badge>测试点 {summary.points}</Badge>
        <Badge>用例 {summary.cases}</Badge>
        <Badge tone={summary.highComplexityPoints > 0 ? "high" : "unknown"}>高复杂度测试点 {summary.highComplexityPoints}</Badge>
        <Badge tone={summary.highComplexityCases > 0 ? "high" : "unknown"}>高复杂度用例 {summary.highComplexityCases}</Badge>
        <Badge tone={summary.needsRevisionCases > 0 ? "high" : "low"}>需修订 {summary.needsRevisionCases}</Badge>
        <Badge tone={summary.pendingClarificationCases > 0 ? "medium" : "low"}>待业务澄清 {summary.pendingClarificationCases}</Badge>
        <Badge tone="low">设计可执行 {summary.executableCases}</Badge>
      </div>

      {data.warnings.length > 0 && (
        <ul role="note" className="list-disc rounded border border-amber-400 p-2 pl-7 text-xs text-amber-700">
          {data.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <span className="opacity-70">测试点审阅</span>
          <select
            aria-label="测试点审阅筛选"
            className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
            value={pointFocus}
            onChange={(event) => setPointFocus(event.target.value as typeof pointFocus)}
          >
            <option value="all">全部（{assessment.points.length}）</option>
            <option value="high_risk">高风险（{assessment.points.filter((point) => point.risk.level === "high").length}）</option>
            <option value="high_complexity">高复杂度（{assessment.points.filter((point) => point.complexity === "high").length}）</option>
            <option value="unknown">无法评估（{assessment.points.filter((point) => point.complexity === "unknown" || point.risk.level === "unknown").length}）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="opacity-70">用例审阅</span>
          <select
            aria-label="用例审阅筛选"
            className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
            value={caseFocus}
            onChange={(event) => setCaseFocus(event.target.value as typeof caseFocus)}
          >
            <option value="all">全部（{assessment.cases.length}）</option>
            <option value="low_confidence">低可信（{assessment.cases.filter((item) => item.status !== "executable").length}）</option>
            <option value="needs_revision">需修订（{summary.needsRevisionCases}）</option>
            <option value="pending_clarification">待澄清（{summary.pendingClarificationCases}）</option>
            <option value="high_risk">高风险／高复杂度（{assessment.cases.filter((item) => item.pointRisk === "high" || item.complexity === "high").length}）</option>
          </select>
        </label>
      </div>

      <div className="text-xs opacity-70">
        产物：
        {(
          [
            ["测试点", data.artifacts.points],
            ["用例", data.artifacts.cases],
          ] as [string, DesignAssessmentData["artifacts"]["points"]][]
        ).map(([label, value]) => {
          if (!value) return <span key={label}>{label} 未找到；</span>;
          return (
            <span key={label} className="mr-3">
              {label} {value.loaded ? "已读取" : "未读取"}
              {value.verified === true ? "（已校验）" : value.loaded ? "（旧产物/未校验）" : ""}
              {value.reason ? ` · ${value.reason}` : ""}
            </span>
          );
        })}
      </div>

      {assessment.unknowns.length > 0 && (
        <ul className="list-disc pl-5 text-xs opacity-70">
          {assessment.unknowns.map((unknown) => (
            <li key={unknown}>{unknown}</li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="text-sm font-medium">
          测试点复杂度与风险 · {visiblePoints.length} / {assessment.points.length} 项
        </h3>
        {assessment.points.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">没有可评估的测试点。</p>
        ) : visiblePoints.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">当前筛选没有测试点。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {visiblePoints.map((point) => (
              <PointRow key={point.pointId} point={point} />
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">
          用例复杂度与可信度 · {visibleCases.length} / {assessment.cases.length} 条
        </h3>
        {assessment.cases.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">没有可评估的用例。</p>
        ) : visibleCases.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">当前筛选没有用例。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {visibleCases.map((item) => (
              <CaseRow key={item.caseId} item={item} />
            ))}
          </ul>
        )}
      </div>

      {data.sourceStatus.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">来源可读性</h3>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {data.sourceStatus.map((source) => (
              <li key={source.path} className={source.loaded ? "opacity-70" : "text-amber-700"}>
                {source.path}：{source.loaded ? "已读取" : source.reason ?? "未读取"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ResidualItemRow({ item }: { item: ResidualRiskItem }) {
  const tone = item.impact === "blocker" || item.impact === "high" ? "high" : item.impact === "medium" ? "medium" : item.impact === "low" ? "low" : "unknown";
  return (
    <li className="rounded border border-[var(--border)] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{item.title}</strong>
        <Badge tone={tone}>影响 {residualImpactLabel(item.impact)}</Badge>
        <Badge>{residualRiskKindLabel(item.kind)}</Badge>
        <span className="text-xs opacity-70">{item.status}</span>
      </div>
      <p className="mt-1 text-xs opacity-70">来源：{item.source}</p>
      <p className="mt-1 text-xs">建议：{item.action}</p>
      <ReasonList reasons={item.reasons} />
    </li>
  );
}

function ResidualGroup({
  title,
  items,
  empty,
}: {
  title: string;
  items: ResidualRiskItem[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium">
        {title} · {items.length}
      </h3>
      {items.length === 0 ? (
        <p className="mt-1 text-xs opacity-70">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((item) => (
            <ResidualItemRow key={`${item.kind}-${item.id}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResidualRiskView({ assessment }: { assessment: ResidualRiskAssessment }) {
  const headlineTone =
    assessment.headline === "blocked" || assessment.headline === "high"
      ? "high"
      : assessment.headline === "review"
        ? "medium"
        : assessment.headline === "informational"
          ? "low"
          : "unknown";
  const counts: [string, number | null][] = [
    ["测试点", assessment.counts.points],
    ["业务用例", assessment.counts.businessCases],
    ["断言/执行记录", assessment.counts.assertions],
    ["已执行", assessment.counts.executed],
    ["通过", assessment.counts.passed],
    ["失败", assessment.counts.failed],
    ["跳过", assessment.counts.skipped],
    ["阻塞", assessment.counts.blocked],
    ["未测用例", assessment.counts.untestedCases],
    ["未覆盖测试点", assessment.counts.uncoveredPoints],
    ["已确认缺陷", assessment.counts.confirmedDefects],
    ["待核查缺陷", assessment.counts.pendingDefects],
  ];
  return (
    <section className="space-y-3 text-sm" aria-label="剩余风险">
      <header>
        <h2 className="text-base font-medium">剩余风险（只读）</h2>
        <p className="mt-1 text-xs opacity-70">
          风险等级映射自现有质量门，不新增总分。已确认缺陷、待核查现象与未覆盖风险分开列出；
          覆盖不等于通过，没有执行结果不计为通过，缺失事实显示“无法评估”。
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={headlineTone}>总体：{assessment.headlineLabel}</Badge>
        <Badge>已确认缺陷 {residualCount(assessment.counts.confirmedDefects)}</Badge>
        <Badge>待核查现象 {residualCount(assessment.counts.pendingDefects)}</Badge>
        <Badge>未覆盖风险 {assessment.groups.uncoveredRisks.length}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {counts.map(([label, value]) => (
          <div key={label} className="rounded border border-[var(--border)] p-2">
            <dt className="opacity-70">{label}</dt>
            <dd className="text-base font-medium">{residualCount(value)}</dd>
          </div>
        ))}
      </dl>

      {assessment.unknowns.length > 0 && (
        <ul role="note" className="list-disc rounded border border-amber-400 p-2 pl-7 text-xs text-amber-700">
          {assessment.unknowns.map((unknown) => (
            <li key={unknown}>{unknown}</li>
          ))}
        </ul>
      )}

      <ResidualGroup title="已确认缺陷" items={assessment.groups.confirmedDefects} empty="没有已确认或已修复未验证的缺陷。" />
      <ResidualGroup title="待核查现象" items={assessment.groups.pendingPhenomena} empty="没有草稿或待复核现象。" />
      <ResidualGroup title="未覆盖风险" items={assessment.groups.uncoveredRisks} empty="没有识别到未覆盖风险；仍需结合缺失事实判断。" />

      <ul className="list-disc pl-5 text-xs opacity-70">
        {assessment.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}
