import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountCookieSeal } from "../src/auth/account-cookie-seal.js";

describe("central cookie at rest", () => {
  it("restores from the same private key and refuses tampering or missing keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-cookie-seal-"));
    try {
      const first = new AccountCookieSeal(root, false);
      const sealed = first.seal("penguin_session=secret-token");
      expect(sealed).toMatch(/^enc:v1:/);
      expect(sealed).not.toContain("secret-token");
      const restored = new AccountCookieSeal(root, true);
      expect(restored.open(sealed)).toBe("penguin_session=secret-token");
      expect(() => restored.open(sealed.slice(0, -2) + "xx")).toThrow();
      fs.unlinkSync(path.join(root, "account-center-cookie.key"));
      expect(() => new AccountCookieSeal(root, true)).toThrow(/missing/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
