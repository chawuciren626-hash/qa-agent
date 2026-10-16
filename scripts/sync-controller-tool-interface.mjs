import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export function controllerTools(tools) {
  if(!Array.isArray(tools)) throw new Error('Missing persisted builtin tool definitions');
  const result=structuredClone(tools);
  for(const name of ['exec_command','run_subagent']) if(result.filter(t=>t.name===name).length!==1) throw new Error(`Expected one ${name} definition`);
  const exec=result.find(t=>t.name==='exec_command');
  if(exec.parameters?.type!=='object' || !exec.parameters.properties?.cmd) throw new Error('Unsupported exec_command schema');
  exec.description='QA controller orchestration entry. Start with node scripts/project-action.mjs catalog. For actions use execute with the current controller-session and a unique output/action-requests JSON filename, supplying the complete action object in qa_request. The QA hook prepares the request before execution. Do not probe/install converters, generate professional reports, run arbitrary scripts or put JSON in the shell command. Professional work belongs to registered child dispatches. Only current-session run stage directory metadata may also be inspected with one ls -la command.';
  const parameter={type:'object',description:'Complete QA controller action JSON, for example {"action":"create_run"}. Supply with the normal project-action.mjs execute command and --request=output/action-requests/<unique>.json. The hook saves these exact contents before execution, without a separate write_file. Never infer missing fields or blindly replay an action whose result is unknown.'};
  const existing=exec.parameters.properties.qa_request;
  if(existing && !isDeepStrictEqual(existing,parameter)) throw new Error('Custom qa_request definition preserved; review compatibility before replacing');
  exec.parameters.properties.qa_request=parameter;
  exec.parameters.properties.workdir={...exec.parameters.properties.workdir,type:'string',description:'Omit to use this session workspace. Structured QA commands must not change workdir; CWD is not a directory name.'};
  const child=result.find(t=>t.name==='run_subagent');
  if(child.parameters?.type!=='object' || !child.parameters.properties?.prompt) throw new Error('Unsupported run_subagent schema');
  child.parameters.properties.agent_id={...child.parameters.properties.agent_id,type:'string',description:'Required target role from the registered delegation.agent_id. Copy it exactly; do not omit it or use the caller role.'};
  child.parameters.required=[...new Set([...(child.parameters.required ?? []),'agent_id','description','prompt'])];
  child.parameters.properties.description={...child.parameters.properties.description,type:'string',description:'Short user-facing description. May use the user language; it does not replace or modify the registered prompt.'};
  child.parameters.properties.yield_time_ms={type:'number',minimum:250,maximum:600000,description:'Optional wait time in milliseconds; affects only how long this call waits, not the child task scope. Omit for the host default.'};
  const allowed=new Set(['agent_id','description','prompt','yield_time_ms']);
  if(child.parameters.required.some(key=>!allowed.has(key))) throw new Error('Unsupported required child tool option; preserve custom schema');
  child.parameters.properties=Object.fromEntries(Object.entries(child.parameters.properties).filter(([key])=>allowed.has(key)));
  child.parameters.additionalProperties=false;
  child.description='Launch the registered QA child delegation returned by dispatch. First create/archive/plan/dispatch through project-action; then read the returned delegation JSON. Copy agent_id and prompt exactly; only description is display text and may use the user language. Never omit the target role or invent run_id, dispatch_id or paths. A rejected unregistered call did not launch a child; correct orchestration, never bypass it with a generic helper.';
  return result;
}

export async function syncControllerInterface(api,{apply=false}={}) {
  const path='projects/default_project/agents/test_agent/config';
  const before=await api(path);
  if(before.activeSessionCount!==0) throw new Error('Controller has active tasks; interface sync deferred');
  if(before.config?.hooks?.enabled===false) throw new Error('QA hook is disabled; request preparation cannot be enabled');
  const tools=controllerTools(before.config?.toolsBuiltin);
  if(isDeepStrictEqual(tools,before.config.toolsBuiltin)) return {status:'in_sync',changed:false};
  if(!apply) return {status:'update_available',changed:true};
  const current=await api(path);
  if(current.activeSessionCount!==0 || !isDeepStrictEqual(current.config,before.config)) throw new Error('Controller changed during preparation; sync refused');
  // The host parses and updates YAML. Never rewrite model, proxy, credentials or unrelated fields.
  await api(path,'PUT',{config:{toolsBuiltin:tools}});
  const after=await api(path);
  const withoutTools=value=>{const copy=structuredClone(value);delete copy.toolsBuiltin;return copy;};
  if(!isDeepStrictEqual(after.config.toolsBuiltin,tools) || !isDeepStrictEqual(withoutTools(before.config),withoutTools(after.config)) || after.agentsMd!==before.agentsMd) throw new Error('Interface verification failed; inspect before proceeding');
  return {status:'synchronized',changed:true,model_unchanged:true,other_config_unchanged:true};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(process.argv.slice(2).some(arg=>arg!=='--apply')) throw new Error('Use --apply or no arguments for read-only check');
  const token=readFileSync(resolve(homedir(),'.penguin/data/api-token'),'utf8').trim();
  const api=async(path,method='GET',body)=>{
    const response=await fetch(`http://localhost:59764/api/${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`Controller config HTTP ${response.status}`);
    return response.json();
  };
  console.log(JSON.stringify(await syncControllerInterface(api,{apply:process.argv.includes('--apply')})));
}
