import {existsSync,readFileSync,mkdirSync,openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {loadProductLayout,productEnvironment} from './product-layout.mjs';
import {inspectProduct,inspectProductService} from './product-doctor.mjs';
import {checkHostUpdate} from './product-updates.mjs';
import {planProductMigration} from './product-migration-plan.mjs';

export function parseProductArguments(args) {
  const [command,...rest]=args;
  if(!['doctor','status','updates','migration-plan','start'].includes(command))throw new Error('Use doctor|status|updates|migration-plan|start --config=<installation.json> [--target=<installation.json>]');
  const options={};
  for(const arg of rest) {
    const match=/^--(config|target)=(.+)$/.exec(arg);
    if(!match||options[match[1]])throw new Error('Unknown or duplicate option');
    options[match[1]]=resolve(match[2]);
  }
  if(!options.config || (command==='migration-plan')!==!!options.target)throw new Error('Configuration required; target is required only for migration-plan');
  return {command,...options};
}
export async function startProduct(layout) {
  if(existsSync(resolve(layout.root,'.product-upgrade/active.json')))return {status:'start_blocked',reason:'installation_transaction_pending',launched:false};
  if(process.platform!=='win32')throw new Error('This product launcher currently supports Windows only');
  const doctor=inspectProduct(layout);
  if(doctor.status!=='ready')return {status:'start_blocked',reason:'installation_not_ready',diagnostics:doctor};
  const service=await inspectProductService(layout);
  if(service.status==='ready')return {status:'already_running',service,launched:false};
  // Do not reuse an unverifiable server or delete an upstream lock on behalf of the application.
  if(!['not_running','stale_lock'].includes(service.status))return {status:'start_blocked',reason:'existing_service_requires_attention',service};
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const processes=execFileSync(shell,['-NoProfile','-NonInteractive','-Command','@(Get-Process -Name PenguinHarness -ErrorAction SilentlyContinue).Count'],{windowsHide:true,encoding:'utf8',timeout:10000}).trim();
  if(!/^0$/.test(processes))return {status:'start_blocked',reason:'desktop_instance_present_close_normally_first',launched:false};
  mkdirSync(layout.paths.qa_data,{recursive:true});
  const lock=resolve(layout.paths.qa_data,'product-launch.lock');
  let fd;
  try {fd=openSync(lock,'wx');}catch{return {status:'start_blocked',reason:'launch_lock_present',launched:false};}
  try {
    writeFileSync(fd,JSON.stringify({pid:process.pid,installation_id:layout.installation_id}));
    const child=spawn(layout.paths.host_executable,[],{cwd:dirname(layout.paths.host_executable),detached:true,windowsHide:true,stdio:'ignore',env:{...productEnvironment(layout),PENGUIN_SHELL:shell}});
    await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();
    // Readiness is deliberately separate from successful process creation.
    for(let attempt=0;attempt<15;attempt++) {
      const health=await inspectProductService(layout);
      if(health.status==='ready')return {status:'started',pid:child.pid,service:health,launched:true};
      if(health.status==='authentication_required')return {status:'started_needs_sign_in_or_authentication_check',pid:child.pid,service:health,launched:true};
      await new Promise(done=>setTimeout(done,1000));
    }
    return {status:'started_readiness_unconfirmed',pid:child.pid,launched:true};
  } finally {closeSync(fd);unlinkSync(lock);}
}
export async function productMain(args) {
  const options=parseProductArguments(args),layout=loadProductLayout(options.config);
  if(options.command==='doctor')return inspectProduct(layout);
  if(options.command==='status')return inspectProductService(layout);
  if(options.command==='migration-plan')return planProductMigration(layout,loadProductLayout(options.target));
  if(options.command==='updates') {
    if(!existsSync(resolve(layout.host_app,'package.json')))throw new Error('Installed host metadata missing');
    return checkHostUpdate(JSON.parse(readFileSync(resolve(layout.host_app,'package.json'),'utf8')).version);
  }
  return startProduct(layout);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {const result=await productMain(process.argv.slice(2));console.log(JSON.stringify(result,null,2));process.exitCode=['not_ready','start_blocked','check_failed'].includes(result.status)?1:0;}
  catch(error) {console.error(JSON.stringify({status:'error',message:error.message}));process.exitCode=1;}
}
