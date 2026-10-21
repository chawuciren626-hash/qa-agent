import {isDeepStrictEqual} from 'node:util';
import {controllerTools} from './sync-controller-tool-interface.mjs';
import {childInlineTools} from './sync-child-tool-interface.mjs';

const initialInline={type:'object',description:'QA controller or dispatched professional child: complete structured action JSON. With project-action.mjs execute --controller-session=<parent> --request=output/action-requests/<unique>.json, the installed QA hook saves this exact body before execution. No separate write_file is needed. Existing different contents are never overwritten. Omit for other commands; dispatch, authorization and stage guards still apply.'};
export function productAgentTools(tools,id) {
  const source=structuredClone(tools);
  const exec=Array.isArray(source)?source.find(t=>t.name==='exec_command'):null;
  // Only the exact installed adapter default may be specialized. Unknown custom schemas still fail.
  if(isDeepStrictEqual(exec?.parameters?.properties?.qa_request,initialInline))delete exec.parameters.properties.qa_request;
  return id==='test_agent'?controllerTools(source):childInlineTools(source);
}
export async function configureProductAgentTools(layout,ids,request) {
  const planned=[];
  for(const id of ids) {
    const path=`http://localhost:${layout.port}/api/projects/${encodeURIComponent(layout.project_id)}/agents/${encodeURIComponent(id)}/config`;
    const before=await request(path);
    if(before.activeSessionCount!==0||before.config?.hooks?.enabled===false)throw Error('Agent is active or hooks are disabled; initialization paused');
    planned.push({path,before,tools:productAgentTools(before.config?.toolsBuiltin,id)});
  }
  for(const item of planned)if(!isDeepStrictEqual(item.tools,item.before.config.toolsBuiltin)) {
    const current=await request(item.path);
    if(!isDeepStrictEqual(current.config,item.before.config)||current.activeSessionCount!==0)throw Error('Agent configuration changed during initialization');
    await request(item.path,{config:{toolsBuiltin:item.tools}},'PUT');
    const after=await request(item.path),withoutTools=cfg=>Object.fromEntries(Object.entries(cfg).filter(([key])=>key!=='toolsBuiltin'));
    if(!isDeepStrictEqual(after.config.toolsBuiltin,item.tools)||!isDeepStrictEqual(withoutTools(after.config),withoutTools(item.before.config)))throw Error('Agent tool interface verification failed');
  }
}
