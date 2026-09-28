import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runArg = process.argv.find((arg) => arg.startsWith("--run-id="));
const runId = runArg?.slice(9) ?? "run-" + new Date().toISOString().replace(/[:.]/g, "-");
const output = runArg ? resolve(root, "output/runs", runId, "execution") : resolve(root, "output");
const now = () => new Date().toISOString();
mkdirSync(resolve(output, "playwright"), { recursive: true });

const config = JSON.parse(readFileSync(resolve(root, "config/test-env.json"), "utf8"));
const account = config.accounts?.normal_user ?? {};
const placeholder = /example\.com|change_me|test_user/i.test([config.base_url, account.username, account.password, account.phone, account.verification_code].join(" "));

function blocked(reason) {
  const time = now();
  writeFileSync(resolve(output, "test_results.json"), JSON.stringify({
    run_id: runId, status: "blocked", started_at: time, finished_at: time,
    block_reason: reason,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    cases: []
  }, null, 2) + "\n");
  console.error("自动化执行已阻塞：" + reason);
}

if (config.execution?.enabled !== true) {
  blocked("config/test-env.json 中 execution.enabled 不是 true。");
  process.exitCode = 2;
} else if (placeholder) {
  blocked("测试环境地址或账号仍为占位值。");
  process.exitCode = 2;
} else if (!existsSync(resolve(root, "node_modules/@playwright/test"))) {
  blocked("缺少 @playwright/test；请先运行 npm install。");
  process.exitCode = 2;
} else {
  const test = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "test"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, QA_BASE_URL: config.base_url, QA_RUN_DIR: output.replace(/\\/g, "/"), QA_HEADED: process.argv.includes("--headed") ? "true" : "false" }
  });
  const parse = spawnSync(process.execPath, ["scripts/parse-playwright-result.mjs", `--run-id=${runId}`], { cwd: root, stdio: "inherit" });
  process.exitCode = test.status || parse.status || 0;
}
