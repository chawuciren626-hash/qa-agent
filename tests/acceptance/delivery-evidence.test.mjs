import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {readDeliveryEvidence,evidenceKind} from '../../scripts/delivery-evidence.mjs';
import {deliveryEvidenceKind,extractDeliveries} from '../../penguin/ui/delivery-ui.mjs';

const base='output/runs/run-fixture/execution';
function fixture(t) {
  const root=realpathSync(mkdtempSync(resolve(tmpdir(),'qa-evidence-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,text)=>{mkdirSync(dirname(resolve(root,path)),{recursive:true});writeFileSync(resolve(root,path),text);};
  return {root,put};
}
test('JSON and directory links are recognized without exposing private connection or arbitrary JSON',t=>{
  const f=fixture(t);
  for(const path of [`${base}/test_results.json`,`${base}/exploration.json`,`${base}/browser-network.json`,`${base}/browser-evidence/one.observation.json`]) {
    f.put(path,'{"message":"<script>not executed</script>"}');
    assert.equal(deliveryEvidenceKind(path),'json');assert.equal(evidenceKind(path),'json');
    assert.equal(readDeliveryEvidence(f.root,path).kind,'json');
    assert.equal(extractDeliveries(`[证据](<${path}>)`,f.root).length,1);
  }
  for(const path of [`${base}/browser-private.json`,`${base}/browser-private.json.backup`,`${base}/other.json`,`${base}/browser-evidence/fill.json`,'../test_results.json','output/action-audit/test.json',`${base}/../execution/test_results.json`]) {
    assert.throws(()=>readDeliveryEvidence(f.root,path));assert.equal(deliveryEvidenceKind(path),null);
  }
  f.put(`${base}/browser-private.json`,'{"token":"PRIVATE"}');
  const result=readDeliveryEvidence(f.root,base);
  assert.equal(result.kind,'directory');assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(result.entries.some(e=>e.name==='browser-evidence'));
});
test('missing invalid oversized and linked evidence are rejected; directory listings are bounded',t=>{
  const f=fixture(t),path=`${base}/test_results.json`;
  assert.throws(()=>readDeliveryEvidence(f.root,path));
  f.put(path,'invalid');assert.throws(()=>readDeliveryEvidence(f.root,path));
  f.put(path,' '.repeat(2*1024*1024+1));assert.throws(()=>readDeliveryEvidence(f.root,path),/2 MB/);
  f.put(path,'{}');
  for(let i=0;i<202;i++) f.put(`${base}/browser-evidence/${i}.observation.json`,'{}');
  const listing=readDeliveryEvidence(f.root,`${base}/browser-evidence`);assert.equal(listing.entries.length,200);assert.equal(listing.truncated,true);
  const alias=resolve(f.root,'alias');symlinkSync(resolve(f.root,'output'),alias,'junction');
  const other=fixture(t);mkdirSync(resolve(other.root,'output/runs'),{recursive:true});
  symlinkSync(resolve(f.root,'output/runs/run-fixture'),resolve(other.root,'output/runs/run-fixture'),'junction');
  assert.throws(()=>readDeliveryEvidence(other.root,path),/Linked/);
});
