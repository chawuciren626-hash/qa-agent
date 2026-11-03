import { describe, expect, it } from "vitest";
import { automationLaunchJob } from "../src/automation.js";
import { launcherEnvironment } from "../src/launch.js";

const base = {
  wsl: "C:\\Windows\\System32\\wsl.exe",
  distro: "penguin-sandbox",
  user: "penguin",
  engineRoot: "E:\\app\\engine",
  attemptRoot: "C:\\runs\\attempt-1",
  testDir: "E:\\app\\engine\\tests\\generated",
  playwrightCli: "E:\\app\\engine\\node_modules\\@playwright\\test\\cli.js",
  baseUrl: "https://example.test",
  args: ["test", "--retries=0"],
  headed: false,
  timeoutMs: 30000,
  workers: 1,
  network: "open" as const,
};
const host = {
  distro: "penguin-sandbox",
  exposeWindowsDrives: false,
  drives: ["c", "e"],
  kind: () => "dir" as const,
};

describe("Playwright WSL job", () => {
  it("does not forward WSLENV or host API credentials to Linux", () => {
    const env = launcherEnvironment({ SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", WSLENV: "PENGUIN_API_TOKEN/u", PENGUIN_API_TOKEN: "secret" });
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.WSL_UTF8).toBe("1");
    expect(env.WSLENV).toBeUndefined();
    expect(env.PENGUIN_API_TOKEN).toBeUndefined();
  });
  it("uses Linux Node and exact read/write mounts without host environment", () => {
    const job = automationLaunchJob(base, host);
    expect(job.isolatedEnvironment).toBe(true);
    expect(job.command).toContain("/usr/bin/node");
    expect(job.command).toContain("QA_RUN_DIR=/mnt/c/runs/attempt-1");
    expect(job.command).toContain("QA_TEST_DIR=/mnt/e/app/engine/tests/generated");
    expect(job.command).toContain("QA_BROWSER_CHANNEL=chromium");
    expect(job.command).toContain("--retries=0");
    expect(job.bwrap.join(" ")).toContain("--ro-bind /mnt/e/app/engine /mnt/e/app/engine");
    expect(job.bwrap.join(" ")).toContain("--bind /mnt/c/runs/attempt-1 /mnt/c/runs/attempt-1");
    expect(job.bwrap).toContain("--share-net");
  });

  it("rejects tests outside the visible roots", () => {
    expect(() => automationLaunchJob({ ...base, testDir: "C:\\Users\\secret" }, host)).toThrow(/belong/);
    expect(() => automationLaunchJob({ ...base, playwrightCli: "C:\\node.exe" }, host)).toThrow(/belong/);
    expect(() => automationLaunchJob({ ...base, baseUrl: "file:///etc/passwd" }, host)).toThrow(/HTTP/);
  });
});
