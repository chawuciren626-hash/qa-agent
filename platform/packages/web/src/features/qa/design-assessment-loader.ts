/**
 * Read-only loader for design assessment inputs.
 *
 * The Q3 case-review projection intentionally drops `expected_basis`/`observations`, so the
 * assessment reads the raw verified artifacts instead: the task detail names the artifact paths,
 * the session file route serves them, and the run's own manifest/ledger names the source files.
 * Nothing here writes artifacts, approves stages or trusts an artifact whose hash check failed.
 */
import { ApiError } from "../../api/client";
import { artifactUrl } from "./task-results";
import type { AssessmentRule, RawCase, RawPoint } from "./design-assessment-model";

type DetailArtifact = {
  path: string;
  name: string;
  stage: string;
  type: string;
  size: number;
  available: boolean;
  verified: boolean | null;
};

type TaskDetail = {
  runId: string;
  status: string;
  workflowMode?: string;
  executionPlatform?: string;
  artifacts: DetailArtifact[];
};

export interface LoadedArtifactStatus {
  path: string;
  loaded: boolean;
  verified: boolean | null;
  reason?: string;
}

export interface LoadedSourceStatus {
  path: string;
  loaded: boolean;
  reason?: string;
}

export interface DesignAssessmentData {
  points: RawPoint[];
  cases: RawCase[];
  rules: AssessmentRule[];
  sources: Record<string, string>;
  mode: "task" | "lifecycle" | "unknown";
  warnings: string[];
  artifacts: {
    points: LoadedArtifactStatus | null;
    cases: LoadedArtifactStatus | null;
    manifest: LoadedArtifactStatus | null;
  };
  sourceStatus: LoadedSourceStatus[];
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "yaml", "yml", "csv", "html", "htm", "xml"]);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) {
    let code = "request_failed";
    let message = `请求失败（${response.status}）`;
    try {
      const body = recordOf(await response.json());
      const error = recordOf(body.error);
      if (typeof error.code === "string") code = error.code;
      if (typeof error.message === "string") message = error.message;
    } catch {
      /* keep the status-based message */
    }
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

async function getText(
  url: string,
  signal: AbortSignal,
  limit = MAX_SOURCE_BYTES,
): Promise<{ text: string; size: number } | null> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await response.text();
  return text.length > limit ? null : { text, size: text.length };
}

function runPrefix(runId: string): string {
  return `output/runs/${runId}/`;
}

function sourceUrl(sessionId: string, runId: string, sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  const relative = normalized.startsWith("output/runs/") ? normalized : `${runPrefix(runId)}${normalized.replace(/^\/+/, "")}`;
  return artifactUrl(sessionId, relative);
}

function safeSourcePath(sourcePath: string): string | null {
  const normalized = sourcePath.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized.startsWith("output/runs/") ? normalized : normalized;
}

function extensionOf(sourcePath: string): string {
  const name = sourcePath.split("/").at(-1) ?? "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function chooseArtifact(artifacts: DetailArtifact[], stage: string, fileName: string): DetailArtifact | undefined {
  const candidates = artifacts.filter(
    (artifact) => artifact.name === fileName || (artifact.stage === stage && artifact.name.endsWith(`/${fileName}`)),
  );
  const inStage = candidates.filter((artifact) => artifact.stage === stage);
  const pool = inStage.length ? inStage : candidates;
  return [...pool].sort((left, right) => {
    const rank = (artifact: DetailArtifact) => (artifact.verified === true ? 0 : artifact.verified === null ? 1 : 2) * 10 + (artifact.available ? 0 : 1);
    return rank(left) - rank(right);
  })[0];
}

async function loadJsonArtifact<T>(
  sessionId: string,
  artifact: DetailArtifact | undefined,
  label: string,
  signal: AbortSignal,
): Promise<{ value: T | null; status: LoadedArtifactStatus | null; warning?: string }> {
  if (!artifact) return { value: null, status: null, warning: `没有找到${label}产物；相关评估显示为无法评估。` };
  if (!artifact.available) {
    return { value: null, status: { path: artifact.path, loaded: false, verified: artifact.verified, reason: "产物已登记但文件不可用。" }, warning: `${label}文件不可用。` };
  }
  if (artifact.verified === false) {
    return { value: null, status: { path: artifact.path, loaded: false, verified: false, reason: "哈希校验未通过。" }, warning: `${label}产物的哈希校验未通过，不能用于评估。` };
  }
  if (artifact.size > MAX_JSON_BYTES) {
    return { value: null, status: { path: artifact.path, loaded: false, verified: artifact.verified, reason: "文件过大。" }, warning: `${label}文件超过 2 MB，请在阶段产物中下载查看。` };
  }
  try {
    const value = await getJson<T>(artifactUrl(sessionId, artifact.path), signal);
    return {
      value,
      status: {
        path: artifact.path,
        loaded: true,
        verified: artifact.verified,
        ...(artifact.verified === true ? {} : { reason: "旧产物没有哈希校验标记，已读取但未通过当前交付校验。" }),
      },
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      value: null,
      status: { path: artifact.path, loaded: false, verified: artifact.verified, reason: "读取失败。" },
      warning: `${label}读取失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
}

function parsePoints(raw: unknown): RawPoint[] {
  if (Array.isArray(raw)) return raw.filter((item): item is RawPoint => Boolean(item) && typeof item === "object");
  const record = recordOf(raw);
  return Array.isArray(record.points) ? (record.points as RawPoint[]) : [];
}

function parseCases(raw: unknown): RawCase[] {
  if (Array.isArray(raw)) return raw.filter((item): item is RawCase => Boolean(item) && typeof item === "object");
  const record = recordOf(raw);
  return Array.isArray(record.cases) ? (record.cases as RawCase[]) : [];
}

function designMode(manifest: Record<string, unknown>, cases: RawCase[]): DesignAssessmentData["mode"] {
  const plan = recordOf(recordOf(manifest.orchestration).plan);
  const value = plan.workflow_mode ?? manifest.workflow_mode;
  if (value === "task") return "task";
  if (value === "lifecycle") return "lifecycle";
  return cases.some((item) => Array.isArray(item.expected_basis) || Array.isArray(item.expectedBasis)) ? "task" : "unknown";
}

function sourcePathsOf(manifest: Record<string, unknown>, cases: RawCase[], ledger: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const tracks = [
    ...arrayOfRecords(recordOf(recordOf(recordOf(manifest.test_tracks).spec).tracks)),
    ...arrayOfRecords(recordOf(recordOf(recordOf(manifest.orchestration).task).spec).tracks),
  ];
  for (const track of tracks) {
    if (Array.isArray(track.source_paths)) {
      for (const path of track.source_paths) if (typeof path === "string") paths.add(path);
    }
  }
  for (const rawCase of cases) {
    const basis = rawCase.expected_basis ?? rawCase.expectedBasis;
    if (!Array.isArray(basis)) continue;
    for (const item of basis) {
      const record = recordOf(item);
      const path = record.source_path ?? record.sourcePath;
      if (typeof path === "string") paths.add(path);
    }
  }
  if (Array.isArray(ledger.sources)) {
    for (const item of arrayOfRecords(ledger.sources)) {
      if (typeof item.path === "string") paths.add(item.path);
    }
  }
  return paths;
}

function parseRules(ledger: Record<string, unknown>): AssessmentRule[] {
  const sourceIds = new Map<string, string>();
  if (Array.isArray(ledger.sources)) {
    for (const item of arrayOfRecords(ledger.sources)) {
      if (typeof item.id === "string" && typeof item.path === "string") sourceIds.set(item.id, item.path);
    }
  }
  return arrayOfRecords(ledger.rules)
    .filter((rule) => typeof rule.id === "string")
    .map((rule) => ({
      ruleId: String(rule.id),
      statement: typeof rule.statement === "string" ? rule.statement : "",
      status: typeof rule.status === "string" ? rule.status : undefined,
      source: typeof rule.source === "string" ? rule.source : undefined,
      citations: Array.isArray(rule.citations)
        ? rule.citations.map((citation) => {
            const record = recordOf(citation);
            const sourceId = typeof record.source_id === "string" ? record.source_id : typeof record.sourceId === "string" ? record.sourceId : undefined;
            return {
              quote: typeof record.quote === "string" ? record.quote : undefined,
              sourceId: sourceId ? (sourceIds.get(sourceId) ?? sourceId) : undefined,
            };
          })
        : undefined,
    }));
}

/** Loads the artifacts the design assessment needs. Callers own the abort signal and error display. */
export async function loadDesignAssessment(
  projectId: string,
  sessionId: string,
  runId: string,
  signal: AbortSignal,
): Promise<DesignAssessmentData> {
  const warnings: string[] = [];
  const detail = await getJson<TaskDetail>(
    `/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    signal,
  );
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  const pointsArtifact = chooseArtifact(artifacts, "test_points", "test_points.json");
  const casesArtifact = chooseArtifact(artifacts, "test_cases", "test_cases.json");

  const manifestArtifact: DetailArtifact | undefined = {
    path: `${runPrefix(runId)}manifest.json`,
    name: "manifest.json",
    stage: "run",
    type: "数据",
    size: 0,
    available: true,
    verified: null,
  };

  const [pointsResult, casesResult, manifestResult] = await Promise.all([
    loadJsonArtifact<unknown>(sessionId, pointsArtifact, "测试点", signal),
    loadJsonArtifact<unknown>(sessionId, casesArtifact, "用例设计", signal),
    getText(artifactUrl(sessionId, manifestArtifact.path), signal, MAX_JSON_BYTES).then((value) => {
      if (!value) return null;
      try {
        return recordOf(JSON.parse(value.text));
      } catch {
        return null;
      }
    }),
  ]);

  for (const warning of [pointsResult.warning, casesResult.warning]) if (warning) warnings.push(warning);

  const manifest = manifestResult ?? {};
  const points = parsePoints(pointsResult.value);
  const cases = parseCases(casesResult.value);
  const mode = designMode(manifest, cases);

  let ledger: Record<string, unknown> = {};
  try {
    const value = await getText(artifactUrl(sessionId, `${runPrefix(runId)}analysis/requirement-ledger.json`), signal, MAX_JSON_BYTES);
    if (value) ledger = recordOf(JSON.parse(value.text));
  } catch (error) {
    if (isAbort(error)) throw error;
    warnings.push("需求台账读取失败；生命周期模式的规则状态无法核对。");
  }

  const sources: Record<string, string> = {};
  const sourceStatus: LoadedSourceStatus[] = [];
  const paths = [...sourcePathsOf(manifest, cases, ledger)].filter((path): path is string => Boolean(safeSourcePath(path)));
  await Promise.all(
    paths.map(async (path) => {
      const safe = safeSourcePath(path);
      if (!safe) {
        sourceStatus.push({ path, loaded: false, reason: "来源路径不是运行目录内的相对路径。" });
        return;
      }
      const extension = extensionOf(safe);
      if (extension && !TEXT_EXTENSIONS.has(extension)) {
        sourceStatus.push({ path: safe, loaded: false, reason: `暂不解析 .${extension} 来源，请在阶段产物中查看原文。` });
        return;
      }
      try {
        const value = await getText(sourceUrl(sessionId, runId, safe), signal);
        if (!value) {
          sourceStatus.push({ path: safe, loaded: false, reason: "来源文件不存在、不可读或超过 256 KB。" });
          return;
        }
        sources[safe] = value.text;
        if (safe !== path) sources[path] = value.text;
        sourceStatus.push({ path: safe, loaded: true });
      } catch (error) {
        if (isAbort(error)) throw error;
        sourceStatus.push({ path: safe, loaded: false, reason: "来源读取失败。" });
      }
    }),
  );

  if (Object.keys(sources).length === 0) warnings.push("没有加载到任何来源原文；预期依据只能检查引用完整性，不能核对语义。");
  sourceStatus.sort((left, right) => left.path.localeCompare(right.path));

  return {
    points,
    cases,
    rules: parseRules(ledger),
    sources,
    mode,
    warnings,
    artifacts: {
      points: pointsResult.status,
      cases: casesResult.status,
      manifest: manifestResult ? { path: manifestArtifact.path, loaded: true, verified: null } : { path: manifestArtifact.path, loaded: false, verified: null, reason: "清单不可读。" },
    },
    sourceStatus,
  };
}
