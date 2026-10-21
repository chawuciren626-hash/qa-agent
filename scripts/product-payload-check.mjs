import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertPlainPath} from './application-data.mjs';
export const requiredPayloadFiles=['AITestHarness.exe','installation.json','THIRD-PARTY-NOTICES.txt','app/engine/scripts/product-uninstall-check.mjs','app/engine/scripts/product-installed-start.mjs','runtime/tools/node/node.exe','runtime/tools/python/python.exe','licenses/Node-LICENSE.txt','licenses/PenguinHarness-LICENSE.txt'];
export const fileDigest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function verifyProductPayload(directory) {
  const stage=assertPlainPath(resolve(directory));
  for(const name of ['data','workspaces'])if(existsSync(resolve(stage,name)))throw Error('Used installation cannot be a release stage');
  const manifest=JSON.parse(readFileSync(resolve(stage,'product-payload.json'),'utf8'));
  if(manifest.version!==1||manifest.distribution_ready!==false||!manifest.files||Array.isArray(manifest.files)||typeof manifest.files!=='object')throw Error('Invalid candidate manifest');
  const expected=new Set(Object.keys(manifest.files));
  for(const name of expected){
    if(!/^(?:app\/|runtime\/|licenses\/|AITestHarness\.exe$|installation\.json$|THIRD-PARTY-NOTICES\.txt$)/.test(name)||/[\\:]/.test(name)||name.split('/').some(s=>!s||s==='..'||s==='.'))throw Error('Invalid manifest path');
    if(!/^[a-f0-9]{64}$/.test(manifest.files[name]))throw Error('Invalid manifest digest');
    const file=assertPlainPath(resolve(stage,name));
    if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||fileDigest(file)!==manifest.files[name])throw Error('Payload checksum mismatch: '+name);
  }
  function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
    const file=resolve(dir,entry.name);if(lstatSync(file).isSymbolicLink())throw Error('Linked payload');
    if(entry.isDirectory())walk(file);else {
      const name=file.slice(stage.length+1).replaceAll('\\','/');
      if(!expected.has(name))throw Error('Unlisted payload file: '+name);
      if(/(?:^|\/)(?:api-token|\.vault\.toml|\.project_config\.toml|browser-private\.json|product-installation\.local\.json|web\.db)(?:$|\.)/.test(name))throw Error('Private state in release payload');
    }
  }}
  for(const folder of ['app','runtime','licenses'])walk(resolve(stage,folder));
  for(const file of requiredPayloadFiles)if(!expected.has(file))throw Error('Required distribution resource missing: '+file);
  return {status:'payload_verified',files:expected.size,private_state_files:false,distribution_ready:false};
}
