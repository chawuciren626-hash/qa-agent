import { describe, expect, it } from "vitest";
import { allowedModule, pageModule } from "../src/lib/module-permissions";

describe("module navigation and route authorization", () => {
  it("reads the same exact view parameter as the page renderer", () => {
    expect(pageModule("/chat", "?view=%6cibrary")).toBe("library");
    expect(pageModule("/chat", "?view=schedules&view=library")).toBe("schedules");
    expect(pageModule("/chat", "?note=view=library")).toBe("chat");
    expect(pageModule("/chat", "?view=library-extra")).toBe("chat");
    expect(pageModule("/chat/session", "")).toBe("chat");
  });
  it("denies missing central grants and preserves explicit administrator access", () => {
    expect(allowedModule(null, "agents")).toBe(false);
    expect(allowedModule({isAdmin:false,modulePermissions:[]}, "agents")).toBe(false);
    expect(allowedModule({isAdmin:false,modulePermissions:["models"]}, "models")).toBe(true);
    expect(allowedModule({isAdmin:false,modulePermissions:["models"]}, "agents")).toBe(false);
    expect(allowedModule({isAdmin:true,modulePermissions:[]}, "agents")).toBe(true);
  });
});
