import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export { patchServer, relocatedPatch } from './penguin-runtime-patches.mjs';

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [app,mode='--check']=process.argv.slice(2);
  if(!app || app.startsWith('--') || !['--check','--apply','--restore','--relocate','--recover'].includes(mode)) throw new Error('Usage: <resources/app> [--check|--apply|--restore|--relocate|--recover]');
  const { installPenguinRuntime } = await import('./install-penguin-runtime.mjs');
  const result=installPenguinRuntime(app,resolve(import.meta.dirname,'..'),mode==='--relocate'?'apply':mode.slice(2));
  console.log(JSON.stringify({...result,scope:'workspace_and_delivery'}));
  if(result.status==='recovery_required') process.exitCode=1;
}
