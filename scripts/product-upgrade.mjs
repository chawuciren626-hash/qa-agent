import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,lstatSync,renameSync,copyFileSync,unlinkSync,openSync,closeSync,fsyncSync,constants} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertPlainPath,within} from './application-data.mjs';
import {loadProductLayout} from './product-layout.mjs';
import {withLocalServicePaused} from './local-service.mjs';

const items=['AITestHarness.exe','app','runtime','licenses','THIRD-PARTY-NOTICES.txt','product-payload.json'];
const json=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
// Windows scanners can briefly hold newly copied executables open. Keep the
// transaction intact while waiting; permanent failures still enter rollback.
export function renameWithRetry(source,target,{rename=renameSync,platform=process.platform,retries=40,delay=250,sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  for(let attempt=0;;attempt++){
    try{return rename(source,target);}catch(error){
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=retries)throw error;
      sleep(delay);
    }
  }
}
function save(file,value){const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});const fd=openSync(tmp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);}
function plainTree(file){assertPlainPath(file);if(lstatSync(file).isSymbolicLink())throw Error('Linked installation file refused');if(lstatSync(file).isDirectory())for(const name of readdirSync(file))plainTree(resolve(file,name));}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(dir,e.name)):[resolve(dir,e.name)]);}
// Node 24.14's native cpSync can silently omit directories at non-ASCII Windows destinations.
// Explicit directory creation and exclusive file copies also make incomplete copies fail visibly.
function copyTree(source,target){
  const stat=lstatSync(source);if(stat.isSymbolicLink())throw Error('Linked candidate entry');
  if(stat.isDirectory()){mkdirSync(target);for(const name of readdirSync(source))copyTree(resolve(source,name),resolve(target,name));}
  else if(stat.isFile())copyFileSync(source,target,constants.COPYFILE_EXCL);
  else throw Error('Unsupported candidate entry');
}
function validName(name){return typeof name==='string'&&!/[\\:\x00-\x1f]/.test(name)&&!name.split('/').some(x=>!x||x==='.'||x==='..')&&(items.some(x=>name===x||(['app','runtime','licenses'].includes(x)&&name.startsWith(x+'/')))||name==='installation.json');}
function version(value){const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(value);if(!m)throw Error('Unsupported product version');return [...m.slice(1,4).map(Number),m[4]===undefined?Number.MAX_SAFE_INTEGER:Number(m[4])];}
function compare(a,b){const x=version(a),y=version(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;}
function manifest(root,verify=false){
  const m=json(resolve(root,'product-payload.json'));
  if(m.version!==1||!m.files||Array.isArray(m.files)||typeof m.files!=='object'||!m.files['AITestHarness.exe'])throw Error('Invalid product ownership manifest');
  version(m.product_version);
  for(const [name,digest] of Object.entries(m.files))if(!validName(name)||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid manifest entry');
  if(verify){
    for(const name of Object.keys(m.files)){const p=resolve(root,name);assertPlainPath(p);if(!lstatSync(p).isFile()||hash(p)!==m.files[name])throw Error('Candidate checksum mismatch');}
    for(const name of ['app','runtime','licenses']){plainTree(resolve(root,name));for(const file of walk(resolve(root,name)))if(!m.files[relative(root,file).replaceAll('\\','/')])throw Error('Unlisted candidate file');}
    for(const name of [...items.filter(x=>x!=='product-payload.json'),'installation.json'])if(!existsSync(resolve(root,name)))throw Error('Incomplete candidate');
  }
  return m;
}
export function assertProductStopped(root){
  if(process.platform!=='win32')throw Error('Windows upgrade required');
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const code='$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; $root=[IO.Path]::GetFullPath($env:QA_UPGRADE_ROOT).TrimEnd("\\")+"\\"; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) }).Count';
  const count=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{env:{...process.env,QA_UPGRADE_ROOT:root},encoding:'utf8',windowsHide:true,timeout:20000}).trim();
  if(count!=='0')throw Error('应用仍在运行，请退出 AITestHarness 后重试安装。');
}
function validateLayout(root){
  const layout=loadProductLayout(resolve(root,'installation.json'));
  if(layout.root!==root||layout.layout!=='unified'||layout.paths.engine!==resolve(root,'app/engine')||layout.paths.host_executable!==resolve(root,'runtime/penguin/PenguinHarness.exe')||layout.paths.node!==resolve(root,'runtime/tools/node/node.exe'))throw Error('Unsupported installation layout');
  // This transaction never migrates data. Require the canonical protected data areas.
  for(const key of ['host_data','qa_data','desktop_profile','workspaces'])if(!['data','workspaces'].some(name=>within(resolve(root,name),layout.paths[key])))throw Error('Data outside protected installation areas');
  return layout;
}
function preserveConfig(root,old,incoming){
  const base=resolve(root,'app/engine/config');
  for(const file of walk(base)){
    const name=relative(root,file).replaceAll('\\','/');
    if(old.files[name]){if(hash(file)!==old.files[name])throw Error('Packaged configuration was edited; review before upgrading');continue;}
    const to=resolve(incoming,name);if(existsSync(to))throw Error('New version conflicts with a local configuration file');mkdirSync(dirname(to),{recursive:true});copyFileSync(file,to);
  }
}
function transactionPaths(root){return {base:resolve(root,'.product-upgrade'),active:resolve(root,'.product-upgrade/active.json')};}
function rollback(root,tx,state,move){
  const backup=resolve(tx,'backup'),incoming=resolve(tx,'incoming'),failed=resolve(tx,'failed');mkdirSync(failed,{recursive:true});
  // Work backwards; existence is authoritative across a crash between rename and journal update.
  for(const name of [...state.items].reverse()){
    const dest=resolve(root,name),old=resolve(backup,name),next=resolve(incoming,name),discard=resolve(failed,name);
    if(existsSync(old)){
      if(existsSync(dest)){if(existsSync(discard))throw Error('Rollback destination conflict');move(dest,discard);}
      move(old,dest);
    }else if(!state.had_old[name]&&!existsSync(next)&&existsSync(dest)){
      if(existsSync(discard))throw Error('Rollback destination conflict');move(dest,discard);
    }
  }
  state.status='rolled_back';save(resolve(tx,'transaction.json'),state);
}
export function recoverProductUpgrade(root,{assertStopped=assertProductStopped,processAlive=alive,move=renameWithRetry}={}){
  root=assertPlainPath(resolve(root));const {base,active}=transactionPaths(root);if(!existsSync(active))return {status:'no_pending_transaction'};
  plainTree(base);const lock=json(active);
  if(lock.version!==1||!/^[-a-f0-9]{36}$/.test(lock.id)||!Number.isInteger(lock.pid))throw Error('Invalid upgrade lock');
  if(processAlive(lock.pid))throw Error('Another installer is active');
  assertStopped(root);
  const tx=resolve(base,lock.id),file=resolve(tx,'transaction.json');
  if(!existsSync(file))throw Error('Incomplete transaction journal; manual recovery required');
  const state=json(file);
  if(state.version!==1||state.root!==root||!Array.isArray(state.items)||state.items.some(x=>![...items,'installation.json'].includes(x))||new Set(state.items).size!==state.items.length||!state.had_old||state.items.some(x=>typeof state.had_old[x]!=='boolean')||!['preparing','swapping','committed','rolled_back'].includes(state.status))throw Error('Invalid recovery journal');
  if(state.status==='swapping')rollback(root,tx,state,move);
  // preparing never changes program files, committed must never revert a later user's data.
  unlinkSync(active);return {status:state.status==='committed'?'already_committed':'recovered',transaction:lock.id};
}
function configure(root){
  const node=resolve(root,'runtime/tools/node/node.exe'),engine=resolve(root,'app/engine');
  execFileSync(node,[resolve(engine,'scripts/product-setup.mjs'),resolve(root,'installation.json')],{cwd:root,windowsHide:true,stdio:'pipe',timeout:120000});
}
export function installProductCandidate(source,root,{assertStopped=assertProductStopped,performSetup=configure,checkpoint=()=>{},processAlive=alive,move=renameWithRetry}={}){
  source=assertPlainPath(resolve(source));root=assertPlainPath(resolve(root));
  if(within(root,source)||within(source,root)||within(root,process.execPath))throw Error('Installer runtime and candidate must be outside the target');
  const next=manifest(source,true);validateLayout(source);
  if(next.host_version!=='0.2.16'||next.upgrade?.protocol!==1||next.upgrade?.data_version!==1)throw Error('Candidate compatibility contract unsupported');
  mkdirSync(root,{recursive:true});const {base,active}=transactionPaths(root);
  if(existsSync(active))recoverProductUpgrade(root,{assertStopped,processAlive,move});
  assertStopped(root);
  const oldFile=resolve(root,'product-payload.json');const upgrading=existsSync(oldFile);
  let old;
  if(upgrading){
    old=manifest(root);validateLayout(root);
    if(old.host_version!==next.host_version||(old.upgrade?.data_version??(old.product_version==='0.1.0-preview.1'?1:null))!==1||compare(next.product_version,old.product_version)<0)throw Error('Cross-host, data migration or downgrade requires separate compatibility review');
    for(const name of items)plainTree(resolve(root,name));
  }else {
    // A failed fresh setup can have created empty data directories before rollback.
    // Never infer ownership of populated data; leave it for an explicit recovery/migration.
    for(const name of readdirSync(root)){
      if(name==='.product-upgrade')continue;
      const p=resolve(root,name);
      if(!['data','workspaces'].includes(name)||!lstatSync(p).isDirectory())throw Error('Target is not an owned installation or empty directory');
      plainTree(p);if(walk(p).length)throw Error('Unowned data directory; migration required');
    }
  }
  mkdirSync(base,{recursive:true});assertPlainPath(base);
  const id=randomUUID(),tx=resolve(base,id),incoming=resolve(tx,'incoming'),backup=resolve(tx,'backup');
  const names=upgrading?items:[...items,'installation.json'];
  const state={version:1,root,id,status:'preparing',from:old?.product_version??null,to:next.product_version,items:names,had_old:Object.fromEntries(names.map(n=>[n,existsSync(resolve(root,n))]))};
  // Write the journal before publishing the exclusive lock; no program file has changed yet.
  mkdirSync(incoming,{recursive:true});mkdirSync(backup);save(resolve(tx,'transaction.json'),state);
  const fd=openSync(active,'wx');try{writeFileSync(fd,JSON.stringify({version:1,id,pid:process.pid}));fsyncSync(fd);}finally{closeSync(fd);}
  try{
    for(const name of names)copyTree(resolve(source,name),resolve(incoming,name));
    if(upgrading)preserveConfig(root,old,incoming);
    checkpoint('prepared');assertStopped(root);
    state.status='swapping';save(resolve(tx,'transaction.json'),state);
    for(const name of names){
      if(state.had_old[name])move(resolve(root,name),resolve(backup,name));
      checkpoint('backed_up:'+name);
      move(resolve(incoming,name),resolve(root,name));checkpoint('installed:'+name);
    }
    performSetup(root);checkpoint('configured');
    // Setup only configures program resources and creates missing data directories; no host process is started.
    state.status='committed';save(resolve(tx,'transaction.json'),state);unlinkSync(active);
    return {status:upgrading?'upgraded':'installed',from:state.from,to:state.to,transaction:id,backup_retained:upgrading,data_migration:false};
  }catch(error){
    const describe=e=>({message:e.message,code:e.code,syscall:e.syscall,path:e.path,dest:e.dest});
    state.failure=describe(error);
    // Diagnostic writes must never prevent restoration of the old program.
    const recordFailure=()=>{try{save(resolve(tx,'transaction.json'),state);}catch{}};
    recordFailure();
    if(state.status==='swapping'){
      try{rollback(root,tx,state,move);}catch(recoveryError){state.recovery_failure=describe(recoveryError);recordFailure();throw Error('自动恢复未完成，请保留安装目录并重新运行安装包。记录：'+resolve(tx,'transaction.json')+'。'+recoveryError.message,{cause:error});}
    }
    if(existsSync(active))unlinkSync(active);
    const hint=['EPERM','EACCES','EBUSY'].includes(error.code)?'目录可能被占用或无权访问。请退出应用，检查安装目录写权限及安全软件拦截记录后重试。':'';
    throw Error('安装失败，旧程序已保留或恢复。'+hint+'记录：'+resolve(tx,'transaction.json')+'。详情：'+error.message,{cause:error});
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    if(![4,5].includes(process.argv.length))throw Error('Usage: product-upgrade.mjs <candidate> <target> [error-file]');
    const config=resolve(process.argv[3],'installation.json');
    const install=()=>installProductCandidate(process.argv[2],process.argv[3]);
    console.log(JSON.stringify(existsSync(config)?await withLocalServicePaused(config,install):install()));
  }
  catch(error){
    // nsExec decodes stdout using the Windows code page, not Node's UTF-8.
    // The Unicode installer reads this explicit UTF-16LE file instead.
    if(process.argv.length===5){try{writeFileSync(process.argv[4],error.message.replace(/[\r\n]+/g,' '),'utf16le');}catch{}}
    console.error(error.message);process.exitCode=1;
  }
}
