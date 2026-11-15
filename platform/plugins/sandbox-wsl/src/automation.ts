/** A Playwright-only WSL job. The caller owns authorization, attempt locking and result checks. */
import path from "node:path";
import type { LaunchJob } from "./launch.js";
import { automationBwrapArgs, toLinuxPath, within } from "./profile.js";
import type { ProfileHost } from "./profile.js";

export interface AutomationJobInput {
  wsl: string;
  distro: string;
  user: string;
  engineRoot: string;
  attemptRoot: string;
  testDir: string;
  playwrightCli: string;
  baseUrl: string;
  args: string[];
  headed: boolean;
  timeoutMs: number;
  workers: number;
  network: "none" | "open";
  loopbackRelay?: { host: string; port: number; localPort: number; wrapper: string };
}

/** No host environment variables are inherited by the Linux command. */
export function automationLaunchJob(input: AutomationJobInput, host: ProfileHost): LaunchJob {
  if (input.distro !== host.distro || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.distro)) {
    throw new Error("Automation distro mismatch");
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(input.user)) throw new Error("Invalid automation user");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 ||
      !Number.isSafeInteger(input.workers) || input.workers < 1 || input.workers > 32) {
    throw new Error("Invalid automation limits");
  }
  const url = new URL(input.baseUrl);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new Error("Automation target must be an HTTP(S) URL without embedded credentials");
  }
  const localPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value)
    ? toLinuxPath(path.win32.normalize(value), input.distro)
    : null;
  const engine = localPath(input.engineRoot);
  const attempt = localPath(input.attemptRoot);
  const testDir = localPath(input.testDir);
  const cli = localPath(input.playwrightCli);
  const relay = input.loopbackRelay;
  const wrapper = relay ? localPath(relay.wrapper) : null;
  if (!engine || !attempt || !testDir || !cli || !within(cli, [engine]) ||
      !within(testDir, [engine, attempt]) || input.args.some(arg => typeof arg !== "string") ||
      (relay && (!wrapper || !within(wrapper, [engine]) ||
        !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(relay.host) ||
        ![relay.port, relay.localPort].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)))) {
    throw new Error("Automation script and tests must belong to the read-only engine or attempt");
  }
  const profile = automationBwrapArgs(input.engineRoot, input.attemptRoot, host, input.network);
  // Explicitly name Linux Node. The distro must provide a compatible Node and Playwright browser.
  const command = [
    "/usr/bin/env",
    "-i",
    `HOME=/home/${input.user}`,
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "XDG_CACHE_HOME=/tmp/penguin-cache",
    "PLAYWRIGHT_BROWSERS_PATH=/opt/penguin-browsers",
    `QA_BASE_URL=${input.baseUrl}`,
    `QA_TEST_DIR=${testDir}`,
    `QA_RUN_DIR=${attempt}`,
    `QA_HEADED=${input.headed ? "true" : "false"}`,
    `QA_TIMEOUT_MS=${input.timeoutMs}`,
    `QA_WORKERS=${input.workers}`,
    "QA_BROWSER_CHANNEL=chromium",
    ...(relay ? [`QA_WSL_RELAY_HOST=${relay.host}`, `QA_WSL_RELAY_PORT=${relay.port}`, `QA_WSL_LOCAL_PORT=${relay.localPort}`] : []),
    "/usr/local/bin/node",
    ...(relay ? [wrapper!, cli] : [cli]),
    ...input.args,
  ];
  return {
    wsl: input.wsl,
    distro: input.distro,
    user: input.user,
    bwrap: profile,
    chdirRoots: [engine, attempt],
    command,
    isolatedEnvironment: true,
  };
}
