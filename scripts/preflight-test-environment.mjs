import { resourcePath } from './directory-context.mjs';
import { dataPath } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { probePython } from './command-runtime.mjs';
import { resolve, relative, isAbsolute } from "node:path";
import { attemptDirectory } from './execution-attempts.mjs';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const environmentId = args.find((arg) => arg.startsWith("--environment="))?.slice(14);
const runId = args.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const attemptId = args.find(arg => arg.startsWith('--attempt-id='))?.slice(13);
const registryPath = args.find(arg => arg.startsWith('--registry='))?.slice(11) ?? 'config/test-environments.json';
const runConfigPath = args.find(arg => arg.startsWith('--environment-config='))?.slice(21);
const runConfig = runConfigPath ? JSON.parse(readFileSync(resourcePath(root, runConfigPath), 'utf8')) : null;
const environments = runConfig ? null : JSON.parse(readFileSync(resourcePath(root, registryPath), "utf8"));
const selectedId = environmentId ?? environments?.default_environment;
const environment = runConfig ? {base_url:runConfig.base_url,browser:runConfig.execution?.browser,authorized_for_execution:true,execution_enabled:runConfig.execution?.enabled} : environments.environments[selectedId];
if (runConfig) {
  const rel=runId ? relative(dataPath(root,'output/runs',runId),resourcePath(root,runConfigPath)) : '..';
  if (!runId || runConfig.environment !== selectedId || !rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Run-local preflight config must belong to this run and match the environment');
}
if (!environment) throw new Error(`未定义测试环境: ${selectedId}`);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, status: ok ? "ready" : "missing", detail });
check("execution_authorization", environment.authorized_for_execution === true, runConfig ? "Run-local environment is checked against the approved execution snapshot by the runner" : environment.authorized_for_execution ? "环境策略允许；不代表本次执行计划已获用户批准" : "环境未授权自动化执行");
check("execution_switch", environment.execution_enabled === true, environment.execution_enabled ? "执行开关已开启" : "执行开关未开启");
const require = createRequire(resolve(root, 'package.json'));
for (const [name, packageName] of [['playwright_package','@playwright/test'],['xlsx_package','xlsx'],['xmind_package','xmind']]) {
  try { check(name,true,require.resolve(packageName)); }
  catch { check(name,false,`Cannot resolve installed package: ${packageName}`); }
}
check('browser_channel', ['chrome','chromium'].includes(environment.browser), 'Chromium-family selection uses the installed Chrome channel in this runner');
let validUrl=false;
try { const url=new URL(environment.base_url); validUrl=['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch {}
check('environment_url',validUrl,'An absolute HTTP(S) base_url without embedded credentials is required; reachability is not checked');
try {
  const config=JSON.parse(readFileSync(resolve(root,'tsconfig.playwright.json'),'utf8'));
  check('shared_playwright_mapping',config.compilerOptions?.allowJs===true && config.compilerOptions?.baseUrl==='.' && config.compilerOptions?.paths?.['@playwright/test']?.[0]==='node_modules/@playwright/test/index.js','Shared Playwright import mapping; script collection remains a separate check');
} catch { check('shared_playwright_mapping',false,'Missing or invalid tsconfig.playwright.json'); }
const chromeCandidates = [
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && resolve(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
].filter(Boolean);
check("chrome", chromeCandidates.some(existsSync), `候选路径: ${chromeCandidates.join("; ")}`);
const reportRuntime = probePython();
check("report_runtime", reportRuntime.status === 'ready', reportRuntime.status === 'ready' ? `python-docx 与 reportlab 可用: ${reportRuntime.executable}` : reportRuntime.reason);
const status = checks.every((item) => item.status === "ready") ? "ready" : "not_ready";
const result = { checked_at: new Date().toISOString(), environment_id: selectedId, environment, status, checks, browser_started:false, network_checked:false, approval_granted:false, scope:'local_static_readiness_not_run_authorization', install_policy: "预检只报告，不安装、不下载依赖或浏览器。" };
if (runId) {
  const target = dataPath(root, "output/runs", runId, "environment");
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, "preflight.json"), JSON.stringify(result, null, 2) + "\n");
  if (attemptId) {
    const archive = resolve(attemptDirectory(root, runId, attemptId), 'environment');
    mkdirSync(archive, { recursive: true });
    writeFileSync(resolve(archive, 'preflight.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = status === "ready" ? 0 : 2;
