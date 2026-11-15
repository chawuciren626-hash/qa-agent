import { describe, expect, it } from "vitest";
import { normalizeAdminMenus } from "../src/features/admin/admin-system-pages";

describe("administrator menu compatibility", () => {
  it("restores groups and names from an older key and visibility response", () => {
    const items = normalizeAdminMenus([
      { key: "agents", visible: false },
      { key: "overview", visible: true },
      { key: "users", visible: true },
    ]);
    expect(items[0]).toMatchObject({ key: "agents", name: "Agent管理", group: "main", visible: false });
    expect(items.find(item => item.key === "users")).toMatchObject({ group: "sys", path: "/users" });
    expect(items).toHaveLength(10);
  });
  it("uses complete defaults when the service returns an empty list", () => {
    expect(normalizeAdminMenus([]).filter(item => item.group === "main")).toHaveLength(6);
    expect(normalizeAdminMenus(null).filter(item => item.group === "sys")).toHaveLength(4);
  });
});
