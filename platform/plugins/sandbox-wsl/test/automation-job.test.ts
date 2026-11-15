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
    expect(job.command).toContain("/usr/local/bin/node");
    expect(job.command).toContain("-i");
    expect(job.command).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/penguin-browsers");
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
  it("routes an authorized loopback target through the attempt gateway", () => {
    const job = automationLaunchJob({ ...base, baseUrl: 'http://127.0.0.1:4317', loopbackRelay: {
      host: '172.26.96.1', port: 51234, localPort: 4317,
      wrapper: 'E:\\app\\engine\\scripts\\wsl-playwright-gateway.mjs',
    } }, host);
    expect(job.command).toContain('QA_BASE_URL=http://127.0.0.1:4317');
    expect(job.command).toContain('QA_WSL_RELAY_HOST=172.26.96.1');
    expect(job.command).toContain('/mnt/e/app/engine/scripts/wsl-playwright-gateway.mjs');
    expect(() => automationLaunchJob({ ...base, loopbackRelay: {
      host: '172.26.96.1', port: 51234, localPort: 4317,
      wrapper: 'C:\\Users\\secret\\gateway.mjs',
    } }, host)).toThrow(/belong/);
  });
});
