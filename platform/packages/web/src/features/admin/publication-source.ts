import type { AgentConfigResponse, AgentSummary, ModelInfo, PluginItem } from "@prismshadow/penguin-server/api";

/** Explicit publication projection. Never spread a project/config/credential DTO into a payload. */
export function agentPublication(agent: AgentSummary, source: AgentConfigResponse) {
  return {
    name: agent.name || agent.agentId, description: agent.description || "",
    payload: {
      prompt: source.config.systemPrompt, agentsMd: source.agentsMd,
      ...(source.config.maxTurns === undefined ? {} : { maxTurns: source.config.maxTurns }),
      modelResource: "", skillResources: [], pluginResources: [],
    },
  };
}

export function modelPublication(model: ModelInfo) {
  const payload: Record<string, unknown> = {
    provider: model.provider, modelId: model.modelId,
    baseUrl: model.effective.baseUrl || "", clientType: model.effective.clientType || "",
    vision: model.vision !== false,
  };
  for (const key of ["contextWindow", "maxTokens", "fastMode", "pricing", "discount"] as const) {
    if (model[key] !== undefined) payload[key] = model[key];
  }
  return { name: model.displayName || model.modelId, description: model.provider, payload };
}

export function pluginPublication(plugin: PluginItem) {
  return {
    name: plugin.titleZh || plugin.title || plugin.name,
    description: plugin.descriptionZh || plugin.description || "",
    payload: { pluginName: plugin.name, pluginVersion: plugin.version, source: "upstream-library" },
  };
}
