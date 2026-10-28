/** Only called while creating a new project, inside its rollback boundary. */
import fs from "node:fs/promises";
import path from "node:path";
import { loadAgentState } from "@prismshadow/penguin-core";
import { parseDocument } from "yaml";
import { qaEnabled, qaEngineModule } from "./qa-engine.js";

export async function provisionQaProject(root: string, projectId: string): Promise<string[]> {
  if (!qaEnabled) return [];
  const engine = qaEngineModule("qa-project-bootstrap");
  const roles: { id: string }[] = engine.qaRoles();
  for (const { id } of roles) await loadAgentState({ root, projectId, agentId: id, init: {} });
  engine.initializeQaRoles(path.join(root, projectId, "agents"));
  for (const { id } of roles) {
    const file = path.join(root, projectId, "agents", id, "agent_state", "system_config.yaml");
    const doc = parseDocument(await fs.readFile(file, "utf8"));
    const tools = doc.toJS().tools?.builtin;
    doc.setIn(["tools", "builtin"], await engine.qaRoleTools(id, tools));
    await fs.writeFile(file, doc.toString());
  }
  await fs.writeFile(path.join(root, projectId, "qa-project.json"), JSON.stringify({
    version: 1, status: "ready", projectId, source: "bundled-testing-template",
  }, null, 2));
  return roles.map(({ id }) => id);
}
