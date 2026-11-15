import type { ModelsResponse } from "@prismshadow/penguin-server/api";
import { controlRequest } from "../../api/control";
import type { RowState } from "./models-page";

export interface CentralModelResource {
  id: string;
  kind: string;
  name: string;
  description: string;
  payload: Record<string, unknown>;
  audience: string[];
  revision: number;
  published: boolean;
  version: number;
}

const key = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

export async function centralModelsOverLocal(local: ModelsResponse): Promise<{ response: ModelsResponse; resources: CentralModelResource[] }> {
  const catalog = await controlRequest("/api/control/admin/resources") as { resources: CentralModelResource[] };
  const resources = catalog.resources.filter(item => item.kind === "models");
  const localRows = new Map(local.models.map(model => [key(model.provider, model.modelId), model]));
  const models: ModelsResponse["models"] = resources.map(resource => {
    const payload = resource.payload;
    const provider = String(payload.provider ?? "");
    const modelId = String(payload.modelId ?? "");
    const original = localRows.get(key(provider, modelId));
    const pricing = payload.pricing && typeof payload.pricing === "object" ? payload.pricing as Record<string, number> : null;
    return {
      ...original,
      provider, modelId,
      displayName: resource.name,
      vision: payload.vision !== false,
      ...(typeof payload.contextWindow === "number" ? { contextWindow: payload.contextWindow } : {}),
      ...(typeof payload.maxTokens === "number" ? { maxTokens: payload.maxTokens } : {}),
      ...(typeof payload.fastMode === "boolean" ? { fastMode: payload.fastMode } : {}),
      ...(pricing ? { pricing: { cacheRead: pricing.cacheRead ?? 0, cacheWrite: pricing.cacheWrite ?? 0, output: pricing.output ?? 0 } } : {}),
      effective: original?.effective ?? { baseUrlSource: "none", clientTypeSource: "none", apiKeySource: "none" },
      isDefault: original?.isDefault ?? false,
    };
  });
  return { response: { ...local, models }, resources };
}

export async function saveCentralModelChanges(rows: RowState[], resources: CentralModelResource[]): Promise<void> {
  const byKey = new Map(resources.map(resource => [key(String(resource.payload.provider ?? ""), String(resource.payload.modelId ?? "")), resource]));
  for (const row of rows) {
    const existing = byKey.get(key(row.provider, row.modelId));
    const payload = {
      ...(existing?.payload ?? {}), provider: row.provider, modelId: row.modelId,
      vision: row.vision, fastMode: row.fastMode,
      ...(row.contextWindow ? { contextWindow: Number(row.contextWindow) } : {}),
      ...(row.maxTokens ? { maxTokens: Number(row.maxTokens) } : {}),
      ...(row.clientType ? { clientType: row.clientType } : {}),
      ...(row.cacheRead || row.cacheWrite || row.output ? { pricing: { ...(existing?.payload.pricing as Record<string, number> ?? {}), cacheRead: Number(row.cacheRead || 0), cacheWrite: Number(row.cacheWrite || 0), output: Number(row.output || 0) } } : {}),
    };
    const name = row.displayName || row.modelId;
    if (existing && existing.name === name && JSON.stringify(existing.payload) === JSON.stringify(payload)) continue;
    const saved = await controlRequest(`/api/control/admin/resources${existing ? `/${existing.id}` : ""}`, existing ? "PUT" : "POST", {
      kind: "models", name, description: existing?.description ?? "", payload,
      audience: existing?.audience?.length ? existing.audience : ["*"],
      ...(existing ? { revision: existing.revision } : {}),
    }) as CentralModelResource;
    await controlRequest(`/api/control/admin/resources/${saved.id}/publish`, "POST", { revision: saved.revision });
  }
}
