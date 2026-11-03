/**
 * The Q3 read adapter: the only place the quality panels know a URL. Coverage/risk, case
 * results, project defects and the report index are read-only here — confirmation, retest and
 * publication stay with the project owner and the integration owner.
 */
import { apiFetch } from "../../api/client";
import type {
  CaseResultView,
  CoverageView,
  DefectDetailView,
  DefectSeverity,
  DefectStatus,
  DefectView,
  ReportIndexResponse,
} from "./quality-traceability-model";

export interface QualityScope {
  projectId: string;
  sessionId: string;
  runId: string;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/agents/qa`;
const runPath = (scope: QualityScope) =>
  `${base(scope.projectId)}/tasks/${encodeURIComponent(scope.sessionId)}/runs/${encodeURIComponent(scope.runId)}`;

export function fetchCoverage(scope: QualityScope): Promise<CoverageView> {
  return apiFetch<CoverageView>(`${runPath(scope)}/coverage`);
}

export function fetchCaseResults(scope: QualityScope): Promise<{ results: CaseResultView[] }> {
  return apiFetch<{ results: CaseResultView[] }>(`${runPath(scope)}/results`);
}

export interface DefectFilters {
  cursor?: string;
  status?: DefectStatus | "all";
  severity?: DefectSeverity | "all";
  sessionId?: string;
  runId?: string;
}

export function fetchDefects(
  projectId: string,
  filters: DefectFilters = {},
): Promise<{ defects: DefectView[]; nextCursor: string | null }> {
  const query: Record<string, string> = {};
  if (filters.status && filters.status !== "all") query.status = filters.status;
  if (filters.severity && filters.severity !== "all") query.severity = filters.severity;
  if (filters.sessionId) query.sessionId = filters.sessionId;
  if (filters.runId) query.runId = filters.runId;
  if (filters.cursor) query.cursor = filters.cursor;
  return apiFetch<{ defects: DefectView[]; nextCursor: string | null }>(`${base(projectId)}/defects`, {
    query,
  });
}

export function fetchDefectDetail(projectId: string, defectId: string): Promise<DefectDetailView> {
  return apiFetch<DefectDetailView>(
    `${base(projectId)}/defects/${encodeURIComponent(defectId)}`,
  );
}

export function fetchReportIndex(scope: QualityScope): Promise<ReportIndexResponse> {
  return apiFetch<ReportIndexResponse>(`${runPath(scope)}/report-index`);
}
