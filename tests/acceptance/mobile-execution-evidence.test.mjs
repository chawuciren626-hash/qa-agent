import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { verifyAndroidExecutionResult, verifyMiniprogramExecutionResult } from '../../scripts/mobile-execution-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'android-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'execution/android-evidence'), { recursive: true });
  const name = 'execution/android-evidence/assert.png';
  const file = resolve(root, name);
  const bytes = Buffer.from('observed screenshot bytes');
  writeFileSync(file, bytes);
  const result = {
    run_id: 'run-verified', invocation_id: 'attempt-1', status: 'completed',
    started_at: '2026-10-28T01:00:00Z', finished_at: '2026-10-28T01:00:01Z',
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
    cases: [{ case_id: 'C1', status: 'passed', evidence_mode: 'real', verification_scope: { layer: 'android_ui' }, evidence_paths: [name] }],
    android: { backend: 'adb', evidence_mode: 'real', device: { model: 'emulator' }, package: 'test.app', evidence_paths: [name] },
    evidence_index: [{ path: name, size: bytes.length, sha256: sha(bytes) }],
  };
  const save = () => writeFileSync(resolve(root, 'execution/android-results.json'), JSON.stringify(result));
  save();
  return { root, file, result, save };
}

test('verifies a real Android result and binds its assertions to unchanged local evidence', t => {
  const { root } = fixture(t);
  const proof = verifyAndroidExecutionResult(root, 'run-verified');
  assert.equal(proof.summary.passed, 1);
  assert.equal(proof.evidence_files, 1);
  assert.match(proof.source_sha256, /^[a-f0-9]{64}$/);
});

test('rejects changed evidence, wrong run and forged aggregate counts', t => {
  const { root, file, result, save } = fixture(t);
  writeFileSync(file, 'changed screenshot bytes');
  assert.throws(() => verifyAndroidExecutionResult(root, 'run-verified'), /evidence changed/);
  writeFileSync(file, 'observed screenshot bytes');
  assert.throws(() => verifyAndroidExecutionResult(root, 'another-run'), /identity mismatch/);
  result.summary.passed = 0; save();
  assert.throws(() => verifyAndroidExecutionResult(root, 'run-verified'), /summary mismatch/);
});

test('rejects missing indexed proof, duplicate paths and links', t => {
  const { root, file, result, save } = fixture(t);
  result.cases[0].evidence_paths = ['execution/android-evidence/missing.png']; save();
  assert.throws(() => verifyAndroidExecutionResult(root, 'run-verified'), /missing from index/);
  result.cases[0].evidence_paths = [result.evidence_index[0].path];
  result.evidence_index.push({ ...result.evidence_index[0] }); save();
  assert.throws(() => verifyAndroidExecutionResult(root, 'run-verified'), /duplicate indexed path/);
  result.evidence_index.pop(); save();
  const backup = readFileSync(file);
  rmSync(file); writeFileSync(resolve(root, 'execution/android-evidence/original.png'), backup);
  // Symlinks are deliberately rejected even when their bytes match the index.
  try {
    symlinkSync(resolve(root, 'execution/android-evidence/original.png'), file);
    assert.throws(() => verifyAndroidExecutionResult(root, 'run-verified'), /linked evidence/);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
});

test('miniprogram proof distinguishes synthetic evidence and rejects changed or misbound results', t => {
  const root=mkdtempSync(resolve(tmpdir(),'miniprogram-proof-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(resolve(root,'execution/miniprogram-evidence'),{recursive:true});
  const name='execution/miniprogram-evidence/assert.png',file=resolve(root,name),bytes=Buffer.from('synthetic screenshot');
  writeFileSync(file,bytes);
  const result={run_id:'run-mini',invocation_id:'attempt-1',status:'completed',started_at:'2026-10-28T01:00:00Z',finished_at:'2026-10-28T01:00:01Z',summary:{total:1,passed:1,failed:0,skipped:0,blocked:0},cases:[{case_id:'M1',status:'passed',evidence_mode:'devtools',verification_scope:{layer:'miniprogram_devtools_ui'},evidence_paths:[name]}],target:{kind:'devtools',real_device:false,synthetic:true},evidence_index:[{path:name,size:bytes.length,sha256:sha(bytes)}]};
  const save=()=>writeFileSync(resolve(root,'execution/miniprogram-results.json'),JSON.stringify(result));save();
  assert.throws(()=>verifyMiniprogramExecutionResult(root,'run-mini'),/synthetic result/);
  assert.equal(verifyMiniprogramExecutionResult(root,'run-mini',{allowSynthetic:true}).summary.passed,1);
  assert.throws(()=>verifyMiniprogramExecutionResult(root,'another-run',{allowSynthetic:true}),/identity mismatch/);
  writeFileSync(file,'tampered');
  assert.throws(()=>verifyMiniprogramExecutionResult(root,'run-mini',{allowSynthetic:true}),/evidence changed/);
  writeFileSync(file,bytes);
  result.summary.passed=0;save();
  assert.throws(()=>verifyMiniprogramExecutionResult(root,'run-mini',{allowSynthetic:true}),/summary mismatch/);
});
