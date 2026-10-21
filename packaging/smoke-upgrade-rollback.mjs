// Test-owned installations only: deliberately fail after real setup and verify restoration.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,lstatSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {installProductCandidate} from '../scripts/product-upgrade.mjs';
if(process.argv.length!==5)throw Error('Usage: smoke-upgrade-rollback.mjs <candidate> <test-installation> <new-evidence-directory>');
const [source,target,out]=process.argv.slice(2).map(p=>resolve(p));mkdirSync(out);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function snapshot(){const files={};function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const file=resolve(dir,e.name);if(lstatSync(file).isSymbolicLink())throw Error('Linked fixture');if(e.isDirectory())walk(file);else files[relative(target,file).replaceAll('\\','/')]=hash(file);}}for(const dir of ['data','workspaces','app/engine/config'])walk(resolve(target,dir));for(const file of ['AITestHarness.exe','installation.json','product-payload.json'])files[file]=hash(resolve(target,file));return files;}
const before=snapshot();writeFileSync(resolve(out,'before.json'),JSON.stringify(before,null,2));
let failed=false;
try{installProductCandidate(source,target,{checkpoint:point=>{if(point==='configured')throw Error('intentional post-setup smoke failure');}});}catch(error){if(!error.message.includes('intentional post-setup smoke failure'))throw error;failed=true;}
assert.ok(failed);assert.deepEqual(snapshot(),before);assert.equal(existsSync(resolve(target,'.product-upgrade/active.json')),false);
const result={status:'passed',scope:'real_payload_setup_failure_rollback',checked_files:Object.keys(before).length,program_restored:true,configuration_and_user_data_unchanged:true,model_calls:0};
writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
