/**
 * The normal-user capability catalog: a read-only projection of what an administrator published
 * (`GET /api/control/catalog`) and what this project already obtained
 * (`GET /api/control/applied`), frozen in `docs/api-q1-capability-2026-11-02.md` §2.6.
 *
 * It answers three questions without offering a single write: which agent templates, skills,
 * plugins and models are available, which agents they belong to, and whether the local copy is
 * behind the published one. A running task keeps the references it started with; this module
 * therefore only reports `applied < version`, never "update now".
 */
import type { AppliedResource, ManagedKind, ManagedResource } from "../../lib/managed-resources";

export type CapabilityState = "current" | "upgradable" | "unapplied";

export interface CapabilityAgentRef {
  id: string;
  name: string;
}

export interface CapabilityEntry {
  id: string;
  kind: ManagedKind;
  name: string;
  description: string;
  version: number;
  state: CapabilityState;
  applied: { agentId: string; version: number }[];
  assignedAgents: CapabilityAgentRef[];
  hints: string[];
}

export interface CapabilityDirectory {
  entries: CapabilityEntry[];
  byKind: Record<ManagedKind, CapabilityEntry[]>;
  counts: { total: number; upgradable: number; current: number; unapplied: number };
}

export const CATALOG_KINDS: { kind: ManagedKind; title: string }[] = [
  { kind: "agents", title: "智能体模板" },
  { kind: "skills", title: "技能" },
  { kind: "plugins", title: "插件" },
  { kind: "models", title: "模型" },
];

const KIND_TITLES: Record<ManagedKind, string> = {
  agents: "智能体",
  models: "模型",
  plugins: "插件",
  skills: "技能",
};

/** Only real ids count: a payload edited elsewhere may hold a non-string or an empty value. */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** Dependencies a published agent declares; the catalog shows them as "assigned to" links. */
export function declaredDependencies(resource: ManagedResource): { id: string; kind: ManagedKind }[] {
  if (resource.kind !== "agents") return [];
  const payload = resource.payload;
  return [
    ...(typeof payload.modelResource === "string" && payload.modelResource
      ? [{ id: payload.modelResource, kind: "models" as const }]
      : []),
    ...idList(payload.skillResources).map(id => ({ id, kind: "skills" as const })),
    ...idList(payload.pluginResources).map(id => ({ id, kind: "plugins" as const })),
  ];
}

function appliedFor(resourceId: string, applied: AppliedResource[]): { agentId: string; version: number }[] {
  const rows = applied.filter(row => row.resourceId === resourceId);
  const latest = new Map<string, number>();
  for (const row of rows) latest.set(row.agentId, Math.max(latest.get(row.agentId) ?? 0, row.version));
  return [...latest.entries()]
    .map(([agentId, version]) => ({ agentId, version }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function stateOf(latest: number, version: number): CapabilityState {
  if (latest <= 0) return "unapplied";
  return latest >= version ? "current" : "upgradable";
}

function appliedHints(state: CapabilityState, latest: number, version: number): string[] {
  if (state === "current") return [`本机已获取发布版本 v${version}`];
  if (state === "upgradable") {
    return [`本机 v${latest} → 发布 v${version}；获取后只对之后启动的任务生效`];
  }
  return ["尚未获取到本机；获取入口在原有功能页，管理员发布不会自动下发"];
}

/**
 * Builds the catalog from two server answers only. No payload content, archive or credential is
 * interpreted here; a dependency hint names the published versions, never claims to show a diff
 * of file contents the server did not send.
 */
export function buildCapabilityCatalog(resources: ManagedResource[], applied: AppliedResource[]): CapabilityDirectory {
  const agentsByDependency = new Map<string, CapabilityAgentRef[]>();
  for (const resource of resources) {
    if (resource.kind !== "agents") continue;
    for (const dependency of declaredDependencies(resource)) {
      const key = `${dependency.kind}:${dependency.id}`;
      const list = agentsByDependency.get(key) ?? [];
      list.push({ id: resource.id, name: resource.name });
      agentsByDependency.set(key, list);
    }
  }

  const entries = resources.map((resource): CapabilityEntry => {
    const latestRows = appliedFor(resource.id, applied);
    const latest = Math.max(0, ...latestRows.map(row => row.version));
    const state = stateOf(latest, resource.version);
    return {
      id: resource.id,
      kind: resource.kind,
      name: resource.name,
      description: resource.description,
      version: resource.version,
      state,
      applied: latestRows,
      assignedAgents: (agentsByDependency.get(`${resource.kind}:${resource.id}`) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, "zh-CN"),
      ),
      hints: appliedHints(state, latest, resource.version),
    };
  });

  // A second pass adds the dependency gap to an agent template: the only honest "diff" the
  // catalog can show without a payload, and it never implies the local copy changes by itself.
  // A dependency the project already has at the published version is not a gap.
  const byId = new Map(entries.map(entry => [`${entry.kind}:${entry.id}`, entry]));
  for (const agent of entries.filter(entry => entry.kind === "agents")) {
    const resource = resources.find(item => item.id === agent.id)!;
    const gaps: string[] = [];
    for (const dependency of declaredDependencies(resource)) {
      const entry = byId.get(`${dependency.kind}:${dependency.id}`);
      if (!entry || entry.state === "current") continue;
      const local = entry.applied[0];
      gaps.push(
        local
          ? `关联${KIND_TITLES[dependency.kind]}「${entry.name}」本机 v${local.version} → 发布 v${entry.version}`
          : `关联${KIND_TITLES[dependency.kind]}「${entry.name}」尚未获取（发布 v${entry.version}）`,
      );
    }
    agent.hints = [...agent.hints, ...gaps];
  }

  const byKind = { agents: [], models: [], plugins: [], skills: [] } as Record<ManagedKind, CapabilityEntry[]>;
  for (const entry of entries) byKind[entry.kind].push(entry);
  for (const kind of Object.keys(byKind) as ManagedKind[]) {
    byKind[kind].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }
  const counts = {
    total: entries.length,
    upgradable: entries.filter(entry => entry.state === "upgradable").length,
    current: entries.filter(entry => entry.state === "current").length,
    unapplied: entries.filter(entry => entry.state === "unapplied").length,
  };
  return { entries, byKind, counts };
}

export function stateLabel(state: CapabilityState): string {
  return state === "current" ? "已获取" : state === "upgradable" ? "有更新" : "未获取";
}

/** What the project has on this machine, as the catalog's last column reads it. */
export function appliedLabel(entry: CapabilityEntry): string {
  if (entry.applied.length === 0) return "本机无副本";
  return entry.applied
    .map(row => `${row.agentId} v${row.version}`)
    .join("、");
}
