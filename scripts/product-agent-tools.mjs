import {isDeepStrictEqual} from 'node:util';
import {controllerTools} from './sync-controller-tool-interface.mjs';
import {childInlineTools} from './sync-child-tool-interface.mjs';

const initialInline={type:'object',description:'QA controller or dispatched professional child: complete structured action JSON. With project-action.mjs execute --controller-session=<parent> --request=output/action-requests/<unique>.json, the installed QA hook saves this exact body before execution. No separate write_file is needed. Existing different contents are never overwritten. Omit for other commands; dispatch, authorization and stage guards still apply.'};
const sourceDefault={type:'object',description:'AITestHarness structured action object. The QA pre-tool hook saves this exact request before project-action.mjs execute. Omit for ordinary shell commands.'};
export function productAgentTools(tools,id) {
  const source=structuredClone(tools);
  const exec=Array.isArray(source)?source.find(t=>t.name==='exec_command'):null;
  const properties=exec?.parameters?.properties;
  const existing=properties?.qa_request;
  if(existing) {
    if(isDeepStrictEqual(existing,initialInline)||isDeepStrictEqual(existing,sourceDefault)) delete properties.qa_request;
    else {
      const probe=structuredClone(source);
      delete probe.find(t=>t.name==='exec_command').parameters.properties.qa_request;
      const expected=(id==='test_agent'?controllerTools(probe):childInlineTools(probe))
        .find(t=>t.name==='exec_command').parameters.properties.qa_request;
      if(!isDeepStrictEqual(existing,expected)) throw new Error('Custom qa_request retained; interface compatibility review needed');
    }
  }
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
