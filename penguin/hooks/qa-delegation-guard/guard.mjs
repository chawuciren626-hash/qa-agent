import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let input;
try {
  input=JSON.parse(readFileSync(0,'utf8'));
  {
    const config=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'project.json'),'utf8'));
    const {bindHookContext}=await import(pathToFileURL(resolve(config.root,'scripts/penguin-workspace-adapter.mjs')).href);
    bindHookContext(input.session_id);
    const {guardDelegation}=await import(pathToFileURL(resolve(config.root,'scripts/delegation-guard.mjs')).href);
    const {guardControllerTool}=await import(pathToFileURL(resolve(config.root,'scripts/controller-tool-guard.mjs')).href);
    const boundary=guardControllerTool(config.root,input);
    console.log(JSON.stringify(boundary.decision==='deny'?boundary:guardDelegation(config.root,input,config.agent_root)));
  }
} catch(error) {
  console.log(JSON.stringify({decision:'deny',reason:`QA hook could not verify dispatch: ${error.message}`}));
}
