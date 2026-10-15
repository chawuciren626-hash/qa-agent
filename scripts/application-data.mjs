import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const within = (base, path) => {
  const rel = relative(base, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function assertPlainPath(path) {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent=dirname(ancestor);
    if(parent===ancestor) throw new Error('Application data has no existing ancestor');
    ancestor=parent;
  }
  if (realpathSync(ancestor) !== ancestor) throw new Error('Application data must not redirect through a link');
  return resolve(path);
}

export function applicationDataRoot(engine, env = process.env) {
  const configured = env.QA_APP_DATA_ROOT;
  if (configured !== undefined && (!configured || !isAbsolute(configured))) throw new Error('QA_APP_DATA_ROOT must be absolute');
  const base = configured ?? resolve(env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'), 'AITestWorker');
  const root = assertPlainPath(base);
  if (within(resolve(engine), root) || within(root, resolve(engine))) throw new Error('Application data must be separate from the engine');
  return root;
}

export function workspaceIndexRoot(engine, env = process.env) {
  return assertPlainPath(resolve(applicationDataRoot(engine, env), 'session-workspaces'));
}
