import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const input=JSON.parse(readFileSync(0,'utf8'));
  if(input.hook!=='stop') console.log('{}');
  else {
    const config=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'project.json'),'utf8'));
    const {bindHookContext}=await import(pathToFileURL(resolve(config.root,'scripts/penguin-workspace-adapter.mjs')).href);
    bindHookContext(input.session_id);
    const {reconcileHandoff}=await import(pathToFileURL(resolve(config.root,'scripts/controller-handoff.mjs')).href);
    console.log(JSON.stringify(await reconcileHandoff(config.root,input.session_id,config.agent_root)));
  }
} catch(error) {console.log(JSON.stringify({decision:'stop',reason:`Handoff hook unavailable: ${error.message}`}));}
