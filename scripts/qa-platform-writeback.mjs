// 引擎 → 平台 server 的本机 HTTP 通道基础（地址与凭据发现）。
// 先例：Bearer 本地 api-token（sync-controller-tool-interface.mjs / product-doctor.mjs）；
// server 地址优先 PENGUIN_API_URL（agent 子进程 controlEnv 注入），缺省回退读
// <PENGUIN_HOME|~/.penguin/data>/server.lock 的端口。消费方：run-registration.mjs
// （运行发起/结束登记）等引擎侧需要回调平台 server 的脚本。
// 历史说明：本模块曾承载平台任务分析回写（platform_task_writeback），分析已改为
// 服务端同步模型通道，回写动作与端点已下线，只保留通道发现部分。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function hostDataDir(explicit) {
  return resolve(explicit ?? process.env.PENGUIN_HOME ?? resolve(homedir(), '.penguin', 'data'));
}

function serverLockBaseUrl(explicit) {
  const lockPath = resolve(hostDataDir(explicit), 'server.lock');
  if (!existsSync(lockPath)) throw new Error('server.lock not found: set PENGUIN_API_URL, or run inside the product');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!Number.isSafeInteger(lock.port) || lock.port < 1 || lock.port > 65535) throw new Error('invalid server.lock port');
  return `http://localhost:${lock.port}`;
}

function readTokenFile(explicit) {
  const tokenPath = resolve(hostDataDir(explicit), 'api-token');
  if (!existsSync(tokenPath)) throw new Error('api-token not found: set PENGUIN_API_TOKEN or run inside the product');
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error('invalid api-token format');
  return token;
}

/** 解析 server 地址与 Bearer 凭据：显式参数 > env（PENGUIN_API_URL/PENGUIN_API_TOKEN）> host_data 文件。 */
export function resolvePlatformEndpoint({ baseUrl, token, hostData } = {}) {
  const base = baseUrl ?? process.env.PENGUIN_API_URL ?? serverLockBaseUrl(hostData);
  const bearer = token ?? process.env.PENGUIN_API_TOKEN ?? readTokenFile(hostData);
  return { baseUrl: base.replace(/\/+$/, ''), token: bearer };
}
