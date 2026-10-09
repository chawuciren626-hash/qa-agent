import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const playwright = process.platform === "win32"
  ? resolve(root, "node_modules/.bin/playwright.cmd")
  : resolve(root, "node_modules/.bin/playwright");

const grep = process.argv.find((arg) => arg.startsWith("--grep="))?.slice(7);
const args = ["test", "tests/generated/tms-retest.spec.ts"];
if (grep) args.push("--grep", grep);

const env = {
  ...process.env,
  QA_BASE_URL: "http://127.0.0.1:59601",
  QA_RUN_DIR: "E:/Codex/测试智能体/output/runs/run-2026-09-29-test-management/execution",
  QA_HEADED: "false"
};

const test = spawnSync(playwright, args, {
  cwd: root,
  stdio: "inherit",
  env
});

if (test.status !== 0) {
  console.error("Playwright 执行失败，exit code:", test.status);
  process.exitCode = test.status || 1;
}
