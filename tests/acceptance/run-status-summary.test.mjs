import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun } from '../../scripts/run-status-summary.mjs';

function fixture(status = 'planned', confirmation = 'after') {
  return { run_id: 'run-summary', status: 'in_progress', stages: { analysis: { status } }, confirmations: [], orchestration: { plan: { stages: [{ id: 'analysis', selected: true, confirmation }] }, events: [] } };
}
const summary = manifest => summarizeRun(JSON.stringify(manifest), 'run-summary');

test('completed workflow explicitly displays blocked execution instead of product success', () => {
  const m = fixture('completed', 'none');
  m.status = 'completed';
  m.orchestration.plan.stages[0].id = 'execution';
  m.stages = { execution: { status: 'completed', execution_outcome: { status: 'blocked', disposition: 'report_only' } } };
  const value = summary(m);
  assert.equal(value.workflow_closed, true);
  assert.equal(value.stages[0].execution_outcome.status, 'blocked');
  assert.match(value.user_summary, /blocked.*report_only/);
});
test('revision state and latest decision override historical completion and approval', () => {
  const m = fixture('revision_requested');
  m.confirmations = [{ stage: 'analysis', status: 'approved' }, { stage: 'analysis', status: 'revision_requested' }];
  m.stages.analysis.reason = 'Needs review';
  m.orchestration.events = [{ stage: 'analysis', type: 'completed' }, { stage: 'analysis', type: 'confirmation_resolved', decision: 'revision_requested' }];
  const before = JSON.stringify(m);
  const s = summary(m);
  assert.equal(s.next_action, 'review_revision_before_dispatch');
  assert.equal(s.workflow_closed, false);
  assert.equal(s.stages[0].confirmation.status, 'revision_requested');
  assert.match(s.user_summary, /Needs review/);
  assert.equal(JSON.stringify(m), before);
});
test('completed without after-approval is not a closed workflow', () => {
  const m = fixture('completed'); m.status = 'completed';
  assert.equal(summary(m).next_action, 'request_confirmation');
  m.confirmations.push({ stage: 'analysis', status: 'approved' });
  assert.equal(summary(m).workflow_closed, true);
  assert.match(summary(m).user_summary, /不代表产品测试通过/);
});
test('pending confirmation and rejected decision retain distinct next actions', () => {
  const m = fixture('awaiting_confirmation'); m.status = 'awaiting_confirmation';
  m.confirmations.push({ stage: 'analysis', status: 'pending' });
  assert.equal(summary(m).next_action, 'wait_for_confirmation');
  m.confirmations[0].status = 'rejected'; m.stages.analysis.status = 'blocked'; m.status = 'blocked';
  assert.equal(summary(m).next_action, 'review_before_recovery');
});
test('preparation completion is not execution completion or authorization', () => {
  const m = fixture('planned', 'before');
  m.orchestration.events.push({ stage: 'analysis', type: 'preparation_completed' });
  assert.equal(summary(m).next_action, 'review_preparation_and_request_confirmation');
  m.confirmations.push({ stage: 'analysis', status: 'approved' });
  assert.equal(summary(m).next_action, 'check_dispatch_readiness');
  assert.equal(summary(m).workflow_closed, false);
});
test('aggregate, audit and pending inconsistencies demand review', () => {
  const m = fixture('completed');
  m.orchestration.events.push({ stage: 'analysis', type: 'blocked' });
  m.confirmations.push({ stage: 'analysis', status: 'pending' });
  assert.equal(summary(m).consistency, 'review_required');
  assert.equal(summary(m).issues.length, 3);
  assert.equal(summary(m).next_action, 'review_manifest_inconsistency');
});
test('no plan, unknown status and duplicate stages cannot claim closure', () => {
  const m = fixture(); m.orchestration.plan.stages = [];
  assert.equal(summary(m).workflow_closed, false);
  const unknown = fixture('invented');
  assert.equal(summary(unknown).consistency, 'review_required');
  unknown.orchestration.plan.stages.push(unknown.orchestration.plan.stages[0]);
  assert.throws(() => summary(unknown), /duplicate/);
});
test('snapshot hash changes with source bytes and rejects wrong run', () => {
  const raw = JSON.stringify(fixture());
  assert.notEqual(summarizeRun(raw, 'run-summary').manifest_sha256, summarizeRun(raw + '\n', 'run-summary').manifest_sha256);
  assert.throws(() => summarizeRun(raw, 'run-other'), /mismatch/);
});
test('out of scope skipped stages do not count as tested; blocked stage takes priority', () => {
  const m = fixture(); m.status = 'failed';
  m.orchestration.plan.stages.push({ id: 'execution', selected: true }, { id: 'report', selected: false });
  m.stages.execution = { status: 'failed' }; m.stages.report = { status: 'skipped' };
  const s = summary(m);
  assert.equal(s.focus_stage, 'execution');
  assert.deepEqual(s.scope, ['analysis', 'execution']);
  assert.match(s.user_summary, /report：skipped；范围外/);
});
