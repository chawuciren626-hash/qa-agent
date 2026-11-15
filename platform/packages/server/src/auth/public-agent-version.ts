import type { PublicResource } from "../http/control-plane.js";

export const MANAGED_AGENT_FIELDS = ["name", "description", "prompt", "agentsMd", "maxTurns"] as const;
export type ManagedAgentField = typeof MANAGED_AGENT_FIELDS[number];
export type ManagedAgentValues = Partial<Record<ManagedAgentField, string | number>>;
export type AgentResolution = Partial<Record<ManagedAgentField, "local" | "published">>;

export function publishedAgentValues(resource: PublicResource): ManagedAgentValues {
  return {
    name: resource.name,
    description: resource.description,
    prompt: String(resource.payload.prompt ?? ""),
    agentsMd: String(resource.payload.agentsMd ?? ""),
    ...(resource.payload.maxTurns === undefined ? {} : { maxTurns: Number(resource.payload.maxTurns) }),
  };
}

export function currentAgentValues(response: any): ManagedAgentValues {
  return {
    name: response.config.name ?? "",
    description: response.config.description ?? "",
    prompt: response.config.systemPrompt ?? "",
    agentsMd: response.agentsMd ?? "",
    ...(response.config.maxTurns === undefined ? {} : { maxTurns: response.config.maxTurns }),
  };
}

/** A missing baseline is treated as a conflict so legacy installs never lose local edits silently. */
export function planAgentUpdate(previous: ManagedAgentValues | null, current: ManagedAgentValues, published: ManagedAgentValues, resolutions: AgentResolution = {}) {
  const fields = MANAGED_AGENT_FIELDS.filter(key => published[key] !== undefined).map(key => {
    const local = current[key];
    const before = previous?.[key];
    const next = published[key];
    const conflict = local !== next && (previous === null || (local !== before && next !== before));
    const choice = resolutions[key];
    const keepLocal = (conflict && choice === "local") || (previous !== null && local !== before && next === before);
    return { key, previous: before ?? null, local: local ?? null, published: next ?? null, conflict,
      value: keepLocal ? local : next };
  });
  return { fields, unresolved: fields.filter(field => field.conflict && !resolutions[field.key]).map(field => field.key),
    values: Object.fromEntries(fields.map(field => [field.key, field.value])) as ManagedAgentValues };
}
