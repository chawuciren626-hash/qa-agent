import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { guardSensitiveRead, isSensitiveRuntimePath } from '../../scripts/sensitive-file-guard.mjs';
import { guardControllerTool } from '../../scripts/controller-tool-guard.mjs';
import { guardChildTool } from '../../scripts/child-tool-guard.mjs';

const engine=resolve(import.meta.dirname,'../..');

test('evidence audit reads an explicit pointer without exposing values or changing original bytes',t=>{
  const root=fixture(t),repo=resolve(root,'repo');mkdirSync(repo);
  execFileSync('git',['init','-q',repo]);
  const secret='synthetic-evidence-secret',source=resolve(repo,'source.json'),copy=resolve(repo,'copy.txt');
  writeFileSync(source,JSON.stringify({observed:secret}));writeFileSync(copy,secret);
  const before=readFileSync(source);
  const args=[resolve(engine,'scripts/credential-exposure-audit.py'),'--repo',repo,'--secret-json',source,'--secret-pointer','/observed'];
  const result=spawnSync(process.env.QA_SECURITY_PYTHON ?? 'python',args,{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout);assert.ok(!result.stdout.includes(secret));assert.ok(!result.stderr.includes(secret));
  const report=JSON.parse(result.stdout);assert.equal(report.mode,'read_only_exact_evidence_value_audit');
  assert.equal(report.working_tree.findings.length,2);
  assert.ok(report.working_tree.findings.every(row=>/^[a-f0-9]{64}$/.test(row.file_sha256) && row.stable_during_read));
  assert.deepEqual(readFileSync(source),before);
  const invalid=spawnSync(process.env.QA_SECURITY_PYTHON ?? 'python',[...args.slice(0,-1),'/missing'],{encoding:'utf8',timeout:30000});
  assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).status,'audit_failed');assert.ok(!invalid.stdout.includes(secret));
});
function fixture(t) {
  const root=mkdtempSync(resolve(tmpdir(),'qa-secret-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}

test('all QA roles reject credential stores, private tokens, backups and Windows aliases without echoing arguments',t=>{
  const root=fixture(t);
  const names=['.vault.toml','.project_config.toml','api-token','browser-private.json','.vault.toml.bak','API-TOKEN.old','browser-private.json:stream','.project_config.toml.'];
  for(const name of names) {
    const input={tool_name:'read_file',arguments:{file_path:resolve(root,name)}};
    assert.equal(isSensitiveRuntimePath(name),true,name);
    assert.equal(guardControllerTool(root,input).decision,'deny');
    for(const agentId of ['automation_execution_agent','requirement_analysis_agent','test_point_agent','test_case_agent','defect_analysis_agent','test_report_agent']) {
      const result=guardChildTool(root,input,{agentId,agentRoot:root});
      assert.equal(result.decision,'deny');
      assert.ok(!result.reason.includes(root));
    }
  }
  for(const name of ['execution/browser-state.json','execution/test_results.json','environment/test-env.json','docs/penguinharness-configuration.md']) {
    assert.deepEqual(guardSensitiveRead(root,{tool_name:'read_file',arguments:{file_path:resolve(root,name)}}),{});
  }
  assert.equal(guardSensitiveRead(root,{tool_name:'read_file',arguments:'{broken'}).decision,'deny');
});

test('native sensitive read guard follows symbolic links',t=>{
  const root=fixture(t),secret=resolve(root,'.vault.toml'),alias=resolve(root,'notes.txt');
  writeFileSync(secret,'synthetic');
  try { symlinkSync(secret,alias); } catch(error) {
    if(['EPERM','EACCES'].includes(error.code)) {t.skip('OS does not permit creating file symbolic links');return;}
    throw error;
  }
  assert.equal(guardSensitiveRead(root,{tool_name:'read_file',arguments:{file_path:alias}}).decision,'deny');
});

test('Git ignores credential store copies but keeps environment examples',t=>{
  const root=fixture(t);
  execFileSync('git',['init','-q',root]);
  writeFileSync(resolve(root,'.gitignore'),readFileSync(resolve(engine,'.gitignore')));
  for(const name of ['.project_config.toml','.vault.toml.backup','nested/browser-private.json','.env','.env.local','nested/api-token']) {
    assert.equal(spawnSync('git',['-C',root,'check-ignore','--quiet',name]).status,0,name);
  }
  assert.equal(spawnSync('git',['-C',root,'check-ignore','--quiet','.env.example']).status,1);
});

test('exposure audit detects deleted Git secrets and UTF-16 local copies without printing values',t=>{
  const root=fixture(t),repo=resolve(root,'repo'),logs=resolve(root,'logs');
  mkdirSync(repo);mkdirSync(logs);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init','-q');
  const secret='synthetic-credential-for-security-fixture';
  const config=resolve(root,'.project_config.toml');
  writeFileSync(config,`[[models]]\napi_key = "${secret}"\n`);
  writeFileSync(resolve(repo,'old.txt'),secret);
  git('add','old.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  git('rm','-q','old.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','removed');
  writeFileSync(resolve(logs,'copy.log'),Buffer.from(secret,'utf16le'));
  const run=()=>spawnSync(process.env.QA_SECURITY_PYTHON ?? 'python',[resolve(engine,'scripts/credential-exposure-audit.py'),'--repo',repo,'--config',config,'--history','--scan-root',logs],{encoding:'utf8',timeout:30000});
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes(secret));assert.ok(!result.stderr.includes(secret));
  const report=JSON.parse(result.stdout);
  assert.equal(report.working_tree.findings.length,0);
  assert.equal(report.history.findings.length,1);
  assert.equal(report.local_scopes[0].findings.length,1);
  assert.deepEqual(report.history.findings[0].keys,['configured-key-1']);
  writeFileSync(config,`api_key = "${secret}\n`);
  const invalid=run();assert.equal(invalid.status,1);
  assert.ok(!invalid.stdout.includes(secret));assert.equal(invalid.stderr,'');
  assert.equal(JSON.parse(invalid.stdout).status,'audit_failed');
});

test('exposure audit excludes directory junctions and marks coverage incomplete',t=>{
  const root=fixture(t),repo=resolve(root,'repo'),logs=resolve(root,'logs'),outside=resolve(root,'outside');
  for(const dir of [repo,logs,outside]) mkdirSync(dir);
  execFileSync('git',['init','-q',repo]);
  const secret='synthetic-junction-credential';
  const config=resolve(root,'.project_config.toml');
  writeFileSync(config,`api_key = "${secret}"\n`);
  writeFileSync(resolve(outside,'secret.txt'),secret);
  try { symlinkSync(outside,resolve(logs,'external'),process.platform==='win32'?'junction':'dir'); }
  catch(error) {
    if(['EPERM','EACCES'].includes(error.code)) {t.skip('OS does not permit directory links');return;}
    throw error;
  }
  const result=spawnSync(process.env.QA_SECURITY_PYTHON ?? 'python',[resolve(engine,'scripts/credential-exposure-audit.py'),'--repo',repo,'--config',config,'--scan-root',logs],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes(secret));
  const scope=JSON.parse(result.stdout).local_scopes[0];
  assert.equal(scope.findings.length,0);
  assert.equal(scope.files_scanned,0);
  assert.equal(scope.traversal.links_excluded,1);
  assert.equal(scope.complete,false);
});
