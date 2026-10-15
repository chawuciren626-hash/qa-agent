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
  assert.match(reportFactsMarkdown(index),/CASE-5 \| passed \| 独立观察 \| 13306/);
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
