import { describe, expect, it } from "vitest";
import { appliedVersion, managedUpdateNotes } from "../src/lib/managed-resources";
import type { ManagedResource } from "../src/lib/managed-resources";
const resource: ManagedResource = { id: "template", kind: "agents", name: "Template", description: "", version: 2, payload: {} };
describe("administrator template version notices", () => {
  it("does not call a newly published uninstalled template an upgrade", () => {
    expect(managedUpdateNotes([resource], [])).toEqual({});
  });
  it("compares the locally obtained version and clears only its own source after obtaining it", () => {
    const applied = [{ resourceId: resource.id, version: 1, agentId: "a" }];
    expect(managedUpdateNotes([resource], applied)["/agents"]).toContain("管理员配置");
    expect(managedUpdateNotes([resource], [...applied, { ...applied[0]!, version: 2 }])).toEqual({});
    expect(managedUpdateNotes([], applied)).toEqual({});
  });
  it("keeps skill application state separate for each target agent", () => {
    const skill = { ...resource, kind: "skills" as const };
    const applied = [{ resourceId: resource.id, version: 2, agentId: "a" }];
    expect(appliedVersion(skill, applied, "a")).toBe(2);
    expect(appliedVersion(skill, applied, "b")).toBe(0);
    expect(managedUpdateNotes([{ ...skill, version: 3 }], applied)["/plugins"]).toBeDefined();
  });
});
