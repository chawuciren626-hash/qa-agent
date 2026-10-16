import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/run-tms-tests.mjs --run-id=<run_id> [--grep=<pattern>]");
const runDir = resolve(root, "output/runs", runId, "execution");

const env = {
  ...process.env,
  QA_RUN_DIR: runDir,
};

const testFiles = [
  "tests/generated/tms-login.spec.ts",
  "tests/generated/tms-user-management.spec.ts",
  "tests/generated/tms-security.spec.ts",
  "tests/generated/tms-performance.spec.ts",
];

const playwright = process.platform === "win32"
  ? resolve(root, "node_modules/.bin/playwright.cmd")
  : resolve(root, "node_modules/.bin/playwright");
if (!existsSync(playwright)) throw new Error("本地 Playwright 未就绪；禁止自动下载或安装。");
const grep = process.argv.find((arg) => arg.startsWith("--grep="))?.slice(7);
const args = ["test", ...testFiles, "--project=chrome"];
if (grep) args.push("--grep", grep);

const result = spawnSync(playwright, args, {
  cwd: root,
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error("执行失败:", result.error);
  process.exit(1);
}
process.exit(result.status || 0);
