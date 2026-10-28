import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {installPenguinRuntime} from './install-penguin-runtime.mjs';
import {installDesktopBranding} from './install-desktop-branding.mjs';
import {syncPenguinAgents} from './sync-penguin-agents.mjs';
import {hostCompatibility} from './product-updates.mjs';
import {productEnvironment} from './product-layout.mjs';
import {checkProductDesktop} from './product-desktop-adapter.mjs';
import {checkSourceRuntime} from './source-runtime.mjs';

const json=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function inspectProduct(layout,{runtime=true,branding=true,platform=`${process.platform}-${process.arch}`}={}) {
  const checks=[];
  const check=(id,action)=>{try {const result=action();checks.push({id,...result});}catch{checks.push({id,status:'not_ready',reason:'inspection_failed'});}};
  check('engine',()=>({status:layout.paths.engine===resolve(import.meta.dirname,'..')?'ready':'not_ready',reason:layout.paths.engine===resolve(import.meta.dirname,'..')?undefined:'run_launcher_from_configured_engine'}));
  for(const key of ['host_executable','node',...(layout.paths.python?['python']:[])]) check(key,()=>({status:existsSync(layout.paths[key])&&statSync(layout.paths[key]).isFile()?'ready':'not_ready',reason:'configured_executable_check'}));
  let hostVersion;
  const sourceMode=existsSync(resolve(layout.host_app,'aitest-source-runtime.json'));
  check('host_version',()=>{hostVersion=json(resolve(layout.host_app,'package.json')).version;if(sourceMode){const r=checkSourceRuntime(layout.host_app,layout.paths.engine);if(r.version!==hostVersion)throw Error('Source package version mismatch');return {status:'ready',mode:'source',verification:r};}const c=hostCompatibility(hostVersion,undefined,platform);return {status:c.status==='supported'?'ready':'not_ready',compatibility:c};});
  if(sourceMode) check('qa_project',()=>({status:json(resolve(layout.paths.host_data,layout.project_id,'qa-project.json')).status==='ready'?'ready':'not_ready'}));
  if(!sourceMode && checks.find(c=>c.id==='engine')?.status==='ready' && checks.find(c=>c.id==='host_version')?.status==='ready') {
    check('runtime_patches',()=>{const r=installPenguinRuntime(layout.host_app,layout.paths.engine,'check');return {status:r.status==='installed'&&!r.changed?'ready':'not_ready',installation:r};});
    if(branding) check('desktop_branding',()=>{const r=existsSync(resolve(layout.host_app,'product-desktop.json'))?checkProductDesktop(layout.host_app):installDesktopBranding(layout.host_app,layout.paths.engine,'check');return {status:r.status==='installed'&&!r.changed?'ready':'not_ready',installation:r};});
    check('agents',()=>{const r=syncPenguinAgents(layout.paths.engine,layout.agent_root);return {status:r.status==='in_sync'?'ready':'not_ready',sync_status:r.status,changes:Array.isArray(r.changes)?r.changes.length:r.changes};});
  }
  check('workspace_configuration',()=>{const c=json(resolve(layout.paths.engine,'config/session-workspaces.json'));return {status:c.enabled===true&&c.project_id===layout.project_id&&resolve(c.default_workspace)===layout.paths.workspaces?'ready':'not_ready',reason:'workspace_configuration_must_match_layout'};});
  // Existing branding preserves Electron's original profile. Custom profiles need an explicit shell adapter.
  check('desktop_profile',()=>{if(sourceMode){checkSourceRuntime(layout.host_app,layout.paths.engine);return {status:'ready',scope:'source_installation_config'};}if(existsSync(resolve(layout.host_app,'product-desktop.json'))){checkProductDesktop(layout.host_app);return {status:'ready',scope:'product_desktop_adapter'};}return {status:layout.paths.desktop_profile===resolve(process.env.APPDATA??'.','PenguinHarness')?'ready':'not_ready',reason:'custom_profile_requires_desktop_adapter'};});
  check('node_version',()=>{const version=execFileSync(layout.paths.node,['--version'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();const [major,minor]=version.replace(/^v/,'').split('.').map(Number);const ready=layout.layout==='existing'?(major>20||major===20&&minor>=11):major>=24;return {status:ready?'ready':'not_ready',version,minimum:layout.layout==='existing'?'20.11 (QA tools; desktop bundles its own runtime)':'24 (product distribution)'};});
  if(runtime) check('tool_runtime',()=>{const child=spawnSync(layout.paths.node,[resolve(layout.paths.engine,'scripts/engineering-preflight.mjs')],{env:productEnvironment(layout),encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:1024*1024});if(child.error)throw child.error;const r=JSON.parse(child.stdout);return {status:child.status===0&&r.status==='ready'?'ready':'not_ready',checks:r.checks};});
  return {version:1,status:checks.every(c=>c.status==='ready')?'ready':'not_ready',read_only:true,installation_id:layout.installation_id,layout_fingerprint:layout.fingerprint,
    host_version:hostVersion,distribution_ready:false,checks};
}

export async function inspectProductService(layout,{fetcher=fetch,processAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}) {
  const lockPath=resolve(layout.paths.host_data,'server.lock');
  if(!existsSync(lockPath))return {status:'not_running',read_only:true};
  let lock;
  try {lock=json(lockPath);}catch{return {status:'invalid_lock',read_only:true};}
  if(!Number.isSafeInteger(lock.pid)||lock.pid<1||!Number.isSafeInteger(lock.port)||lock.port<1||lock.port>65535)return {status:'invalid_lock',read_only:true};
  if(!processAlive(lock.pid))return {status:'stale_lock',read_only:true};
  const tokenFile=resolve(layout.paths.host_data,'api-token');
  if(!existsSync(tokenFile))return {status:'authentication_unavailable',read_only:true};
  try {
    const token=readFileSync(tokenFile,'utf8').trim();
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(token))return {status:'authentication_unavailable',read_only:true};
    // Penguin serves authenticated APIs on localhost; 127.0.0.1 is the isolated preview origin.
    const response=await fetcher(`http://localhost:${lock.port}/api/version`,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.status===401||response.status===403)return {status:'authentication_required',read_only:true,port:lock.port};
    if(!response.ok)return {status:'unhealthy',http_status:response.status,read_only:true};
    const body=await response.json();
    const actual=typeof body.version==='string'?body.version:body.version?.version;
    const expected=json(resolve(layout.host_app,'package.json')).version;
    if(actual!==expected)return {status:'version_mismatch',read_only:true};
    return {status:'ready',version:actual,port:lock.port,read_only:true,scope:'authenticated_local_version_endpoint'};
  } catch{return {status:'unreachable_or_invalid_response',read_only:true};}
}
