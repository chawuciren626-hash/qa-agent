/** Executes Playwright test discovery inside WSL with network disabled. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourcePath } from './directory-context.mjs';
import { runDirectory } from './design-quality.mjs';
import { runManagedProcess } from './managed-process.mjs';
import { wslAutomationInvocation } from './wsl-automation.mjs';

export async function wslTestList(root, runId, plan, env = process.env) {
  const output = resolve(runDirectory(root, runId), 'execution');
  const dir = resolve(output, 'preparation-sandbox', randomUUID());
  mkdirSync(dir, { recursive: true });
  const config = JSON.parse(readFileSync(resourcePath(root, plan.environment_config), 'utf8'));
  const ids = plan.cases.map(row => row.case_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const launch = await wslAutomationInvocation({
    root, context: { output, dir }, testDir: resourcePath(root, plan.execution_policy.test_dir),
    playwrightCli: resolve(root, 'node_modules/@playwright/test/cli.js'), baseUrl: config.base_url,
    args: ['test', '--list', '--grep', `(?:^|\\s)(${ids.join('|')})(?=\\s|$)`],
    headed: false, timeoutMs: 30000, workers: 1, network: 'none', verifyBrowser: false, env,
  });
  try {
    const result = await runManagedProcess({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env,
      timeoutMs: 30000, logPath: resolve(dir, 'list.log') });
    const log = readFileSync(resolve(dir, 'list.log'), 'utf8');
    const count = Number(/Total:\s+(\d+)\s+tests?/.exec(log)?.[1]);
    const allPresent = ids.every(id => new RegExp(`(?:^|\\s)${id}(?=\\s|$)`, 'm').test(log));
    if (result.code !== 0 || result.termination || !result.termination_confirmed || !Number.isSafeInteger(count) || count < plan.cases.length || !allPresent) {
      throw new Error('WSL sandbox could not discover every planned Playwright case');
    }
    return { status: 'passed', backend: 'wsl', network: 'none', discovered: count, evidence_dir: dir };
  } finally { await launch.close?.(); }
}
