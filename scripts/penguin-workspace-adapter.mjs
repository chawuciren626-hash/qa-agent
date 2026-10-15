import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryContext } from './directory-context.mjs';
import { workspaceIndexRoot, assertPlainPath, within } from './application-data.mjs';

const engine=resolve(import.meta.dirname,'..');
const settings=()=>JSON.parse(readFileSync(resolve(engine,'config/session-workspaces.json'),'utf8'));
const marker=workspace=>resolve(workspace,'.qa-session.json');
export function applies(state,opts) {
  const config=settings();
  return config.enabled && state.projectId===config.project_id && state.agentId===config.controller_agent && opts.source!=='subagent' && !opts.subagentDepth;
}
export function bindWorkspace(state,opts,sessionId,previous) {
  if(!applies(state,opts)) return previous;
  const config=settings();
  const workspace=resolve(opts.workspaceDir || config.default_workspace);
  const canonical=assertPlainPath(workspace);
  if(within(engine,canonical)) throw new Error('The engine directory is for program files. Choose an external workspace or leave Workspace empty to use the default.');
  const name=sessionId.replace(/^session-/,'');
  const session=resolve(workspace,name);
  const context=directoryContext(engine,{QA_DIRECTORY_CONTEXT:JSON.stringify({version:1,engine_root:engine,workspace_root:workspace,session_root:session,session_id:sessionId})});
  const index=workspaceIndexRoot(engine);
  if(existsSync(session)) throw new Error('New session directory already exists; refusing to reuse it');
  mkdirSync(session,{recursive:true});
  for(const dir of ['inputs','output/action-requests','output/runs','scripts']) mkdirSync(resolve(session,dir),{recursive:true});
  writeFileSync(marker(session),JSON.stringify(context,null,2)+'\n',{flag:'wx'});
  // Tiny entry shims keep familiar commands usable without copying the engine or dependencies.
  for(const file of ['project-action.mjs','project-command.mjs']) writeFileSync(resolve(session,'scripts',file),`import ${JSON.stringify(pathToFileURL(resolve(engine,'scripts',file)).href)};\n`,{flag:'wx'});
  mkdirSync(index,{recursive:true});
  writeFileSync(resolve(index,`${sessionId}.json`),JSON.stringify(context,null,2)+'\n',{flag:'wx'});
  return session;
}
export function contextForWorkspace(workspace,sessionId,source) {
  if(!existsSync(marker(workspace))) return null;
  const context=directoryContext(engine,{QA_DIRECTORY_CONTEXT:readFileSync(marker(workspace),'utf8')});
  if(context.session_root!==resolve(workspace) || realpathSync(workspace)!==resolve(workspace)) throw new Error('Session workspace binding mismatch');
  if(source!=='subagent' && context.session_id!==sessionId) throw new Error('Workspace belongs to another session');
  return context;
}
export function workspaceEnv(workspace,sessionId,source) {
  const context=contextForWorkspace(workspace,sessionId,source);
  return context?{QA_DIRECTORY_CONTEXT:JSON.stringify(context)}:{};
}
export function bindHookContext(sessionId) {
  if(!/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(sessionId ?? '')) throw new Error('Invalid hook session');
  const current=assertPlainPath(resolve(workspaceIndexRoot(engine),`${sessionId}.json`));
  const legacy=resolve(engine,'output/session-workspaces',`${sessionId}.json`);
  const path=existsSync(current)?current:legacy;
  if(!existsSync(path)) return;
  const context=JSON.parse(readFileSync(path,'utf8'));
  const actual=contextForWorkspace(context.session_root,sessionId);
  if(JSON.stringify(context)!==JSON.stringify(actual)) throw new Error('Session index and workspace marker differ');
  process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(actual);
}

export function bindChildHookContext(sessionId,agentId,agentRoot) {
  const date=/^session-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.exec(sessionId ?? '')?.[1];
  if(!date || !/^[a-z0-9_]+$/.test(agentId ?? '')) throw new Error('Invalid child hook identity');
  const dir=resolve(agentRoot,agentId,'traces',date);
  const files=readdirSync(dir).filter(name=>name.startsWith(`${sessionId}_`) && name.endsWith('.jsonl')).sort();
  if(!files.length) throw new Error('Child hook trace is missing');
  const rows=files.flatMap(name=>readFileSync(resolve(dir,name),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));
  const meta=rows.find(row=>row.type==='session_meta')?.payload;
  if(meta?.session_id!==sessionId || meta.source!=='subagent' || resolve(meta.agent_state ?? '')!==resolve(agentRoot,agentId,'agent_state')) throw new Error('Child hook trace identity mismatch');
  const context=contextForWorkspace(meta.workspace,sessionId,'subagent');
  if(!context) throw new Error('Child hook workspace has no QA session binding');
  process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(context);
  return context;
}
