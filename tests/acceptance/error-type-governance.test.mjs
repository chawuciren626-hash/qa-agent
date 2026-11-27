import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const engine = resolve(import.meta.dirname, '../..');
const source = name => readFileSync(resolve(engine, 'scripts', name), 'utf8');

// Caller-facing entries whose rejections are all correctable input/state errors.
// A bare Error here is classified runner_error/script_failure by the receipt layer
// and can latch the controller session stopped; the type is the contract, not prose.
const FULLY_TYPED = ['project-action.mjs', 'api-snapshot.mjs', 'draft-records.mjs', 'resolve-stage-confirmation.mjs', 'request-stage-confirmation.mjs'];

test('caller-facing CLI and confirmation entries express correctable errors with CommandUsageError', () => {
  for (const name of FULLY_TYPED) {
    assert.doesNotMatch(source(name), /throw new Error\(/, `${name} expresses a correctable rejection as bare Error; migrate it to CommandUsageError`);
  }
});

test('post-eligibility revision guards are typed; eligibility rejections stay deliberate bare Errors', () => {
  const text = source('draft-stage-revision.mjs');
  assert.match(text, /throw new CommandUsageError\('Revision directory redirected'\)/);
  assert.match(text, /throw new CommandUsageError\('Draft changed during revision snapshot; working files preserved'\)/);
  // Ratchet: the remaining bare throws are inspectDraftRevision's eligibility rejections,
  // which its caller converts to `ineligible` by design. A changed count means a new
  // throw landed here — review whether it is correctable and migrate it before updating.
  assert.equal([...text.matchAll(/throw new Error\(/g)].length, 10);
});

test('analysis-draft tamper guards stay fatal bare Errors, ownership rejections stay typed', () => {
  const text = source('analysis-draft.mjs');
  assert.match(text, /throw new CommandUsageError\('Draft update requires the owning active analysis dispatch/);
  assert.match(text, /throw new CommandUsageError\('Existing analysis has no controlled generation snapshot/);
  // Archive/hash/redirect inconsistencies are engineering faults, not caller-correctable
  // input: they must remain runner_error so a tampered state stops instead of retrying.
  for (const message of ['Analysis directory must not redirect writes', 'Reviewed draft archive changed', 'Previous analysis snapshot changed', 'Generation archive must not redirect writes']) {
    assert.ok(text.includes(`throw new Error('${message}')`), message);
  }
});