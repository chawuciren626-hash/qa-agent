/**
 * Sample container for the read-only Q3 surfaces (T4). It wires the adapter to the coverage,
 * defect and report-index routes and renders the three independent views; it deliberately has no
 * write actions — results writing, defect confirmation/retest and report publication stay with
 * the owner and the integration owner.
 *
 * The task detail page is not touched here; the integration owner decides where these views
 * live. This page exists so the components can be exercised against real API responses.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "@prismshadow/penguin-ui";
import { ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { projectDisplayName, useProject } from "../../state/project";
import {
  fetchCaseResults,
  fetchCoverage,
  fetchDefectDetail,
  fetchDefects,
  fetchReportIndex,
} from "./quality-traceability-api";
import {
  qualityErrorHint,
  type CaseResultView,
  type CoverageView,
  type DefectDetailView,
  type DefectView,
  type ReportIndexResponse,
} from "./quality-traceability-model";
import { CoverageRiskView, DefectStatusView, ReportIndexViewPanel } from "./quality-traceability-views";
import { assessResidualRisk } from "./design-assessment-model";
import { DesignAssessmentPanel } from "./design-assessment-panel";
import { ResidualRiskView } from "./design-assessment-views";

function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return qualityErrorHint(code) ?? apiErrorText(error);
}

function ErrorNote({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded border border-red-300 p-2 text-xs text-red-700">
      {children}
    </p>
  );
}

export function QualityTraceabilityPage() {
  const { currentProject } = useProject();
  return <QualityTraceabilityPageContent key={currentProject?.projectId ?? "no-project"} />;
}

function QualityTraceabilityPageContent() {
  const { currentProject } = useProject();
  const { search } = useLocation();
  const projectId = currentProject?.projectId;

  const initial = new URLSearchParams(search);
  const [sessionDraft, setSessionDraft] = useState(initial.get("sessionId") ?? "");
  const [runDraft, setRunDraft] = useState(initial.get("runId") ?? "");
  const [scope, setScope] = useState({
    sessionId: initial.get("sessionId") ?? "",
    runId: initial.get("runId") ?? "",
  });
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  const [defects, setDefects] = useState<DefectView[] | null>(null);
  const [nextDefectCursor, setNextDefectCursor] = useState<string | null>(null);
  const [loadingMoreDefects, setLoadingMoreDefects] = useState(false);
  const [defectsError, setDefectsError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DefectDetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [coverage, setCoverage] = useState<CoverageView | null>(null);
  const [results, setResults] = useState<CaseResultView[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportIndexResponse | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const hasScope = Boolean(projectId && scope.sessionId && scope.runId);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setDefects(null);
    setNextDefectCursor(null);
    setDefectsError(null);
    setDetail(null);
    setDetailError(null);
    fetchDefects(projectId, {
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope.runId ? { runId: scope.runId } : {}),
    })
      .then((data) => {
        if (alive) {
          setDefects(data.defects);
          setNextDefectCursor(data.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (alive) setDefectsError(errorText(error));
      });
    return () => {
      alive = false;
    };
  }, [projectId, scope.sessionId, scope.runId, reload]);

  useEffect(() => {
    if (!hasScope || !projectId) {
      setCoverage(null);
      setResults(null);
      setRunError(null);
      setReport(null);
      setReportError(null);
      return;
    }
    let alive = true;
    const runScope = { projectId, sessionId: scope.sessionId, runId: scope.runId };
    setCoverage(null);
    setResults(null);
    setRunError(null);
    setReport(null);
    setReportError(null);

    Promise.all([fetchCoverage(runScope), fetchCaseResults(runScope)])
      .then(([nextCoverage, nextResults]) => {
        if (!alive) return;
        setCoverage(nextCoverage);
        setResults(nextResults.results);
      })
      .catch((error: unknown) => {
        if (alive) setRunError(errorText(error));
      });

    fetchReportIndex(runScope)
      .then((nextReport) => {
        if (alive) setReport(nextReport);
      })
      .catch((error: unknown) => {
        if (alive) setReportError(errorText(error));
      });

    return () => {
      alive = false;
    };
  }, [projectId, hasScope, scope.sessionId, scope.runId, reload]);

  const selectDefect = (defectId: string) => {
    if (!projectId) return;
    setDetailError(null);
    fetchDefectDetail(projectId, defectId)
      .then(setDetail)
      .catch((error: unknown) => setDetailError(errorText(error)));
  };

  const loadMoreDefects = async () => {
    if (!projectId || !nextDefectCursor || loadingMoreDefects) return;
    setLoadingMoreDefects(true);
    setDefectsError(null);
    try {
      const data = await fetchDefects(projectId, {
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        ...(scope.runId ? { runId: scope.runId } : {}),
        cursor: nextDefectCursor,
      });
      setDefects((current) => [...(current ?? []), ...data.defects]);
      setNextDefectCursor(data.nextCursor);
    } catch (error) {
      setDefectsError(errorText(error));
    } finally {
      setLoadingMoreDefects(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 text-sm">
      <header>
        <h1 className="text-xl font-semibold">质量追踪（只读）</h1>
        <p className="mt-1 text-xs opacity-70">
          {currentProject ? projectDisplayName(currentProject) : "尚未选择项目"} · 覆盖、缺陷与报告索引全部来自 Q3
          接口；本页不写结果、不确认缺陷、不发布报告。
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-2 rounded border border-[var(--border)] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setScope({ sessionId: sessionDraft.trim(), runId: runDraft.trim() });
          refresh();
        }}
      >
        <label className="text-xs">
          <span className="mb-1 block opacity-70">任务 ID</span>
          <input
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1"
            aria-label="任务 ID"
            value={sessionDraft}
            onChange={(event) => setSessionDraft(event.target.value)}
            placeholder="session-..."
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block opacity-70">运行 ID</span>
          <input
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1"
            aria-label="运行 ID"
            value={runDraft}
            onChange={(event) => setRunDraft(event.target.value)}
            placeholder="run-..."
          />
        </label>
        <Button size="sm" type="submit" disabled={!projectId}>
          加载
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={refresh} disabled={!projectId}>
          刷新
        </Button>
      </form>

      {!hasScope && (
        <p className="text-xs opacity-70">
          填写任务 ID 与运行 ID 后加载该运行的覆盖、用例结果与报告索引；缺陷列表按当前项目读取。
        </p>
      )}

      <section aria-label="覆盖与报告" className="space-y-3">
        {runError && <ErrorNote>{runError}</ErrorNote>}
        {coverage && <CoverageRiskView coverage={coverage} results={results ?? []} />}
        {reportError && <ErrorNote>{reportError}</ErrorNote>}
        {report && <ReportIndexViewPanel response={report} />}
      </section>

      <section aria-label="设计复杂度与可信度" className="space-y-3">
        <DesignAssessmentPanel
          projectId={projectId}
          sessionId={scope.sessionId}
          runId={scope.runId}
          reload={reload}
        />
      </section>

      <section aria-label="剩余风险" className="space-y-3">
        {hasScope && (
          <ResidualRiskView
            assessment={assessResidualRisk({
              coverage,
              results,
              defects,
              report,
              reportLoaded: report !== null,
            })}
          />
        )}
      </section>

      <section aria-label="缺陷" className="space-y-3">
        {defectsError && <ErrorNote>{defectsError}</ErrorNote>}
        {detailError && <ErrorNote>{detailError}</ErrorNote>}
        {defects && <DefectStatusView defects={defects} detail={detail} onSelect={selectDefect} />}
        {nextDefectCursor && (
          <Button size="sm" variant="ghost" disabled={loadingMoreDefects} onClick={() => void loadMoreDefects()}>
            {loadingMoreDefects ? "正在加载…" : "加载更多缺陷"}
          </Button>
        )}
      </section>
    </div>
  );
}
