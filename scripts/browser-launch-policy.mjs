import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 托管浏览器启动策略（D2）：Playwright/Chromium 版本锁、批量 headless 与登录 headed 两态、
 * 每 worker 独立 context 的隔离参数。配置文件缺失或字段非法时回退安全默认值，
 * 但一旦显式锁定版本，就必须与运行中的 Playwright 主版本一致。
 */
export const DEFAULT_BROWSER_POLICY = Object.freeze({
  schema_version: 1,
  playwright: '1.63.0',
  chromium_major: null,
  channel: null,
  executable_path: null,
  batch_headless: true,
  login_headed: true,
  isolate_workers: true,
  enforce_playwright_version: true,
  viewport: { width: 1440, height: 1000 },
  service_workers: 'block',
});

export function browserPolicyPath(root) {
  return resolve(root, 'config', 'browsers.json');
}

export function readBrowserPolicy(root) {
  const path = browserPolicyPath(root);
  if (!existsSync(path)) return { ...DEFAULT_BROWSER_POLICY, source_path: null };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw?.schema_version !== 1) throw new Error('config/browsers.json schema_version 必须为 1。');
  const policy = { ...DEFAULT_BROWSER_POLICY, ...raw, source_path: path };
  if (typeof policy.playwright !== 'string' || !/^\d+\.\d+\.\d+/.test(policy.playwright)) throw new Error('browsers.json.playwright 必须是语义化版本。');
  if (policy.chromium_major !== null && (!Number.isSafeInteger(policy.chromium_major) || policy.chromium_major < 1)) throw new Error('browsers.json.chromium_major 必须是正整数或 null。');
  for (const key of ['batch_headless', 'login_headed', 'isolate_workers', 'enforce_playwright_version']) {
    if (typeof policy[key] !== 'boolean') throw new Error(`browsers.json.${key} 必须是布尔值。`);
  }
  if (policy.channel !== null && !['chrome', 'msedge', 'chromium'].includes(policy.channel)) throw new Error('browsers.json.channel 只支持 chrome / msedge / chromium 或 null。');
  return policy;
}

/**
 * 版本受控：锁的是主版本。次版本差异（浏览器安全更新）不应阻断执行，
 * 但主版本漂移意味着启动参数/协议可能已变，必须显式对齐配置而不是静默升级。
 */
export function assertPlaywrightVersion(policy, installedVersion) {
  const actual = String(installedVersion ?? '');
  const receipt = { enforced: policy.enforce_playwright_version, expected: policy.playwright, actual, ok: true };
  if (!policy.enforce_playwright_version) return receipt;
  // 读不到安装版本时只记录未验证，不把“无法判断”当成“版本错误”阻断执行。
  if (!actual) return { ...receipt, enforced: false, unverified: true };
  const expectedMajor = policy.playwright.split('.')[0];
  const actualMajor = actual.split('.')[0];
  if (expectedMajor !== actualMajor) {
    receipt.ok = false;
    throw new Error(`Browser policy version mismatch: browsers.json locks Playwright ${policy.playwright} but ${actual || 'unknown'} is installed. Align config/browsers.json with the installed runtime; no automatic upgrade was performed.`);
  }
  return receipt;
}

export function assertChromiumVersion(policy, browserVersion) {
  if (policy.chromium_major === null) return { enforced: false, expected: null, actual: browserVersion ?? null };
  const actualMajor = Number(String(browserVersion ?? '').split('.')[0]);
  if (actualMajor !== policy.chromium_major) throw new Error(`Browser policy version mismatch: browsers.json locks Chromium major ${policy.chromium_major} but the launched browser reports ${browserVersion}.`);
  return { enforced: true, expected: policy.chromium_major, actual: actualMajor };
}

/**
 * 两态启动：批量执行 headless；登录/验证码/人工卡片需要 headed 以便人工续接。
 * 显式 headless 仍可覆盖策略（测试与排障场景），但不会被默认值意外打开。
 */
export function resolveLaunchHeadless(policy, { mode = 'batch', requested } = {}) {
  if (typeof requested === 'boolean') return requested;
  if (mode === 'login') return !policy.login_headed;
  return policy.batch_headless;
}

export function launchOptions(policy, { headless, bundled }) {
  const options = { headless };
  if (policy.executable_path) options.executablePath = policy.executable_path;
  else if (!bundled) options.channel = policy.channel ?? 'chrome';
  else if (policy.channel) options.channel = policy.channel;
  return options;
}

/**
 * 每个 worker 一个独立 context：不共享 storageState、cookie 或下载目录。
 * 这里只负责参数；生命周期仍由 browser-task 的单浏览器多 context 模型管理。
 */
export function workerContextOptions(policy, workerIndex = 0) {
  const options = {
    viewport: policy.viewport,
    serviceWorkers: policy.service_workers,
    acceptDownloads: false,
  };
  if (policy.isolate_workers) options.extraHTTPHeaders = { 'x-qa-worker': String(workerIndex) };
  return options;
}

export function browserPolicyReceipt(policy, { playwrightVersion, browserVersion, headless, mode }) {
  return {
    policy_path: policy.source_path,
    locked: { playwright: policy.playwright, chromium_major: policy.chromium_major },
    actual: { playwright: playwrightVersion ?? null, chromium: browserVersion ?? null },
    mode,
    headless,
    isolated_context: policy.isolate_workers,
  };
}
