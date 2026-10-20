import { mkdtempSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { within } from './application-data.mjs';
import { packageMetadata } from './runtime-dependencies.mjs';

const root=resolve(import.meta.dirname,'..'),base=realpathSync(tmpdir()),dir=realpathSync(mkdtempSync(resolve(base,'qa-production-')));
try {
  for(const file of ['package.json','package-lock.json']) copyFileSync(resolve(root,file),resolve(dir,file));
  // Use npm's installed CLI without shell composition or lifecycle scripts.
  const npm=resolve(process.execPath,'../node_modules/npm/bin/npm-cli.js');
  const result=spawnSync(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--fetch-timeout=20000'],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
  if(result.status!==0) throw new Error(`Production npm ci failed: ${result.stderr?.slice(-2000)}`);
  const require=createRequire(resolve(dir,'package.json'));
  const packages={};for(const name of ['@playwright/test','ajv','xlsx','xmind']) {require(name);packages[name]=packageMetadata(dir,name).version;}
  console.log(JSON.stringify({status:'passed',omit_dev:true,lifecycle_scripts:false,packages,browser_binary:'separate operator installation; not downloaded by this check'}));
} finally {
  if(!within(base,dir) || dir===base || realpathSync(dir)!==dir || !dir.startsWith(resolve(base,'qa-production-'))) throw new Error('Refusing cleanup outside generated production fixture');
  rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:250});
}
