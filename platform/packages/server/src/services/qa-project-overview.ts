import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { qaEnabled, qaEngineModule } from "./qa-engine.js";

// The index is read-only: no generated progress, no inference from conversation text.
export async function readTaskRuns(workspace: string, sessionId: string) {
  const runs: { id: string; status: string; executionPlatform: string; stages: { id: string; status: string }[];
    artifacts: { path: string; category: string }[]; caseCount: number; defectCount: number;
    executed: number; passed: number; failed: number; cases: { id: string; title: string; type: string; status: string; module: string; priority: string; expected: string; results: any[] }[];
    defects: { id: string; title: string; severity: string; source: string; detail: any }[];
    activities: { type: string; stage: string; at: string }[] }[] = [];
  let unavailable = 0;
  let truncated = false;
  if (!workspace) return { runs, unavailable, truncated };
  let root: string;
  try {
    if ((await fs.lstat(workspace)).isSymbolicLink()) throw Error("Linked workspace");
    // Windows temp/user paths may use an 8.3 alias; canonicalize the trusted session root once.
    root = await fs.realpath(path.resolve(workspace));
  } catch (error) {
    return { runs, unavailable: (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : 1, truncated };
  }
  const safe = async (rel: string) => {
    const parts = rel.split("/");
    if (parts.some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p))) throw Error("Invalid path");
    let current = root;
    if (await fs.realpath(current) !== current) throw Error("Linked workspace");
    for (const part of parts) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink() || await fs.realpath(current) !== current) throw Error("Linked artifact");
    }
    return current;
  };
  try {
    const directory = await safe("output/runs");
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^run-[A-Za-z0-9-]+$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name));
    truncated = entries.length > 100;
    for (const entry of entries.slice(0, 100)) {
      try {
        const prefix = `output/runs/${entry.name}`;
        const file = await safe(`${prefix}/manifest.json`);
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw Error("Large manifest");
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        // Shared workspaces may contain runs belonging to other tasks/projects.
        const owner = manifest.directory_context?.session_id;
        const owners = new Set((manifest.orchestration?.events ?? []).map((e: any) => e["parent-session-id"] ?? e.evidence?.parent_session_id).filter(Boolean));
        if (owner ? owner !== sessionId : owners.size !== 1 || !owners.has(sessionId)) continue;
        const artifacts: { path: string; category: string }[] = [];
        const events = Array.isArray(manifest.orchestration?.events) ? manifest.orchestration.events : [];
        const verified = new Map<string, string>();
        for (const stage of Object.keys(manifest.stages ?? {})) {
          if (!["completed", "awaiting_confirmation", "confirmed"].includes(manifest.stages[stage]?.status)) continue;
          const completed = events.filter((event: any) => event?.stage === stage && event.type === "completed" && event.evidence?.artifact_contract?.status === "passed").at(-1);
          const dispatched = events.filter((event: any) => event?.stage === stage && event.type === "dispatched").at(-1);
          if (!completed || (dispatched && events.indexOf(completed) < events.indexOf(dispatched))) continue;
          if (manifest.stages[stage]?.dispatch_id && completed["dispatch-id"] !== manifest.stages[stage].dispatch_id) continue;
          for (const item of completed.evidence.artifact_contract.files ?? [])
            if (typeof item?.path === "string" && /^[a-f0-9]{64}$/.test(item.sha256)) verified.set(item.path, item.sha256);
        }
        const readVerifiedRows = async (relative: string, keys: string[]): Promise<any[]> => {
          const expected = verified.get(relative);
          if (!expected || !(Array.isArray(manifest.artifacts) && manifest.artifacts.includes(relative))) return [];
          try {
            const file = await safe(`${prefix}/${relative}`);
            if ((await fs.stat(file)).size > 2 * 1024 * 1024) return [];
            const bytes = await fs.readFile(file);
            if (createHash("sha256").update(bytes).digest("hex") !== expected) return [];
            const value = JSON.parse(bytes.toString("utf8"));
            const rows = Array.isArray(value) ? value : keys.map(key => value?.[key]).find(Array.isArray);
            return Array.isArray(rows) ? rows.slice(0, 10000) : [];
          } catch { return []; }
        };
        const cases = await readVerifiedRows("design/test_cases.json", ["cases", "test_cases"]);
        const webResults = await readVerifiedRows("execution/test_results.json", ["cases"]);
        const apiResults = await readVerifiedRows("execution/api/test_results.json", ["cases"]);
        const defectRows = await readVerifiedRows("defects/defect-records.json", ["records"]);
        const results = [...webResults, ...apiResults];
        for (const rel of (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).slice(0, 300)) {
          if (typeof rel !== "string") continue;
          const category = /^design\/.*\.xlsx$/i.test(rel) ? "cases" : /^defects\//.test(rel) ? "defects" : /^report\/.*\.html$/i.test(rel) ? "reports" : null;
          if (!category) continue;
          try { if ((await fs.stat(await safe(`${prefix}/${rel}`))).isFile()) artifacts.push({ path: `${prefix}/${rel}`, category }); }
          catch { unavailable++; }
        }
        runs.push({ id: entry.name, status: typeof manifest.status === "string" ? manifest.status : "unknown",
          executionPlatform: ["web", "android", "miniprogram"].includes(manifest.orchestration?.plan?.execution_platform) ? manifest.orchestration.plan.execution_platform : "web",
          stages: Object.entries(manifest.stages ?? {}).map(([id, stage]) => ({ id, status: typeof (stage as any)?.status === "string" ? (stage as any).status : "unknown" })), artifacts,
          caseCount: cases.length, defectCount: defectRows.length,
          executed: results.filter((row: any) => ["passed", "failed", "partial", "completed"].includes(row?.status)).length,
          passed: results.filter((row: any) => row?.status === "passed").length,
          failed: results.filter((row: any) => row?.status === "failed").length,
          cases: cases.map((row: any) => {
            const linked = results.filter((result: any) => result?.case_ref?.source_path === "design/test_cases.json" && result.case_ref.case_id === row?.case_id || !result?.case_ref && result?.case_id === row?.case_id);
            return { id: String(row?.case_id ?? "").slice(0, 100), title: String(row?.title ?? "").slice(0, 200), type: String(row?.type ?? "").slice(0, 80), module: String(row?.module ?? "").slice(0, 100), priority: String(row?.priority ?? "").slice(0, 40), expected: String(row?.expected ?? "").slice(0, 2000), status: !linked.length ? "未执行" : linked.some((result: any) => result?.status === "failed") ? "不通过" : linked.every((result: any) => result?.status === "passed") ? "通过" : "部分验证", results: linked.map((result: any) => ({ case_id: String(result?.case_id ?? "").slice(0, 100), title: String(result?.title ?? "").slice(0, 200), status: String(result?.status ?? "unknown").slice(0, 40), expected: String(result?.expected ?? "").slice(0, 2000), actual_result: String(result?.actual_result ?? result?.error_message ?? result?.reason ?? "").slice(0, 4000), evidence_paths: Array.isArray(result?.evidence_paths) ? result.evidence_paths.filter((value: unknown): value is string => typeof value === "string").slice(0, 30) : [] })) };
          }),
          defects: defectRows.map((row: any) => ({ id: String(row?.defect_id ?? "").slice(0, 100), title: String(row?.title ?? "").slice(0, 200), severity: String(row?.severity ?? "").slice(0, 80), source: String(row?.source_stage ?? "").slice(0, 80), detail: { category: String(row?.category ?? "").slice(0, 80), lifecycle_status: String(row?.lifecycle_status ?? "").slice(0, 80), related_cases: Array.isArray(row?.related_cases) ? row.related_cases.slice(0, 100) : [], steps_to_reproduce: String(row?.steps_to_reproduce ?? "").slice(0, 4000), expected_result: String(row?.expected_result ?? "").slice(0, 4000), actual_result: String(row?.actual_result ?? "").slice(0, 4000), impact: String(row?.impact ?? "").slice(0, 4000), recommendation: String(row?.recommendation ?? "").slice(0, 4000), evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs.filter((value: unknown): value is string => typeof value === "string").slice(0, 30) : [] } })),
          activities: events.filter((event: any) => typeof event?.type === "string" && typeof event?.at === "string")
            .slice(-50).reverse().map((event: any) => ({ type: event.type.slice(0, 80), stage: String(event.stage ?? ""), at: event.at })) });
      } catch { unavailable++; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable++; }
  return { runs, unavailable, truncated };
}

type DetailArtifact = { path: string; name: string; stage: string; type: string; size: number; available: boolean; verified: boolean | null; updatedAt?: string; sha256?: string };
const taskResultPaths: Record<string, string> = {
  analysis: "analysis/analysis-task.json", test_points: "design/test_points-task.json",
  test_cases: "design/test_cases-task.json", execution: "execution/execution-task.json",
  api_execution: "execution/api/task.json", defects: "defects/defects-task.json", report: "report/report-task.json",
};
function artifactStage(file: string): string {
  if (file.startsWith("analysis/")) return "analysis";
  if (file.startsWith("design/test_points")) return "test_points";
  if (file.startsWith("design/test_cases")) return "test_cases";
  if (file.startsWith("execution/api/")) return "api_execution";
  if (file.startsWith("execution/")) return "execution";
  if (file.startsWith("defects/")) return "defects";
  if (file.startsWith("report/")) return "report";
  return "other";
}
function artifactType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".xlsx" || ext === ".xmind" ? "用例" : ext === ".html" || ext === ".pdf" ? "报告" : ext === ".json" ? "数据" : "文档";
}
function eventsOf(manifest: any): any[] { return Array.isArray(manifest.orchestration?.events) ? manifest.orchestration.events : []; }

/** Read a single owned run. A stage or artifact is never inferred from chat text. */
export async function readTaskRunDetail(workspace: string, sessionId: string, runId: string) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId)) return null;
  const listed = await readTaskRuns(workspace, sessionId);
  if (!listed.runs.some(run => run.id === runId)) return null;
  const root = await fs.realpath(path.resolve(workspace));
  const safe = async (relative: string) => {
    const parts = relative.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) throw Error("Invalid artifact path");
    let file = root;
    for (const part of parts) {
      file = path.join(file, part);
      if ((await fs.lstat(file)).isSymbolicLink() || await fs.realpath(file) !== file) throw Error("Linked artifact");
    }
    return file;
  };
  const prefix = `output/runs/${runId}/`;
  const manifestFile = await safe(prefix + "manifest.json");
  if ((await fs.stat(manifestFile)).size > 2 * 1024 * 1024) return null;
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  if (manifest.run_id && manifest.run_id !== runId) return null;
  const owner = manifest.directory_context?.session_id;
  const owners = new Set(eventsOf(manifest).map((event: any) => event["parent-session-id"] ?? event.evidence?.parent_session_id).filter(Boolean));
  if (owner ? owner !== sessionId : owners.size !== 1 || !owners.has(sessionId)) return null;
  const plan = Array.isArray(manifest.orchestration?.plan?.stages) ? manifest.orchestration.plan.stages : [];
  const selected = plan.filter((stage: any) => stage?.selected === true && typeof stage.id === "string");
  const stageIds: string[] = selected.length ? selected.map((stage: any) => stage.id) : Object.keys(manifest.stages ?? {}).filter(id => manifest.stages[id]?.status !== "skipped");
  const events: any[] = eventsOf(manifest);
  const contracts = new Map<string, Map<string, string>>();
  for (const id of stageIds) {
    if (!["completed", "awaiting_confirmation", "confirmed"].includes(manifest.stages?.[id]?.status)) continue;
    const completed = events.filter(event => event?.stage === id && event.type === "completed" && event.evidence?.artifact_contract?.status === "passed").at(-1);
    const dispatched = events.filter(event => event?.stage === id && event.type === "dispatched").at(-1);
    if (dispatched && events.indexOf(completed) < events.indexOf(dispatched)) continue;
    if (manifest.stages?.[id]?.dispatch_id && completed?.["dispatch-id"] !== manifest.stages[id].dispatch_id) continue;
    const files = completed?.evidence?.artifact_contract?.files;
    if (Array.isArray(files)) contracts.set(id, new Map(files.filter((file: any) => typeof file?.path === "string" && /^[a-f0-9]{64}$/.test(file.sha256)).map((file: any) => [file.path, file.sha256])));
  }
  const artifacts: DetailArtifact[] = [];
  const recordedArtifacts: string[] = (Array.isArray(manifest.artifacts) ? manifest.artifacts as unknown[] : []).filter((file): file is string => typeof file === "string");
  for (const relative of [...new Set(recordedArtifacts)].slice(0, 300)) {
    const stage = artifactStage(relative);
    if (stage === "other" || !stageIds.includes(stage)) continue;
    let size = 0, available = false, verified: boolean | null = null, updatedAt: string | undefined;
    try {
      const file = await safe(prefix + relative);
      const stat = await fs.stat(file);
      available = stat.isFile(); size = stat.size; updatedAt = available ? stat.mtime.toISOString() : undefined;
      const expected = contracts.get(stage)?.get(relative);
      if (available && expected && size <= 16 * 1024 * 1024) verified = createHash("sha256").update(await fs.readFile(file)).digest("hex") === expected;
    } catch { /* Show the registered file as unavailable. */ }
    artifacts.push({ path: prefix + relative, name: path.posix.basename(relative), stage, type: artifactType(relative), size, available, verified, updatedAt, ...(verified === true ? {sha256:contracts.get(stage)?.get(relative)} : {}) });
  }
  const stages = await Promise.all(stageIds.map(async id => {
    const state = manifest.stages?.[id] ?? {};
    const history = (Array.isArray(manifest.confirmations) ? manifest.confirmations : []).filter((item: any) => item?.stage === id).slice(-50).map((item: any) => ({ status: String(item.status ?? "unknown"), reason: typeof item.reason === "string" ? item.reason.slice(0, 2000) : "", at: String(item.resolved_at ?? item.requested_at ?? "") }));
    let summary = "", questions: string[] = [], limitations: string[] = [];
    const taskPath = taskResultPaths[id];
    if (taskPath && contracts.get(id)?.has(taskPath)) {
      try {
        const file = await safe(prefix + taskPath), raw = await fs.readFile(file);
        if (raw.length <= 2 * 1024 * 1024 && createHash("sha256").update(raw).digest("hex") === contracts.get(id)!.get(taskPath)) {
          const task = JSON.parse(raw.toString("utf8"));
          if (task.run_id === runId && task.stage === id) {
            summary = typeof task.summary === "string" ? task.summary.slice(0, 4000) : "";
            questions = Array.isArray(task.questions) ? task.questions.filter((value: unknown): value is string => typeof value === "string").slice(0, 30).map((value: string) => value.slice(0, 1000)) : [];
            limitations = Array.isArray(task.limitations) ? task.limitations.filter((value: unknown): value is string => typeof value === "string").slice(0, 30).map((value: string) => value.slice(0, 1000)) : [];
          }
        }
      } catch { /* No unverified summary is shown. */ }
    }
    const latestConfirmation = (Array.isArray(manifest.confirmations) ? manifest.confirmations : []).filter((item: any) => item?.stage === id).at(-1);
    const pendingConfirmationId = state.status === "awaiting_confirmation" && latestConfirmation?.status === "pending" &&
      manifest.orchestration?.plan?.workflow_mode === "lifecycle" && manifest.orchestration?.plan?.review_mode === "staged" &&
      (selected.find((item: any) => item.id === id)?.confirmation === "after" || selected.find((item: any) => item.id === id)?.result_confirmation === "after") &&
      latestConfirmation?.kind !== "authorization" && /^confirm-[A-Za-z0-9_-]+$/.test(latestConfirmation?.id ?? "")
      ? latestConfirmation.id as string : "";
    let reviewMarkdown = "";
    // Existing approved deliveries stay immutable; render a view only from sealed JSON.
    if (qaEnabled && ["test_points","execution","api_execution"].includes(id) && !artifacts.some(item => item.stage === id && item.name.endsWith(".md") && item.verified === true)) {
      try {
        const sources = new Map<string, unknown>();
        for (const relative of ["design/test_points.json","execution/test_results.json","execution/execution-blocked.json","execution/execution-task.json","execution/browser-coverage.json","execution/api/test_results.json","execution/api/task.json"]) {
          const expected = contracts.get(id)?.get(relative);
          if (!expected) continue;
          const file = await safe(prefix + relative);
          if ((await fs.stat(file)).size > 2 * 1024 * 1024) continue;
          const bytes = await fs.readFile(file);
          if (createHash("sha256").update(bytes).digest("hex") === expected) sources.set(relative, JSON.parse(bytes.toString("utf8")));
        }
        reviewMarkdown = qaEngineModule("stage-review-documents").renderStageReview(id, (file: string) => sources.get(file) ?? null);
      } catch { /* Invalid or changed source is never rendered as verified. */ }
    }
    return { id, status: typeof state.status === "string" ? state.status : "unknown", agent: selected.find((stage: any) => stage.id === id)?.agent ?? "", reason: typeof state.reason === "string" ? state.reason : "", revisionId: typeof state.revision_id === "string" ? state.revision_id : "", summary, questions, limitations, history, pendingConfirmationId, reviewMarkdown };
  }));
  return { runId, status: String(manifest.status ?? "unknown"), workflowMode: String(manifest.orchestration?.plan?.workflow_mode ?? "unknown"), reviewMode: String(manifest.orchestration?.plan?.review_mode ?? "unknown"), executionPlatform: String(manifest.orchestration?.plan?.execution_platform ?? "web"), stages, artifacts };
}
