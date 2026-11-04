/** An explicitly selected Playwright attempt inside the managed WSL sandbox. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProductLayout } from './product-layout.mjs';
import { executionChildEnv } from './execution-child-env.mjs';
import { startWslLoopbackRelay, wslNetworkAddresses } from './wsl-loopback-relay.mjs';

const inside = (base, target) => {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function copyScripts(source, target) {
  if (lstatSync(source).isSymbolicLink()) throw new Error('WSL test snapshot contains a link');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name), to = resolve(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error('WSL test snapshot contains a link');
    if (entry.isDirectory()) copyScripts(from, to);
    else if (entry.isFile()) {
      const bytes = readFileSync(from);
      writeFileSync(to, bytes, { flag: 'wx' });
      if (sha256(to) !== sha256(from)) throw new Error('WSL test snapshot checksum mismatch');
    } else throw new Error('WSL test snapshot contains an unsupported file');
  }
}

export function resolveWslRuntime(root, env = process.env) {
  root = resolve(root);
  const sourcePlugin = resolve(root, 'platform/plugins/sandbox-wsl/dist');
  if (existsSync(resolve(sourcePlugin, 'index.js'))) {
    if (!env.PENGUIN_SANDBOX_WSL_DATA_DIR) throw new Error('WSL sandbox data directory is not configured');
    return { pluginDist: sourcePlugin, dataDir: resolve(env.PENGUIN_SANDBOX_WSL_DATA_DIR) };
  }
  const installation = resolve(root, '../../installation.json');
  if (!existsSync(installation)) throw new Error('Managed WSL plugin is unavailable');
  const layout = loadProductLayout(installation);
  if (layout.paths.engine !== root) throw new Error('WSL automation engine does not match installation');
  const pluginDist = resolve(layout.host_app, 'plugins/node_modules/@penguinharness/sandbox-wsl/dist');
  if (!existsSync(resolve(pluginDist, 'index.js'))) throw new Error('Managed WSL plugin is unavailable');
  return { pluginDist, dataDir: resolve(layout.paths.qa_data, 'sandbox-wsl') };
}

export async function wslAutomationInvocation({ root, context, testDir, playwrightCli, baseUrl, args, headed, timeoutMs, workers, network = 'open', verifyBrowser = true, env = process.env }) {
  if (!['none', 'open'].includes(network) || (network === 'open' && !verifyBrowser)) throw new Error('Invalid WSL automation network/browser policy');
  root = resolve(root);
  const { pluginDist, dataDir } = resolveWslRuntime(root, env);
  const statePath = resolve(dataDir, 'state.json');
  if (!existsSync(statePath)) throw new Error('WSL sandbox distro is not initialized');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.distro ?? '') || !/^[a-z_][a-z0-9_-]*$/i.test(state.user ?? '')) {
    throw new Error('Invalid WSL sandbox state');
  }
  const attempt = resolve(context.dir);
  if (inside(root, attempt) || inside(attempt, root)) throw new Error('WSL attempt must be separate from the engine');
  const target = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname.toLowerCase());
  if (loopback && Number(target.port || (target.protocol === 'https:' ? 443 : 80)) < 1024 && network === 'open') {
    throw new Error('WSL localhost relay requires a target port at or above 1024');
  }
  testDir = resolve(testDir);
  if (!inside(root, testDir)) {
    const sessionRoot = resolve(context.output, '../../../..');
    if (!inside(sessionRoot, testDir) || inside(attempt, testDir)) throw new Error('WSL tests must belong to engine or current session');
    const snapshot = resolve(attempt, 'inputs/wsl-tests');
    copyScripts(testDir, snapshot);
    testDir = snapshot;
  }
  const { automationLaunchJob, toLinuxPath } = await import(pathToFileURL(resolve(pluginDist, 'index.js')).href);
  const { launcherEnvironment } = await import(pathToFileURL(resolve(pluginDist, 'launch.js')).href);
  const wsl = resolve(env.SystemRoot ?? 'C:/Windows', 'System32/wsl.exe');
  const playwrightPackage = toLinuxPath(resolve(dirname(playwrightCli), 'index.js'), state.distro);
  const check = verifyBrowser ? spawnSync(wsl, ['-d', state.distro, '-u', state.user, '--cd', '/', '--exec', '/usr/bin/env',
    'PLAYWRIGHT_BROWSERS_PATH=/opt/penguin-browsers', '/usr/local/bin/node', '-e',
    'const fs=require("node:fs");const {chromium}=require(process.argv[1]);if(!fs.existsSync(chromium.executablePath()))process.exit(2)',
    playwrightPackage], { env: launcherEnvironment(env), encoding: 'utf8', windowsHide: true, timeout: 20000 }) : null;
  if (check && check.status !== 0) throw new Error('WSL Node or Playwright Chromium is unavailable in the sandbox distro');
  const host = { distro: state.distro, exposeWindowsDrives: false, drives: [], kind: p => {
    try { return statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return null; }
  } };
  let relay;
  try {
  if (loopback && network === 'open') {
    const addresses = wslNetworkAddresses(wsl, state.distro, env);
    const targetHost = ['::1', '[::1]'].includes(target.hostname.toLowerCase()) ? '::1' : '127.0.0.1';
    relay = await startWslLoopbackRelay({ ...addresses, targetHost, targetPort: Number(target.port || (target.protocol === 'https:' ? 443 : 80)) });
  }
  const job = automationLaunchJob({
    wsl, distro: state.distro, user: state.user,
    engineRoot: root, attemptRoot: attempt, testDir, playwrightCli, baseUrl, args, headed,
    timeoutMs, workers, network,
    ...(relay ? { loopbackRelay: { host: relay.host, port: relay.port, localPort: Number(target.port || (target.protocol === 'https:' ? 443 : 80)), wrapper: resolve(root, 'scripts/wsl-playwright-gateway.mjs') } } : {}),
  }, host);
  return { command: process.execPath, args: [resolve(pluginDist, 'launch.js'), Buffer.from(JSON.stringify(job)).toString('base64')], cwd: root, env: executionChildEnv(env), backend: 'wsl', close: relay?.close };
  } catch (error) { await relay?.close(); throw error; }
}
