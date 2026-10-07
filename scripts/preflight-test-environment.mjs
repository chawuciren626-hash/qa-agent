import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const environmentId = args.find((arg) => arg.startsWith("--environment="))?.slice(14);
const runId = args.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const registryPath = args.find(arg => arg.startsWith('--registry='))?.slice(11) ?? 'config/test-environments.json';
const environments = JSON.parse(readFileSync(resolve(root, registryPath), "utf8"));
const selectedId = environmentId ?? environments.default_environment;
const environment = environments.environments[selectedId];
if (!environment) throw new Error(`未定义测试环境: ${selectedId}`);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, status: ok ? "ready" : "missing", detail });
check("execution_authorization", environment.authorized_for_execution === true, environment.authorized_for_execution ? "环境允许自动化执行" : "环境未授权自动化执行");
check("execution_switch", environment.execution_enabled === true, environment.execution_enabled ? "执行开关已开启" : "执行开关未开启");
check("playwright_package", existsSync(resolve(root, "node_modules/@playwright/test")), "项目 node_modules/@playwright/test");
check("xlsx_package", existsSync(resolve(root, "node_modules/xlsx")), "项目 node_modules/xlsx");
check("xmind_package", existsSync(resolve(root, "node_modules/xmind")), "项目 node_modules/xmind");
const chromeCandidates = [
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && resolve(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
].filter(Boolean);
check("chrome", chromeCandidates.some(existsSync), `候选路径: ${chromeCandidates.join("; ")}`);
const pythonCandidates = [
  process.env.QA_PYTHON,
  "D:\\Python\\python\\python.exe",
  "python"
].filter(Boolean);
let reportPython;
for (const candidate of pythonCandidates) {
  const python = spawnSync(candidate, ["-c", "from docx import Document; import reportlab; print('ready')"], { encoding: "utf8", shell: candidate === "python" && process.platform === "win32" });
  if (python.status === 0) { reportPython = candidate; break; }
}
check("report_runtime", Boolean(reportPython), reportPython ? `python-docx 与 reportlab 可用: ${reportPython}` : `缺少 Python 报告生成运行时；已检查: ${pythonCandidates.join("; ")}`);
const status = checks.every((item) => item.status === "ready") ? "ready" : "not_ready";
const result = { checked_at: new Date().toISOString(), environment_id: selectedId, environment, status, checks, install_policy: "预检只报告，不安装、不下载依赖或浏览器。" };
if (runId) {
  const target = resolve(root, "output/runs", runId, "environment");
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, "preflight.json"), JSON.stringify(result, null, 2) + "\n");
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = status === "ready" ? 0 : 2;
