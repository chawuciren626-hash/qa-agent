import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationDataRoot, assertPlainPath } from './application-data.mjs';

const engine=resolve(import.meta.dirname,'..');
const ownerPattern=/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/;
const referencePattern=/^qa-secret:\/\/(session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+)\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const stores=new Map();

// A protected value must be a credential. The capture paths below are text based, so a
// bad capture can wrap an identifier (TP-003), half a JSON object, or a Chinese sentence
// fragment; registering it rewrites every later occurrence of that string in the run,
// which silently breaks traceability and step text while still passing schema checks.
const artifactIdPattern=/^(?:TP|TC|TS|RULE|REQ|CASE|BUG|DEF|ENV)-\d+$/i;
const structuralChars=/[{}[\]"\\]/;
const invisiblePattern=/^[\p{P}\p{S}\s]+$/u;
const cjkPattern=/[\u3400-\u9fff]/;
// snake_case or kebab-case identifiers read as field names, never as typed credentials.
const fieldNamePattern=/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;

const notACredential=value=>typeof value!=='string'||!value||value.length>100000
  ||value.includes('qa-secret://')||artifactIdPattern.test(value)||invisiblePattern.test(value);

// Values a "keyword: value" scan may register. Prose around 密码/password is almost always
// a field name, a sample label or a placeholder pointer, so require a shape no document
// identifier has: at least 8 chars, no CJK, no whitespace, and a digit or real symbol.
const inferableSecret=value=>!notACredential(value)&&!structuralChars.test(value)&&!cjkPattern.test(value)
  &&!fieldNamePattern.test(value)&&!/\s/.test(value)&&value.length>=8
  &&/[0-9]|[^\p{L}\p{N}\s_.-]/u.test(value);

// References re-hydrated from text must not resurrect values an older capture invented.
const hydratableSecret=value=>!notACredential(value)&&!structuralChars.test(value)&&!cjkPattern.test(value)
  &&!fieldNamePattern.test(value)&&!/\s/.test(value)&&value.length>=4;

const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function dpapi(bytes,unprotect=false) {
  if(process.platform!=='win32') throw new Error('Protected input storage requires Windows DPAPI');
  const method=unprotect?'Unprotect':'Protect';
  const code=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${method}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{input:bytes.toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.status!==0 || !/^[A-Za-z0-9+/=]+$/.test(result.stdout ?? '')) throw new Error('Protected input storage is unavailable; no plaintext fallback');
  return Buffer.from(result.stdout,'base64');
}

// Windows uses CurrentUser DPAPI. Unix deployments keep the generated master key in
// the protected-inputs directory with owner-only permissions and use it as the local
// wrapping key; the payloads remain AES-GCM encrypted and session-bound.
function platformWrap(bytes) {
  return process.platform==='win32' ? dpapi(bytes) : Buffer.from(bytes);
}
function platformUnwrap(bytes) {
  return process.platform==='win32' ? dpapi(bytes,true) : Buffer.from(bytes);
}

// Injection exists for isolated tests; runtime callers use the platform backend.
export function createProtectedInputs(base,{wrap=platformWrap,unwrap=platformUnwrap}={}) {
  base=assertPlainPath(resolve(base));
  let key;const known=new Map(),loadedReferences=new Set();
  const master=()=>{
    if(key) return key;
    mkdirSync(base,{recursive:true});
    const path=assertPlainPath(resolve(base,'key.dpapi'));
    if(!existsSync(path)) {
      const fresh=randomBytes(32),wrapped=wrap(fresh);
      try {writeFileSync(path,wrapped,{flag:'wx',mode:0o600});chmodSync(path,0o600);}
      catch(error) {if(error.code!=='EEXIST') throw new Error('Protected input key creation failed');}
      finally {fresh.fill(0);}
    }
    key=unwrap(readFileSync(path));
    if(key.length!==32) throw new Error('Invalid protected input key');
    return key;
  };
  return {
    put(owner,value) {
      if(!ownerPattern.test(owner ?? '') || typeof value!=='string' || !value || value.length>100000) throw new Error('Invalid protected input');
      if(referencePattern.test(value)) return value;
      const scope=known.get(owner) ?? new Map();known.set(owner,scope);
      if(scope.has(value)) return scope.get(value);
      const digest=createHmac('sha256',master()).update(JSON.stringify([owner,value])).digest();
      digest[6]=(digest[6]&15)|64;digest[8]=(digest[8]&63)|128;
      const hex=digest.subarray(0,16).toString('hex'),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,ref=`qa-secret://${owner}/${id}`,iv=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',master(),iv);cipher.setAAD(Buffer.from(ref));
      const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      const dir=assertPlainPath(resolve(base,owner));mkdirSync(dir,{recursive:true});
      const path=assertPlainPath(resolve(dir,`${id}.json`));
      try {writeFileSync(path,JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}),{flag:'wx',mode:0o600});}
      catch(error) {if(error.code!=='EEXIST' || this.get(owner,ref)!==value) throw new Error('Protected input write failed');}
      scope.set(value,ref);return ref;
    },
    get(owner,ref) {
      const match=typeof ref==='string' && referencePattern.exec(ref);
      if(!match || match[1]!==owner) throw new Error('Protected input is not owned by this task session');
      try {
        const saved=JSON.parse(readFileSync(assertPlainPath(resolve(base,owner,`${match[2]}.json`)),'utf8'));
        if(saved.version!==1) throw new Error();
        const decipher=createDecipheriv('aes-256-gcm',master(),Buffer.from(saved.iv,'base64'));
        decipher.setAAD(Buffer.from(ref));decipher.setAuthTag(Buffer.from(saved.tag,'base64'));
        return Buffer.concat([decipher.update(Buffer.from(saved.ciphertext,'base64')),decipher.final()]).toString('utf8');
      } catch {throw new Error('Protected input unavailable; no credential-store search or plaintext fallback');}
    },
    protect(owner,value) {
      const protectText=text=>{
        for(const match of text.matchAll(/qa-secret:\/\/session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+\/[a-f0-9-]{36}/g)) {
          const ref=match[0];
          if(loadedReferences.has(ref) || !ref.startsWith(`qa-secret://${owner}/`)) continue;
          try {
            const raw=this.get(owner,ref);
            // Ignore references an older capture invented; re-hydrating them would keep
            // rewriting ordinary document text for the rest of the run.
            if(!hydratableSecret(raw)) continue;
            const scope=known.get(owner) ?? new Map();scope.set(raw,ref);known.set(owner,scope);loadedReferences.add(ref);
          } catch { /* Unknown references stay opaque and cannot authorize a lookup elsewhere. */ }
        }
        // Complete JSON is parsed before masking so write_file arguments stay valid JSON.
        if(text.length<=2000000 && /^[\s]*[\[{]/.test(text)) {
          let parsed;try {parsed=JSON.parse(text);} catch {}
          if(parsed && typeof parsed==='object') {const changed=visit(parsed);return JSON.stringify(changed)===JSON.stringify(parsed)?text:JSON.stringify(changed);}
        }
        let result=text;
        for(const [secret,ref] of known.get(owner) ?? []) {
          if(typeof secret!=='string' || (secret.length<4 && !/^[A-Za-z0-9_]+$/.test(secret))) continue;
          // Word-like credentials must match a whole token: substring replacement turned
          // "test_data.username" into "<ref>.username" and broke every step that cited it.
          // The trailing lookahead also refuses to split a dotted field path.
          const token=/^[\p{L}\p{N}_]+$/u.test(secret);
          const pattern=token?new RegExp(`(?<![\\p{L}\\p{N}_.])${escapeRegExp(secret)}(?![\\p{L}\\p{N}_])(?!\\.[\\p{L}\\p{N}_])`,'gu'):null;
          const replace=part=>pattern?part.replace(pattern,()=>ref):part.split(secret).join(ref);
          result=result.split(/(qa-secret:\/\/session-[0-9a-f-]+\/[0-9a-f-]{36})/g).map(part=>referencePattern.test(part)?part:replace(part)).join('');
        }
        result=result.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,raw=>this.put(owner,raw));
        return result.replace(/(["']?(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret|密码|口令|密钥|令牌)["']?\s*[:=：]\s*)("([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;，；<>]+))/gi,(all,prefix,quoted,double,single,bare)=>{
          const raw=double ?? single ?? bare;
          if(!raw || referencePattern.test(raw) || raw==='[REDACTED]') return all;
          // Only register what could plausibly be a credential; otherwise the note that
          // explains the credential policy becomes one.
          if(!inferableSecret(raw)) return all;
          const ref=this.put(owner,raw);
          return prefix+(double!==undefined?JSON.stringify(ref):single!==undefined?`'${ref}'`:ref);
        });
      };
      const visit=(node,depth=0)=>{
        if(depth>64) throw new Error('Protected input nesting limit exceeded');
        // Traceability IDs are linkage, not content: never mask a whole identifier value.
        if(typeof node==='string') return artifactIdPattern.test(node)?node:protectText(node);
        if(Array.isArray(node)) return node.map(x=>visit(x,depth+1));
        if(!node || typeof node!=='object') return node;
        const sensitiveFill=node.type==='fill' && (node.secret===true || /password|密码|口令/i.test(JSON.stringify(node.target ?? {})));
        // Register all explicit sensitive fields before scanning sibling free text.
        const replaced=new Map();
        for(const [k,v] of Object.entries(node)) if(typeof v==='string' && v && (/^(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|answer)$/i.test(k) || (/^authorization$/i.test(k) && /^(?:Bearer|Basic)\s+\S+$/i.test(v)) || (sensitiveFill && k==='value'))) replaced.set(k,notACredential(v)?v:this.put(owner,v));
        const structural=new Set(['request_id','run_id','session_id','invocation_id','dispatch_id','tool_call_id','command_id','id','name','type','role','status','file_path','path','source_path','agent_id','owner_session_id','process_id','sha256','request_sha256','target','cmd','url','case_id','test_point_id','related_test_point','rule_id','rule_ids','source_paths']);
        return Object.fromEntries(Object.entries(node).map(([k,v])=>[k,replaced.has(k)?replaced.get(k):structural.has(k)?v:visit(v,depth+1)]));
      };
      return visit(value);
    }
  };
}

export function protectedInputs() {
  const base=resolve(applicationDataRoot(engine),'protected-inputs');
  if(!stores.has(base)) stores.set(base,createProtectedInputs(base));
  return stores.get(base);
}

export const isProtectedInput=value=>typeof value==='string' && referencePattern.test(value);
