import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { readRunFile } from '../../scripts/design-quality.mjs';
import { buildReportEvidence, reportFactsMarkdown } from '../../scripts/report-evidence.mjs';

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'report-evidence-'));
  const sources = [];
  const manifest = { run_id: 'run-facts', orchestration: { events: [{ type:'dispatched', stage:'report', available_sources:sources }] } };
  const put = (path, value, completed = true) => {
    mkdirSync(dirname(resolve(dir,path)), { recursive:true });
    writeFileSync(resolve(dir,path), JSON.stringify(value));
    const file = readRunFile(dir,path);
    const entry = { path, sha256:file.sha256 };
    if (completed) sources.push(entry);
    return entry;
  };
  return { dir, manifest, sources, put };
}

test('extracts exact assertion counts, timing and hashed evidence without changing source', () => {
  const f=fixture();
  const evidence=f.put('execution/browser-evidence/observed.json',{ secret_value:'DO_NOT_COPY_TEXT' },false);
  f.put('execution/exploration.json',{run_id:'run-facts',mode:'interactive_browser',evidence:[evidence]});
  f.put('execution/test_results.json',{run_id:'run-facts',summary:{total:999},cases:Array.from({length:7},(_,i)=>({case_id:`CASE-${i}`,status:i===5?'passed':'failed',timing:{mode:i<4?'same_operation':'standalone_observation',delay_after_action_ms:i===5?13306:0,preceding_action:{request_id:'click-1'}},evidence_paths:[evidence.path,'execution/missing.json']}))});
  const before=readFileSync(resolve(f.dir,'execution/test_results.json'));
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.equal(index.facts[0].total,7);
  assert.equal(index.facts[0].counts.passed,1);
  assert.equal(index.facts[0].counts.failed,6);
  assert.equal(index.facts[0].count_unit,'assertion_attempts');
  assert.equal(index.facts[0].business_test_point_count,null);
  assert.equal(index.facts[0].assertions[5].timing_mode,'standalone_observation');
  assert.equal(index.facts[0].assertions[5].delay_after_action_ms,13306);
  assert.equal(index.facts[0].assertions[5].assertion_started_at,null);
  assert.equal(index.facts[0].assertions[5].matched_at,null);
  assert.equal(index.facts[0].assertions[5].unavailable_evidence_count,1);
  assert.equal(index.files.find(p=>p.path===evidence.path).read_path,resolve(f.dir,evidence.path));
  assert.ok(!JSON.stringify(index).includes('DO_NOT_COPY_TEXT'));
  assert.equal(index.facts[0].assertions[5].verification_layer,'not_recorded');
  assert.match(reportFactsMarkdown(index),/CASE-5 \| passed \| 未记录 \| 独立观察 \| 13306/);
  assert.deepEqual(readFileSync(resolve(f.dir,'execution/test_results.json')),before);
});

test('missing optional artifacts and text-only report do not require predecessor stages', () => {
  const f=fixture();f.put('inputs/request.txt','Only summarize supplied material',false);
  const index=buildReportEvidence(f.dir,f.manifest,['inputs/request.txt']);
  assert.equal(index.files.length,1);assert.deepEqual(index.facts,[]);
  assert.match(reportFactsMarkdown(index),/未评估/);
  assert.ok(!index.files.some(p=>p.path.includes('metrics')));
});

test('tampering, foreign run data, traversal and unlisted evidence are not facts', () => {
  const f=fixture();
  f.put('execution/test_results.json',{run_id:'run-other',cases:[{case_id:'foreign',status:'passed'}]});
  const entry=f.put('execution/exploration.json',{run_id:'run-facts',evidence:[]});
  writeFileSync(resolve(f.dir,entry.path),'{}');
  f.sources.push({path:'../outside.json',sha256:'x'},{path:'execution/absent.json',sha256:'x'},{path:'execution/browser-private.json',sha256:'x'});
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.deepEqual(index.facts,[]);assert.equal(index.unavailable.length,4);
  assert.ok(!index.files.some(p=>p.path===entry.path));
});

test('tampered referenced evidence is omitted while partial facts remain usable', () => {
  const f=fixture();const e=f.put('execution/observed.json',{ok:true},false);
  f.put('execution/exploration.json',{run_id:'run-facts',mode:'interactive_browser',evidence:[e]});
  f.put('execution/test_results.json',{run_id:'run-facts',cases:[{case_id:'A',status:'failed',evidence_paths:[e.path]}]});
  writeFileSync(resolve(f.dir,e.path),'{}');
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.deepEqual(index.facts[0].assertions[0].evidence_paths,[]);
  assert.equal(index.facts[0].assertions[0].timing_mode,'not_recorded');
});

test('imported results are labelled supplied and deduplicated without inventing timing', () => {
  const f=fixture();f.put('inputs/results.json',{cases:[{case_id:'X',status:'unknown'}]});
  const index=buildReportEvidence(f.dir,f.manifest,['inputs/results.json']);
  assert.equal(index.facts.length,1);assert.equal(index.facts[0].count_unit,'result_records');
  assert.equal(index.facts[0].counts.unknown,1);
  assert.equal(index.facts[0].source_kind,'user_supplied_not_independently_verified');
});

test('directory links cannot introduce external evidence', () => {
  const f=fixture();const other=fixture();other.put('outside/item.json',{value:'outside'});
  symlinkSync(resolve(other.dir,'outside'),resolve(f.dir,'linked'),'junction');
  f.sources.push({path:'linked/item.json',sha256:readRunFile(other.dir,'outside/item.json').sha256});
  assert.equal(buildReportEvidence(f.dir,f.manifest).files.length,0);
});

test('explicit assertion timestamps are retained and invalid timestamps are unknown', () => {
  const f=fixture();
  f.put('inputs/results.json',{cases:[{case_id:'T',status:'passed',timing:{assertion_started_at:'2026-10-15T01:00:00.000Z',matched_at:'not-a-date'}}]},false);
  const row=buildReportEvidence(f.dir,f.manifest,['inputs/results.json']).facts[0].assertions[0];
  assert.equal(row.assertion_started_at,'2026-10-15T01:00:00.000Z');
  assert.equal(row.matched_at,null);
});

test('data cleanup facts are hash-bound, distinguish residuals and never inflate product counts',()=>{
  const f=fixture();
  const ledger=f.put('execution/browser-data-ledger.json',{run_id:'run-facts',invocation_id:'invocation',items:[
    {key:'one',marker:'qa-one',status:'removed_from_view'},
    {key:'two',marker:'qa-two',status:'cleanup_uncertain'},
    {key:'three',marker:'qa-three',status:'prepared'}
  ]},false);
  f.put('execution/exploration.json',{run_id:'run-facts',invocation_id:'invocation',mode:'interactive_browser',evidence:[ledger]});
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.deepEqual(index.facts,[]);
  assert.equal(index.test_data.tracked,3);assert.equal(index.test_data.possible_residuals,1);assert.equal(index.test_data.prepared_only,1);
  assert.match(reportFactsMarkdown(index),/页面不再显示不等于后端已物理删除/);
  assert.match(reportFactsMarkdown(index),/qa-two.*清理结果不确定/);
  writeFileSync(resolve(f.dir,ledger.path),'{}');
  assert.equal(buildReportEvidence(f.dir,f.manifest).test_data,null);
});

test('statistics are recomputed and design-only inputs never become execution records',()=>{
  const f=fixture();
  const design=f.put('inputs/cases.json',{cases:[{case_id:'DESIGN1',expected:'Ready'}]});
  const case_ref={source_path:design.path,case_id:'DESIGN1',source_sha256:design.sha256};
  const base={expected:'Ready',case_ref,verification_scope:{layer:'ui'},check_fingerprint:'same',timing:{mode:'standalone_observation'}};
  f.put('execution/exploration.json',{run_id:'run-facts',mode:'interactive_browser',evidence:[design]});
  f.put('execution/test_results.json',{run_id:'run-facts',statistics:{records:999},cases:[{...base,case_id:'A',status:'failed'},{...base,case_id:'B',status:'passed',recheck_of:'A'}]});
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.equal(index.facts.length,1);assert.equal(index.facts[0].statistics.records,2);
  assert.equal(index.facts[0].statistics.linked_case_count,1);assert.equal(index.facts[0].statistics.read_only_rechecks,1);
  assert.match(reportFactsMarkdown(index),/原失败保留/);
  writeFileSync(resolve(f.dir,design.path),'{}');
  assert.equal(buildReportEvidence(f.dir,f.manifest).facts[0].statistics.linked_case_count,null);
});

test('simulated failures and affected observations remain visibly separate from real backend evidence',()=>{
  const f=fixture();f.put('execution/exploration.json',{run_id:'run-facts',mode:'interactive_browser',evidence:[]});
  f.put('execution/test_results.json',{run_id:'run-facts',cases:[
    {case_id:'MOCK',status:'passed',evidence_mode:'simulated',verification_scope:{layer:'ui'}},
    {case_id:'LATER',status:'passed',evidence_mode:'simulation_affected',verification_scope:{layer:'ui'}},
    {case_id:'API',status:'failed',evidence_mode:'real',verification_scope:{layer:'api_contract'}}]});
  const index=buildReportEvidence(f.dir,f.manifest),markdown=reportFactsMarkdown(index);
  assert.deepEqual(index.facts[0].statistics.evidence_modes,{real:1,simulated:1,simulation_affected:1,not_recorded:0});
  assert.match(markdown,/MOCK.*模拟故障/);assert.match(markdown,/LATER.*受模拟影响/);
  assert.match(markdown,/不是服务端真实故障/);
});

test('optional regression mapping reaches rendered facts and tampered evidence removes the comparison',()=>{
  const f=fixture();
  const evidence=f.put('inputs/observation.json',{observed:true});
  const row={case_id:'R',status:'failed',expected:'Ready',check_fingerprint:'matching',evidence_mode:'real',verification_scope:{layer:'ui'},evidence_paths:[evidence.path]};
  const before=f.put('inputs/old.json',{run_id:'old',invocation_id:'a',started_at:'2026-10-14T01:00:00Z',finished_at:'2026-10-14T02:00:00Z',cases:[row]});
  const after=f.put('execution/test_results.json',{run_id:'run-facts',invocation_id:'b',started_at:'2026-10-15T01:00:00Z',finished_at:'2026-10-15T02:00:00Z',cases:[{...row,status:'passed'}]});
  const mapping=f.put('inputs/regression.json',{kind:'regression_comparison',version:1,comparisons:[{id:'R',layer:'original',
    baseline:{source_path:before.path,source_sha256:before.sha256,case_id:'R'},current:{source_path:after.path,source_sha256:after.sha256,case_id:'R'}}]});
  const snapshot=readFileSync(resolve(f.dir,before.path));
  const index=buildReportEvidence(f.dir,f.manifest);
  assert.equal(index.regression.counts.now_passing,1);assert.equal(index.facts.length,2);
  assert.match(reportFactsMarkdown(index),/回归对照/);assert.match(reportFactsMarkdown(index),/含导入材料/);
  assert.deepEqual(readFileSync(resolve(f.dir,before.path)),snapshot);
  writeFileSync(resolve(f.dir,evidence.path),'{}');
  assert.equal(buildReportEvidence(f.dir,f.manifest).regression.rows[0].reason,'evidence_not_indexed');
  writeFileSync(resolve(f.dir,mapping.path),'{}');
  assert.equal(buildReportEvidence(f.dir,f.manifest).regression,null);
});

test('foreign-run execution artifacts cannot become current regression evidence',()=>{
  const f=fixture();
  const row={case_id:'R',status:'failed'};
  const old=f.put('inputs/old.json',{run_id:'old',cases:[row]});
  const foreign=f.put('execution/test_results.json',{run_id:'foreign',cases:[{...row,status:'passed'}]});
  f.put('inputs/regression.json',{kind:'regression_comparison',version:1,comparisons:[{id:'R',layer:'original',
    baseline:{source_path:old.path,source_sha256:old.sha256,case_id:'R'},current:{source_path:foreign.path,source_sha256:foreign.sha256,case_id:'R'}}]});
  const result=buildReportEvidence(f.dir,f.manifest).regression;
  assert.equal(result.rows[0].current,null);assert.equal(result.rows[0].outcome,'not_verified');
});

test('JSON content without suffix and with BOM is indexed without inventing missing evidence aliases',()=>{
  const f=fixture();
  const evidence=f.put('inputs/evidence',{observed:true});
  const record={case_id:'R',status:'failed',expected:'Ready',check_fingerprint:'same',evidence_mode:'real',verification_scope:{layer:'ui'},evidence_paths:[evidence.path]};
  const before=f.put('inputs/before',{run_id:'old',invocation_id:'a',started_at:'2026-10-14T01:00:00Z',finished_at:'2026-10-14T02:00:00Z',cases:[record]},false);
  writeFileSync(resolve(f.dir,before.path),'\uFEFF'+readFileSync(resolve(f.dir,before.path),'utf8'));
  const after=f.put('inputs/after.JSON',{run_id:'new',invocation_id:'b',started_at:'2026-10-15T01:00:00Z',finished_at:'2026-10-15T02:00:00Z',cases:[{...record,status:'passed'}]},false);
  const inputs=[before.path,after.path,evidence.path];
  const mapping={version:1,comparisons:[{id:'pair',layer:'original',baseline:{source_path:before.path,case_id:'R'},current:{source_path:after.path,case_id:'R'}}]};
  const index=buildReportEvidence(f.dir,f.manifest,inputs,mapping);
  assert.equal(index.facts.length,2);assert.equal(index.regression.counts.now_passing,1);
  const source=JSON.parse(readFileSync(resolve(f.dir,after.path),'utf8'));source.cases[0].evidence_paths=['inputs/evidence.json'];
  writeFileSync(resolve(f.dir,after.path),JSON.stringify(source));
  assert.equal(buildReportEvidence(f.dir,f.manifest,inputs,mapping).regression.rows[0].reason,'evidence_not_indexed');
  f.put('inputs/binary',{ignored:true},false);writeFileSync(resolve(f.dir,'inputs/binary'),Buffer.from([123,255,125]));
  f.put('inputs/broken',{},false);writeFileSync(resolve(f.dir,'inputs/broken'),'{broken');
  assert.equal(buildReportEvidence(f.dir,f.manifest,['inputs/binary','inputs/broken']).facts.length,0);
});
