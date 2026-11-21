import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
function fixture(t){
 const base=mkdtempSync(resolve(tmpdir(),'qa-engine-deploy-'));
 const dir=resolve(base,'installed');
 t.after(()=>rmSync(base,{recursive:true,force:true,maxRetries:5}));
 const app=resolve(dir,'runtime/penguin/resources/app'),engine=resolve(dir,'app/engine');
 const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const files={};for(const key of ['dist/main.js','dist/server.js','dist/penguin.js','web-dist/index.html','package.json']){put(resolve(app,key),'fixture');files[key]=hash('fixture');}
 put(resolve(engine,'scripts/run-ui-tests.mjs'),'old');
 const manifest={version:1,mode:'source',upstream:{version:'fixture'},files,engine_files:{'scripts/run-ui-tests.mjs':hash('old')}};
 put(resolve(app,'aitest-source-runtime.json'),JSON.stringify(manifest));
 put(resolve(dir,'.local-service-paused.json'),'{}');
 return {dir,app,engine};
}
test('engine deployment creates new directories and records every policy file',t=>{
 const f=fixture(t);const result=spawnSync(process.execPath,[resolve(root,'scripts/deploy-engine-files.mjs'),f.dir],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const manifest=JSON.parse(readFileSync(resolve(f.app,'aitest-source-runtime.json'),'utf8'));
 assert.ok(manifest.engine_files['scripts/run-registration.mjs']);
 assert.ok(existsSync(resolve(f.engine,'aitestharness-tools/desktop-exec.py')) || Object.keys(manifest.engine_files).some(k=>k.startsWith('aitestharness-tools/')));
 assert.ok(JSON.parse(result.stdout).added>0);
});
test('failed new-file copy restores old files and removes files created by this deployment',t=>{
 const f=fixture(t);
 mkdirSync(resolve(f.engine,'config/release-resources.json'),{recursive:true});
 const before=readFileSync(resolve(f.app,'aitest-source-runtime.json'),'utf8');
 const result=spawnSync(process.execPath,[resolve(root,'scripts/deploy-engine-files.mjs'),f.dir],{encoding:'utf8'});
 assert.equal(result.status,1);
 assert.match(result.stderr,/同步失败/);
 assert.equal(readFileSync(resolve(f.engine,'scripts/run-ui-tests.mjs'),'utf8'),'old');
 assert.equal(existsSync(resolve(f.engine,'scripts/run-registration.mjs')),false);
 assert.equal(readFileSync(resolve(f.app,'aitest-source-runtime.json'),'utf8'),before);
});
