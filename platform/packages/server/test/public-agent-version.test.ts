import { describe, expect, it } from "vitest";
import { planAgentUpdate } from "../src/auth/public-agent-version.js";

const base = { name: "Agent", description: "Old", prompt: "Prompt 1", agentsMd: "Instructions 1", maxTurns: 10 };

describe("managed Agent updates", () => {
  it("adopts published changes when local fields still match the previous release", () => {
    const plan = planAgentUpdate(base, base, { ...base, prompt: "Prompt 2" });
    expect(plan.unresolved).toEqual([]);
    expect(plan.values.prompt).toBe("Prompt 2");
  });

  it("keeps a local edit when the release did not change that field", () => {
    const plan = planAgentUpdate(base, { ...base, description: "Mine" }, { ...base, prompt: "Prompt 2" });
    expect(plan.unresolved).toEqual([]);
    expect(plan.values.description).toBe("Mine");
  });

  it("requires a decision for divergent edits and follows each chosen resolution", () => {
    const local = { ...base, prompt: "Mine" };
    const release = { ...base, prompt: "Prompt 2" };
    expect(planAgentUpdate(base, local, release).unresolved).toEqual(["prompt"]);
    expect(planAgentUpdate(base, local, release, { prompt: "local" }).values.prompt).toBe("Mine");
    expect(planAgentUpdate(base, local, release, { prompt: "published" }).values.prompt).toBe("Prompt 2");
  });

  it("treats an older install without a baseline conservatively", () => {
    const plan = planAgentUpdate(null, base, { ...base, prompt: "Prompt 2" });
    expect(plan.unresolved).toEqual(["prompt"]);
  });
});
