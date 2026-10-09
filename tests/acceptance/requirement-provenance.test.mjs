import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executionInputs, writeJsonFile } from './safety-fixtures.mjs';
import { designArtifacts } from './artifact-fixtures.mjs';
import { inspectDesign, designReceipt, validatePlanDesign } from '../../scripts/design-quality.mjs';
import { inspectStageArtifacts } from '../../scripts/artifact-contracts.mjs';
import { createExecutionCases } from '../../scripts/execution-plan.mjs';
import { renderAnalysis, assertAnalysisMarkdown } from '../../scripts/analysis-markdown.mjs';

const root = resolve(import.meta.dirname, '../..');
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
  f.ledger.rules[0].module = 'Synthetic module'; f.ledger.rules[0].category = 'context';
  for (const [id, kind, status, scope, category] of [
    ['QUESTION', 'assumption', 'pending', 'in_scope', 'clarification'],
    ['EXCLUDED', 'assumption', 'pending', 'out_of_scope', 'risk'],
    ['OBSERVATION', 'observation', 'observed', 'in_scope', 'environment']
  ]) f.ledger.rules.push({ ...f.ledger.rules[0], id, kind, status, scope, category, statement: id, reason: 'Synthetic unresolved statement' });
  f.save(); assert.equal(f.inspect().status, 'passed');
  const md = renderAnalysis(f.ledger);
  for (const word of ['QUESTION', 'EXCLUDED', 'OBSERVATION', 'pending', 'out\\_of\\_scope', 'Synthetic module', 'clarification', 'context', 'SRC\\-SYNTHETIC']) assert.ok(md.includes(word), word);
  assert.equal(md, renderAnalysis(structuredClone(f.ledger)));
  assert.doesNotThrow(() => assertAnalysisMarkdown(f.ledger, Buffer.from(md.replaceAll('\n', '\r\n'))));
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
