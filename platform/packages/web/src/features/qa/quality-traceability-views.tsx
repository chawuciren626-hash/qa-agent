/**
 * Read-only Q3 surfaces: coverage and risk, defect status, and the report evidence index.
 *
 * These components take already-loaded data. They never derive a pass from a partial run, never
 * confirm a defect, and never publish a report; a missing index says "尚未登记", a stale one
 * says so, and every failure/block/untested line keeps its reason and evidence source.
 */
import {
  conclusionLabel,
  defectCategoryLabel,
  defectStatusLabel,
  isSeverityUnknown,
  percent,
  pointConcern,
  pointStatusLabel,
  qualityGateLabel,
  reportStateLabel,
  resultStatusLabel,
  riskLabel,
  severityDimensionLabel,
  severityDimensionValueLabel,
  severityLabel,
  severitySummary,
  type CaseResultView,
  type CoverageView,
  type DefectDetailView,
  type DefectView,
  type ReportIndexResponse,
} from "./quality-traceability-model";
import { evidenceLine, shortHash, timeLabel } from "./project-knowledge-model";

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--border)] px-2 py-0.5 text-xs opacity-80">
      {children}
    </span>
  );
}

export function CoverageRiskView({
  coverage,
  results = [],
}: {
  coverage: CoverageView;
  results?: CaseResultView[];
}) {
  const byCase = new Map(results.map((result) => [result.caseKey, result]));
  return (
    <section className="qt-coverage space-y-3 text-sm" aria-label="覆盖与风险">
      <header>
        <h2 className="text-base font-medium">覆盖与风险</h2>
        <p className="mt-1 text-xs opacity-70">
          设计修订 {coverage.designRevision}（{coverage.designStatus === "frozen" ? "已冻结" : "编制中"}）·
          覆盖只表示有关联用例，不等于通过；跳过、阻塞和无结果都不计为通过。
        </p>
      </header>

      <div className="qt-gate rounded border border-[var(--border)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong>质量门：{qualityGateLabel(coverage.gate.qualityGate)}</strong>
          <Badge>结论：{conclusionLabel(coverage.gate.conclusion)}</Badge>
          <Badge>{coverage.gate.allPassed ? "全部通过" : "未全部通过"}</Badge>
          <Badge>{coverage.gate.complete ? "范围完整" : "范围不完整"}</Badge>
          <Badge>{coverage.gate.evidenceComplete ? "证据完整" : "证据缺失"}</Badge>
        </div>
        {coverage.gate.reasons.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs">
            {coverage.gate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ["测试点", coverage.counts.points],
          ["用例", coverage.counts.cases],
          ["有关联用例的点", coverage.counts.coveredPoints],
          ["无关联用例的点", coverage.counts.uncoveredPoints],
          ["已执行", coverage.counts.executed],
          ["通过", coverage.counts.passed],
          ["失败", coverage.counts.failed],
          ["跳过", coverage.counts.skipped],
          ["阻塞", coverage.counts.blocked],
          ["无结果用例", coverage.counts.untestedCases],
          ["测试点覆盖率", percent(coverage.rates.pointCoverage)],
          ["用例执行率", percent(coverage.rates.caseExecution)],
          ["通过率", percent(coverage.rates.passRate)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border border-[var(--border)] p-2">
            <dt className="opacity-70">{label}</dt>
            <dd className="text-base font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <table className="w-full text-left text-xs" aria-label="风险分布">
        <thead>
          <tr className="opacity-70">
            <th className="py-1">风险</th>
            <th>测试点</th>
            <th>有关联用例</th>
            <th>已执行</th>
            <th>失败</th>
            <th>未测</th>
          </tr>
        </thead>
        <tbody>
          {(["high", "medium", "low"] as const).map((risk) => {
            const row = coverage.risk[risk];
            return (
              <tr key={risk} className="border-t border-[var(--border)]">
                <td className="py-1">{riskLabel(risk)}</td>
                <td>{row.points}</td>
                <td>{row.covered}</td>
                <td>{row.executed}</td>
                <td className={row.failed > 0 ? "text-red-600" : undefined}>{row.failed}</td>
                <td className={row.untested > 0 ? "text-amber-600" : undefined}>{row.untested}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div>
        <h3 className="text-sm font-medium">测试点</h3>
        {coverage.points.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">该运行没有设计测试点。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {coverage.points.map((point) => {
              const concern = pointConcern(point);
              return (
                <li
                  key={point.pointKey}
                  className="qt-point rounded border border-[var(--border)] p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>
                      {point.pointKey} · {point.module} / {point.feature}
                    </strong>
                    <Badge>风险 {riskLabel(point.risk)}</Badge>
                    <Badge>{pointStatusLabel(point.status)}</Badge>
                    <span className="text-xs opacity-70">
                      用例 {point.coveredBy.length} · 通过 {point.caseCounts.passed} · 失败{" "}
                      {point.caseCounts.failed} · 跳过 {point.caseCounts.skipped} · 阻塞{" "}
                      {point.caseCounts.blocked} · 无结果 {point.caseCounts.notRun}
                    </span>
                  </div>
                  {concern && (
                    <p className="mt-1 text-xs" role="note">
                      原因：{concern}
                    </p>
                  )}
                  {point.coveredBy.length > 0 && (
                    <ul className="mt-1 space-y-1">
                      {point.coveredBy.map((caseKey) => {
                        const result = byCase.get(caseKey);
                        return (
                          <li key={caseKey} className="qt-case-result text-xs">
                            <span className="font-mono">{caseKey}</span>
                            {result ? (
                              <>
                                {" "}
                                · {resultStatusLabel(result.status)}
                                {result.reason ? ` · 原因：${result.reason}` : ""}
                                {result.evidenceRefs.length > 0 && (
                                  <ul className="ml-4 list-disc opacity-70">
                                    {result.evidenceRefs.map((ref, index) => (
                                      <li key={index}>证据：{evidenceLine(ref)}</li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            ) : (
                              <span className="opacity-70"> · 无执行结果（不得视为通过）</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="qt-untested">
        <h3 className="text-sm font-medium">未测项与原因</h3>
        {coverage.untested.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">没有未测项。</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {coverage.untested.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                {item.kind === "point" ? "测试点" : "用例"} {item.id}：{item.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function DefectStatusView({
  defects,
  detail = null,
  onSelect,
}: {
  defects: DefectView[];
  detail?: DefectDetailView | null;
  onSelect?: (defectId: string) => void;
}) {
  const severity = severitySummary(defects);
  const unassessed = severity.unknown + severity.unrecorded;
  return (
    <section className="qt-defects space-y-3 text-sm" aria-label="缺陷状态">
      <header>
        <h2 className="text-base font-medium">缺陷状态</h2>
        <p className="mt-1 text-xs opacity-70">
          只读视图：确认、修复声明和关闭都不在这里发生。修复声明不等于已验证；关闭需要独立复测运行。
        </p>
        {defects.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" aria-label="缺陷严重度分布">
            {Object.entries(severity.levels)
              .filter(([, count]) => count > 0)
              .map(([level, count]) => (
                <Badge key={level}>
                  严重度 {severityLabel(level)} {count}
                </Badge>
              ))}
            {severity.unknown > 0 && <Badge>未评估 {severity.unknown}</Badge>}
            {severity.unrecorded > 0 && <Badge>未记录 {severity.unrecorded}</Badge>}
            {unassessed > 0 && (
              <span className="opacity-70">
                未评估/未记录不代表低风险，应补充影响证据或人工复核。
              </span>
            )}
          </div>
        )}
      </header>
      {defects.length === 0 ? (
        <p className="text-xs opacity-70">本项目还没有登记缺陷。</p>
      ) : (
        <ul className="space-y-1">
          {defects.map((defect) => (
            <li key={defect.defectId}>
              <button
                className={`qt-defect w-full rounded border border-[var(--border)] p-2 text-left ${detail?.defect.defectId === defect.defectId ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"}`}
                onClick={() => onSelect?.(defect.defectId)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <strong>{defect.title}</strong>
                  <Badge>{defectStatusLabel(defect.status)}</Badge>
                  <Badge>严重度 {severityLabel(defect.severity)}</Badge>
                  <Badge>{defectCategoryLabel(defect.category)}</Badge>
                  <Badge>{defect.priority}</Badge>
                </span>
                <span className="mt-1 block text-xs opacity-70">
                  发现于 {defect.originSessionId}/{defect.originRunId} · 事件 {defect.eventCount} · 更新{" "}
                  {timeLabel(defect.updatedAt)}
                </span>
                <span className="mt-1 block text-xs opacity-70">
                  关联用例：{defect.relatedCases.join("、") || "无"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <article className="qt-defect-detail space-y-2 rounded border border-[var(--border)] p-3">
          <h3 className="text-sm font-medium">
            {detail.defect.title} · {defectStatusLabel(detail.defect.status)}
          </h3>
          <dl className="grid gap-1 text-xs">
            <div>
              <dt className="inline opacity-70">期望：</dt>
              <dd className="inline">{detail.defect.expectedResult || "—"}</dd>
            </div>
            <div>
              <dt className="inline opacity-70">实际：</dt>
              <dd className="inline">{detail.defect.actualResult || "—"}</dd>
            </div>
            <div>
              <dt className="inline opacity-70">分析：</dt>
              <dd className="inline">{detail.defect.analysis || "—"}</dd>
            </div>
            <div>
              <dt className="inline opacity-70">严重度：</dt>
              <dd className="inline">{severityLabel(detail.defect.severity)}</dd>
              {detail.defect.severityReason ? ` · ${detail.defect.severityReason}` : ""}
            </div>
            {detail.defect.severityDimensions && (
              <div>
                <dt className="inline opacity-70">严重度依据：</dt>
                <dd className="inline">
                  {Object.entries(detail.defect.severityDimensions)
                    .map(([key, value]) => `${severityDimensionLabel(key)} ${severityDimensionValueLabel(value ?? "unknown")}`)
                    .join(" · ")}
                </dd>
              </div>
            )}
            <div>
              <dt className="inline opacity-70">指纹：</dt>
              <dd className="inline font-mono">{shortHash(detail.defect.fingerprint)}</dd>
            </div>
          </dl>
          <div>
            <h4 className="text-xs font-medium">出现记录</h4>
            <ul className="mt-1 space-y-1 text-xs">
              {detail.occurrences.map((occurrence) => (
                <li key={occurrence.occurrenceId} className="rounded border border-[var(--border)] p-2">
                  {occurrence.sessionId}/{occurrence.runId} · 用例 {occurrence.caseKey} ·{" "}
                  {timeLabel(occurrence.observedAt)}
                  {occurrence.evidenceRefs.length > 0 && (
                    <ul className="ml-4 list-disc opacity-70">
                      {occurrence.evidenceRefs.map((ref, index) => (
                        <li key={index}>证据：{evidenceLine(ref)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-medium">事件链</h4>
            <ol className="mt-1 space-y-1 text-xs">
              {detail.events.map((event) => (
                <li key={event.eventId} className="rounded border border-[var(--border)] p-2">
                  #{event.sequence} {event.action} · {event.fromStatus || "—"} → {event.toStatus} ·{" "}
                  {event.actorUserId} · {timeLabel(event.createdAt)}
                  {event.reason ? ` · ${event.reason}` : ""}
                  {event.retestRunId ? ` · 复测运行 ${event.retestRunId}` : ""}
                  <span className="ml-2 font-mono opacity-60">{shortHash(event.eventHash)}</span>
                </li>
              ))}
            </ol>
          </div>
          {detail.retests.length > 0 && (
            <div>
              <h4 className="text-xs font-medium">复测记录</h4>
              <ul className="mt-1 space-y-1 text-xs">
                {detail.retests.map((retest) => (
                  <li key={retest.retestId} className="rounded border border-[var(--border)] p-2">
                    {retest.result === "passed" ? "通过" : "失败"} · {retest.sessionId}/{retest.runId} ·{" "}
                    {retest.createdBy} · {timeLabel(retest.createdAt)} · 用例{" "}
                    {retest.caseResults.map((item) => `${item.caseKey}:${resultStatusLabel(item.status)}`).join("、")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
    </section>
  );
}

export function ReportIndexViewPanel({ response }: { response: ReportIndexResponse }) {
  const { report, stale } = response;
  if (report === null) {
    return (
      <section className="qt-report space-y-2 text-sm" aria-label="报告索引">
        <h2 className="text-base font-medium">报告证据索引</h2>
        <p className="qt-report-missing rounded border border-[var(--border)] p-3 opacity-80">
          尚未登记报告索引。不得根据会话文本、截图文件名或日志推断本次运行通过。
        </p>
      </section>
    );
  }
  return (
    <section className="qt-report space-y-3 text-sm" aria-label="报告索引">
      <header>
        <h2 className="text-base font-medium">报告证据索引</h2>
        <p className="mt-1 text-xs opacity-70">
          第 {report.revision} 版 · {reportStateLabel(report, stale)} · 设计修订{" "}
          {report.designRevision} · 内容 {shortHash(report.contentHash)}
        </p>
        <p className="mt-1 text-xs opacity-70">
          {report.createdBy} · {timeLabel(report.createdAt)} · HTML {report.htmlPath}（
          {shortHash(report.htmlSha256)}）
        </p>
      </header>

      {stale && (
        <p role="alert" className="qt-report-stale rounded border border-amber-400 p-2 text-sm text-amber-700">
          结果已变化：这份报告是旧结果快照，不是当前报告。请以最新结果为准，不得把旧报告当作当前结论。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Badge>结论 {conclusionLabel(report.conclusion)}</Badge>
        <Badge>质量门 {qualityGateLabel(report.qualityGate)}</Badge>
        <Badge>{report.status === "published" ? "已发布" : "已被新版本取代"}</Badge>
        <Badge>{report.coverage.allPassed ? "全部通过" : "未全部通过"}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ["用例", report.counts.cases],
          ["已执行", report.counts.executed],
          ["通过", report.counts.passed],
          ["失败", report.counts.failed],
          ["跳过", report.counts.skipped],
          ["阻塞", report.counts.blocked],
          ["无结果用例", report.counts.untestedCases],
          ["测试点覆盖率", percent(report.coverage.pointCoverage)],
          ["用例执行率", percent(report.coverage.caseExecution)],
          ["通过率", percent(report.coverage.passRate)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border border-[var(--border)] p-2">
            <dt className="opacity-70">{label}</dt>
            <dd className="text-base font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="qt-report-untested">
        <h3 className="text-sm font-medium">未测项</h3>
        {report.untested.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">报告未列出未测项。</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {report.untested.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                {item.kind === "point" ? "测试点" : "用例"} {item.id}：{item.reason}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">证据来源</h3>
        {report.evidence.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">报告没有列出证据。</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs">
            {report.evidence.map((item, index) => (
              <li key={`${index}-${item.label}`} className="rounded border border-[var(--border)] p-2">
                <strong>{item.label}</strong>
                {item.path ? ` · ${item.path}` : ""}
                {item.sha256 ? ` · 哈希 ${shortHash(item.sha256)}` : ""}
                <span className="block opacity-70">{evidenceLine(item.ref)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {report.limitations.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">范围限制</h3>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {report.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="qt-report-open-defects">
        <h3 className="text-sm font-medium">未解决缺陷（生成报告时）</h3>
        {report.openDefects.length === 0 ? (
          <p className="mt-1 text-xs opacity-70">报告生成时没有未解决缺陷。</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {report.openDefects.map((defect) => (
              <li key={defect.defectId}>
                {defect.defectId} · {defectStatusLabel(defect.status)} · {severityLabel(defect.severity)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
