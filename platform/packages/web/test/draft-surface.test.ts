import { describe, expect, it } from "vitest";
import { usesQaDraft } from "../src/features/chat/draft-surface";

describe("assistant draft presentation", () => {
  it.each(["/chat/new", "/chat/draft-saved"])(
    "keeps %s on the original assistant throughout Agent loading and failure",
    (pathname) => {
      const input = { pathname, accountClient: false, hasTestAgent: false };
      expect(usesQaDraft(input)).toBe(true);
      expect(usesQaDraft({ ...input, hasTestAgent: true })).toBe(true);
      expect(usesQaDraft(input)).toBe(true);
    },
  );

  it("preserves the administrator assistant", () => {
    expect(usesQaDraft({ pathname: "/chat/new", fixedAgentId: "admin_assistant",
      accountClient: true, hasTestAgent: true })).toBe(false);
  });

  it("preserves other draft surfaces", () => {
    expect(usesQaDraft({ pathname: "/other", accountClient: false, hasTestAgent: false })).toBe(false);
  });
});
