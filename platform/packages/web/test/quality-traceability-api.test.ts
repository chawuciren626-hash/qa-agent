/**
 * The Q3 read adapter (T4): one place knows the route shapes, and it only ever issues GETs. A
 * write verb here would mean a read-only panel could mutate a defect, so the method is pinned.
 */
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { path: string; options?: { method?: string; query?: Record<string, unknown> } }[]);

vi.mock("../src/api/client", () => ({
  apiFetch: async (path: string, options?: { method?: string; query?: Record<string, unknown> }) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return {};
  },
}));

import {
  fetchCaseResults,
  fetchCoverage,
  fetchDefectDetail,
  fetchDefects,
  fetchReportIndex,
} from "../src/features/qa/quality-traceability-api";

afterEach(() => {
  calls.length = 0;
});

it("addresses the run-scoped coverage, results and report-index routes", async () => {
  const scope = { projectId: "demo", sessionId: "session-1", runId: "run-1" };
  await fetchCoverage(scope);
  await fetchCaseResults(scope);
  await fetchReportIndex(scope);

  expect(calls.map((call) => call.path)).toEqual([
    "/api/projects/demo/agents/qa/tasks/session-1/runs/run-1/coverage",
    "/api/projects/demo/agents/qa/tasks/session-1/runs/run-1/results",
    "/api/projects/demo/agents/qa/tasks/session-1/runs/run-1/report-index",
  ]);
  for (const call of calls) {
    expect(call.options?.method ?? "GET").toBe("GET");
  }
});

it("encodes ids so a project or session id cannot change the route", async () => {
  await fetchCoverage({ projectId: "demo/a", sessionId: "s/1", runId: "r/1" });
  expect(calls[0]!.path).toBe(
    "/api/projects/demo%2Fa/agents/qa/tasks/s%2F1/runs/r%2F1/coverage",
  );
});

it("passes only set defect filters as query parameters", async () => {
  await fetchDefects("demo");
  await fetchDefects("demo", { status: "all", severity: "Critical", sessionId: "session-1" });
  await fetchDefects("demo", { cursor: "next-page" });

  expect(calls[0]).toEqual({ path: "/api/projects/demo/agents/qa/defects", options: { query: {} } });
  expect(calls[1]).toEqual({
    path: "/api/projects/demo/agents/qa/defects",
    options: { query: { severity: "Critical", sessionId: "session-1" } },
  });
  expect(calls[2]?.options?.query).toEqual({ cursor: "next-page" });
});

it("reads one defect under the project scope", async () => {
  await fetchDefectDetail("demo", "defect/1");
  expect(calls[0]!.path).toBe("/api/projects/demo/agents/qa/defects/defect%2F1");
  expect(calls[0]!.options?.method ?? "GET").toBe("GET");
});
