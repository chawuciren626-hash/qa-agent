import { createHash } from "node:crypto";
import type { PublicResource, ResourceKind } from "../http/control-plane.js";

export interface PublishedResourceRef {
  id: string;
  kind: ResourceKind;
  version: number;
  contentHash: string;
}

export interface ResolvedPublishedBundle {
  rootId: string;
  versions: PublishedResourceRef[];
  bundleHash: string;
  resources: PublicResource[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Hash only immutable published content; mutable database status and draft revision are excluded. */
export function publishedResourceRef(resource: PublicResource): PublishedResourceRef {
  const { kind, name, description, payload, audience } = resource;
  return {
    id: resource.id,
    kind,
    version: resource.version,
    contentHash: `sha256:${sha256(JSON.stringify({ kind, name, description, payload, audience }))}`,
  };
}

export function resolvedBundleHash(versions: readonly PublishedResourceRef[]): string {
  return `sha256:${sha256(JSON.stringify(versions))}`;
}

/** Validate a central response before a local machine writes it into its immutable cache. */
export function validateResolvedBundle(value: unknown): ResolvedPublishedBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid published bundle");
  const bundle = value as ResolvedPublishedBundle;
  if (!/^[a-f0-9-]{36}$/.test(bundle.rootId) || !Array.isArray(bundle.versions) || !Array.isArray(bundle.resources) ||
    bundle.versions.length === 0 || bundle.versions.length !== bundle.resources.length || bundle.versions.length > 100 ||
    bundle.versions[0]?.id !== bundle.rootId) throw Error("Invalid published bundle manifest");
  const seen = new Set<string>();
  if (bundle.resources[0]?.kind !== "agents") throw Error("Published bundle root must be an Agent");
  for (let i = 0; i < bundle.versions.length; i++) {
    const ref = bundle.versions[i]!;
    const resource = bundle.resources[i]!;
    if (!/^[a-f0-9-]{36}$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 || seen.has(ref.id) ||
      resource.id !== ref.id || resource.kind !== ref.kind || resource.version !== ref.version ||
      ref.contentHash !== publishedResourceRef(resource).contentHash) throw Error("Published resource mismatch");
    seen.add(ref.id);
  }
  for (const resource of bundle.resources) {
    const payload = resource.payload;
    const dependencies: [unknown, ResourceKind][] = [
      ...(payload.modelResource ? [[payload.modelResource, "models"]] as [unknown, ResourceKind][] : []),
      ...(Array.isArray(payload.skillResources) ? payload.skillResources.map(id => [id, "skills"] as [unknown, ResourceKind]) : []),
      ...(Array.isArray(payload.pluginResources) ? payload.pluginResources.map(id => [id, "plugins"] as [unknown, ResourceKind]) : []),
    ];
    for (const [id, kind] of dependencies) {
      const target = bundle.resources.find(item => item.id === id);
      if (!target || target.kind !== kind) throw Error("Published bundle dependency is missing");
    }
  }
  if (bundle.bundleHash !== resolvedBundleHash(bundle.versions)) throw Error("Published bundle hash mismatch");
  return bundle;
}
