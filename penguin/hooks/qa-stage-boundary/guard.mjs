import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const input=JSON.parse(readFileSync(0,'utf8'));
  const config=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'project.json'),'utf8'));
  const {bindChildHookContext}=await import(pathToFileURL(resolve(config.root,'scripts/penguin-workspace-adapter.mjs')).href);
  bindChildHookContext(input.session_id,config.agent_id,config.agent_root);
  const {guardChildTool}=await import(pathToFileURL(resolve(config.root,'scripts/child-tool-guard.mjs')).href);
  console.log(JSON.stringify(guardChildTool(config.root,input,{agentId:config.agent_id,agentRoot:config.agent_root})));
} catch(error) {
  console.log(JSON.stringify({decision:'deny',reason:`QA stage hook could not verify the write: ${error.message}`}));
}
