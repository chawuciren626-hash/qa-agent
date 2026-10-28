import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {syncPenguinAgents} from './sync-penguin-agents.mjs';
import {isDeepStrictEqual} from 'node:util';

const root=resolve(import.meta.dirname,'..');
export function qaRoles() {
  return JSON.parse(readFileSync(resolve(root,'penguin/agents.json'),'utf8')).agents.map(({id,skills})=>({id,skills}));
}
export function initializeQaRoles(agentRoot) {
  return syncPenguinAgents(root,agentRoot,{apply:true});
}
export async function qaRoleTools(id,tools) {
  const next=structuredClone(tools);
  const props=next?.find(t=>t.name==='exec_command')?.parameters?.properties;
  const builtin={type:'object',description:'AITestHarness structured action object. The QA pre-tool hook saves this exact request before project-action.mjs execute. Omit for ordinary shell commands.'};
  // Only the known source default may be replaced; the transforms reject custom schemas.
  if(props && isDeepStrictEqual(props.qa_request,builtin)) delete props.qa_request;
  if(id==='test_agent') return (await import('./sync-controller-tool-interface.mjs')).controllerTools(next);
  return (await import('./sync-child-tool-interface.mjs')).childInlineTools(next);
}
