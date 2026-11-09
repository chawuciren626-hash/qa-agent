import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseActionInvocation } from './command-contracts.mjs';
import { directoryContext } from './directory-context.mjs';
import { executionChildEnv } from './execution-child-env.mjs';

const allowed=new Set(['explore_url','browser_task']);
const MAX_REQUEST=16*1024;

/** Called by the host before confinement, with host-owned context, never Agent vault values. */
export function localBrowserSpawn(root,{cmd,cwd,controlEnv={},hostEnv=process.env,toolCallId=''}) {
  if(hostEnv.AITEST_BROWSER_EXECUTION!=='local' || !controlEnv.QA_DIRECTORY_CONTEXT) return null;
  let invocation;
  try {invocation=parseActionInvocation(cmd);} catch {return null;}
  if(invocation.action!=='execute') return null;
  const context=directoryContext(root,controlEnv);
  if(context.mode!=='isolated' || invocation.options['controller-session']!==context.session_id) return null;
  const inside=value=>{const rel=relative(context.session_root,value);return rel!== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);};
  if(!inside(realpathSync(cwd))) throw new Error('Browser command cwd must belong to the current session');
  const file=resolve(context.session_root,invocation.options.request);
  if(!inside(file) || realpathSync(file)!==file) throw new Error('Browser request must be a plain current-session file');
  if(statSync(file).size>1024*1024) return null;
  const raw=readFileSync(file,'utf8');
  let request;
  try {request=JSON.parse(raw);} catch {return null;}
  if(!allowed.has(request?.action)) return null;
  if(Buffer.byteLength(raw)>MAX_REQUEST) throw new Error('Browser request exceeds the controlled request limit');
  // Snapshot the request here. The privileged child never reopens an Agent-writable request.
  const input=JSON.stringify({session:context.session_id,request});
  const env=executionChildEnv(hostEnv,{
    QA_DIRECTORY_CONTEXT:JSON.stringify(context),QA_BROWSER_EXECUTION:'local',
    ...(hostEnv.PLAYWRIGHT_BROWSERS_PATH?{PLAYWRIGHT_BROWSERS_PATH:hostEnv.PLAYWRIGHT_BROWSERS_PATH}:{}),
    ...(controlEnv.PENGUIN_AGENT_ROOT?{PENGUIN_AGENT_ROOT:controlEnv.PENGUIN_AGENT_ROOT}:{}),
    ...(controlEnv.PENGUIN_SESSION_ID?{PENGUIN_SESSION_ID:controlEnv.PENGUIN_SESSION_ID}:{}),
    QA_HOST_TOOL_CALL_ID:toolCallId,
  });
  return {argv:[process.execPath,resolve(root,'scripts/local-browser-executor.mjs')],env,input};
}

export async function executeLocalBrowser(root,envelope,{execute,signal}={}) {
  if(!envelope || !allowed.has(envelope.request?.action)) throw new Error('Only controlled browser actions may use the local browser executor');
  const context=directoryContext(root);
  if(context.mode!=='isolated' || envelope.session!==context.session_id) throw new Error('Browser executor session mismatch');
  const {bindProductCommandPaths}=await import('./product-layout.mjs');
  bindProductCommandPaths(root);
  execute ??= (await import('./structured-actions.mjs')).executeAction;
  return execute(root,envelope.session,()=>JSON.stringify(envelope.request),{signal});
}

async function main() {
  const controller=new AbortController();const stop=()=>controller.abort();
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    let input='';
    for await(const chunk of process.stdin) {input+=chunk;if(Buffer.byteLength(input)>MAX_REQUEST*2) throw new Error('Browser request exceeds limit');}
    const result=await executeLocalBrowser(resolve(import.meta.dirname,'..'),JSON.parse(input),{signal:controller.signal});
    console.log(JSON.stringify(result));process.exitCode=result.exit_code ?? 0;
  } catch {
    console.log(JSON.stringify({status:'blocked',exit_code:2,diagnostic:{category:'local_browser_request_rejected'},next_action:'inspect_owned_dispatch_and_request_no_automatic_retry'}));process.exitCode=2;
  } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) void main();
