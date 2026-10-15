import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { within } from './application-data.mjs';

export function cleanupPlan(root,archive,tracked) {
  root=resolve(root);archive=resolve(archive);
  const manifest=JSON.parse(readFileSync(resolve(archive,'manifest.json'),'utf8'));
  if(manifest.status!=='verified' || manifest.source_root!==root || resolve(manifest.archive_root)!==archive) throw new Error('Archive manifest identity is not verified for this source');
  const files=[];const counts={};
  for(const file of manifest.files) {
    if(typeof file.path!=='string' || isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(p=>['.','..',''].includes(p))) throw new Error('Invalid archived path');
    const source=resolve(root,file.path),backup=resolve(archive,'data',file.path);
    let decision='retain_history_or_runtime_state';
    if(tracked.has(file.path)) decision='retain_tracked_source';
    else if(/^inputs\/word-fixture-[a-f0-9-]+\.docx$/.test(file.path) || /^output\/[^/]+\.log$/.test(file.path)) {
      decision='review_candidate';
      for(const path of [source,backup]) {
        if(!existsSync(path)) {decision='retain_missing_file';break;}
        if(lstatSync(path).isSymbolicLink() || realpathSync(toNamespacedPath(path))!==toNamespacedPath(path)) {decision='retain_linked_file';break;}
        const content=readFileSync(path);
        if(content.length!==file.size || createHash('sha256').update(content).digest('hex')!==file.sha256) {decision='retain_changed_or_unverified';break;}
      }
    }
    files.push({path:file.path,size:file.size,sha256:file.sha256,decision});
    counts[decision]=(counts[decision]??0)+1;
  }
  return {version:1,created_at:new Date().toISOString(),source_root:root,archive_root:archive,mode:'review_only_no_delete',counts,links:manifest.links,files,requires_before_delete:['user_approval_of_exact_paths','application_stopped','recheck_current_source_and_archive_hashes','no_runtime_references']};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [archive,destination,...extra]=process.argv.slice(2);
  const root=resolve(import.meta.dirname,'..');
  if(extra.length || !archive || !destination || !isAbsolute(archive) || !isAbsolute(destination) || within(root,resolve(destination))) throw new Error('Usage: node scripts/plan-archive-cleanup.mjs <absolute-archive> <new-external-plan.json>');
  const git=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
  if(git.status!==0) throw new Error('Cannot identify tracked source files');
  const plan=cleanupPlan(root,archive,new Set(git.stdout.split('\0').filter(Boolean)));
  writeFileSync(destination,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({path:destination,mode:plan.mode,counts:plan.counts}));
}
