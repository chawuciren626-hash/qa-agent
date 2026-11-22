import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentStateDir } from "@prismshadow/penguin-core";
import { inspectQaAgentStates, repairQaAgentStates } from "../src/services/qa-agent-repair.js";
import { fillMissingQaAgentResources, qaRoleTools } from "../../../../scripts/qa-project-bootstrap.mjs";
import { makeTempRoot } from "./helpers.js";

const project = "qa-project";
const explorer = "env_explorer_agent";
const assistant = "default_agent";

describe("explicit QA Agent repair", () => {
  it("adopts an existing partial tree without replacing files and is safe to repeat", async () => {
    const root = await makeTempRoot();
    try {
      const state = agentStateDir(root, project, explorer);
      const skill = path.join(state, "skills", "system-map-exploration", "SKILL.md");
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(path.join(state, "AGENTS.md"), "existing prompt");
      await fs.writeFile(skill, "existing skill");
      const shared = agentStateDir(root, project, "test_agent");
      await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(path.join(shared, "shared-agent.json"), '{"version":1,"agentId":"test_agent"}');
      const ids = [explorer, assistant, "test_agent"];
      expect(await inspectQaAgentStates(root, project, ids)).toEqual([explorer, assistant]);
      await expect(fs.stat(path.join(state, "system_config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      const indexed = new Set<string>();
      const listAgents = async () => {
        for (const id of ids) {
          try { await fs.stat(path.join(agentStateDir(root, project, id), "system_config.yaml")); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          indexed.add(id);
        }
        return [...indexed].map(agentId => ({ agentId }));
      };
      const engine = { fillMissingQaAgentResources, qaRoleTools };
      expect(await repairQaAgentStates(root, project, ids, engine, listAgents)).toEqual([explorer, assistant]);
      const config = await fs.readFile(path.join(state, "system_config.yaml"), "utf8");
      expect(parse(config)).toMatchObject({ name: explorer, system_prompt: expect.any(String) });
      expect(await fs.readFile(path.join(state, "AGENTS.md"), "utf8")).toBe("existing prompt");
      expect(await fs.readFile(skill, "utf8")).toBe("existing skill");
      expect(await fs.readFile(path.join(state, "hooks/qa-stage-boundary/project.json"), "utf8")).toContain(explorer);
      expect(await fs.readFile(path.join(agentStateDir(root, project, assistant), "AGENTS.md"), "utf8")).toContain("qa-default-entry");
      await expect(fs.stat(path.join(shared, "system_config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await repairQaAgentStates(root, project, ids, engine, listAgents)).toEqual([]);
      expect(await fs.readFile(path.join(state, "system_config.yaml"), "utf8")).toBe(config);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
