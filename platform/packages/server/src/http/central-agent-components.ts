import fs from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, zipSync } from "fflate";
import { parseSkillFrontmatter } from "@prismshadow/penguin-core";
import type { ControlStore, PublicResource } from "./control-plane.js";
import { parseSkillArchive } from "./routes/skills.js";
import { loadTrustedLocalAdapters } from "../auth/trusted-local-adapters.js";
import { toHookItem } from "../services/plugin-library.js";
import { HttpError } from "./errors.js";

/** Project-independent presentation of the exact resources used by an Agent definition. */
function componentResources(store: ControlStore, id: string, version: string) {
  const agent = version === "draft" ? store.get(id, true) : store.getVersion(id, Number(version));
  if (agent.kind !== "agents") throw new HttpError(400, "not_agent", "仅智能体支持组件列表。");
  let resources: PublicResource[];
  let warning = "";
  try {
    resources = version === "draft" ? store.list() :
      store.get(id).published && store.get(id).version === Number(version)
        ? store.resolveBundle(id, "", true).resources : store.versionBundle(id, Number(version)).resources;
  } catch (error) {
    // Older imported versions have no snapshots. Names can still be shown, but content cannot be asserted.
    if (!(error instanceof HttpError) || error.code !== "historical_dependencies_unpinned") throw error;
    resources = store.list();
    warning = "该历史版本未记录依赖快照；仅显示关联名称，无法预览或导出当时的内容。";
  }
  return {agent, resources, warning};
}

/** Count only components shown in the corresponding version's settings tabs. */
export function agentComponentCounts(store: ControlStore, id: string, version: string) {
  const {agent, resources} = componentResources(store, id, version);
  const references = (key: string, kind: string) => (agent.payload[key] as string[] ?? []).map(resourceId => {
    const resource = resources.find(item => item.id === resourceId && item.kind === kind);
    if (!resource) throw new HttpError(409, "component_missing", `关联组件不存在：${resourceId}`);
    return resource;
  });
  return {
    skillCount: references("skillResources", "skills").length,
    hookCount: references("pluginResources", "plugins").filter(item => item.payload.source === "trusted-local-adapter").length,
  };
}

export async function agentComponents(store: ControlStore, id: string, version: string) {
  const {agent, resources, warning} = componentResources(store, id, version);
  const find = (resourceId: string, kind: string) => {
    const resource = resources.find(item => item.id === resourceId && item.kind === kind);
    if (!resource) throw new HttpError(409, "component_missing", `关联${kind === "skills" ? "技能" : "插件"}不存在：${resourceId}`);
    return resource;
  };
  const skills = (agent.payload.skillResources as string[] ?? []).map(resourceId => {
    const resource = find(resourceId, "skills");
    const name = String(resource.payload.skillName ?? resource.name);
    if (warning) return {resourceId, name, description: resource.description, version: "", files: {}, archiveBase64: ""};
    const packed = typeof resource.payload.archiveBase64 === "string"
      ? parseSkillArchive(Buffer.from(resource.payload.archiveBase64, "base64")).files
      : new Map([["SKILL.md", strToU8(String(resource.payload.content ?? ""))]]);
    const metadata = parseSkillFrontmatter(strFromU8(packed.get("SKILL.md")!));
    const files: Record<string,string> = {};
    const decoder = new TextDecoder("utf-8", {fatal:true});
    for (const [name,data] of packed) try { if (!data.includes(0)) files[name] = decoder.decode(data); } catch { /* Binary files remain in export. */ }
    return {resourceId, name, description: metadata?.description ?? resource.description,
      version: String(resource.version), shortDescription: metadata?.shortDescription, shortDescriptionZh: metadata?.shortDescriptionZh,
      icon: files["icon.svg"], files,
      archiveBase64: Buffer.from(zipSync(Object.fromEntries([...packed].map(([file,data])=>[`${name}/${file}`,data])))).toString("base64")};
  });
  const hooks = [];
  const unavailable: string[] = [];
  for (const resourceId of agent.payload.pluginResources as string[] ?? []) {
    const resource = find(resourceId, "plugins");
    // Plugins that only contain instructions, tools or skills are not hook packages.
    if (resource.payload.source !== "trusted-local-adapter") continue;
    const name = String(resource.payload.pluginName);
    if (warning) { hooks.push({resourceId, name, description:resource.description, version:"", events:[], archiveBase64:""}); continue; }
    try {
      const [hook] = await loadTrustedLocalAdapters(process.env.AITEST_ENGINE_ROOT ?? process.cwd(), [{name, version:String(resource.payload.adapterVersion), hash:String(resource.payload.adapterHash)}]);
      const files:Record<string,Uint8Array> = {};
      for (const entry of await fs.readdir(hook!.dir, {withFileTypes:true})) {
        if (entry.isFile() && /\.(json|mjs|svg)$/.test(entry.name)) files[`${name}/${entry.name}`] = await fs.readFile(path.join(hook!.dir,entry.name));
      }
      hooks.push({...toHookItem(hook!),resourceId,archiveBase64:Buffer.from(zipSync(files)).toString("base64")});
    } catch {
      unavailable.push(`${name}：服务端缺少匹配版本的钩子包，暂不可导出。`);
      hooks.push({resourceId,name,description:resource.description,version:String(resource.payload.adapterVersion),events:[],archiveBase64:""});
    }
  }
  return {skills,hooks,warning:[warning,...unavailable].filter(Boolean).join("\n")};
}
