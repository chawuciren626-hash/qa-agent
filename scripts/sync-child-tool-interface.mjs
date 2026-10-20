import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { stageDefinitions } from './stage-registry.mjs';

const parameter={type:'object',description:'Complete action JSON for this registered professional dispatch. Use project-action.mjs execute --controller-session=<parent> --request=output/action-requests/<unique>.json. The role hook persists it before execution, so no separate write_file is needed. All existing authorization and stage guards remain. Reuse operation IDs after transport uncertainty; never replay unknown submissions.'};
export function childInlineTools(tools) {
  if(!Array.isArray(tools)) throw new Error('Missing persisted tools');
  const result=structuredClone(tools),matches=result.filter(t=>t.name==='exec_command');
  if(matches.length!==1 || matches[0].parameters?.type!=='object' || !matches[0].parameters.properties?.cmd) throw new Error('Unsupported professional exec schema');
  const properties=matches[0].parameters.properties;
  if(properties.qa_request && !isDeepStrictEqual(properties.qa_request,parameter)) throw new Error('Custom qa_request retained; interface compatibility review needed');
  properties.qa_request=parameter;return result;
}
export async function syncChildInterfaces(api,{apply=false}={}) {
  const planned=[];
  for(const id of [...new Set(stageDefinitions.map(s=>s.agent))]) {
    const path=`projects/default_project/agents/${id}/config`,before=await api(path);
    if(before.activeSessionCount!==0 || before.config?.hooks?.enabled===false) throw new Error('Professional role is active or hook disabled; no interface writes');
    planned.push({id,path,before,tools:childInlineTools(before.config?.toolsBuiltin)});
  }
  const changed=planned.filter(p=>!isDeepStrictEqual(p.tools,p.before.config.toolsBuiltin));
  if(apply) for(const p of changed) {
    const current=await api(p.path);
    if(current.activeSessionCount!==0 || !isDeepStrictEqual(current.config,p.before.config)) throw new Error('Professional config changed; interface update refused');
    await api(p.path,'PUT',{config:{toolsBuiltin:p.tools}});
    const after=await api(p.path),omit=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='toolsBuiltin'));
    if(!isDeepStrictEqual(after.config.toolsBuiltin,p.tools) || !isDeepStrictEqual(omit(after.config),omit(p.before.config)) || after.agentsMd!==p.before.agentsMd) throw new Error('Interface verification failed; inspect config before continuing');
  }
  return {status:changed.length?apply?'synchronized':'update_available':'in_sync',roles:changed.map(p=>p.id),model_proxy_and_other_fields_unchanged:true};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(process.argv.slice(2).some(a=>a!=='--apply')) throw new Error('Use --apply or no arguments');
  const token=readFileSync(resolve(homedir(),'.penguin/data/api-token'),'utf8').trim();
  const api=async(path,method='GET',body)=>{
    const response=await fetch(`http://localhost:59764/api/${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`Role config HTTP ${response.status}`);return response.json();
  };
  console.log(JSON.stringify(await syncChildInterfaces(api,{apply:process.argv.includes('--apply')})));
}
