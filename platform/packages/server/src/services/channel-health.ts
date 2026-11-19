/**
 * Model channel health (GET /api/projects/:p/models/health) — §6.2 of the P5 plan:
 * "管理端配了 ≠ 运行时能用".
 *
 * The admin page already probes a channel (POST /models/detect, POST /models/test), but the
 * answer used to live in the page's memory only: reload the tab and "was this channel
 * reachable five minutes ago?" is unanswerable, and nothing at run time could ever see it.
 * That is the same shape of gap as the tool ledger before M1 — a fact exists, at exactly one
 * place, and the place is a browser session.
 *
 * So the probe result is written here, to `<engine root>/output/runtime/channel-health.json`,
 * the file tree that already holds `tool-usage.jsonl`: run-time code can read it, the admin
 * page can read it back, and it is not another database to keep in sync.
 *
 * Three deliberate choices:
 *
 * 1. **No engine root, no record.** The server may be deployed without
 *    `AITEST_ENGINE_ROOT`; then there is no run time to inform. We answer
 *    `{enforced: false, reason: "engine_root_unset"}` and write nothing — a health file at a
 *    guessed path would be read by nobody and look like a working feature.
 * 2. **A failed probe is a record, not an error.** An unreachable channel is exactly the
 *    fact worth keeping; throwing would push it into the error centre and lose it.
 * 3. **Bounded.** One entry per (base URL, protocol), newest first, 50 per Project. A health
 *    file that grows without limit eventually becomes the reason nobody reads it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelProtocolProbeDto } from "../api/types.js";

/** Relative to the engine root; the folder `tool-gate` already writes usage into. */
export const CHANNEL_HEALTH_PATH = "output/runtime/channel-health.json";
/** How many entries one Project keeps. */
export const CHANNEL_HEALTH_LIMIT = 50;

export type ChannelHealthStatus = "reachable" | "unreachable";

export interface ChannelHealthEntry {
  baseUrl: string;
  /** The protocol the endpoint answered with, when one did. */
  protocol: string | null;
  status: ChannelHealthStatus;
  /** HTTP status of the probe that decided the verdict, when a response arrived at all. */
  statusCode: number | null;
  /** Which admin action produced this reading. */
  source: "detect" | "test";
  checkedAt: string;
  /** Per-probe outcomes, kept because "unreachable" alone does not say at which layer. */
  probes: { clientType: string; outcome: string; status?: number }[];
}

interface HealthFile {
  version: 1;
  updated_at: string;
  projects: Record<string, ChannelHealthEntry[]>;
}

export interface ChannelHealthReading {
  /** False when no engine root is configured: there is no run-time view to write or read. */
  enforced: boolean;
  reason?: "engine_root_unset";
  path: string | null;
  updatedAt: string | null;
  entries: ChannelHealthEntry[];
}

function engineRoot(): string | null {
  const root = (process.env.AITEST_ENGINE_ROOT ?? "").trim();
  return root ? resolve(root) : null;
}

function healthPath(root: string): string {
  return resolve(root, CHANNEL_HEALTH_PATH);
}

function readFile(root: string): HealthFile {
  const path = healthPath(root);
  if (!existsSync(path)) return { version: 1, updated_at: new Date().toISOString(), projects: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<HealthFile>;
    return {
      version: 1,
      updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date().toISOString(),
      projects: value.projects && typeof value.projects === "object" && !Array.isArray(value.projects) ? value.projects as Record<string, ChannelHealthEntry[]> : {},
    };
  } catch {
    // A corrupt file must not take the admin page down; it also must not be silently
    // overwritten with an empty map before the caller has seen that it was corrupt —
    // `read` reports `updatedAt: null` in that case (see below).
    return { version: 1, updated_at: "", projects: {} };
  }
}

/**
 * Record one probe outcome. Returns whether it landed, so a caller can say "recorded to
 * / not recorded because" instead of assuming success.
 */
export function recordChannelHealth(input: {
  projectId: string;
  baseUrl: string;
  protocol: string | null;
  probes: ModelProtocolProbeDto[];
  source: "detect" | "test";
  /** Overrides the verdict derived from `probes` (POST /models/test reports `ok` directly). */
  status?: ChannelHealthStatus;
}): { recorded: boolean; reason?: "engine_root_unset" } {
  const root = engineRoot();
  if (!root) return { recorded: false, reason: "engine_root_unset" };
  const file = readFile(root);
  const firstAnswer = input.probes.find(item => typeof item.status === "number");
  const entry: ChannelHealthEntry = {
    baseUrl: input.baseUrl,
    protocol: input.protocol,
    status: input.status ?? (input.protocol ? "reachable" : "unreachable"),
    statusCode: firstAnswer?.status ?? null,
    source: input.source,
    checkedAt: new Date().toISOString(),
    probes: input.probes.map(item => ({ clientType: item.clientType, outcome: String(item.outcome), ...(typeof item.status === "number" ? { status: item.status } : {}) })),
  };
  const existing = (file.projects[input.projectId] ?? []).filter(
    item => !(item.baseUrl === entry.baseUrl && item.protocol === entry.protocol),
  );
  file.projects[input.projectId] = [entry, ...existing]
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, CHANNEL_HEALTH_LIMIT);
  file.updated_at = entry.checkedAt;
  const path = healthPath(root);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic replace: the run-time reader polls this file, and a half-written JSON would be
  // read as "no channel is healthy", which is the worst possible wrong answer here.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(file, null, 2));
  renameSync(temporary, path);
  return { recorded: true };
}

/** Read one Project's health. An unconfigured engine root is an answer, not an error. */
export function readChannelHealth(projectId: string): ChannelHealthReading {
  const root = engineRoot();
  if (!root) return { enforced: false, reason: "engine_root_unset", path: null, updatedAt: null, entries: [] };
  const file = readFile(root);
  return {
    enforced: true,
    path: CHANNEL_HEALTH_PATH,
    updatedAt: file.updated_at || null,
    entries: file.projects[projectId] ?? [],
  };
}
