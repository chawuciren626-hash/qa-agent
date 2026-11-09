/** Persist exactly the memory injected when a task first opens a model context. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { userPreferencesRoot } from './paths.js';
import { resolveSessionMemory, type SessionMemory } from './memory.js';

interface Snapshot {
  schemaVersion: 1; sessionId: string; ownerUserId: string | null; workspaceDir: string;
  createdAt: string; contentHash: string; memory: SessionMemory | null;
}
const digest = (memory: SessionMemory | null) => createHash('sha256').update(JSON.stringify(memory)).digest('hex');
export function taskMemorySnapshotPath(args: { root: string; projectId: string; agentId: string; sessionId: string }): string {
  const key = createHash('sha256').update(JSON.stringify([args.projectId, args.agentId, args.sessionId])).digest('hex');
  // Outside Agent State: exporting an Agent must never export personal preference bodies.
  return path.join(userPreferencesRoot(args.root), 'task-memory', key, 'task-memory.json');
}
export async function resolveTaskMemory(args: Parameters<typeof resolveSessionMemory>[0] & {sessionId: string}): Promise<SessionMemory | null> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(args.sessionId)) throw new Error('Invalid memory snapshot session');
  const file = taskMemorySnapshotPath(args);
  const dir = path.dirname(file);
  const read = async () => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Task memory snapshot must be a regular file');
    const snapshot: Snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
    if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== args.sessionId || snapshot.ownerUserId !== (args.userId ?? null) ||
      snapshot.workspaceDir !== path.resolve(args.workspaceDir) || snapshot.contentHash !== digest(snapshot.memory))
      throw new Error('Task memory snapshot identity or integrity mismatch');
    return snapshot.memory;
  };
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const memory = await resolveSessionMemory(args);
  const snapshot: Snapshot = {schemaVersion:1, sessionId:args.sessionId, ownerUserId:args.userId ?? null,
    workspaceDir:path.resolve(args.workspaceDir), createdAt:new Date().toISOString(), contentHash:digest(memory), memory};
  await fs.mkdir(dir, {recursive:true, mode:0o700});
  const tmp = path.join(dir, `.task-memory-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(snapshot), {mode:0o600});
  try { await fs.link(tmp, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await fs.rm(tmp, {force:true}); }
  return read();
}
