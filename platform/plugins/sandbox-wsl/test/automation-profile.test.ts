import { describe, expect, it } from "vitest";
import { automationBwrapArgs } from "../src/profile.js";

const host = {
  distro: "penguin-sandbox",
  exposeWindowsDrives: false,
  drives: ["c", "e"],
  kind: (_path: string) => "dir" as const,
};

describe("Playwright attempt mount profile", () => {
  it("mounts only the engine read-only and the attempt writable", () => {
    const args = automationBwrapArgs("E:\\AITestHarness\\installed\\app\\engine", "C:\\qa\\attempt-1", host);
    const text = args.join(" ");
    expect(text).toContain("--tmpfs /mnt");
    expect(text).toContain("--bind /mnt/c/qa/attempt-1 /mnt/c/qa/attempt-1");
    expect(text).toContain("--ro-bind /mnt/e/AITestHarness/installed/app/engine /mnt/e/AITestHarness/installed/app/engine");
    expect(text).not.toContain("--ro-bind /mnt/c /mnt/c");
    expect(args.indexOf("--ro-bind")).toBeLessThan(args.indexOf("--remount-ro"));
    expect(args).not.toContain("--share-net");
  });

  it("rejects roots that overlap, cannot be mounted, or expose all drives", () => {
    expect(() => automationBwrapArgs("C:\\qa", "C:\\qa\\attempt", host)).toThrow(/separate/);
    expect(() => automationBwrapArgs("C:\\QA", "c:\\qa\\attempt", host)).toThrow(/separate/);
    expect(() => automationBwrapArgs("C:\\qa\\other\\..", "C:\\qa\\attempt", host)).toThrow(/separate/);
    expect(() => automationBwrapArgs("\\\\server\\share", "C:\\qa\\attempt", host)).toThrow(/local Windows/);
    expect(() => automationBwrapArgs("C:\\engine", "C:\\qa", { ...host, exposeWindowsDrives: true })).toThrow(/expose/);
    expect(() => automationBwrapArgs("C:\\engine", "C:\\qa", { ...host, kind: () => null })).toThrow(/exist/);
  });
});
