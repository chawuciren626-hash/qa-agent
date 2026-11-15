/**
 * Project built-in provisioning follows the product boundary:
 *
 * - Ordinary QA Projects receive professional QA roles only. They do not receive
 *   default_agent or the administrator Benchmarks.
 * - admin_agent_catalog is the administrator assistant Project and is the sole QA
 *   Project that receives default_agent and Benchmarks.
 * - default_project is the built-in administrator's CLI compatibility Project; it keeps
 *   its historical built-in Agent and Benchmark behavior.
 *
 * Upstream mode retains its original built-in defaults because it has no QA product
 * boundary to apply.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarksDir, libraryPlugin, loadPreinstalledPlugins } from "@prismshadow/penguin-core";
import type { BenchmarkCasesResponse, BenchmarksResponse } from "../src/api/types.js";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";
import { qaEnabled } from "../src/services/qa-engine.js";

/** What every built-in Benchmark's id starts with: `penguinharness-benchmark-<name>`. */
const BUILTIN_PREFIX = "penguinharness-benchmark-";

interface AgentsResponse {
  agents: Array<{ agentId: string; name?: string; description?: string }>;
}
interface ProjectsResponse {
  projects: Array<{ projectId: string }>;
}
interface ProjectCreateResponse {
  project: { projectId: string };
}

describe("built-in Agent provisioning", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp();
    const reg = await provisionUser(t.app, "owner1");
    owner = apiClient(t.app, reg.cookie);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  async function expectAdministratorAssistant(
    projectId: string,
    client: ReturnType<typeof apiClient>,
  ): Promise<void> {
    const list = (await (
      await client.get(`/api/projects/${projectId}/agents`)
    ).json()) as AgentsResponse;
    const ids = list.agents.map((a) => a.agentId);
    expect(ids).toContain("default_agent");
    expect(ids).not.toContain("agent_creator");
    expect(ids).not.toContain("agent_optimizer");

    const skills = await fs.readdir(
      path.join(t.root, projectId, "agents", "default_agent", "agent_state", "skills"),
    );
    expect(skills.sort()).toEqual(
      loadPreinstalledPlugins()
        .flatMap((plugin) => plugin.skills.map((skill) => skill.name))
        .sort(),
    );
    const hooks = await fs.readdir(
      path.join(t.root, projectId, "agents", "default_agent", "agent_state", "hooks"),
    );
    expect(hooks).toContain("goal");
    expect(hooks).not.toContain("continual-learning");
    expect(
      await fs.readFile(
        path.join(
          t.root,
          projectId,
          "agents",
          "default_agent",
          "agent_state",
          "hooks",
          "goal",
          "icon.svg",
        ),
        "utf8",
      ),
    ).toBe(libraryPlugin("goal")!.icon);
    const agentsMd = await fs.readFile(
      path.join(t.root, projectId, "agents", "default_agent", "agent_state", "AGENTS.md"),
      "utf8",
    );
    expect(agentsMd).toContain("<!-- qa-default-entry:start -->");
    expect(agentsMd).toContain("# general_agent");
    expect(agentsMd).toContain("<!-- qa-default-entry:end -->");

    const benchmarks = (await (
      await client.get(`/api/projects/${projectId}/benchmarks`)
    ).json()) as BenchmarksResponse;
    expect(benchmarks.benchmarks.find((b) => b.id === "example-benchmark")).toBeDefined();
  }

  it("an ordinary account starts empty and a QA Project receives professional roles only", async () => {
    const projects = (await (await owner.get("/api/projects")).json()) as ProjectsResponse;
    expect(projects.projects).toEqual([]);
    const projectId = "owner1-first";
    const created = (await (
      await owner.post("/api/projects", { projectId, name: "First project" })
    ).json()) as ProjectCreateResponse;
    expect(created.project.projectId).toBe(projectId);

    if (qaEnabled) {
      const agents = (await (
        await owner.get(`/api/projects/${projectId}/agents`)
      ).json()) as AgentsResponse;
      expect(agents.agents.map((a) => a.agentId)).toContain("test_agent");
      expect(agents.agents.map((a) => a.agentId)).not.toContain("default_agent");
      await expect(fs.stat(path.join(t.root, projectId, "agents", "default_agent"))).rejects.toThrow();
      expect((await owner.get(`/api/projects/${projectId}/benchmarks`)).status).toBe(403);
    } else {
      const agents = (await (
        await owner.get(`/api/projects/${projectId}/agents`)
      ).json()) as AgentsResponse;
      expect(agents.agents.map((a) => a.agentId)).toContain("default_agent");
    }
  });

  it("the administrator assistant catalog receives default_agent and Benchmarks", async () => {
    const projectId = "admin_agent_catalog";
    const admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    const created = await admin.post("/api/projects", { projectId });
    expect(created.status).toBe(201);
    const response = (await created.json()) as ProjectCreateResponse;
    await expectAdministratorAssistant(response.project.projectId, admin);
  });

  it("the administrator assistant catalog comes with the example and seven built-ins", async () => {
    // The one scenario that reads the shipped catalog whole, on an app that writes it as
    // production does (createTestApp leaves the built-ins out unless asked).
    const shipped = await createTestApp({ builtinBenchmarks: true });
    try {
      const admin = apiClient(shipped.app, (await loginAdmin(shipped.app)).cookie);
      const created = (await (
        await admin.post("/api/projects", { projectId: "admin_agent_catalog", name: "Administrator assistant" })
      ).json()) as ProjectCreateResponse;
      for (const projectId of [created.project.projectId]) {
        const base = `/api/projects/${projectId}/benchmarks`;
        const body = (await (await admin.get(base)).json()) as BenchmarksResponse;
        const example = body.benchmarks.find((b) => b.id === "example-benchmark")!;
        const builtins = body.benchmarks.filter((b) => b.id.startsWith(BUILTIN_PREFIX));
        expect(builtins, projectId).toHaveLength(7);
        expect(body.benchmarks.map((b) => b.id)).toEqual([
          "example-benchmark",
          ...builtins.map((b) => b.id),
        ]);
        for (const bench of [example, ...builtins]) {
          // Seeded, at a revision of their own.
          expect(bench.origin, bench.id).toEqual({ kind: "builtin" });
          expect(bench.version, bench.id).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/);
        }
        for (const bench of builtins) {
          // Read like any Benchmark: nothing in the summary sets a built-in apart.
          expect(Object.keys(bench).sort(), bench.id).toEqual(Object.keys(example).sort());
          // Ready to evaluate, and never evaluated: no baseline ships with them.
          expect(bench.status).toBe("published");
          expect(bench.runs).toBe(1);
          expect(bench.evaluations).toEqual([]);
          expect(bench.caseCount).toBeGreaterThan(0);
          const cases = (await (
            await admin.get(`${base}/${bench.id}/cases`)
          ).json()) as BenchmarkCasesResponse;
          expect(cases.cases).toHaveLength(bench.caseCount);
          for (const c of cases.cases) {
            // Listed under the title its statement opens with.
            expect(c.title).not.toBe(c.id);
            // The statement links the task's folder in the public repository and says how the
            // case is run.
            const statement = await (
              await admin.get(`${base}/${bench.id}/cases/${c.id}/files/content?path=README.md`)
            ).text();
            expect(statement, c.id).toMatch(
              /^- Task: `[^`]+` in https:\/\/github\.com\/\S+\/tree\/\S+$/m,
            );
            expect(statement, c.id).toMatch(/^## How this case is run$/m);
            expect(statement, c.id).toMatch(/harbor run -p \S+ -i \S+ /);
          }
        }
      }
    } finally {
      await shipped.cleanup();
    }
  }, 30_000);

  it("an existing default_project adopted at bootstrap keeps its own Benchmarks and is given only the missing ones", async () => {
    const mine = `${BUILTIN_PREFIX}sec-a`;
    const adopted = await createTestApp({
      builtinBenchmarks: true,
      // A data root the CLI made before the server's first start, holding a Benchmark of its
      // own under a built-in's id.
      beforeSeed: async (root) => {
        const dir = path.join(benchmarksDir(root, "default_project"), mine);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "benchmark_config.toml"), 'title = "Mine"\n');
      },
    });
    try {
      const admin = apiClient(adopted.app, (await loginAdmin(adopted.app)).cookie);
      const body = (await (
        await admin.get("/api/projects/default_project/benchmarks")
      ).json()) as BenchmarksResponse;
      const ids = body.benchmarks.map((b) => b.id);
      expect(ids).toContain("example-benchmark");
      expect(ids.filter((id) => id.startsWith(BUILTIN_PREFIX))).toHaveLength(7);
      expect(body.benchmarks.find((b) => b.id === mine)).toMatchObject({
        title: "Mine",
        caseCount: 0,
      });
      expect(
        await fs.readdir(path.join(benchmarksDir(adopted.root, "default_project"), mine)),
      ).toEqual(["benchmark_config.toml"]);
    } finally {
      await adopted.cleanup();
    }
  });

  it("default_agent remains deletion-protected in the administrator catalog", async () => {
    const admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    expect((await admin.post("/api/projects", { projectId: "admin_agent_catalog" })).status).toBe(201);
    const res = await admin.delete("/api/projects/admin_agent_catalog/agents/default_agent");
    expect(res.status).toBe(409);
  });

  it("legacy ids like agent_creator lose built-in protection: creatable, deletable", async () => {
    const admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    const projectId = qaEnabled ? "admin_agent_catalog" : "owner1-legacy_ids";
    const client = qaEnabled ? admin : owner;
    expect((await client.post("/api/projects", { projectId })).status).toBe(201);
    const created = await client.post(`/api/projects/${projectId}/agents`, {
      agentId: "agent_creator",
    });
    expect(created.status).toBe(201);
    const res = await client.delete(`/api/projects/${projectId}/agents/agent_creator`);
    expect(res.status).toBe(204);
  });
});
