/**
 * Publication review: the pure reading of the Q1 validation, history and rollback contract
 * (`docs/api-q1-capability-2026-11-02.md`), kept out of the pages so the rules stay testable.
 *
 * The server returns `valid: true|false` with HTTP 200 for a rejected payload, summaries that
 * never contain an archive, and history items that flag the current version. This module turns
 * those into the lines an administrator reads and the rules the buttons obey; it never fetches,
 * never infers a payload's contents from `body`, and never treats a failed validation as a save.
 */
import type { ManagedKind } from "../../lib/managed-resources";

export const KIND_TITLES: Record<string, string> = {
  agents: "智能体",
  models: "模型",
  plugins: "插件",
  skills: "技能",
};

/** A public, non-secret view of a validated payload; archives are reduced to names and hashes. */
export interface ResourceSummary {
  kind?: string;
  name?: string;
  description?: string;
  skillName?: string;
  fileCount?: number;
  files?: string[];
  sizeBytes?: number;
  contentHash?: string;
  pluginName?: string;
  pluginVersion?: string;
  adapterVersion?: string;
  adapterHash?: string;
  source?: string;
  skillResources?: string[];
  instructionsLength?: number;
  modelResource?: string;
  pluginResources?: string[];
  provider?: string;
  modelId?: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
  promptLength?: number;
  agentsMdLength?: number;
  maxTurns?: number;
}

export interface ValidationSuccess {
  valid: true;
  kind: ManagedKind;
  summary: ResourceSummary;
  dependencies: { id: string; kind: string }[];
  warnings?: string[];
}
export interface ValidationFailure {
  valid: false;
  error: { code?: string; message?: string };
}
export type ValidationResult = ValidationSuccess | ValidationFailure;

/** A rejected payload keeps its error and must not be published or saved. */
export function isValidationSuccess(
  result: ValidationResult | null | undefined,
): result is ValidationSuccess {
  return result !== null && result !== undefined && result.valid === true;
}

export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "未提供";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** `sha256:0123456789ab…` — enough to compare two releases by eye. */
export function shortHash(hash: string | undefined, keep = 12): string {
  if (!hash) return "未提供";
  const match = /^([A-Za-z0-9-]+):([a-fA-F0-9]+)$/.exec(hash);
  if (!match) return hash.length > keep ? `${hash.slice(0, keep)}…` : hash;
  const hex = match[2]!;
  return `${match[1]}:${hex.length > keep ? `${hex.slice(0, keep)}…` : hex}`;
}

function sizeOrNull(bytes: number | null | undefined): string {
  return typeof bytes === "number" ? formatSize(bytes) : "未提供";
}

const SOURCE_TITLES: Record<string, string> = {
  "upstream-library": "上游插件库引用",
  "trusted-local-adapter": "受信本机适配器",
  managed: "公共说明与技能组合",
  custom: "公共说明与技能组合",
};

const isManagedKind = (value: unknown): value is ManagedKind =>
  value === "agents" || value === "models" || value === "plugins" || value === "skills";

/** The lines an administrator reads about a payload the server has already validated. */
export function summaryLines(kind: ManagedKind, summary: ResourceSummary): string[] {
  const lines: string[] = [];
  const name = summary.name || summary.skillName || summary.pluginName;
  if (name) lines.push(`名称：${name}`);
  if (kind === "skills") {
    lines.push(`技能标识：${summary.skillName || summary.name || "未提供"}`);
    if (typeof summary.fileCount === "number") {
      const sample = summary.files ?? [];
      const listed = sample.slice(0, 3).join("、");
      lines.push(`文件：${summary.fileCount} 个${listed ? `（${listed}${sample.length > 3 ? " 等" : ""}）` : ""}`);
    }
    lines.push(`大小：${formatSize(summary.sizeBytes)}`);
    lines.push(`内容哈希：${shortHash(summary.contentHash)}`);
    return lines;
  }
  if (kind === "plugins") {
    lines.push(`插件标识：${summary.pluginName || "未提供"}`);
    lines.push(`来源：${SOURCE_TITLES[String(summary.source ?? "")] ?? "未记录"}`);
    if (summary.source === "upstream-library") lines.push(`上游版本：${summary.pluginVersion || "未提供"}`);
    else if (summary.source === "trusted-local-adapter") {
      lines.push(`适配器版本：${summary.adapterVersion || "未提供"}`);
      lines.push(`本机文件哈希：${shortHash(summary.adapterHash)}`);
    }
    else {
      lines.push(`关联技能：${(summary.skillResources ?? []).length} 个`);
      lines.push(`使用说明：${summary.instructionsLength ?? 0} 字`);
    }
    return lines;
  }
  if (kind === "agents") {
    lines.push(`关联模型：${summary.modelResource || "由用户自行选择"}`);
    lines.push(`关联技能：${(summary.skillResources ?? []).length} 个`);
    lines.push(`关联插件：${(summary.pluginResources ?? []).length} 个`);
    lines.push(`提示词：${summary.promptLength ?? 0} 字 · AGENTS.md：${summary.agentsMdLength ?? 0} 字`);
    if (summary.maxTurns !== undefined) lines.push(`最大轮数：${summary.maxTurns}`);
    else lines.push("最大轮数：沿用本机默认");
    return lines;
  }
  lines.push(`供应商：${summary.provider || "未提供"}`);
  lines.push(`模型 ID：${summary.modelId || "未提供"}`);
  lines.push(`上下文窗口：${sizeOrNull(summary.contextWindow)} · 最大输出：${sizeOrNull(summary.maxTokens)}`);
  return lines;
}

export interface ValidationReport {
  ok: boolean;
  title: string;
  details: string[];
  warnings: string[];
}

/** What the validation panel shows; a failure names its error code instead of a summary. */
export function validationReport(result: ValidationResult): ValidationReport {
  if (!isValidationSuccess(result)) {
    const error = result.error ?? {};
    return {
      ok: false,
      title: "校验未通过",
      details: [`原因：${error.message || "服务端未说明原因"}`],
      warnings: error.code ? [`错误码：${error.code}`] : [],
    };
  }
  return {
    ok: true,
    title: "校验通过",
    details: [
      ...summaryLines(result.kind, result.summary),
      ...(result.dependencies.length
        ? [`依赖：${result.dependencies.map(item => `${KIND_TITLES[item.kind] ?? item.kind} ${item.id}`).join("、")}`]
        : ["依赖：无"]),
    ],
    warnings: result.warnings ?? [],
  };
}

/** One history item as `/history` returns it; `summary` is new, `body` kept for old records. */
export interface ResourceVersion {
  version: number;
  created_at: string;
  current?: boolean;
  published?: boolean;
  summary?: ResourceSummary;
  audience?: string[];
  body?: {
    kind?: string;
    name?: string;
    description?: string;
    payload?: Record<string, unknown>;
    audience?: string[];
  };
}

export function versionTitle(item: ResourceVersion): string {
  return `v${item.version} · ${item.current ? "当前版本" : "历史版本"} · ${item.published ? "已发布" : "已下架"}`;
}

/** Only a published resource has a revision a rollback can be checked against. */
export function canRestore(item: ResourceVersion, publishedNow: boolean): boolean {
  return publishedNow && Number.isSafeInteger(item.version) && item.version > 0 && !item.current;
}

function audienceText(audience: string[] | undefined): string {
  if (!audience || audience.length === 0) return "仅管理员";
  return audience.includes("*") ? "全部用户" : `${audience.length} 个授权账号`;
}

/** A history item's lines: the summary when the server sent one, the retained body otherwise. */
export function versionSummaryLines(item: ResourceVersion, kind: ManagedKind): string[] {
  if (item.summary) return summaryLines(isManagedKind(item.summary.kind) ? item.summary.kind : kind, item.summary);
  const body = item.body;
  if (!body) return ["旧版本记录：没有可展示的摘要。"];
  const lines = [body.name ? `名称：${body.name}` : "名称：未记录"];
  if (body.description) lines.push(`说明：${body.description}`);
  const keys = Object.keys(body.payload ?? {});
  if (keys.length) lines.push(`内容字段：${keys.join("、")}`);
  lines.push(`受众：${audienceText(item.audience ?? body.audience)}`);
  return lines;
}

const DIFF_FIELDS: Record<ManagedKind, { key: keyof ResourceSummary; label: string }[]> = {
  skills: [
    { key: "fileCount", label: "文件数" },
    { key: "sizeBytes", label: "大小" },
    { key: "contentHash", label: "内容哈希" },
  ],
  plugins: [
    { key: "source", label: "来源" },
    { key: "pluginVersion", label: "上游版本" },
    { key: "adapterVersion", label: "适配器版本" },
    { key: "adapterHash", label: "本机文件哈希" },
    { key: "skillResources", label: "关联技能" },
    { key: "instructionsLength", label: "使用说明长度" },
  ],
  agents: [
    { key: "modelResource", label: "关联模型" },
    { key: "skillResources", label: "关联技能" },
    { key: "pluginResources", label: "关联插件" },
    { key: "promptLength", label: "提示词长度" },
    { key: "agentsMdLength", label: "AGENTS.md 长度" },
    { key: "maxTurns", label: "最大轮数" },
  ],
  models: [
    { key: "provider", label: "供应商" },
    { key: "modelId", label: "模型 ID" },
    { key: "contextWindow", label: "上下文窗口" },
    { key: "maxTokens", label: "最大输出" },
  ],
};

function fieldText(key: keyof ResourceSummary, value: unknown): string {
  if (value === undefined || value === null || value === "") return "未提供";
  if (Array.isArray(value)) return `${value.length} 个`;
  if (key === "sizeBytes" || key === "contextWindow" || key === "maxTokens") return sizeOrNull(value as number);
  if (key === "contentHash") return shortHash(String(value));
  if (key === "source") return SOURCE_TITLES[String(value)] ?? String(value);
  return String(value);
}

/** How restoring this version differs from the current one — said before the button is pressed. */
export function versionChanges(target: ResourceVersion, current: ResourceVersion | undefined, kind: ManagedKind): string[] {
  const next = target.summary;
  const now = current?.summary;
  if (!next || !now) return ["没有可比对的版本摘要；恢复仍会把历史内容记录为一个新版本。"];
  const changes: string[] = [];
  for (const { key, label } of DIFF_FIELDS[kind]) {
    const before = fieldText(key, now[key]);
    const after = fieldText(key, next[key]);
    if (before !== after) changes.push(`${label}：${before} → ${after}`);
  }
  return changes.length
    ? changes
    : ["与当前版本的内容摘要一致；恢复仍会记录为一个新版本，不改写历史。"];
}
