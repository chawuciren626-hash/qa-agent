import { lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const base='output/runs/run-[A-Za-z0-9-]+/execution';
const json=new RegExp(`^${base}/(?:test_results|exploration|browser-network)\\.json$|^${base}/browser-evidence/[A-Za-z0-9_-]+\\.observation\\.json$`);
const directory=new RegExp(`^${base}(?:/browser-evidence)?$`);
const image=new RegExp(`^${base}/browser-evidence/[A-Za-z0-9_.-]+\\.(?:png|jpe?g|webp)$`,'i');
export function evidenceKind(path) {
  if(typeof path!=='string' || path.split('/').some(p=>!p || p==='.' || p==='..') || /[\\:\x00-\x1f]/.test(path)) return null;
  return json.test(path)?'json':directory.test(path)?'directory':image.test(path)?'image':null;
}
function safePath(workspace,path) {
  const root=resolve(workspace),target=resolve(root,path),rel=relative(root,target);
  if(!rel || rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || realpathSync(root)!==root) throw new Error('Evidence path unavailable');
  let current=root;
  for(const part of rel.split(sep)) {
    current=resolve(current,part);
    if(lstatSync(current).isSymbolicLink() || realpathSync(current)!==current) throw new Error('Linked evidence is not supported');
  }
  return target;
}
export function readDeliveryEvidence(workspace,path) {
  const kind=evidenceKind(path);
  if(!['json','directory'].includes(kind)) throw new Error('Unsupported evidence');
  const target=safePath(workspace,path),stat=lstatSync(target);
  if(kind==='directory') {
    if(!stat.isDirectory()) throw new Error('Evidence directory unavailable');
    const entries=[];let truncated=false;
    for(const entry of readdirSync(target,{withFileTypes:true})) {
      const next=`${path}/${entry.name}`,type=evidenceKind(next);
      if(!type || entry.isSymbolicLink() || (type==='directory'?!entry.isDirectory():!entry.isFile())) continue;
      try {safePath(workspace,next);} catch {continue;}
      if(entries.length===200) {truncated=true;break;}
      entries.push({path:next,name:entry.name,kind:type});
    }
    return {kind,path,entries,truncated};
  }
  if(!stat.isFile() || stat.size>2*1024*1024) throw new Error('Evidence is not a supported JSON file or exceeds 2 MB');
  const text=readFileSync(target,'utf8').replace(/^\uFEFF/,'');
  if(Buffer.byteLength(text)>2*1024*1024) throw new Error('Evidence exceeds 2 MB');
  return {kind,path,text:JSON.stringify(JSON.parse(text),null,2)};
}
