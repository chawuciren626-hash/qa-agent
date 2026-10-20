import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { probePython } from './command-runtime.mjs';
import { packageMetadata } from './runtime-dependencies.mjs';
import { installPenguinRuntime } from './install-penguin-runtime.mjs';

export function engineeringPreflight(root,{app,env=process.env,staticCheck=false}={}) {
  const checks=[],add=(id,status,detail)=>checks.push({id,status,...detail});
  const [major,minor]=process.versions.node.split('.').map(Number);
  add('node',major>20 || major===20 && minor>=11?'ready':'unsupported',{version:process.version,minimum:'20.11'});
  const python=probePython(env);add('python',python.status,{executable:python.executable,minimum:'3.11',reason:python.reason});
  const require=createRequire(resolve(root,'package.json')),pkg=JSON.parse(readFileSync(resolve(root,'package.json')));
  for(const name of ['@playwright/test','ajv','xlsx','xmind']) {
    try {add(name,pkg.dependencies?.[name]?'ready':'production_dependency_missing',{version:packageMetadata(root,name).version});}
    catch {add(name,'missing');}
  }
  try {
    const path=require('@playwright/test').chromium.executablePath();
    const chrome=process.platform==='win32'?[env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean).map(base=>resolve(base,'Google/Chrome/Application/chrome.exe')).find(existsSync):null;
    add('chromium',existsSync(path) || chrome?'ready':'missing',{executable:existsSync(path)?path:chrome ?? path,channel:existsSync(path)?'bundled':'chrome',installation:'operator-only: npx --no-install playwright install chromium; no automatic task-time install'});
  }
  catch {add('chromium','missing');}
  if(app) {
    try {const result=installPenguinRuntime(app,root,'check');add('host','ready',{installation:result,compatibility:'exact version and source anchors checked; no writes'});}
    catch(error) {add('host','incompatible',{reason:error.message,authorization_denial:false});}
  }
  if(staticCheck) {
    const policy=JSON.parse(readFileSync(resolve(root,'config/release-resources.json'),'utf8'));
    for(const file of policy.files.filter(p=>p.endsWith('.mjs'))) {
      const result=spawnSync(process.execPath,['--check',resolve(root,file)],{encoding:'utf8',windowsHide:true,timeout:15000});
      if(result.status!==0) add(`syntax:${file}`,'invalid',{diagnostic:result.stderr?.slice(0,1500)});
    }
    if(python.status==='ready') {
      const files=policy.files.filter(p=>p.endsWith('.py')).map(p=>resolve(root,p));
      const result=spawnSync(python.executable,['-c','import ast,json,sys; [(ast.parse(open(p,encoding="utf-8-sig").read(),filename=p)) for p in json.load(sys.stdin)]'],{input:JSON.stringify(files),encoding:'utf8',windowsHide:true,timeout:15000});
      add('python_syntax',result.status===0?'ready':'invalid',{files:files.length,...(result.status!==0?{diagnostic:result.stderr?.slice(0,1500)}:{})});
    }
  }
  return {version:1,status:checks.every(c=>c.status==='ready')?'ready':'not_ready',read_only:true,product_authorization:false,checks};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2);
  if(args.some(a=>a!=='--static' && !a.startsWith('--app='))) throw new Error('Use --static and/or --app=<resources/app>');
  const result=engineeringPreflight(resolve(import.meta.dirname,'..'),{staticCheck:args.includes('--static'),app:args.find(a=>a.startsWith('--app='))?.slice(6)});
  console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='ready'?0:1;
}
