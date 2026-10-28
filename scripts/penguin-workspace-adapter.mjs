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
  const projectMarker=state.root && /^[a-zA-Z0-9_-]+$/.test(state.projectId ?? '') ? resolve(state.root,state.projectId,'qa-project.json') : null;
  const enabledProject=projectMarker && existsSync(projectMarker) && JSON.parse(readFileSync(projectMarker,'utf8')).status==='ready';
  return config.enabled && (enabledProject || (!process.env.AITEST_ENGINE_ROOT && state.projectId===config.project_id)) && state.agentId===config.controller_agent && opts.source!=='subagent' && !opts.subagentDepth;
}
export function bindWorkspace(state,opts,sessionId,previous) {
  if(!applies(state,opts)) return previous;
  const config=settings();
  const defaultWorkspace=process.env.QA_WORKSPACE_ROOT ? resolve(process.env.QA_WORKSPACE_ROOT,state.projectId) : config.default_workspace;
  const workspace=resolve(opts.workspaceDir || defaultWorkspace);
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
  let workspace=meta?.workspace;
  let indexed;
  if(meta) {
    if(meta.session_id!==sessionId || meta.source!=='subagent' || resolve(meta.agent_state ?? '')!==resolve(agentRoot,agentId,'agent_state')) throw new Error('Child hook trace identity mismatch');
  } else {
    // A resumed trace can start at request_begin after the host rotated the trace file.
    // Bind it to the host timing stamp and the parent's persisted workspace index.
    const stamps=rows.map(row=>row.qa_timing).filter(Boolean);
    if(!stamps.length || stamps.some(stamp=>stamp.version!==1 || stamp.session_id!==sessionId || !/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(stamp.owner_session_id ?? ''))) throw new Error('Child hook trace identity mismatch');
    const owners=new Set(stamps.map(stamp=>stamp.owner_session_id));
    if(owners.size!==1) throw new Error('Child hook trace identity mismatch');
    const owner=[...owners][0];
    const index=assertPlainPath(resolve(workspaceIndexRoot(engine),`${owner}.json`));
    if(!existsSync(index)) throw new Error('Child hook parent workspace binding is missing');
    indexed=JSON.parse(readFileSync(index,'utf8'));
    if(indexed.session_id!==owner) throw new Error('Child hook parent workspace binding mismatch');
    const parentDir=resolve(agentRoot,'test_agent','traces',owner.slice(8,18));
    const parentFiles=readdirSync(parentDir).filter(name=>name.startsWith(`${owner}_`) && name.endsWith('.jsonl')).sort();
    const parentRows=parentFiles.flatMap(name=>readFileSync(resolve(parentDir,name),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));
    const parentMeta=parentRows.find(row=>row.type==='session_meta')?.payload;
    const call=parentRows.find(row=>{
      if(row.payload?.type!=='tool_call' || row.payload.name!=='run_subagent') return false;
      try {const args=typeof row.payload.arguments==='string'?JSON.parse(row.payload.arguments):row.payload.arguments;return args?.agent_id===agentId;} catch {return false;}
    });
    const events=parentRows.filter(row=>row.payload?.type==='subagent' && row.payload.session_id===sessionId);
    if(parentMeta?.session_id!==owner || resolve(parentMeta.agent_state ?? '')!==resolve(agentRoot,'test_agent','agent_state') || resolve(parentMeta.workspace ?? '')!==resolve(indexed.session_root) || !call || events.length!==1 || parentRows.indexOf(call)>parentRows.indexOf(events[0])) throw new Error('Child hook parent dispatch identity mismatch');
    workspace=indexed.session_root;
  }
  const context=contextForWorkspace(workspace,sessionId,'subagent');
  if(!context) throw new Error('Child hook workspace has no QA session binding');
  if(indexed && JSON.stringify(context)!==JSON.stringify(indexed)) throw new Error('Child hook parent workspace binding mismatch');
  process.env.QA_DIRECTORY_CONTEXT=JSON.stringify(context);
  return context;
}
