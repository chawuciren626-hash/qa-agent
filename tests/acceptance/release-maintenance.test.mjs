import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {assessReleaseEvidence,releaseChecks,prepareReleaseCandidate} from '../../scripts/prepare-release-candidate.mjs';
import {verifyProductPayload,fileDigest,requiredPayloadFiles} from '../../scripts/product-payload-check.mjs';
import {reviewHost,hostTreeDigest,copyHostTree} from '../../scripts/host-compatibility-review.mjs';
function fixture(t){const base=mkdtempSync(resolve(tmpdir(),'release-maintenance-'));t.after(()=>rmSync(base,{recursive:true,force:true}));return base;}
const identity={product_version:'0.1.0-preview.3',host_version:'0.2.16',installer_sha256:'a'.repeat(64),payload_manifest_sha256:'b'.repeat(64)};
test('evidence binds exact binary and manifest; missing checks stay pending and raw notes are excluded',()=>{
  const input={version:1,...identity,checks:[{id:'fresh_install',status:'passed',notes:'SECRET'}]};
  const result=assessReleaseEvidence(input,identity);assert(result.blockers.includes('clean_windows'));assert(!JSON.stringify(result).includes('SECRET'));assert.equal(result.distribution_ready,false);
  for(const key of Object.keys(identity))assert.throws(()=>assessReleaseEvidence({...input,[key]:'different'},identity),/match/);
  assert.throws(()=>assessReleaseEvidence({...input,checks:[...input.checks,...input.checks]},identity),/duplicate/);
  assert.throws(()=>assessReleaseEvidence({...input,checks:[{id:'clean_windows',status:'skipped'}]},identity),/Invalid/);
  const passed=assessReleaseEvidence({...input,checks:releaseChecks.map(id=>({id,status:'passed'}))},identity);assert.equal(passed.blockers.length,0);assert.equal(passed.publication,'not_published');assert.equal(passed.review_required,true);
});
function payload(base){
  const stage=resolve(base,'候选 stage');mkdirSync(stage);const files={};
  for(const name of requiredPayloadFiles){const file=resolve(stage,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,name);files[name]=fileDigest(file);}
  const manifest={version:1,product_version:identity.product_version,host_version:identity.host_version,distribution_ready:false,signature_status:'unsigned',files};
  const save=()=>writeFileSync(resolve(stage,'product-payload.json'),JSON.stringify(manifest));save();return {stage,manifest,save};
}
test('payload rejects tampering, traversal, used installation and private or unlisted state',t=>{
  for(const mode of ['tamper','traversal','used','private','unlisted']){
    const sub=resolve(fixture(t),mode);mkdirSync(sub);const f=payload(sub);assert.equal(verifyProductPayload(f.stage).status,'payload_verified');
    if(mode==='tamper')writeFileSync(resolve(f.stage,'AITestHarness.exe'),'changed');
    if(mode==='traversal'){f.manifest.files['../outside']='a'.repeat(64);f.save();}
    if(mode==='used')mkdirSync(resolve(f.stage,'data'));
    if(['private','unlisted'].includes(mode)){const name=mode==='private'?'runtime/api-token':'runtime/extra';writeFileSync(resolve(f.stage,name),'fixture');if(mode==='private'){f.manifest.files[name]=fileDigest(resolve(f.stage,name));f.save();}}
    assert.throws(()=>verifyProductPayload(f.stage));
  }
});
test('release directory contains a verified copy, filtered evidence and digests without publishing',t=>{
  const base=fixture(t),f=payload(base),installer=resolve(base,'AITestHarness-0.1.0-preview.3-win-x64.exe'),evidence=resolve(base,'evidence.json'),output=resolve(base,'release');writeFileSync(installer,'MZfixture');
  writeFileSync(evidence,JSON.stringify({version:1,...identity,installer_sha256:fileDigest(installer),payload_manifest_sha256:fileDigest(resolve(f.stage,'product-payload.json')),checks:[{id:'fresh_install',status:'passed',notes:'SECRET'}]}));
  const result=prepareReleaseCandidate({stage:f.stage,installer,evidence,output});assert.equal(result.status,'draft_prepared');assert.equal(fileDigest(resolve(output,'AITestHarness-0.1.0-preview.3-win-x64.exe')),fileDigest(installer));assert(!readFileSync(resolve(output,'acceptance.json'),'utf8').includes('SECRET'));assert.match(readFileSync(resolve(output,'SHA256SUMS.txt'),'utf8'),/acceptance.json/);
  assert.throws(()=>prepareReleaseCandidate({stage:f.stage,installer,evidence,output}),/fresh/);
});
test('unknown host gets a review-required report and is never copied or patched',async t=>{
  const base=fixture(t),app=resolve(base,'host'),out=resolve(base,'review');mkdirSync(app);writeFileSync(resolve(app,'package.json'),JSON.stringify({version:'99.0.0'}));const before=hostTreeDigest(app);
  const result=await reviewHost(app,out,{checkUpdates:false});assert.equal(result.status,'compatibility_review_required');assert.equal(result.automatic_install,false);assert(!existsSync(resolve(out,'host-app')));assert.equal(hostTreeDigest(app),before);
  await assert.rejects(reviewHost(app,resolve(app,'nested'),{checkUpdates:false}),/separate/);
});
test('isolated copying preserves Chinese directories and refuses linked or private host input',t=>{
  const base=fixture(t),source=resolve(base,'输入'),target=resolve(base,'输出');mkdirSync(source);mkdirSync(resolve(source,'目录'));writeFileSync(resolve(source,'目录/数据'),'fixture');copyHostTree(source,target);assert.equal(hostTreeDigest(source),hostTreeDigest(target));
  writeFileSync(resolve(source,'api-token'),'fixture');assert.throws(()=>hostTreeDigest(source),/User state/);
  const link=resolve(base,'linked');symlinkSync(target,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>copyHostTree(link,resolve(base,'copy')),/Linked/);
});
