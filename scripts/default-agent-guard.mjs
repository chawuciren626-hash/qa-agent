import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function guardDefaultDelegation(root, input) {
  if (input.tool_name !== 'run_subagent') return {};
  try {
    const args=typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
    if(!args || typeof args.agent_id!=='string') throw new Error('Missing target');
    const manifest=JSON.parse(readFileSync(resolve(root,'penguin/agents.json'),'utf8'));
    if(manifest.agents.some(agent=>agent.id===args.agent_id)) return {decision:'deny',reason:'This default conversation is not the QA controller. Ask the user to choose test_agent in the app; do not launch QA roles as nested substitutes or request unlock approval.'};
    return {};
  } catch {return {decision:'deny',reason:'Cannot verify the delegation target. Correct the arguments; do not launch an unknown QA task.'};}
}
