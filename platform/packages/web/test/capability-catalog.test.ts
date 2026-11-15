import { describe, expect, it } from "vitest";
import type { ManagedResource } from "../src/lib/managed-resources";
import {
  appliedLabel,
  buildCapabilityCatalog,
  declaredDependencies,
  stateLabel,
} from "../src/features/plugins/capability-catalog";

const skill: ManagedResource = {
  id: "skill-s",
  kind: "skills",
  name: "接口补充",
  description: "接口检查清单",
  version: 3,
  payload: { skillName: "api-extra" },
};
const plugin: ManagedResource = {
  id: "plugin-p",
  kind: "plugins",
  name: "qa-helper",
  description: "",
  version: 2,
  payload: { pluginName: "qa-helper", source: "upstream-library" },
};
const model: ManagedResource = {
  id: "model-m",
  kind: "models",
  name: "公共模型",
  description: "",
  version: 1,
  payload: { provider: "custom", modelId: "m" },
};
const agent: ManagedResource = {
  id: "agent-a",
  kind: "agents",
  name: "公共模板",
  description: "",
  version: 2,
  payload: {
    prompt: "x",
    modelResource: "model-m",
    skillResources: ["skill-s"],
    pluginResources: ["plugin-p"],
  },
};

const applied = [
  { resourceId: "skill-s", version: 1, agentId: "test_agent" },
  { resourceId: "skill-s", version: 2, agentId: "test_agent" },
  { resourceId: "agent-a", version: 1, agentId: "local_agent" },
];

describe("the read-only capability catalog", () => {
  const catalog = buildCapabilityCatalog([skill, plugin, model, agent], applied);

  it("groups every published kind and counts its states", () => {
    expect(catalog.byKind.skills.map(entry => entry.name)).toEqual(["接口补充"]);
    expect(catalog.byKind.plugins.map(entry => entry.name)).toEqual(["qa-helper"]);
    expect(catalog.byKind.models.map(entry => entry.name)).toEqual(["公共模型"]);
    expect(catalog.byKind.agents.map(entry => entry.name)).toEqual(["公共模板"]);
    expect(catalog.counts).toEqual({ total: 4, upgradable: 2, current: 0, unapplied: 2 });
  });

  it("compares the newest local copy with the published version, never the other way round", () => {
    const entry = catalog.byKind.skills[0]!;
    expect(entry.state).toBe("upgradable");
    expect(entry.applied).toEqual([{ agentId: "test_agent", version: 2 }]);
    expect(entry.hints[0]).toBe("本机 v2 → 发布 v3；获取后只对之后启动的任务生效");
    expect(stateLabel(entry.state)).toBe("有更新");
    expect(appliedLabel(entry)).toBe("test_agent v2");
    // A published version alone never marks a local copy current: only applied does.
    expect(buildCapabilityCatalog([skill], []).byKind.skills[0]!.state).toBe("unapplied");
  });

  it("shows an unapplied resource as not obtained, and its local copies plainly", () => {
    const entry = catalog.byKind.plugins[0]!;
    expect(entry.state).toBe("unapplied");
    expect(entry.hints).toEqual(["尚未获取到本机；获取入口在原有功能页，管理员发布不会自动下发"]);
    expect(stateLabel(entry.state)).toBe("未获取");
    expect(appliedLabel(entry)).toBe("本机无副本");
  });

  it("names the published agent templates that declare a skill, plugin or model", () => {
    expect(catalog.byKind.skills[0]!.assignedAgents).toEqual([{ id: "agent-a", name: "公共模板" }]);
    expect(catalog.byKind.plugins[0]!.assignedAgents).toEqual([{ id: "agent-a", name: "公共模板" }]);
    expect(catalog.byKind.models[0]!.assignedAgents).toEqual([{ id: "agent-a", name: "公共模板" }]);
    expect(catalog.byKind.agents[0]!.assignedAgents).toEqual([]);
  });

  it("adds a dependency gap to an applied agent template", () => {
    const hints = catalog.byKind.agents[0]!.hints;
    expect(hints).toContain("本机 v1 → 发布 v2；获取后只对之后启动的任务生效");
    expect(hints).toContain("关联技能「接口补充」本机 v2 → 发布 v3");
    expect(hints).toContain("关联插件「qa-helper」尚未获取（发布 v2）");
    expect(hints).toContain("关联模型「公共模型」尚未获取（发布 v1）");
  });

  it("reads dependencies only from an agent resource's declared fields", () => {
    expect(declaredDependencies(skill)).toEqual([]);
    expect(declaredDependencies(agent)).toEqual([
      { id: "model-m", kind: "models" },
      { id: "skill-s", kind: "skills" },
      { id: "plugin-p", kind: "plugins" },
    ]);
    expect(
      declaredDependencies({ ...agent, payload: { skillResources: "skill-s", pluginResources: [1], modelResource: 5 } }),
    ).toEqual([]);
  });
});
