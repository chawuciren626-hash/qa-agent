/** Snapshot an API contract and parse it in a network-free WSL sandbox. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDirectory } from './design-quality.mjs';
import { resolveWslRuntime } from './wsl-automation.mjs';
import { runManagedProcess } from './managed-process.mjs';
import { inspectApiContract } from './api-contract.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function managedApiContractSandbox(root, env = process.env) {
  if (process.platform !== 'win32') return false;
  try { return existsSync(resolve(resolveWslRuntime(root, env).dataDir, 'state.json')); }
  catch { return false; }
}

export async function inspectApiContractSandbox(root, runId, bytes, options = {}, env = process.env) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || !Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid API contract sandbox input');
  const run = runDirectory(root, runId);
  const attempt = resolve(run, 'audit/api-contracts', randomUUID());
  mkdirSync(attempt, { recursive: true });
  const input = resolve(attempt, 'contract.bin'), request = resolve(attempt, 'request.json'), output = resolve(attempt, 'result.json');
  writeFileSync(input, bytes, { flag: 'wx' });
  writeFileSync(request, JSON.stringify({ version: 1, operations: options.operations ?? [], source_path: options.source_path ?? null }), { flag: 'wx' });
  if (sha256(readFileSync(input)) !== sha256(bytes)) throw new Error('API contract snapshot checksum mismatch');
  const { pluginDist, dataDir } = resolveWslRuntime(root, env);
  const state = JSON.parse(readFileSync(resolve(dataDir, 'state.json'), 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.distro ?? '') || !/^[a-z_][a-z0-9_-]*$/i.test(state.user ?? '')) throw new Error('Invalid WSL sandbox state');
  const { automationBwrapArgs, toLinuxPath } = await import(pathToFileURL(resolve(pluginDist, 'index.js')).href);
  const { launcherEnvironment } = await import(pathToFileURL(resolve(pluginDist, 'launch.js')).href);
  const wsl = resolve(env.SystemRoot ?? 'C:/Windows', 'System32/wsl.exe');
  const host = { distro: state.distro, exposeWindowsDrives: false, drives: [], kind: path => {
    try { return statSync(path).isDirectory() ? 'dir' : 'file'; } catch { return null; }
  } };
  const job = {
    wsl, distro: state.distro, user: state.user,
    bwrap: automationBwrapArgs(root, attempt, host, 'none'),
    chdirRoots: [toLinuxPath(root, state.distro)], isolatedEnvironment: true,
    command: ['/usr/bin/env', '-i', `HOME=/home/${state.user}`, 'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/local/bin/node',
      toLinuxPath(resolve(root, 'scripts/api-contract-sandbox-worker.mjs'), state.distro),
      toLinuxPath(request, state.distro), toLinuxPath(input, state.distro), toLinuxPath(output, state.distro)],
  };
  const result = await runManagedProcess({ command: process.execPath,
    args: [resolve(pluginDist, 'launch.js'), Buffer.from(JSON.stringify(job)).toString('base64')],
    cwd: root, env: launcherEnvironment(env), timeoutMs: 30000, logPath: resolve(attempt, 'parse.log') });
  if (result.code !== 0 || result.termination || !result.termination_confirmed) throw new Error('Sandboxed API contract parser did not finish cleanly');
  const info = lstatSync(output);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Invalid sandboxed API contract output');
  const parsed = JSON.parse(readFileSync(output, 'utf8'));
  if (parsed.version !== 1 || parsed.input_sha256 !== sha256(bytes) || parsed.result?.source_sha256 !== parsed.input_sha256 ||
      parsed.result.source_path !== (options.source_path ?? null)) throw new Error('Sandboxed API contract output mismatch');
  return { ...parsed.result, sandbox_backend: 'wsl', sandbox_network: 'none' };
}

export async function inspectApiContractInRuntime(root, runId, bytes, options = {}, env = process.env) {
  return managedApiContractSandbox(root, env)
    ? inspectApiContractSandbox(root, runId, bytes, options, env)
    : inspectApiContract(bytes, options);
}
