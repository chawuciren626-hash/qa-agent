import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { directoryContext } from './directory-context.mjs';
import { runDirectory } from './design-quality.mjs';
import { executeAttempt } from './execution-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
if (!runId) throw new Error('Use --run-id=<run_id> [--headed]');

/**
 * 发起时刻的本地事实（判据 1）。
 *
 * 平台登记一次运行靠"看见 manifest"，而 manifest 在 create-run 就写好了——它只能证明
 * "这次运行存在过"。执行器自己写的 execution-state / 锁 / attempt 证明"执行开始了"，
 * 但那是**进入尝试之后**的事：执行器没起来、起来就退、参数就错，这三者在此之前长得
 * 一模一样，都是"什么都没有"。
 *
 * 这里补的是中间那一格：命令被真正调用的那一刻。三个约束：
 *   - 不联系平台：执行器是子进程，拿不到会话令牌，为一行"已发起"新开凭据通道不值得；
 *   - 不改 manifest：manifest 是产物清单，混进调度事实会让两份真源对不上；
 *   - 只写第一次：同一 run 被重跑时"发起时刻"仍是第一次，重跑本身有 attempts 记录。
 */
function recordDispatch(dir, runId) {
  const file = resolve(dir, 'execution/dispatch.json');
  if (existsSync(file)) return;
  // run 目录里还没有 manifest 时不要造目录：那不是一次运行，只是参数拼错了。
  if (!existsSync(resolve(dir, 'manifest.json'))) return;
  const context = directoryContext(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    run_id: runId,
    session_id: context.session_id,
    host: hostname(),
    dispatched_at: new Date().toISOString(),
    owner_pid: process.pid,
    headed: process.argv.includes('--headed'),
  }, null, 2)}\n`);
}

const abort = new AbortController();
const cancel = () => abort.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  // 发起记录失败不能拦住执行：dispatch.json 是辅助证据，不是闸门。
  try {
    recordDispatch(runDirectory(root, runId), runId);
  } catch (error) {
    console.error(`dispatch record skipped: ${error.message}`);
  }
  const outcome = await executeAttempt(root, runId, { headed: process.argv.includes('--headed'), signal: abort.signal });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.reason) console.error(outcome.reason);
  process.exitCode = outcome.code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 3;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
