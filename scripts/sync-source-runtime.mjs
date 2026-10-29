/** Closed-application local source synchronization, with verified backup and rollback. */
import {cpSync,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml';
import {loadProductLayout} from './product-layout.mjs';
import {checkSourceRuntime} from './source-runtime.mjs';
import {assertPlainPath,within} from './application-data.mjs';
import {qaRoles,qaRoleTools} from './qa-project-bootstrap.mjs';
import {withLocalServicePaused} from './local-service.mjs';

const json=file=>JSON.parse(readFileSync(file,'utf8'));
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function sourceTreeHashes(root) {
  if(!existsSync(root)) return {};
  const files={};
  function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const file=resolve(dir,item.name);if(lstatSync(file).isSymbolicLink())throw Error('Linked backup path');if(item.isDirectory())walk(file);else files[relative(root,file).replaceAll('\\','/')]=digest(file);}}
  walk(root);return files;
}
export function assertSourceTargetStopped(layout) {
  if(process.platform==='win32') {
    const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PenguinHarness.exe' } | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});
    const paths=raw.trim()?JSON.parse(raw):[];
    if([paths].flat().some(p=>p&&resolve(p).toLowerCase()===layout.paths.host_executable.toLowerCase())) throw Error('AITestHarness is running; exit normally from its tray before synchronizing');
  }
  const file=resolve(layout.paths.host_data,'server.lock');
  if(existsSync(file)) { const lock=json(file); if(!Number.isInteger(lock.pid)) throw Error('Invalid server lock; inspect before migration'); let alive=false;try{process.kill(lock.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')throw error;}if(alive)throw Error('The configured server is still alive; do not synchronize active tasks'); }
  if(existsSync(resolve(layout.root,'.product-upgrade/active.json'))) throw Error('Another product upgrade is active');
}
export async function planSourceAdoption(layout) {
  const file=resolve(layout.paths.host_data,layout.project_id,'qa-project.json');
  if(existsSync(file)) {const marker=json(file);if(marker.status!=='ready')throw Error('Project initialization incomplete');return {marker:file,existing:true,edits:[]};}
  const ownership=json(resolve(layout.paths.qa_data,'agent-initialization.json'));
  if(ownership.status!=='complete'||ownership.installation_id!==layout.installation_id||ownership.project_id!==layout.project_id||!qaRoles().every(r=>ownership.owned?.includes(r.id))) throw Error('Cannot adopt unowned or incomplete testing roles');
  const edits=[];
  for(const role of qaRoles()) {
    const config=resolve(layout.agent_root,role.id,'agent_state/system_config.yaml');
    const before=readFileSync(config,'utf8'), parsed=parseYaml(before);
    if(parsed.hooks?.enabled===false)throw Error('Existing role disables required hooks; review before adoption');
    const toolsKey=Array.isArray(parsed.tools?.builtin)?'nested':Array.isArray(parsed.tools_builtin)?'snake':null;
    if(!toolsKey)throw Error('Unsupported role tool configuration: '+role.id);
    const tools=toolsKey==='nested'?parsed.tools.builtin:parsed.tools_builtin;
    const next=await qaRoleTools(role.id,tools);
    if(JSON.stringify(next)!==JSON.stringify(tools)) {
      if(toolsKey==='nested')parsed.tools.builtin=next;else parsed.tools_builtin=next;
      edits.push({file:config,before,after:stringifyYaml(parsed)});
    }
  }
  return {marker:file,existing:false,edits};
}
export async function syncSourceRuntime({installation,stage,backupRoot}) {
  return withLocalServicePaused(installation,()=>syncStoppedRuntime({installation,stage,backupRoot}));
}
async function syncStoppedRuntime({installation,stage,backupRoot}) {
  const layout=loadProductLayout(installation),candidate=loadProductLayout(resolve(stage,'installation.json'));
  for(const root of [layout.root,candidate.root,resolve(backupRoot)])assertPlainPath(root);
  if(within(layout.root,candidate.root)||within(candidate.root,layout.root)||within(layout.root,resolve(backupRoot))||within(candidate.root,resolve(backupRoot)))throw Error('Installation, stage and backups must be separate');
  checkSourceRuntime(candidate.host_app,candidate.paths.engine);
  assertSourceTargetStopped(layout);
  const plan=await planSourceAdoption(layout);
  const lock=resolve(layout.root,'.source-sync.lock'),fd=openSync(lock,'wx');
  const backup=resolve(backupRoot,'source-sync-'+Date.now()+'-'+randomUUID().slice(0,8));
  const pendingEngine=layout.paths.engine+'.source-pending',pendingApp=layout.host_app+'.source-pending';
  const journal={version:1,status:'preparing',installation:resolve(installation),backup,stage:candidate.root,engine:layout.paths.engine,app:layout.host_app};
  let engineMoved=false,appMoved=false,engineInstalled=false,appInstalled=false,markerWritten=false;
  let createdPendingEngine=false,createdPendingApp=false;
  const appliedEdits=[];
  try {
    if(existsSync(pendingEngine)||existsSync(pendingApp))throw Error('Pending source directory exists; inspect prior transaction');
    mkdirSync(backup,{recursive:true});
    const save=()=>writeFileSync(resolve(backup,'transaction.json'),JSON.stringify(journal,null,2));save();
    // Back up all persistent stores before a newer server can migrate a database.
    const hashes={};
    for(const name of ['host_data','qa_data','desktop_profile']) {
      hashes[name]=sourceTreeHashes(layout.paths[name]);
      if(existsSync(layout.paths[name]))cpSync(layout.paths[name],resolve(backup,name),{recursive:true});
      if(JSON.stringify(sourceTreeHashes(resolve(backup,name)))!==JSON.stringify(hashes[name]))throw Error('Backup hash mismatch: '+name);
    }
    writeFileSync(resolve(backup,'data-hashes.json'),JSON.stringify(hashes,null,2));
    copyFileSync(installation,resolve(backup,'installation.json'));
    createdPendingEngine=true;cpSync(layout.paths.engine,pendingEngine,{recursive:true});
    const sourceManifest=json(resolve(candidate.host_app,'aitest-source-runtime.json'));
    for(const name of Object.keys(sourceManifest.engine_files)){const dest=resolve(pendingEngine,name);mkdirSync(dirname(dest),{recursive:true});copyFileSync(resolve(candidate.paths.engine,name),dest);}
    createdPendingApp=true;cpSync(candidate.host_app,pendingApp,{recursive:true});
    checkSourceRuntime(pendingApp,pendingEngine);
    assertSourceTargetStopped(layout);
    for(const name of Object.keys(hashes))if(JSON.stringify(sourceTreeHashes(layout.paths[name]))!==JSON.stringify(hashes[name]))throw Error('Persistent data changed during backup; synchronization refused');
    journal.status='swapping';save();
    renameSync(layout.paths.engine,resolve(backup,'engine'));engineMoved=true;
    renameSync(pendingEngine,layout.paths.engine);engineInstalled=true;
    renameSync(layout.host_app,resolve(backup,'desktop-app'));appMoved=true;
    renameSync(pendingApp,layout.host_app);appInstalled=true;
    for(const edit of plan.edits){writeFileSync(edit.file,edit.after);appliedEdits.push(edit);}
    if(!plan.existing){writeFileSync(plan.marker,JSON.stringify({version:1,status:'ready',projectId:layout.project_id,migration:'owned_legacy_roles',migrated_at:new Date().toISOString()},null,2),{flag:'wx'});markerWritten=true;}
    checkSourceRuntime(layout.host_app,layout.paths.engine);
    journal.status='synchronized';journal.finished_at=new Date().toISOString();save();
    return {status:journal.status,backup,roles_updated:plan.edits.length,existing_user_data:'preserved',installer_created:false};
  } catch(error) {
    if(appInstalled)renameSync(layout.host_app,resolve(backup,'failed-app'));
    if(appMoved)renameSync(resolve(backup,'desktop-app'),layout.host_app);
    if(engineInstalled)renameSync(layout.paths.engine,resolve(backup,'failed-engine'));
    if(engineMoved)renameSync(resolve(backup,'engine'),layout.paths.engine);
    for(const edit of appliedEdits)writeFileSync(edit.file,edit.before);
    if(markerWritten)unlinkSync(plan.marker);
    // Keep this transaction's temporary copies in its backup for inspection,
    // while clearing the installation's pending slots for a safe retry.
    for(const [created,path,name] of [[createdPendingEngine,pendingEngine,'pending-engine'],[createdPendingApp,pendingApp,'pending-app']]) if(created && existsSync(path)) {
      try {renameSync(path,resolve(backup,name));}
      catch(cleanupError) {journal.cleanup_error=cleanupError.message;}
    }
    journal.status='rolled_back';journal.error=error.message;
    if(existsSync(backup))writeFileSync(resolve(backup,'transaction.json'),JSON.stringify(journal,null,2));
    throw error;
  } finally {closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [installation,stage,backupRoot]=process.argv.slice(2);if(!installation||!stage||!backupRoot)throw Error('Usage: sync-source-runtime.mjs <installation.json> <verified-stage> <backup-directory>');console.log(JSON.stringify(await syncSourceRuntime({installation:resolve(installation),stage:resolve(stage),backupRoot:resolve(backupRoot)})));}
