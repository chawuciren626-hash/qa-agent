import {existsSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {within} from './application-data.mjs';

export function planProductMigration(source,target) {
  if(source.installation_id!==target.installation_id)throw new Error('Migration must retain the installation identity');
  if(target.layout!=='unified')throw new Error('Migration target must use the unified layout');
  if(source.fingerprint===target.fingerprint)throw new Error('Source and target layouts are identical');
  const keys=['engine','host_executable','host_data','qa_data','desktop_profile','workspaces','node','python','browsers'];
  const entries=keys.filter(k=>source.paths[k]&&target.paths[k]).map(key=>({key,source:source.paths[key],target:target.paths[key],source_exists:existsSync(source.paths[key]),target_exists:existsSync(target.paths[key]),move:source.paths[key]!==target.paths[key]}));
  // Cross-layout nesting would make recursive copy include its own output or overwrite another source.
  for(const e of entries.filter(e=>e.move))for(const p of Object.values(source.paths))if(within(p,e.target)||within(e.target,p))throw new Error('Migration target overlaps a source path');
  const index=resolve(source.paths.qa_data,'session-workspaces');let indexed=0,invalid=0,withRuns=0;
  if(existsSync(index))for(const name of readdirSync(index).filter(n=>n.endsWith('.json'))) {
    indexed++;
    try {
      const file=resolve(index,name);if(lstatSync(file).isSymbolicLink())throw new Error('Linked index');
      const c=JSON.parse(readFileSync(file,'utf8'));
      // Do not follow paths supplied by history while preparing a read-only inventory.
      if(typeof c.engine_root!=='string'||typeof c.session_root!=='string')throw new Error('Invalid index');
      withRuns++; // Every existing binding requires a separate history audit, even if it may be empty.
    } catch{invalid++;}
  }
  return {version:1,status:'planning_only',read_only:true,source_fingerprint:source.fingerprint,target_fingerprint:target.fingerprint,entries,
    history:{indexed_sessions:indexed,bindings_requiring_audit:withRuns,invalid_indexes:invalid},
    blocks:[...entries.filter(e=>e.move&&e.target_exists).map(e=>`target_not_empty_or_existing:${e.key}`),...entries.filter(e=>!e.source_exists).map(e=>`missing_source:${e.key}`),
      ...(invalid?['invalid_history_index']:[]),'desktop_profile_adapter_required','host_installer_registration_must_be_planned','consistent_backup_required','absolute_path_references_require_migration'],
    migration_executed:false,ready_to_apply:false};
}
