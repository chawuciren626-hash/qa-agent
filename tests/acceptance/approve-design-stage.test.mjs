import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const engine = resolve(import.meta.dirname, '../..');
test('design approval binds owner session and current deliverable under the run lock', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'qa-review-'));
  try {
    const sessionId = `session-2026-11-02-01-00-00-${randomUUID().replaceAll('-', '')}`;
    const session = resolve(temp, sessionId), runId = `run-${randomUUID()}`;
    const dir = resolve(session, 'output/runs', runId), artifact = 'analysis/requirement_analysis.md';
    mkdirSync(resolve(dir, 'analysis'), { recursive: true });
    const bytes = Buffer.from('Synthetic review fixture\n');
    writeFileSync(resolve(dir, artifact), bytes);
    const receipt = { version: 1, run_id: runId, stage: 'analysis', status: 'passed', files: [{ path: artifact, sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const context = { version: 1, engine_root: engine, workspace_root: temp, session_root: session, session_id: sessionId };
    const manifestPath = resolve(dir, 'manifest.json');
    const manifest = { run_id: runId, directory_context: context, status: 'awaiting_confirmation',
      stages: { analysis: { status: 'awaiting_confirmation' } }, confirmations: [{ id: 'confirm-analysis-1', stage: 'analysis', status: 'pending', artifact_contract: receipt }],
      orchestration: { plan: { workflow_mode: 'lifecycle', review_mode: 'staged', stages: [{ id: 'analysis', selected: true, confirmation: 'after' }] },
        events: [{ type: 'completed', stage: 'analysis', evidence: { artifact_contract: receipt } }, { type: 'confirmation_requested', stage: 'analysis' }] } };
    const run = (...args) => spawnSync(process.execPath, [resolve(engine, 'scripts/approve-design-stage.mjs'), ...args], { cwd: engine, encoding: 'utf8', env: { ...process.env, QA_DIRECTORY_CONTEXT: JSON.stringify(context) } });
    const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
    save();
    assert.notEqual(run(runId, sessionId, 'analysis', 'confirm-analysis-old', 'owner').status, 0);
    assert.equal(JSON.parse(readFileSync(manifestPath)).confirmations[0].status, 'pending');
    writeFileSync(resolve(dir, artifact), 'changed');
    assert.notEqual(run(runId, sessionId, 'analysis', 'confirm-analysis-1', 'owner').status, 0);
    assert.equal(JSON.parse(readFileSync(manifestPath)).confirmations[0].status, 'pending');
    writeFileSync(resolve(dir, artifact), bytes);
    const approved = run(runId, sessionId, 'analysis', 'confirm-analysis-1', 'owner');
    assert.equal(approved.status, 0, approved.stderr);
    const result = JSON.parse(readFileSync(manifestPath));
    assert.equal(result.confirmations[0].status, 'approved');
    assert.equal(result.stages.analysis.status, 'completed');
    assert.equal(result.orchestration.events.at(-1).actor_user_id, 'owner');
    assert.notEqual(run(runId, sessionId, 'analysis', 'confirm-analysis-1', 'owner').status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('stage revision preserves the reviewed report and exact feedback before redispatch', () => {
  const temp=mkdtempSync(resolve(tmpdir(),'qa-revision-'));
  try {
    const sessionId=`session-2026-11-02-02-00-00-${randomUUID().replaceAll('-','')}`, runId=`run-${randomUUID()}`;
    const session=resolve(temp,sessionId),dir=resolve(session,'output/runs',runId),artifact='report/test_report.md';
    mkdirSync(resolve(dir,'report'),{recursive:true}); mkdirSync(resolve(dir,'inputs'),{recursive:true});
    const bytes=Buffer.from('# Reviewed report\n'); writeFileSync(resolve(dir,artifact),bytes);
    const receipt={version:1,run_id:runId,stage:'report',status:'passed',files:[{path:artifact,sha256:createHash('sha256').update(bytes).digest('hex')}]};
    const context={version:1,engine_root:engine,workspace_root:temp,session_root:session,session_id:sessionId};
    const manifest={run_id:runId,directory_context:context,status:'awaiting_confirmation',artifacts:[artifact],
      stages:{report:{status:'awaiting_confirmation'}},confirmations:[{id:'confirm-report-1',stage:'report',kind:'result',status:'pending',artifact_contract:receipt}],
      orchestration:{plan:{workflow_mode:'lifecycle',review_mode:'staged',stages:[{id:'report',selected:true,confirmation:'after',depends_on:[]}]},events:[{type:'completed',stage:'report',evidence:{artifact_contract:receipt}},{type:'confirmation_requested',stage:'report'}]}};
    const manifestPath=resolve(dir,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest));
    const run=(id,feedback)=>spawnSync(process.execPath,[resolve(engine,'scripts/request-stage-revision.mjs'),runId,sessionId,'report',id,'owner'],{cwd:engine,encoding:'utf8',env:{...process.env,QA_DIRECTORY_CONTEXT:JSON.stringify(context),QA_STAGE_FEEDBACK:feedback}});
    assert.notEqual(run('confirm-report-old','请补充结论').status,0);
    assert.equal(JSON.parse(readFileSync(manifestPath)).confirmations[0].status,'pending');
    const result=run('confirm-report-1','请补充结论'); assert.equal(result.status,0,result.stderr);
    const changed=JSON.parse(readFileSync(manifestPath));
    assert.equal(changed.stages.report.status,'revision_requested');
    assert.equal(changed.confirmations[0].status,'revision_requested');
    assert.equal(readFileSync(resolve(dir,changed.stages.report.revision_archive,artifact),'utf8'),bytes.toString());
    assert.equal(readFileSync(resolve(dir,changed.stages.report.feedback_input.path),'utf8'),'请补充结论');
    assert.notEqual(run('confirm-report-1','重复').status,0);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
