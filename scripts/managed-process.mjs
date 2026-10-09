import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { processAlive } from './execution-attempts.mjs';

export function runManagedProcess({ command, args, cwd, env, timeoutMs, logPath, signal, onSpawn = () => {} }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Positive process timeout required');
  return new Promise(resolve => {
    const started = performance.now();
    const fd = openSync(logPath, 'wx');
    let child, timer, watchdog, settled = false, termination = null, spawnError, treeStopped = true;
    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(watchdog);
      signal?.removeEventListener('abort', abort);
      closeSync(fd);
      const stopped = !child?.pid || !processAlive(child.pid);
      if (!stopped) child.unref();
      resolve({ code, signal: exitSignal, pid: child?.pid ?? null, duration_ms: Math.round(performance.now() - started), termination, error: spawnError, termination_confirmed: stopped && treeStopped });
    };
    const stop = why => {
      if (settled || termination) return;
      termination = why;
      if (child?.pid) {
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
          treeStopped = killed.status === 0;
          if (killed.error) spawnError = killed.error.message;
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') { spawnError = error.message; treeStopped = false; } } }
      }
      watchdog = setTimeout(() => finish(null, null), 5000);
    };
    const abort = () => stop('interrupted');
    if (signal?.aborted) { termination = 'interrupted'; finish(null, null); return; }
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
      child.once('spawn', () => { try { onSpawn(child.pid); } catch (error) { spawnError = error.message; stop('tracking_failed'); } });
      child.once('error', error => { spawnError = error.message; finish(null, null); });
      child.once('close', (code, exitSignal) => finish(code, exitSignal));
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { spawnError = error.message; finish(null, null); }
  });
}
