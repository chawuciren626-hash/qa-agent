import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const input=JSON.parse(readFileSync(0,'utf8'));
  const config=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'project.json'),'utf8'));
  const {guardDefaultDelegation}=await import(pathToFileURL(resolve(config.root,'scripts/default-agent-guard.mjs')).href);
  console.log(JSON.stringify(guardDefaultDelegation(config.root,input)));
} catch {console.log(JSON.stringify({decision:'deny',reason:'Default QA entry hook unavailable; no QA child was authorized.'}));}
