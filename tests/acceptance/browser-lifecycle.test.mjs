import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserAuthorization, browserCoverage, assertBrowserTarget, assertBrowserDesignCheck } from '../../scripts/browser-lifecycle.mjs';
const root=resolve(import.meta.dirname,'../..');
const native=(text,sender)=>({type:'model_msg',timestamp:new Date().toISOString(),payload:{type:'text',role:'user',text,sender}});
function fixture() {
  const id=`run-${randomUUID()}`,dir=resolve(root,'output/runs',id);mkdirSync(resolve(dir,'design'),{recursive:true});
  const cases=[{case_id:'TC-1',title:'Confirmed',expected:'Ready',design_contract:{basis:[{status:'confirmed'}],assumptions:[]}},{case_id:'TC-2',title:'Pending',expected:'Unknown',design_contract:{basis:[{status:'pending'}],assumptions:[]}}];
  writeFileSync(resolve(dir,'design/test_cases.json'),JSON.stringify(cases));
  const text='请对 http://127.0.0.1:12345/ 执行全流程测试，登录时由我处理。',rows=[native(text)];
  const auth=browserAuthorization(root,id,'parent',rows,text);
  const manifest={run_id:id,orchestration:{plan:{workflow_mode:'lifecycle'},execution_strategy:'browser',events:[{type:'dispatched',stage:'execution',browser_authorization:auth}]}};
  return {id,dir,cases,text,rows,auth,manifest};
}
test('browser lifecycle authorization binds native execution intent, origin and immutable design',()=>{
  const f=fixture();
  assert.doesNotThrow(()=>assertBrowserTarget(root,f.id,f.manifest,'http://127.0.0.1:12345/feature'));
  assert.throws(()=>assertBrowserTarget(root,f.id,f.manifest,'http://localhost:12345/'),/outside/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[native(f.text,'harness')],f.text),/native/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',f.rows,'invented'),/native/);
  const text='只生成测试用例 http://127.0.0.1:12345/';
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[native(text)],text),/execution/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[...f.rows,native('停止测试')],f.text),/stop/);
  writeFileSync(resolve(f.dir,'design/test_cases.json'),'[]');
  assert.throws(()=>assertBrowserTarget(root,f.id,f.manifest,'http://127.0.0.1:12345/'),/changed/);
});
test('unknown and unconfirmed design expectations cannot enter lifecycle assertions; unmapped cases stay untested',()=>{
  const f=fixture();
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{}),/reference/);
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:{source_path:'design/test_cases.json',case_id:'TC-2'}}),/Unconfirmed/);
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:{source_path:'design/test_cases.json',case_id:'invented'}}),/Unconfirmed/);
  const ref={source_path:'design/test_cases.json',case_id:'TC-1',source_sha256:f.auth.design_sha256};
  assert.doesNotThrow(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:ref}));
  const coverage=browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref},{case_ref:ref}]});
  assert.deepEqual(coverage.linked_case_ids,['TC-1']);assert.equal(coverage.untested_cases[0].case_id,'TC-2');
  assert.equal(browserCoverage(f.dir,f.manifest,{cases:[{case_ref:{...ref,source_sha256:'changed'}}]}).untested_cases.length,2);
  assert.equal(browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref,evidence_mode:'simulated'}]}).untested_cases.length,2);
});
