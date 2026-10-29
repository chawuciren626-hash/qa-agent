/** One-time, repeatable import of shipped product presets into the central draft library.
 * Run with: tsx scripts/import-upstream-public-catalog.ts --db <web.db> --agents <source/penguin/agents> --skills <source/skills> [--apply]
 * The default is a read-only inventory. Existing administrator drafts are never overwritten.
 */
import { DatabaseSync } from "node:sqlite";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { loadLibraryPlugins } from "@prismshadow/penguin-core";
import { MODEL_CATALOG, providerClientType, providerInfo } from "../src/model-catalog/catalog.js";
import { ControlStore, publicPayload, type ResourceKind } from "../src/http/control-plane.js";

type Preset = { kind: ResourceKind; sourceKey: string; name: string; description: string; payload: Record<string, unknown> };
function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const dbPath = option("--db");
const agentsPath = option("--agents");
const skillsPath = option("--skills");
const apply = process.argv.includes("--apply");
if (!dbPath || !agentsPath || !skillsPath) throw new Error("Specify --db, --agents and --skills.");

const presets: Preset[] = [];
for (const entry of MODEL_CATALOG.filter(row => !row.retired)) {
  const group = providerInfo(entry.provider);
  const sourcePricing = entry.pricing as Record<string, number | string> | undefined;
  const pricing = sourcePricing ? Object.fromEntries([
    ["output", sourcePricing.output],
    ["cacheRead", sourcePricing.cache_read], ["cacheWrite", sourcePricing.cache_write],
  ].filter((item): item is [string, number] => typeof item[1] === "number")) : undefined;
  const payload: Record<string, unknown> = {
    provider: entry.provider, modelId: entry.modelId, vision: entry.supportsVision,
    ...(entry.baseUrl || group?.gatewayBaseUrl ? { baseUrl: entry.baseUrl || group?.gatewayBaseUrl } : {}),
    ...(entry.clientType || providerClientType(entry.provider) ? { clientType: entry.clientType || providerClientType(entry.provider) } : {}),
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    ...(pricing && Object.keys(pricing).length ? { pricing } : {}),
    ...(entry.discount ? { discount: entry.discount } : {}),
  };
  presets.push({ kind: "models", sourceKey: `${entry.provider}/${entry.modelId}`,
    name: entry.displayName, description: `${group?.label || entry.provider} · 上游模型预设`, payload });
}

for (const plugin of loadLibraryPlugins().filter(item => item.source !== "installed")) {
  presets.push({ kind: "plugins", sourceKey: plugin.name,
    name: plugin.titleZh || plugin.title || plugin.name, description: plugin.descriptionZh || plugin.description,
    payload: { pluginName: plugin.name, pluginVersion: plugin.version, source: "upstream-library" } });
  for (const skill of plugin.skills) {
    const files: Record<string, Uint8Array> = { [`${skill.name}/SKILL.md`]: strToU8(skill.content) };
    for (const [relative, content] of Object.entries(skill.files || {})) files[`${skill.name}/${relative}`] = strToU8(content);
    const archive = Buffer.from(zipSync(files));
    presets.push({ kind: "skills", sourceKey: `${plugin.name}/${skill.name}`, name: skill.name,
      description: skill.description || `上游插件 ${plugin.name} 的技能`,
      payload: { skillName: skill.name, archiveBase64: archive.toString("base64"), fileNames: Object.keys(files) } });
  }
}

for (const directory of readdirSync(skillsPath, { withFileTypes: true }).filter(item => item.isDirectory())) {
  const files: Record<string, Uint8Array> = {};
  const walk = (root: string, relative = "") => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (lstatSync(full).isSymbolicLink()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, child);
      else if (entry.isFile()) files[`${directory.name}/${child}`] = readFileSync(full);
    }
  };
  walk(join(skillsPath, directory.name));
  const archive = Buffer.from(zipSync(files));
  presets.push({ kind: "skills", sourceKey: `engine/${directory.name}`, name: directory.name,
    description: `AITestHarness 内置测试技能 · ${directory.name}`,
    payload: { skillName: directory.name, archiveBase64: archive.toString("base64"), fileNames: Object.keys(files) } });
}

for (const directory of readdirSync(agentsPath, { withFileTypes: true }).filter(item => item.isDirectory())) {
  const content = readFileSync(join(agentsPath, directory.name, "AGENTS.md"), "utf8");
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || directory.name;
  presets.push({ kind: "agents", sourceKey: directory.name, name: heading,
    description: `上游内置智能体模板 · ${directory.name}`,
    payload: { prompt: "", agentsMd: content, modelResource: "", skillResources: [], pluginResources: [] } });
}

for (const preset of presets) publicPayload(preset.kind, preset.payload);
const counts = Object.fromEntries((["models", "plugins", "skills", "agents"] as const).map(kind => [kind, presets.filter(item => item.kind === kind).length]));
if (!apply) { console.log(JSON.stringify({ mode: "preview", counts, total: presets.length })); process.exit(0); }

const db = new DatabaseSync(dbPath);
const store = new ControlStore(db);
db.exec("CREATE TABLE IF NOT EXISTS public_resource_upstream (kind TEXT NOT NULL, source_key TEXT NOT NULL, resource_id TEXT NOT NULL UNIQUE, PRIMARY KEY(kind,source_key))");
const mapped = db.prepare("SELECT resource_id FROM public_resource_upstream WHERE kind=? AND source_key=?");
const link = db.prepare("INSERT INTO public_resource_upstream(kind,source_key,resource_id) VALUES (?,?,?)");
const imported: Record<string, number> = { models: 0, plugins: 0, skills: 0, agents: 0 };
db.exec("BEGIN IMMEDIATE");
try {
  for (const preset of presets) {
    if (mapped.get(preset.kind, preset.sourceKey)) continue;
    const resource = store.save("upstream-import", { kind: preset.kind, name: preset.name,
      description: preset.description, payload: preset.payload, audience: [] });
    link.run(preset.kind, preset.sourceKey, resource.id);
    imported[preset.kind] += 1;
  }
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
console.log(JSON.stringify({ mode: "applied", available: counts, imported, total: Object.values(imported).reduce((a, b) => a + b, 0) }));
