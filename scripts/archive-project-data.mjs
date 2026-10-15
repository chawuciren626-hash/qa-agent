import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';

const inside=(base,path)=>{const rel=relative(base,path);return rel!== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);};
const digest=async path=>{const hash=createHash('sha256');for await(const bytes of createReadStream(path)) hash.update(bytes);return hash.digest('hex');};
const exists=async path=>{try {await lstat(path);return true;}catch(e){if(e.code==='ENOENT') return false;throw e;}};
async function plain(path) {
  if((await lstat(path)).isSymbolicLink() || await realpath(toNamespacedPath(path))!==resolve(path)) throw new Error(`Linked archive source or destination: ${path}`);
}

export async function inventory(root) {
  root=resolve(root);await plain(root);
  const selected=['output','inputs','scratchpad','tests/generated'];
  for(const entry of await readdir(root,{withFileTypes:true})) if(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(entry.name)) selected.push(entry.name);
  const files=[],directories=[],missing=[],links=[];
  async function walk(path) {
    const s=await lstat(path);const name=relative(root,path).split(sep).join('/');
    if(s.isSymbolicLink()) {links.push({path:name,target:await readlink(path),policy:'record_only_not_followed'});return;}
    await plain(path);
    if(s.isDirectory()) {
      directories.push(name);
      for(const entry of (await readdir(path)).sort()) await walk(resolve(path,entry));
    } else if(s.isFile()) files.push({path:name,size:s.size,mtime_ms:s.mtimeMs});
    else throw new Error(`Unsupported source type: ${path}`);
  }
  for(const name of selected) {const path=resolve(root,name);if(await exists(path)) await walk(path);else missing.push(name);}
  return {source_root:root,selected,missing,links,directories:directories.sort(),files:files.sort((a,b)=>a.path.localeCompare(b.path)),bytes:files.reduce((n,f)=>n+f.size,0)};
}

export async function archiveData(root,destination,{progress=()=>{}}={}) {
  root=resolve(root);destination=resolve(destination);
  if(inside(root,destination) || inside(destination,root)) throw new Error('Archive and source must be separate');
  if(await exists(destination)) throw new Error('Archive destination already exists; refusing overwrite');
  await plain(resolve(destination,'..'));
  const before=await inventory(root);
  await mkdir(destination);
  const manifest={version:1,status:'copying',created_at:new Date().toISOString(),source_root:root,archive_root:destination,selected:before.selected,missing:before.missing,links:before.links,directories:before.directories,files:[],bytes:before.bytes,source_deleted:false};
  const record=resolve(destination,'manifest.json');
  const save=()=>writeFile(record,JSON.stringify(manifest,null,2)+'\n');
  await save();
  try {
    for(const dir of before.directories) await mkdir(resolve(destination,'data',dir),{recursive:true});
    for(const file of before.files) {
      const source=resolve(root,file.path),target=resolve(destination,'data',file.path);
      await plain(source);
      const hash=await digest(source);
      await copyFile(source,target,constants.COPYFILE_EXCL);
      const copied=await digest(target);
      if(copied!==hash || (await stat(target)).size!==file.size) throw new Error(`Copy differs: ${file.path}`);
      manifest.files.push({...file,sha256:hash});
      if(manifest.files.length%500===0) progress({phase:'copying',files:manifest.files.length,total:before.files.length});
    }
    const after=await inventory(root);
    if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Source inventory changed while copying');
    for(const [i,file] of manifest.files.entries()) {
      const source=resolve(root,file.path);await plain(source);
      if(await digest(source)!==file.sha256) throw new Error(`Source changed: ${file.path}`);
      if(i%1000===0) progress({phase:'source_recheck',files:i,total:manifest.files.length});
    }
    if(JSON.stringify(before)!==JSON.stringify(await inventory(root))) throw new Error('Source inventory changed during final verification');
    manifest.status='verified';manifest.verified_at=new Date().toISOString();await save();
    return {manifest:record,status:manifest.status,files:manifest.files.length,bytes:manifest.bytes,links_recorded:manifest.links.length};
  } catch(error) {manifest.status='incomplete';manifest.error=error.message;await save();throw error;}
}

export async function verifyArchive(destination) {
  destination=resolve(destination);await plain(destination);
  const manifest=JSON.parse(await readFile(resolve(destination,'manifest.json'),'utf8'));
  if(manifest.version!==1 || manifest.status!=='verified' || resolve(manifest.archive_root)!==destination) throw new Error('Archive is not a verified matching manifest');
  const actual=await inventory(resolve(destination,'data'));
  if(actual.links.length || JSON.stringify(actual.directories)!==JSON.stringify(manifest.directories) || JSON.stringify(actual.files.map(f=>f.path))!==JSON.stringify(manifest.files.map(f=>f.path))) throw new Error('Archive entries differ from manifest');
  const seen=new Set();
  for(const file of manifest.files) {
    const target=resolve(destination,'data',file.path);
    if(!inside(resolve(destination,'data'),target) || seen.has(target)) throw new Error('Invalid archive entry');
    seen.add(target);await plain(target);
    if((await stat(target)).size!==file.size || await digest(target)!==file.sha256) throw new Error(`Archive verification failed: ${file.path}`);
  }
  return {status:'verified',files:manifest.files.length,bytes:manifest.bytes,source_required:false};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [mode,destination,...extra]=process.argv.slice(2);
  if(extra.length || !['--scan','--create','--verify'].includes(mode) || (mode!=='--scan' && (!destination || !isAbsolute(destination)))) throw new Error('Usage: node scripts/archive-project-data.mjs --scan | --create <absolute-new-directory> | --verify <absolute-archive>');
  const root=resolve(import.meta.dirname,'..');
  if(mode==='--scan') {const data=await inventory(root);console.log(JSON.stringify({selected:data.selected,missing:data.missing,files:data.files.length,directories:data.directories.length,links_recorded:data.links.length,bytes:data.bytes}));}
  else console.log(JSON.stringify(mode==='--create'?await archiveData(root,destination,{progress:message=>console.log(JSON.stringify(message))}):await verifyArchive(destination)));
}
