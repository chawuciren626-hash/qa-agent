import { resolve, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applicationDataRoot, assertPlainPath } from './application-data.mjs';
import { probePython } from './command-runtime.mjs';
import { writeJson } from './orchestration-state.mjs';

export function configurePython(engine,executable,env=process.env) {
  if(!isAbsolute(executable ?? '')) throw new Error('Supply one absolute Python executable');
  const probe=probePython({...env,QA_PYTHON:executable});
  if(probe.status!=='ready') throw new Error(probe.reason);
  const dir=assertPlainPath(resolve(applicationDataRoot(engine,env),'runtime'));mkdirSync(dir,{recursive:true});
  writeJson(assertPlainPath(resolve(dir,'python.json')),{version:1,executable:probe.executable});
  return {status:'configured',executable:probe.executable,scope:'local_application_runtime_only',model_or_proxy_changed:false};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(process.argv.length!==3) throw new Error('Usage: node scripts/configure-python.mjs <absolute-python-executable>');
  console.log(JSON.stringify(configurePython(resolve(import.meta.dirname,'..'),process.argv[2])));
}
