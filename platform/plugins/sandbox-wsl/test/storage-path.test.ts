import { describe, expect, it } from "vitest";
import { stateDir } from "../src/host.js";

describe("WSL sandbox storage", () => {
  it("uses the managed installation data directory when configured", () => {
    expect(stateDir({ PENGUIN_SANDBOX_WSL_DATA_DIR: "E:\\AITestHarness\\installed\\data\\qa\\sandbox-wsl" }))
      .toBe("E:\\AITestHarness\\installed\\data\\qa\\sandbox-wsl");
  });

  it("rejects relative or network storage paths", () => {
    expect(() => stateDir({ PENGUIN_SANDBOX_WSL_DATA_DIR: "relative\\sandbox" })).toThrow(/absolute local drive/);
    expect(() => stateDir({ PENGUIN_SANDBOX_WSL_DATA_DIR: "\\\\server\\share" })).toThrow(/absolute local drive/);
  });
});
