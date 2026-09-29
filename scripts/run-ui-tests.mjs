import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readJson, validateExecutionPlan } from "./execution-plan.mjs";

const root = resolve(import.meta.dirname, "..");
const runArg = process.argv.find((arg) => arg.startsWith("--run-id="));
if (!runArg) throw new Error("用法: node scripts/run-ui-tests.mjs --run-id=<run_id> [--headed]");
const runId = runArg.slice(9);
const output = resolve(root, "output/runs", runId, "execution");
const now = () => new Date().toISOString();
mkdirSync(resolve(output, "playwright"), { recursive: true });
const planPath = resolve(output, "execution-plan.json");
const plan = existsSync(planPath) ? readJson(planPath) : null;

const config = JSON.parse(readFileSync(resolve(root, "config/test-env.json"), "utf8"));
const account = config.accounts?.normal_user ?? {};
const placeholder = /example\.com|change_me|test_user/i.test([config.base_url, account.username, account.password, account.phone, account.verification_code].join(" "));

function blocked(reason) {
  const time = now();
  writeFileSync(resolve(output, "test_results.json"), JSON.stringify({
    run_id: runId, status: "blocked", started_at: time, finished_at: time,
    block_reason: reason,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    cases: [],
    asset_refs: plan?.cases?.flatMap((testCase) => testCase.asset_refs ?? []) ?? []
  }, null, 2) + "\n");
  console.error("自动化执行已阻塞：" + reason);
}

if (!plan) {
  blocked("缺少 execution/execution-plan.json；请先创建并校验执行计划。");
  process.exitCode = 2;
} else if (plan.run_id !== runId || validateExecutionPlan(plan).length) {
  blocked("执行计划无效或与当前 run_id 不一致。");
  process.exitCode = 2;
} else if (!plan.cases.length) {
  blocked("执行计划中没有可自动化执行的用例。");
  process.exitCode = 2;
} else if (config.execution?.enabled !== true) {
  blocked("config/test-env.json 中 execution.enabled 不是 true。");
  process.exitCode = 2;
} else if (placeholder) {
  blocked("测试环境地址或账号仍为占位值。");
  process.exitCode = 2;
} else if (!existsSync(resolve(root, "node_modules/@playwright/test"))) {
  blocked("缺少项目已安装的 @playwright/test；环境未就绪，未执行任何下载或安装。");
  process.exitCode = 2;
} else {
  const playwright = process.platform === "win32"
    ? resolve(root, "node_modules/.bin/playwright.cmd")
    : resolve(root, "node_modules/.bin/playwright");
  if (!existsSync(playwright)) {
    blocked("缺少项目本地 Playwright 可执行文件；环境未就绪，未执行任何下载或安装。");
    process.exitCode = 2;
    process.exit();
  }
  const environmentId = config.environment;
  if (!environmentId) {
    blocked("config/test-env.json 缺少 environment，无法执行环境预检。");
    process.exitCode = 2;
    process.exit();
  }
  const preflight = spawnSync(process.execPath, ["scripts/preflight-test-environment.mjs", `--environment=${environmentId}`, `--run-id=${runId}`], { cwd: root, stdio: "inherit" });
  if (preflight.status !== 0) {
    blocked("环境预检未通过；未启动浏览器。请查看 environment/preflight.json。");
    process.exitCode = 2;
    process.exit();
  }
  const escapedIds = plan.cases.map((testCase) => testCase.case_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const args = ["test", "--grep", `(${escapedIds.join("|")})`, `--workers=${plan.execution_policy.workers}`];
  const test = spawnSync(playwright, args, {
    cwd: root, stdio: "inherit",
    env: {
      ...process.env,
      QA_BASE_URL: config.base_url,
      QA_RUN_DIR: output.replace(/\\/g, "/"),
      QA_HEADED: process.argv.includes("--headed") ? "true" : "false",
      QA_TIMEOUT_MS: String(config.execution.timeout_ms ?? 30_000),
      QA_WORKERS: String(plan.execution_policy.workers)
    }
  });
  const parse = spawnSync(process.execPath, ["scripts/parse-playwright-result.mjs", `--run-id=${runId}`], { cwd: root, stdio: "inherit" });
  process.exitCode = test.status || parse.status || 0;
}
