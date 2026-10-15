import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPenguinRuntime } from './install-penguin-runtime.mjs';
export { patchDeliveryBundle, patchDeliveryServer } from './penguin-runtime-patches.mjs';

// Compatibility API: the two patches are always maintained as one installation.
export function installDeliveryUI(app, root, mode='check') {
  return installPenguinRuntime(app, root, mode);
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [app,mode='--check']=process.argv.slice(2);
  if(!app || app.startsWith('--') || !['--check','--apply','--restore','--relocate','--recover'].includes(mode)) throw new Error('Usage: <resources/app> [--check|--apply|--restore|--relocate|--recover]');
  const result=installPenguinRuntime(app,resolve(import.meta.dirname,'..'),mode==='--relocate'?'apply':mode.slice(2));
  console.log(JSON.stringify({...result,scope:'workspace_and_delivery'}));
  if(result.status==='recovery_required') process.exitCode=1;
}
