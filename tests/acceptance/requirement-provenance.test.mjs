import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { designArtifacts } from './artifact-fixtures.mjs';
import { inspectDesign, designReceipt, validatePlanDesign } from '../../scripts/design-quality.mjs';
import { inspectStageArtifacts } from '../../scripts/artifact-contracts.mjs';
import { createExecutionCases } from '../../scripts/execution-plan.mjs';
import { renderAnalysis, assertAnalysisMarkdown } from '../../scripts/analysis-markdown.mjs';
import { publishAnalysisDraft } from '../../scripts/analysis-draft.mjs';
import { analysisSummary } from '../../scripts/analysis-summary.mjs';
import { childCommandPolicy } from '../../scripts/child-command-policy.mjs';
import { hasApprovedConfirmation, assertStageReady } from '../../scripts/orchestration-state.mjs';

const root = resolve(import.meta.dirname, '../..');

test('draft diagnosis aggregates citation issues without Markdown or source changes', async () => {
  const { diagnoseRequirementLedger } = await import('../../scripts/requirement-provenance.mjs');
  const source=Buffer.from('First\r\nSecond\r\nThird\n');
  const ledger={version:1,run_id:'run-diagnostic',sources:[{id:'S',kind:'specification',path:'inputs/source.txt',origin:'user',locator:'all'}],rules:[
    {id:'R1',statement:'First',kind:'requirement',scope:'in_scope',status:'confirmed',citations:[{source_id:'S',quote:'missing one'},{source_id:'S',quote:'missing two'}]},
    {id:'R2',statement:'Second',kind:'assumption',scope:'in_scope',status:'pending',citations:[{source_id:'S',quote:'First\nSecond'}]}
  ]};
  const read=path=>{assert.notEqual(path,'analysis/requirement_analysis.md');return path==='analysis/requirement-ledger.json'?Buffer.from(JSON.stringify(ledger)):source;};
  const before=Buffer.from(source);
  const bad=diagnoseRequirementLedger('run-diagnostic',read);
  assert.equal(bad.status,'needs_correction');
  for(const fragment of ['R1: citation[0]','R1: citation[1]','R2: citation[0]','R2: reason required']) assert.ok(bad.errors.some(e=>e.includes(fragment)),fragment);
  ledger.rules[0].citations=[{source_id:'S',quote:'First\r\nSecond'}];
  ledger.rules[1].citations=[{source_id:'S',quote:'Third'}];ledger.rules[1].reason='Awaiting decision';
  assert.equal(diagnoseRequirementLedger('run-diagnostic',read).status,'passed');
  ledger.rules[1].id='R1';
  assert.equal(diagnoseRequirementLedger('run-diagnostic',read).status,'needs_correction');
  assert.deepEqual(source,before);
});

function revisionFixture(status = 'pending') {
  const f = fixture();
  const parent = `session-2026-10-09-00-00-00-${randomUUID().replaceAll('-', '')}`;
  const agentRoot = resolve(f.dir, 'synthetic-agent-store');
  const trace = (agent, session, rows) => {
    const dir = resolve(agentRoot, agent, 'traces/2026-10-09'); mkdirSync(dir, { recursive: true });
    const timestamp = new Date(Date.now() + 1000).toISOString();
    writeFileSync(resolve(dir, `${session}_001.jsonl`), rows.map(row => JSON.stringify({ timestamp, type: ['subagent', 'request_end'].includes(row.payload?.type) ? 'event_msg' : 'model_msg', ...row })).join('\n'));
  };
  const meta = { type: 'session_meta', payload: { session_id: parent, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } };
  trace('test_agent', parent, [meta]);
  const stages = JSON.parse(readFileSync(resolve(root, 'config/orchestration-workflow.json'))).stages.map(s => ({ ...s, selected: true }));
  const manifest = { run_id: f.id, artifacts: [], stages: Object.fromEntries(stages.map(s => [s.id, { status: 'planned' }])), confirmations: [{ id: 'synthetic-initial-decision', stage: 'analysis', status }], orchestration: { plan: { stages }, events: [] } };
  manifest.stages.analysis.status = status === 'pending' ? 'awaiting_confirmation' : status === 'rejected' ? 'blocked' : 'completed';
  writeJsonFile(resolve(f.dir, 'manifest.json'), manifest);
  const call = (script, args, env = {}) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PENGUIN_AGENT_ROOT: agentRoot, ...env } });
  const ok = (script, args, env) => { const result = call(script, args, env); assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const read = () => JSON.parse(readFileSync(resolve(f.dir, 'manifest.json')));
  const complete = () => {
    const dispatch = read().orchestration.events.filter(e => e.type === 'dispatched' && e.stage === 'analysis').at(-1);
    const child = `session-2026-10-09-00-00-01-${randomUUID().replaceAll('-', '')}`;
    trace(dispatch.agent, child, [
      { type: 'session_meta', payload: { session_id: child, source: 'subagent', agent_state: resolve(agentRoot, dispatch.agent, 'agent_state'), workspace: root } },
      { payload: { type: 'text', role: 'user', text: `${f.id} ${childCommandPolicy(dispatch.dispatch_id)}` } },
      { payload: { type: 'text', role: 'assistant', text: 'Synthetic revision contract test, not Agent E2E' } },
      { payload: { type: 'request_end', status: 'completed' } }
    ]);
    trace('test_agent', parent, [meta,
      { payload: { type: 'tool_call', name: 'run_subagent', tool_call_id: 'revision', arguments: { agent_id: dispatch.agent, prompt: `${f.id} ${dispatch.dispatch_id} ${childCommandPolicy(dispatch.dispatch_id)}` } } },
      { payload: { type: 'subagent', session_id: child } },
      { payload: { type: 'tool_call_output', tool_call_id: 'revision', stop_reason: 'completed', output: 'Synthetic returned child' } }
    ]);
    return ok('record-orchestration-event', [f.id, 'completed', '--stage=analysis', `--parent-session-id=${parent}`, `--dispatch-id=${dispatch.dispatch_id}`, `--session-id=${child}`, '--artifacts=analysis/requirement_analysis.md,analysis/requirement-ledger.json']);
  };
  return { ...f, parent, call, ok, read, complete };
}

test('user analysis revision archives pending and approved versions, redispatches and requires a fresh confirmation', () => {
  const f = revisionFixture();
  for (let cycle = 0; cycle < 2; cycle++) {
    const oldMarkdown = readFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'));
    const oldLedger = readFileSync(f.path);
    const history = f.read();
    const revised = f.ok('resolve-stage-confirmation', [f.id, 'analysis', 'revision_requested', `Synthetic user modification ${cycle}`]);
    assert.deepEqual(readFileSync(resolve(f.dir, revised.archive, 'analysis/requirement_analysis.md')), oldMarkdown);
    assert.deepEqual(readFileSync(resolve(f.dir, revised.archive, 'analysis/requirement-ledger.json')), oldLedger);
    assert.deepEqual(readFileSync(f.path), oldLedger);
    assert.equal(existsSync(resolve(f.dir, 'analysis/requirement_analysis.md')), false);
    if (cycle) assert.deepEqual(f.read().confirmations.slice(0, history.confirmations.length), history.confirmations);
    assert.equal(hasApprovedConfirmation(f.read(), 'analysis'), false);
    assert.notEqual(f.call('request-stage-confirmation', [f.id, 'analysis']).status, 0);
    f.ok('record-orchestration-event', [f.id, 'dispatched', '--stage=analysis', '--agent=requirement_analysis_agent', '--skills=requirement-analysis', `--parent-session-id=${f.parent}`]);
    f.ledger.rules[0].reason = `Synthetic clarified explanation ${cycle}`; f.save();
    const generated = f.ok('generate-analysis-markdown', [f.id], { QA_CONTROLLER_SESSION: f.parent });
    assert.equal(generated.generation.revision, 0);
    assert.equal(inspectStageArtifacts(root, f.id, 'analysis').status, 'passed');
    f.complete();
    assert.throws(() => assertStageReady(f.read(), 'test_points'), /尚未批准/);
    f.ok('request-stage-confirmation', [f.id, 'analysis']);
    f.ok('resolve-stage-confirmation', [f.id, 'analysis', 'approved', 'Synthetic explicit approval of new version']);
    assert.equal(hasApprovedConfirmation(f.read(), 'analysis'), true);
    assert.doesNotThrow(() => assertStageReady(f.read(), 'test_points'));
  }
});

test('analysis revision invalidates transitive approvals but preserves rejected decisions and historical files', () => {
  const f = revisionFixture('approved');
  const manifest = f.read();
  for (const stage of ['test_points', 'test_cases', 'execution', 'defects', 'report']) {
    manifest.stages[stage].status = 'completed';
    manifest.confirmations.push({ id: `synthetic-${stage}`, stage, status: stage === 'report' ? 'rejected' : 'approved' });
  }
  manifest.stages.report.status = 'blocked';
  writeJsonFile(resolve(f.dir, 'manifest.json'), manifest);
  const previousCases = readFileSync(f.source);
  f.ok('resolve-stage-confirmation', [f.id, 'analysis', 'revision_requested', 'Synthetic user correction']);
  const next = f.read();
  assert.deepEqual(next.confirmations.slice(0, manifest.confirmations.length), manifest.confirmations);
  for (const stage of ['analysis', 'test_points', 'test_cases', 'execution', 'defects']) {
    assert.equal(next.stages[stage].status, 'revision_requested');
    assert.equal(hasApprovedConfirmation(next, stage), false);
  }
  assert.equal(next.stages.report.status, 'blocked');
  assert.equal(next.confirmations.filter(c => c.stage === 'report').at(-1).status, 'rejected');
  assert.deepEqual(readFileSync(f.source), previousCases);
  assert.throws(() => assertStageReady(next, 'execution'));
});

test('analysis revision refuses empty reasons, rejected decisions and unsafe execution without changing files', () => {
  for (const scenario of ['empty', 'rejected', 'active', 'lock', 'unknown']) {
    const f = revisionFixture(scenario === 'rejected' ? 'rejected' : 'approved');
    if (scenario === 'active') { const m = f.read(); m.stages.test_points.status = 'in_progress'; writeJsonFile(resolve(f.dir, 'manifest.json'), m); }
    if (scenario === 'lock') writeJsonFile(resolve(f.dir, 'execution/execution.lock.json'), { synthetic: true });
    if (scenario === 'unknown') writeJsonFile(resolve(f.dir, 'execution/execution-state.json'), { version: 2, status: 'blocked' });
    const before = readFileSync(resolve(f.dir, 'manifest.json'));
    const markdown = readFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'));
    const result = f.call('resolve-stage-confirmation', [f.id, 'analysis', 'revision_requested', scenario === 'empty' ? '' : 'Synthetic user correction']);
    assert.notEqual(result.status, 0, scenario);
    assert.deepEqual(readFileSync(resolve(f.dir, 'manifest.json')), before);
    assert.deepEqual(readFileSync(resolve(f.dir, 'analysis/requirement_analysis.md')), markdown);
  }
});

test('analysis summary preserves exact rules and statuses without inventing coverage or approval',()=>{
  const f=fixture();
  f.ledger.rules.push({...f.ledger.rules[0],id:'QUESTION',kind:'assumption',status:'pending',category:'clarification',reason:'Different interpretations affect the result.'});
  f.ledger.rules.push({...f.ledger.rules[0],id:'OBS',kind:'observation',status:'observed',category:'context',reason:'Material observation, not product inspection.'});
  f.ledger.rules.push({...f.ledger.rules[0],id:'CANDIDATE',kind:'assumption',status:'pending',scope:'out_of_scope',reason:'Unapproved suggestion.'});
  f.save();writeFileSync(resolve(f.dir,'analysis/requirement_analysis.md'),renderAnalysis(f.ledger));
  const before=readFileSync(f.path);
  const summary=analysisSummary(root,f.id);
  assert.deepEqual(summary.groups.requirements,f.ledger.rules.filter(r=>r.kind==='requirement'));
  assert.deepEqual(summary.unresolved_ids,['QUESTION','CANDIDATE']);
  assert.deepEqual(summary.out_of_scope_ids,['CANDIDATE']);
  assert.equal(summary.groups.observations[0].status,'observed');
  assert.equal(summary.counts.assumptions,2);
  assert.equal(Object.hasOwn(summary,'approved'),false);
  assert.ok(summary.evidence.some(e=>e.path==='analysis/requirement-ledger.json' && /^[a-f0-9]{64}$/.test(e.sha256)));
  assert.deepEqual(readFileSync(f.path),before);
});

test('analysis summary rejects divergent Markdown and fabricated citations without rewriting artifacts',()=>{
  const f=fixture();const path=resolve(f.dir,'analysis/requirement_analysis.md');
  writeFileSync(path,'Unexpected independent summary');
  assert.throws(()=>analysisSummary(root,f.id),/differs from ledger/);
  assert.equal(readFileSync(path,'utf8'),'Unexpected independent summary');
  f.ledger.rules[0].citations[0].quote='Invented quote';f.save();
  writeFileSync(path,renderAnalysis(f.ledger));
  assert.throws(()=>analysisSummary(root,f.id),/quote missing/);
});

test('active draft regeneration preserves prior bytes and rejects tampering, foreign dispatch and confirmations',()=>{
  const f=fixture();const manifestPath=resolve(f.dir,'manifest.json');
  const manifest={run_id:f.id,stages:{}};
  manifest.stages.analysis={status:'in_progress'};manifest.confirmations=[];
  manifest.orchestration={events:[{type:'dispatched',stage:'analysis',dispatch_id:'synthetic-dispatch','parent-session-id':'synthetic-parent'}]};
  writeJsonFile(manifestPath,manifest);
  const markdown=resolve(f.dir,'analysis/requirement_analysis.md');unlinkSync(markdown);
  const initial=publishAnalysisDraft(root,f.id,'first','synthetic-parent');
  const oldLedger=readFileSync(f.path);writeFileSync(f.path,'{"draft":"changed"}');
  assert.equal(publishAnalysisDraft(root,f.id,'second','synthetic-parent').revision,1);
  assert.equal(readFileSync(resolve(f.dir,initial.snapshot,'requirement_analysis.md'),'utf8'),'first');
  assert.deepEqual(readFileSync(resolve(f.dir,initial.snapshot,'requirement-ledger.json')),oldLedger);
  assert.throws(()=>publishAnalysisDraft(root,f.id,'third','other-parent'),/owning/);
  for(const status of ['pending','approved','rejected']) {
    manifest.confirmations=[{stage:'analysis',status}];writeJsonFile(manifestPath,manifest);
    assert.throws(()=>publishAnalysisDraft(root,f.id,'third','synthetic-parent'),/confirmation/);
  }
  manifest.confirmations=[];writeJsonFile(manifestPath,manifest);
  writeFileSync(markdown,'manual change');assert.throws(()=>publishAnalysisDraft(root,f.id,'third','synthetic-parent'),/hash mismatch/);
  writeFileSync(markdown,'second');assert.equal(publishAnalysisDraft(root,f.id,'third','synthetic-parent').revision,2);
  assert.equal(publishAnalysisDraft(root,f.id,'fourth','synthetic-parent').revision,3);
  assert.equal(readFileSync(markdown,'utf8'),'fourth');
});
function fixture() {
  const id = `run-provenance-${randomUUID()}`;
  const f = executionInputs(root, id);
  const path = resolve(f.dir, 'analysis/requirement-ledger.json');
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const cases = JSON.parse(readFileSync(f.source, 'utf8'));
  const save = () => { writeJsonFile(path, ledger); writeJsonFile(f.source, cases); };
  const inspect = (execution = true) => inspectDesign({ root, runId: id, source: f.source, execution });
  return { ...f, id, path, ledger, cases, save, inspect };
}
test('reviewed recovery adopts only the exact archived draft into the new dispatch and preserves correction bounds',()=>{
  const f=fixture();const path=resolve(f.dir,'manifest.json');const md='analysis/requirement_analysis.md';
  const archive='audit/revisions/synthetic-reviewed';mkdirSync(resolve(f.dir,archive,'analysis'),{recursive:true});
  const files=[md,'analysis/requirement-ledger.json'].map(p=>{const bytes=readFileSync(resolve(f.dir,p));writeFileSync(resolve(f.dir,archive,p),bytes);return {path:p,sha256:createHash('sha256').update(bytes).digest('hex')};});
  const manifest={run_id:f.id,stages:{analysis:{status:'in_progress'}},confirmations:[],orchestration:{events:[{type:'stage_recovered',stage:'analysis',parent_session_id:'parent',archive,evidence:{sha256:'synthetic-review'},files},{type:'dispatched',stage:'analysis',dispatch_id:'new','parent-session-id':'parent',revision_context:{archive}}]}};
  writeJsonFile(path,manifest);
  const old=readFileSync(resolve(f.dir,md));writeFileSync(resolve(f.dir,md),'unreviewed');
  assert.throws(()=>publishAnalysisDraft(root,f.id,'new draft','parent'),/archive changed/);
  writeFileSync(resolve(f.dir,md),old);
  assert.equal(publishAnalysisDraft(root,f.id,'new draft','parent').revision,0);
  assert.equal(publishAnalysisDraft(root,f.id,'corrected','parent').revision,1);
  assert.deepEqual(readFileSync(resolve(f.dir,archive,md)),old);
});
test('missing legacy ledger blocks without modifying historical files', () => {
  const f = fixture(); unlinkSync(f.path);
  const before = readFileSync(f.source, 'utf8');
  assert.equal(f.inspect().status, 'blocked');
  assert.equal(readFileSync(f.source, 'utf8'), before);
});
test('implementation and historical evidence cannot become normative requirements', () => {
  const f = fixture();
  for (const kind of ['implementation', 'observation', 'historical']) {
    f.ledger.sources[0].kind = kind; f.save();
    assert.match(f.inspect().errors.join(), /normative source/);
  }
});
test('observations are valid analysis evidence but not expected behavior', () => {
  const f = fixture();
  f.ledger.rules.push({ ...f.ledger.rules[0], id: 'OBS', kind: 'observation', status: 'observed', reason: 'Implementation observation only' });
  f.save(); assert.equal(f.inspect().status, 'passed');
  f.cases[0].design_contract.basis[0].rule_id = 'OBS'; f.save();
  assert.match(f.inspect(false).errors.join(), /observation/);
  f.ledger.rules[1].status = 'confirmed'; f.save();
  assert.match(f.inspect(false).errors.join(), /cannot be confirmed/);
});
test('invented quotation, duplicate rules and generated-analysis sources fail', () => {
  for (const mutate of [
    f => { f.ledger.rules[0].citations[0].quote = 'Never present in source'; },
    f => { f.ledger.rules.push(f.ledger.rules[0]); },
    f => { f.ledger.sources[0].path = 'inputs/../analysis/requirement_analysis.md'; },
    f => { f.ledger.rules[0].scope = 'out_of_scope'; f.ledger.rules[0].reason = 'Explicitly excluded'; },
    f => { f.ledger.run_id = 'run-other'; }
  ]) { const f = fixture(); mutate(f); f.save(); assert.equal(f.inspect().status, 'blocked'); }
});

test('quote diagnostics locate the bad citation without changing source or accepting a paraphrase',()=>{
  const f=fixture();
  const sourcePath=resolve(f.dir,f.ledger.sources[0].path);
  const before=readFileSync(sourcePath);
  f.ledger.rules[0].citations[0].quote='A paraphrase absent from the original.';
  f.save();
  const errors=f.inspect().errors.join();
  assert.match(errors,/citation\[0\]/);
  assert.ok(errors.includes(f.ledger.sources[0].path));
  assert.match(errors,/Do not change the source/);
  assert.deepEqual(readFileSync(sourcePath),before);
  f.ledger.rules[0].citations[0].source_id='not-declared';f.save();
  assert.match(f.inspect().errors.join(),/unknown source_id/);
});
test('case cannot promote pending rules, rewrite statements or invent IDs', () => {
  const f = fixture();
  f.ledger.rules[0].status = 'pending'; f.ledger.rules[0].reason = 'Needs user review'; f.save();
  assert.equal(f.inspect(false).status, 'blocked');
  f.cases[0].design_contract.basis[0].status = 'pending'; f.save();
  assert.equal(f.inspect(false).status, 'passed'); assert.equal(f.inspect().status, 'blocked');
  f.cases[0].design_contract.basis[0].rule = 'Must return precise status code'; f.save();
  assert.match(f.inspect(false).errors.join(), /differs/);
  f.cases[0].design_contract.basis[0].rule_id = 'UNKNOWN'; f.save();
  assert.match(f.inspect(false).errors.join(), /unknown rule_id/);
});
test('confirmed assumptions need actual confirmation-typed sources', () => {
  const f = fixture();
  f.ledger.rules.push({ ...f.ledger.rules[0], id: 'ASSUMPTION', kind: 'assumption' });
  f.save(); assert.match(f.inspect().errors.join(), /explicit user confirmation/);
});
test('source and ledger changes invalidate already captured design receipts', () => {
  const f = fixture(); const checked = f.inspect();
  const plan = { run_id: f.id, source: f.source, cases: createExecutionCases(checked.cases), design_gate: designReceipt(checked) };
  assert.deepEqual(validatePlanDesign(root, f.id, plan), []);
  f.ledger.sources[0].locator = 'Changed attribution'; f.save();
  assert.match(validatePlanDesign(root, f.id, plan).join(), /changed/);
});
test('analysis and point contracts enforce ledger and explicit coverage', () => {
  const id = `run-provenance-${randomUUID()}`;
  const f = designArtifacts(root, id);
  assert.equal(inspectStageArtifacts(root, id, 'analysis').status, 'passed');
  const file = resolve(f.dir, 'analysis/requirement-ledger.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  ledger.rules.push({ ...ledger.rules[0], id: 'UNCOVERED' }); writeJsonFile(file, ledger);
  writeFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'), renderAnalysis(ledger));
  assert.match(inspectStageArtifacts(root, id, 'test_points').errors.join(), /missing test point coverage/);
  ledger.sources[0].kind = 'implementation'; writeJsonFile(file, ledger);
  assert.equal(inspectStageArtifacts(root, id, 'analysis').status, 'blocked');
});

test('deterministic analysis includes assumptions, questions, context, exclusions and provenance', () => {
  const f = fixture();
  f.ledger.rules[0].module = 'Synthetic module'; f.ledger.rules[0].category = 'constraint';
  for (const [id, kind, status, scope, category] of [
    ['CONTEXT', 'requirement', 'confirmed', 'in_scope', 'context'],
    ['QUESTION', 'assumption', 'pending', 'in_scope', 'clarification'],
    ['EXCLUDED', 'assumption', 'pending', 'out_of_scope', 'risk'],
    ['OBSERVATION', 'observation', 'observed', 'in_scope', 'environment']
  ]) f.ledger.rules.push({ ...f.ledger.rules[0], id, kind, status, scope, category, statement: id, reason: 'Synthetic unresolved statement' });
  f.save(); assert.equal(f.inspect().status, 'passed');
  const md = renderAnalysis(f.ledger);
  for (const word of ['QUESTION', 'EXCLUDED', 'OBSERVATION', 'pending', 'out\\_of\\_scope', 'Synthetic module', 'clarification', 'context', 'SRC\\-SYNTHETIC']) assert.ok(md.includes(word), word);
  assert.equal(md, renderAnalysis(structuredClone(f.ledger)));
  assert.doesNotThrow(() => assertAnalysisMarkdown(f.ledger, Buffer.from(md.replaceAll('\n', '\r\n'))));
  f.ledger.rules[0].category = 'context'; f.save();
  assert.equal(f.inspect().status, 'blocked');
  assert.match(f.inspect().errors.join('; '), /supporting information/);
});

test('analysis gate blocks independent additions, omissions and changed ledger in analysis and downstream', () => {
  const id = `run-analysis-${randomUUID()}`; const f = designArtifacts(root, id);
  const path = resolve(f.dir, 'analysis/requirement_analysis.md'); const original = readFileSync(path, 'utf8');
  for (const content of [original + '\nUnregistered assumption: unlimited budget', original.replace('Synthetic', 'Other'), original.slice(0, 40)]) {
    writeFileSync(path, content);
    for (const stage of ['analysis', 'test_points', 'test_cases']) assert.match(inspectStageArtifacts(root, id, stage).errors.join(), /Markdown differs/);
  }
  writeFileSync(path, original);
  const ledgerPath = resolve(f.dir, 'analysis/requirement-ledger.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); ledger.rules[0].module = 'New module'; writeJsonFile(ledgerPath, ledger);
  assert.match(inspectStageArtifacts(root, id, 'analysis').errors.join(), /Markdown differs/);
});

test('unknown freeform fields cannot hide content from the generated analysis', () => {
  for (const mutate of [
    f => { f.ledger.assumptions = ['unreviewed']; },
    f => { f.ledger.rules[0].extra = 'hidden rule'; },
    f => { f.ledger.sources[0].notes = 'unrendered'; },
    f => { f.ledger.rules[0].citations[0].interpretation = 'hidden inference'; },
    f => { f.ledger.rules[0].category = 'unsupported'; }
  ]) { const f = fixture(); mutate(f); f.save(); assert.equal(f.inspect().status, 'blocked'); }
});

test('renderer treats source markdown and HTML as literal content', () => {
  const f = fixture();
  f.ledger.rules[0].statement = '# False approval\n<script>alert(1)</script> [execute](https://example.test)';
  const md = renderAnalysis(f.ledger);
  assert.ok(md.includes('\\# False approval<br>&lt;script&gt;'));
  assert.ok(!md.includes('<script>') && !md.includes('\n# False approval'));
  assert.ok(md.includes('\\[execute\\]\\('));
});

test('generator CLI is idempotent and refuses to overwrite old analysis or invalid inputs', () => {
  const f = fixture(); const path = resolve(f.dir, 'analysis/requirement_analysis.md');
  const run = () => spawnSync(process.execPath, ['scripts/generate-analysis-markdown.mjs', f.id], { cwd: root, encoding: 'utf8' });
  unlinkSync(path);
  assert.equal(run().status, 0);
  const original = readFileSync(path, 'utf8'); assert.equal(run().status, 0);
  writeFileSync(path, 'Historical analysis must be preserved');
  assert.notEqual(run().status, 0); assert.equal(readFileSync(path, 'utf8'), 'Historical analysis must be preserved');
  unlinkSync(path); f.ledger.rules[0].citations[0].quote = 'nonexistent excerpt'; f.save();
  assert.notEqual(run().status, 0);
  assert.throws(() => readFileSync(path));
  assert.notEqual(original.length, 0);
});

test('generation never grants approval or removes draft execution restrictions', () => {
  const f = fixture();
  f.ledger.rules[0].status = 'pending'; f.ledger.rules[0].reason = 'Awaiting review';
  f.cases[0].design_contract.basis[0].status = 'pending'; f.save();
  unlinkSync(resolve(f.dir, 'analysis/requirement_analysis.md'));
  const manifest = resolve(f.dir, 'manifest.json'); writeJsonFile(manifest, { run_id: f.id, status: 'revision_requested' });
  const before = readFileSync(manifest, 'utf8');
  const result = spawnSync(process.execPath, ['scripts/generate-analysis-markdown.mjs', f.id], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(manifest, 'utf8'), before);
  assert.equal(inspectStageArtifacts(root, f.id, 'analysis').status, 'passed');
  assert.equal(f.inspect().status, 'blocked');
});
