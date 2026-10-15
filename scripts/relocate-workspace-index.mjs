import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { applicationDataRoot, workspaceIndexRoot, assertPlainPath, within } from './application-data.mjs';
import { directoryContext } from './directory-context.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

// Only repair empty diagnostic bindings here. Business runs require a separate archive migration.
export function planIndexRelocation(engine, oldEngine, env = process.env) {
  engine=resolve(engine);
  if(!isAbsolute(oldEngine) || resolve(oldEngine)===engine) throw new Error('An explicit different absolute old engine path is required');
  oldEngine=resolve(oldEngine);
  const move = path => within(oldEngine,resolve(path)) ? resolve(engine,relative(oldEngine,resolve(path))) : resolve(path);
  const index=resolve(engine,'output/session-workspaces');
  const plans=[], deferred=[];
  for(const entry of existsSync(index)?readdirSync(index,{withFileTypes:true}):[]) {
    if(!entry.isFile() || !/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+\.json$/.test(entry.name)) throw new Error('Unexpected legacy index entry');
    const source=assertPlainPath(resolve(index,entry.name));
    const old=JSON.parse(readFileSync(source,'utf8'));
    if(old.session_id+'.json'!==entry.name || resolve(old.engine_root)!==oldEngine) throw new Error('Legacy index identity/engine mismatch');
    const session=assertPlainPath(move(old.session_root));
    const marker=resolve(session,'.qa-session.json');
    if(!existsSync(marker)) {deferred.push({session_id:old.session_id,reason:'missing_workspace',path:session});continue;}
    const runs=resolve(session,'output/runs');
    if(existsSync(runs) && readdirSync(runs).length) {deferred.push({session_id:old.session_id,reason:'business_run_requires_archive_migration',path:session});continue;}
    const next=directoryContext(engine,{QA_DIRECTORY_CONTEXT:json({...old,engine_root:engine,workspace_root:move(old.workspace_root),session_root:session})});
    const actual=JSON.parse(readFileSync(assertPlainPath(marker),'utf8'));
    if(json(actual)!==json(old) && json(actual)!==json(next)) throw new Error('Marker differs from legacy or relocated identity');
    const writes=[{path:marker,content:json(next)}];
    for(const file of ['project-action.mjs','project-command.mjs']) {
      const path=assertPlainPath(resolve(session,'scripts',file));
      const before=`import ${JSON.stringify(pathToFileURL(resolve(oldEngine,'scripts',file)).href)};\n`;
      const content=`import ${JSON.stringify(pathToFileURL(resolve(engine,'scripts',file)).href)};\n`;
      const actual=readFileSync(path,'utf8');
      if(actual!==before && actual!==content) throw new Error('Workspace shim was modified; refusing overwrite');
      writes.push({path,content});
    }
    const destination=assertPlainPath(resolve(workspaceIndexRoot(engine,env),entry.name));
    if(existsSync(destination) && readFileSync(destination,'utf8')!==json(next)) throw new Error('Destination index conflict');
    writes.push({path:destination,content:json(next)});
    plans.push({session_id:old.session_id,native_workspace_rebind_required:session!==resolve(old.session_root),writes});
  }
  return {plans,deferred};
}

export function applyIndexRelocation(engine, plan, env=process.env) {
  const backup=resolve(applicationDataRoot(engine,env),'migrations',`workspace-${randomUUID()}`);
  const writes=plan.plans.flatMap(item=>item.writes).map(item=>({...item,before:existsSync(item.path)?readFileSync(item.path):null}));
  mkdirSync(backup,{recursive:true});
  for(const [i,item] of writes.entries()) if(item.before) writeFileSync(resolve(backup,`${i}.bak`),item.before,{flag:'wx'});
  const record={status:'prepared',deferred:plan.deferred,bindings:plan.plans.map(({writes,...item})=>item),files:writes.map((item,i)=>({path:item.path,backup:item.before?`${i}.bak`:null,before_sha256:item.before?hash(item.before):null,after_sha256:hash(item.content)}))};
  const journal=resolve(backup,'migration.json');
  writeFileSync(journal,json(record),{flag:'wx'});
  // The durable journal also identifies newly created indexes for explicit rollback.
  try {
    for(const item of writes) {
      assertPlainPath(item.path);
      if(item.before && (!existsSync(item.path) || hash(readFileSync(item.path))!==hash(item.before))) throw new Error('Source changed during migration');
      if(!item.before && existsSync(item.path)) throw new Error('Destination appeared during migration');
      mkdirSync(resolve(item.path,'..'),{recursive:true});
      writeFileSync(item.path,item.content,{flag:item.before?'w':'wx'});
      if(hash(readFileSync(item.path))!==hash(item.content)) throw new Error('Migration verification failed');
    }
    record.status='completed';
  } catch(error) {
    record.status='interrupted';record.error=error.message;
    writeFileSync(journal,json(record));
    throw new Error(`Migration interrupted; preserve journal for recovery: ${journal}; ${error.message}`);
  }
  writeFileSync(journal,json(record));
  return {journal,status:record.status,bindings:record.bindings,deferred:record.deferred};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [old,mode='--check',...extra]=process.argv.slice(2);
  if(!old || extra.length || !['--check','--apply'].includes(mode)) throw new Error('Usage: node scripts/relocate-workspace-index.mjs <old-engine-root> [--check|--apply]');
  const engine=resolve(import.meta.dirname,'..');
  const plan=planIndexRelocation(engine,old);
  console.log(JSON.stringify(mode==='--apply'?applyIndexRelocation(engine,plan):{bindings:plan.plans.map(({writes,...item})=>item),deferred:plan.deferred},null,2));
}
