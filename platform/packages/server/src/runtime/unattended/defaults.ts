/** Local executor adapters. Missing or unverifiable evidence stays unknown. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Component, Use } from '@prismshadow/penguin-core/kernel';
import type { RunCanceller, RunOutcomeSource } from './types.js';
import type { Sessions } from '../session-manager.js';
import type { SessionIndex } from '../../mechanisms/sessions.js';
import { qaEnabled } from '../../services/qa-engine.js';

const execFileAsync = promisify(execFile);

@Component()
export class LocalRunOutcomeSource implements RunOutcomeSource {
  @Use() private readonly sessions!: SessionIndex;
  @Use() private readonly manager!: Sessions;
  async observe(sessionId: string, fireCreatedAt?: string | null): Promise<'succeeded' | 'failed' | null> {
    if (!qaEnabled || !fireCreatedAt || !Number.isFinite(Date.parse(fireCreatedAt)) || this.manager.statusOf(sessionId) !== 'idle') return null;
    const session = this.sessions.findById(sessionId);
    if (!session?.workspace) return null;
    try {
      const engineRoot = path.resolve(process.env.AITEST_ENGINE_ROOT!);
      const marker = JSON.parse(await fs.readFile(path.join(session.workspace, '.qa-session.json'), 'utf8'));
      if (marker.session_id !== sessionId || marker.session_root !== path.resolve(session.workspace) || marker.engine_root !== engineRoot) return null;
      // Isolate the per-session directory context; never change the host process environment.
      const { stdout } = await execFileAsync(process.execPath, [path.join(engineRoot, 'scripts', 'observe-unattended-outcome.mjs'), fireCreatedAt], {
        cwd: engineRoot, env: { ...process.env, QA_DIRECTORY_CONTEXT: JSON.stringify(marker) },
        windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
      });
      const outcome: unknown = JSON.parse(stdout);
      return outcome === 'succeeded' || outcome === 'failed' ? outcome : null;
    } catch { return null; }
  }
}

@Component()
export class LocalRunCanceller implements RunCanceller {
  @Use() private readonly manager!: Sessions;
  async cancel(sessionId: string): Promise<boolean> {
    return this.manager.abortTask(sessionId);
  }
}
