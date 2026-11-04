/** Confined DOCX parsing with host-side input validation and result publication. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { resolveWslRuntime } from './wsl-automation.mjs';
import { runManagedProcess } from './managed-process.mjs';
import { safeInputName } from './command-contracts.mjs';

export async function extractWordSandbox(root, runId, source, env = process.env) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || typeof source !== 'string' || !source.startsWith('inputs/') || !safeInputName(source.slice(7)) || !/\.docx$/i.test(source)) throw new Error('Expected run ID and run-local DOCX input');
  const run = runDirectory(root, runId);
  const original = readRunFile(run, source);
  if (original.data.length > 32 * 1024 * 1024) throw new Error('DOCX exceeds 32 MiB input limit');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const attempt = resolve(run, 'audit/extractions', randomUUID());
  mkdirSync(attempt, { recursive: true });
  const input = resolve(attempt, 'input.docx');
  writeFileSync(input, original.data, { flag: 'wx' });
  if (hash(readFileSync(input)) !== original.sha256) throw new Error('DOCX snapshot checksum mismatch');
  const { pluginDist, dataDir } = resolveWslRuntime(root, env);
  const state = JSON.parse(readFileSync(resolve(dataDir, 'state.json'), 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.distro ?? '') || !/^[a-z_][a-z0-9_-]*$/i.test(state.user ?? '')) throw new Error('Invalid WSL sandbox state');
  const { automationBwrapArgs, toLinuxPath } = await import(pathToFileURL(resolve(pluginDist, 'index.js')).href);
  const { launcherEnvironment } = await import(pathToFileURL(resolve(pluginDist, 'launch.js')).href);
  const wsl = resolve(env.SystemRoot ?? 'C:/Windows', 'System32/wsl.exe');
  const host = { distro: state.distro, exposeWindowsDrives: false, drives: [], kind: p => {
    try { return statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return null; }
  } };
  const job = {
    wsl, distro: state.distro, user: state.user,
    bwrap: automationBwrapArgs(root, attempt, host, 'none'),
    chdirRoots: [toLinuxPath(root, state.distro)], isolatedEnvironment: true,
    command: ['/usr/bin/env', '-i', `HOME=/home/${state.user}`, 'PATH=/usr/bin:/bin', '/usr/bin/python3',
      toLinuxPath(resolve(root, 'scripts/extract-word-sandbox.py'), state.distro),
      toLinuxPath(input, state.distro), toLinuxPath(attempt, state.distro), runId, source],
  };
  const result = await runManagedProcess({ command: process.execPath,
    args: [resolve(pluginDist, 'launch.js'), Buffer.from(JSON.stringify(job)).toString('base64')],
    cwd: root, env: launcherEnvironment(env), timeoutMs: 30000, logPath: resolve(attempt, 'parse.log') });
  if (result.code !== 0 || result.termination || !result.termination_confirmed) throw new Error('Sandboxed DOCX parser did not finish cleanly');
  const outputFile = name => {
    const path = resolve(attempt, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Invalid sandboxed DOCX parser output');
    return readFileSync(path);
  };
  const metadata = outputFile('metadata.json');
  const text = outputFile('text.txt');
  const parsed = JSON.parse(metadata);
  if (parsed.version !== 1 || parsed.run_id !== runId || parsed.original !== source || parsed.original_sha256 !== original.sha256 || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.warnings) || !text.length) throw new Error('Sandboxed DOCX parser output mismatch');
  if (readRunFile(run, source).sha256 !== original.sha256) throw new Error('DOCX changed during sandboxed extraction');
  const outputs = [[resolve(run, `${source}.txt`), text], [resolve(run, `${source}.extraction.json`), metadata]];
  for (const [path, bytes] of outputs) if (existsSync(path)) {
    if (!lstatSync(path).isFile() || !readFileSync(path).equals(bytes)) throw new Error('Existing extraction differs or is linked; preserve it and use a new input name');
  }
  for (const [path, bytes] of outputs) if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
  return { status: 'extracted', original: source, text_path: `${source}.txt`, metadata_path: `${source}.extraction.json`, original_sha256: original.sha256, block_count: parsed.blocks.length, warnings: parsed.warnings, sandbox_backend: 'wsl', attempt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await extractWordSandbox(resolve(import.meta.dirname, '..'), process.argv[2], process.argv[3]))); }
  catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 2; }
}
