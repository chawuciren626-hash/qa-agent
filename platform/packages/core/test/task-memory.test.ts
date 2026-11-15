import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveTaskMemory, taskMemorySnapshotPath } from '../src/state/task-memory.js';
import { saveUserPreference } from '../src/state/user-preferences.js';

it('keeps injected memory fixed across contexts and rejects another owner or altered bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-memory-'));
  try {
    const args = {root, projectId:'p', agentId:'a', sessionId:'session-test', workspaceDir:path.join(root,'workspace'), enabled:true, userId:'alice'};
    await fs.mkdir(args.workspaceDir);
    await saveUserPreference(root, 'alice', { title:'Language', content:'Answer in Chinese' });
    const initial = await resolveTaskMemory(args);
    expect(initial?.userPreferences?.block).toContain('Answer in Chinese');
    await saveUserPreference(root, 'alice', { title:'Format', content:'Use tables' });
    expect(await resolveTaskMemory(args)).toEqual(initial);
    expect((await resolveTaskMemory({...args, sessionId:'session-next'}))?.userPreferences?.block).toContain('Use tables');
    await expect(resolveTaskMemory({...args, userId:'bob'})).rejects.toThrow('identity');
    const file = taskMemorySnapshotPath(args);
    expect(file).not.toContain('agent_state');
    const snapshot = JSON.parse(await fs.readFile(file,'utf8')); snapshot.memory.userIndex = 'tampered';
    await fs.writeFile(file,JSON.stringify(snapshot));
    await expect(resolveTaskMemory(args)).rejects.toThrow('integrity');
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});
