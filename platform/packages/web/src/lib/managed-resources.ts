export type ManagedKind = "agents" | "models" | "plugins" | "skills";
export interface ManagedResource {
  id: string;
  kind: ManagedKind;
  name: string;
  description: string;
  version: number;
  payload: Record<string, unknown>;
}
export interface AppliedResource {
  resourceId: string;
  version: number;
  agentId: string;
}

/** Imported templates have their own version trail, independent of upstream package versions. */
export function appliedVersion(resource: ManagedResource, applied: AppliedResource[], agentId?: string) {
  return Math.max(0, ...applied.filter(row => row.resourceId === resource.id &&
    (agentId === undefined || resource.kind === "models" || row.agentId === agentId)).map(row => row.version));
}

export function managedUpdateNotes(resources: ManagedResource[], applied: AppliedResource[]) {
  const counts: Record<string, number> = {};
  for (const resource of resources) {
    const installed = appliedVersion(resource, applied);
    if (!installed || installed >= resource.version) continue;
    // Skills live in the existing plugin market's Skills tab.
    const route = resource.kind === "skills" ? "/plugins" : `/${resource.kind}`;
    counts[route] = (counts[route] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([route, count]) =>
    [route, `管理员配置：${count} 项已有本地副本可获取新版本`]));
}
