import { describe, expect, it } from "vitest";
import { requestModule } from "../src/auth/module-access.js";

describe("native route module permissions", () => {
  it.each([
    ["/api/projects/p/benchmarks", "GET", "benchmark"],
    ["/api/projects/p/agents/a/mcp-servers/service", "DELETE", "plugins"],
    ["/api/projects/p/agents/qa/personal-resources", "POST", "skills"],
    ["/api/projects/p/agents/qa/overview", "GET", "projects"],
    ["/api/projects/p/dir-skills", "GET", "skills"],
    ["/api/projects/p/agents/a/import", "POST", "agents"],
    ["/api/projects/p/agents/a/export", "GET", "agents"],
    ["/api/projects/p/agents/a/memory/library", "GET", "library"],
    ["/api/projects/p/agents/a/config/kernel-update", "POST", "agents"],
  ])("gates %s (%s) by %s", (path, method, module) => {
    expect(requestModule(path, method)).toBe(module);
  });

  it("does not interpret project, agent, session or plugin names as modules", () => {
    expect(requestModule("/api/projects/models/agents/skills/config", "PUT")).toBe("agents");
    expect(requestModule("/api/projects/plugins/sessions/models/input", "POST")).toBe("chat");
    expect(requestModule("/api/plugins/models/files", "GET")).toBe("plugins");
    expect(requestModule("/api/projects/models/agents", "GET")).toBeUndefined();
  });

  it("preserves bootstrap and history reads, including HEAD, while gating writes", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const path of ["/api/projects", "/api/projects/p/agents/", "/api/projects/p/sessions/s"]) {
        expect(requestModule(path, method)).toBeUndefined();
      }
    }
    expect(requestModule("/api/projects/p/agents/", "POST")).toBe("agents");
    expect(requestModule("/api/projects/p/sessions/s/input", "POST")).toBe("chat");
  });
});
