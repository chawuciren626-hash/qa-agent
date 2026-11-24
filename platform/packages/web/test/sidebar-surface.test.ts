import { describe, expect, it } from "vitest";
import { usesQaSidebar } from "../src/components/layout/sidebar-surface";

describe("usesQaSidebar", () => {
  it("keeps QA routes on the product shell before a Project or test Agent has loaded", () => {
    expect(
      usesQaSidebar({
        inCompany: false,
        accountClient: false,
        hasTestAgent: false,
        pathname: "/qa/projects",
      }),
    ).toBe(true);
  });

  it("does not replace the organization shell in company mode", () => {
    expect(
      usesQaSidebar({
        inCompany: true,
        accountClient: true,
        hasTestAgent: true,
        pathname: "/qa/projects",
      }),
    ).toBe(false);
  });

  it("keeps the product shell when account-center or the test Agent identifies it", () => {
    const base = {
      inCompany: false,
      accountClient: false,
      hasTestAgent: false,
      pathname: "/chat",
    };
    expect(usesQaSidebar({ ...base, accountClient: true })).toBe(true);
    expect(usesQaSidebar({ ...base, hasTestAgent: true })).toBe(true);
    expect(usesQaSidebar(base)).toBe(false);
  });
});
