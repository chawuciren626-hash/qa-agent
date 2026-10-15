import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const within=(base,path)=>{const rel=relative(base,path);return rel!== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);};
function plainPath(path) {
  let existing=path;
  while (!existsSync(existing)) { const parent=dirname(existing);if(parent===existing) throw new Error('Directory has no existing ancestor');existing=parent; }
  if (realpathSync(existing)!==existing) throw new Error('Directory context must not redirect through a link');
  return path;
}

export function directoryContext(engineRoot,env=process.env) {
  const engine=resolve(engineRoot);
  if (!env.QA_DIRECTORY_CONTEXT) return {version:1,mode:'legacy',engine_root:engine,workspace_root:engine,session_root:engine,session_id:null,output_root:resolve(engine,'output'),run_root:resolve(engine,'output/runs')};
  const value=JSON.parse(env.QA_DIRECTORY_CONTEXT);
  if(value.version!==1 || !['engine_root','workspace_root','session_root'].every(k=>typeof value[k]==='string' && isAbsolute(value[k]))) throw new Error('Invalid directory context paths/version');
  if(resolve(value.engine_root)!==engine) throw new Error('Directory context engine mismatch');
  if(!/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(value.session_id ?? '')) throw new Error('Directory context requires a parent session ID');
  const workspace=plainPath(resolve(value.workspace_root));const session=plainPath(resolve(value.session_root));
  if(session===workspace || !within(workspace,session)) throw new Error('Session directory must be a dedicated child of the workspace');
  if(session===engine || ['output','scripts','config','node_modules','skills','penguin'].some(name=>within(resolve(engine,name),session))) throw new Error('Session data must not overlap engine runtime directories');
  return {version:1,mode:'isolated',engine_root:engine,workspace_root:workspace,session_root:session,session_id:value.session_id,output_root:resolve(session,'output'),run_root:resolve(session,'output/runs')};
}

export function dataPath(root,...parts) {
  const context=directoryContext(root);
  const target=resolve(context.session_root,...parts);
  if(!within(context.session_root,target)) throw new Error('Data path escapes current session');
  return context.mode==='isolated'?plainPath(target):target;
}

export function assertContextSession(root,id) {
  const context=directoryContext(root);
  if(context.session_id && context.session_id!==id) throw new Error('Directory context belongs to another controller session');
  return context;
}

export function sessionWorkspaces(root,runDir) {
  const c=directoryContext(root);
  return c.mode==='legacy'?[resolve(root),runDir]:[c.workspace_root,c.session_root,runDir];
}

export function resourcePath(root,path) {
  const c=directoryContext(root);
  const target=isAbsolute(path)?resolve(path):/^(output|inputs)[\\/]/.test(path)?dataPath(root,path):resolve(root,path);
  if(!within(c.engine_root,target) && !within(c.session_root,target)) throw new Error('Resource outside engine/current session');
  if(c.mode==='isolated' && within(resolve(root,'output'),target)) throw new Error('Legacy output is not part of the current isolated session');
  plainPath(target);
  return target;
}

export function assertRunContext(root,manifest) {
  const current=directoryContext(root);
  if(current.mode==='legacy') return;
  const recorded=manifest.directory_context;
  if(recorded?.session_id!==current.session_id || recorded.session_root!==current.session_root || recorded.engine_root!==current.engine_root) throw new Error('Run belongs to another directory context; no legacy fallback');
}
