export interface OwnedProcess {
  pluginId: string;
  version: string;
  /** Kills the child process tree owned by this plugin invocation. */
  kill: () => void | Promise<void>;
  /** Removes per-invocation temporary directories. */
  cleanup?: () => void | Promise<void>;
  exited: boolean;
}

/** Tracks processes and temp data a plugin invocation owns so an abnormal exit can recycle them. */
export class OwnedProcessRegistry {
  private readonly entries = new Map<string, Set<OwnedProcess>>();

  track(sessionId: string, process: OwnedProcess): void {
    const set = this.entries.get(sessionId) ?? new Set();
    set.add(process);
    this.entries.set(sessionId, set);
  }

  markExited(sessionId: string, process: OwnedProcess): void {
    process.exited = true;
    this.dropIfEmpty(sessionId, process);
  }

  /** Session close, logout or abnormal exit: kill every owned child and remove its temporary data. */
  async recycle(sessionId: string): Promise<void> {
    const set = this.entries.get(sessionId);
    if (!set) return;
    this.entries.delete(sessionId);
    for (const process of set) {
      try { await process.kill(); } catch { /* best effort */ }
      try { await process.cleanup?.(); } catch { /* best effort */ }
      process.exited = true;
    }
  }

  running(pluginId?: string, version?: string): boolean {
    for (const set of this.entries.values()) {
      for (const process of set) {
        if (process.exited) continue;
        if (pluginId && process.pluginId !== pluginId) continue;
        if (version && process.version !== version) continue;
        return true;
      }
    }
    return false;
  }

  count(sessionId?: string): number {
    if (sessionId) return this.entries.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const set of this.entries.values()) total += set.size;
    return total;
  }

  private dropIfEmpty(sessionId: string, process: OwnedProcess): void {
    const set = this.entries.get(sessionId);
    if (!set) return;
    set.delete(process);
    if (!set.size) this.entries.delete(sessionId);
  }
}
