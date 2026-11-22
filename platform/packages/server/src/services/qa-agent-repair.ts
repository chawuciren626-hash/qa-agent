import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentsDir, defaultSystemConfig, systemConfigPath } from "@prismshadow/penguin-core";
import { stringify } from "yaml";
import { HttpError } from "../http/errors.js";

type RepairEngine = {
  fillMissingQaAgentResources(root: string, ids: readonly string[]): void;
  qaRoleTools(id: string, tools: unknown): Promise<unknown>;
};

/** Do not follow links or overwrite an unexpected type, even in a partial Agent tree. */
async function existsPlain(root: string, target: string, directory: boolean): Promise<boolean> {
  const resolved = path.resolve(root);
  const relative = path.relative(resolved, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid local Agent path");
  let current = resolved;
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const info = await fs.lstat(current).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return false;
    if (info.isSymbolicLink() || (!(directory || index < components.length - 1) ? !info.isFile() : !info.isDirectory())) {
      throw new HttpError(409, "qa_agent_path_conflict", "本地 Agent 目录有链接或文件类型冲突，未覆盖现有文件。");
    }
  }
  return true;
}

export async function inspectQaAgentStates(root: string, projectId: string, ids: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const id of ids) {
    const config = systemConfigPath(root, projectId, id);
    if (await existsPlain(root, path.join(path.dirname(config), "shared-agent.json"), false)) continue;
    if (!await existsPlain(root, config, false)) missing.push(id);
  }
  return missing;
}

/** Explicit repair for bundled projects only: preserve every existing file and commit config last. */
export async function repairQaAgentStates(
  root: string,
  projectId: string,
  ids: readonly string[],
  engine: RepairEngine,
  listAgents: () => Promise<readonly { agentId: string }[]>,
): Promise<string[]> {
  const missing = await inspectQaAgentStates(root, projectId, ids);
  for (const id of missing) {
    const file = systemConfigPath(root, projectId, id);
    const config = defaultSystemConfig();
    if (id !== "default_agent" && config.tools) {
      const builtin = await engine.qaRoleTools(id, config.tools.builtin);
      Object.assign(config.tools, { builtin });
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await existsPlain(root, path.dirname(file), true);
    engine.fillMissingQaAgentResources(agentsDir(root, projectId), [id]);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, stringify({ ...config, name: id }), { flag: "wx", mode: 0o600 });
    try {
      // Link to the complete file without replacing a concurrently created config.
      await fs.link(tmp, file);
    } finally {
      await fs.unlink(tmp);
    }
  }
  // The regular Agent index adopts valid local configs, including partial work from a prior retry.
  const indexed = new Set((await listAgents()).map(agent => agent.agentId));
  if (missing.some(id => !indexed.has(id))) throw new Error("Could not index repaired QA Agents");
  return missing;
}
