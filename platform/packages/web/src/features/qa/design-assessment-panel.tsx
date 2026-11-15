/**
 * Container for the design assessment read-only surfaces. It loads raw verified design artifacts
 * and the run's sources through the existing session file route, then renders the pure model's
 * output. It stays off the task detail page so the integration owner can decide placement.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { assessDesign, type DesignAssessment } from "./design-assessment-model";
import { loadDesignAssessment, type DesignAssessmentData } from "./design-assessment-loader";
import { DesignAssessmentView } from "./design-assessment-views";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DesignAssessmentData };

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "task_not_found") return "任务不存在，或不属于当前项目。";
    if (error.code === "project_forbidden") return "没有该项目的访问权限。";
  }
  return apiErrorText(error);
}

export function DesignAssessmentPanel({
  projectId,
  sessionId,
  runId,
  reload,
}: {
  projectId: string | undefined;
  sessionId: string;
  runId: string;
  reload: number;
}) {
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!projectId || !sessionId || !runId) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void loadDesignAssessment(projectId, sessionId, runId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: errorText(error) });
      });
    return () => controller.abort();
  }, [projectId, sessionId, runId, reload]);

  const assessment: DesignAssessment | null = useMemo(
    () =>
      state.status === "ready"
        ? assessDesign({ points: state.data.points, cases: state.data.cases, sources: state.data.sources, rules: state.data.rules })
        : null,
    [state],
  );

  if (!projectId || !sessionId || !runId) {
    return (
      <section aria-label="设计复杂度与可信度" className="text-sm">
        <h2 className="text-base font-medium">设计复杂度与可信度（只读）</h2>
        <p className="mt-1 text-xs opacity-70">填写任务 ID 与运行 ID 后读取设计产物并评估。</p>
      </section>
    );
  }

  if (state.status === "loading" || state.status === "idle") {
    return (
      <section aria-label="设计复杂度与可信度" className="text-sm">
        <p role="status" className="text-xs opacity-70">正在读取设计产物与来源原文…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section aria-label="设计复杂度与可信度" className="text-sm">
        <p role="alert" className="rounded border border-red-300 p-2 text-xs text-red-700">
          {state.message}
        </p>
      </section>
    );
  }

  return <DesignAssessmentView assessment={assessment!} data={state.data} />;
}
