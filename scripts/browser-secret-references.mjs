import { randomUUID } from 'node:crypto';

export function validateSecretReference(ref) {
  if(!ref || typeof ref!=='object' || Array.isArray(ref) || Object.keys(ref).length!==1 || !Object.hasOwn(ref,'id') || !/^sr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ref.id ?? '')) throw new Error('Invalid secret_ref; use an opaque reference returned by this browser worker');
}

// No filesystem, environment or global vault access. Entries are an allowlist of
// values already supplied to this task, tied to the exact page and observed target.
export function browserSecretReferences(runId) {
  const entries=new Map(),targets=new Map();let closed=false;
  const binding=(run,url,target)=>{
    if(closed || run!==runId) throw new Error('Secret reference unavailable for this task');
    let page;
    try {page=new URL(url);if(!['http:','https:'].includes(page.protocol) || page.username || page.password) throw new Error();}
    catch {throw new Error('Secret reference requires its original page');}
    return JSON.stringify([run,page.href,target.by,target.value,target.name ?? null]);
  };
  return {
    register({run,url,target,value}) {
      const key=binding(run,url,target);
      const prior=targets.get(key);
      if(typeof value!=='string' || !value || value.length>32000) {
        if(prior) entries.delete(prior);targets.delete(key);return null;
      }
      if(prior && entries.get(prior)?.value===value) return {id:prior};
      if(prior) entries.delete(prior);
      else if(entries.size>=128) return null;
      const id=`sr-${randomUUID()}`;entries.set(id,{key,value});targets.set(key,id);
      return {id};
    },
    invalidate({run,url,target}) {
      const key=binding(run,url,target),id=targets.get(key);
      if(id) entries.delete(id);targets.delete(key);
    },
    resolve({run,url,target,ref}) {
      validateSecretReference(ref);
      const key=binding(run,url,target),entry=entries.get(ref.id);
      if(!entry || entry.key!==key) throw new Error('Secret reference unavailable for this page and target');
      return entry.value;
    },
    clear() {entries.clear();targets.clear();closed=true;}
  };
}
