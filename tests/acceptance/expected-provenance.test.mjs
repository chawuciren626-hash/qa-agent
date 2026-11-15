import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectExpectation, smokeEligible, verdictCeiling, applyCeiling,
  auditExpectations, describeExpectationAudit, effectiveState,
} from '../../scripts/expected-source.mjs';
import { ExpectationAuditQueue, describeExpectationHealth } from '../../scripts/expectation-audit.mjs';

const docSource = { type: 'doc', ref: '§3.2', quote: '满 100 元减 10 元' };
const verified = text => ({ text, kind: 'decide', source: docSource, state: 'verified', verified_by: 'human:qa_lead' });
const unverified = text => ({ text, kind: 'decide', source: { type: 'model', ref: 'draft-1', quote: '模型推导' }, state: 'unverified' });

test('a reasoning assertion without a source is refused, while an observation may stand alone', () => {
  assert.throws(() => inspectExpectation({ text: '订单状态为已支付' }), /decide 断言必须有 source/);
  const observed = inspectExpectation({ text: '页面出现成功提示', kind: 'observe' });
  assert.equal(observed.state, 'unverified');
  assert.equal(observed.kind, 'observe');
});

test('model-derived expectations can never certify themselves, and verification needs a human signature', () => {
  assert.throws(() => inspectExpectation({ text: 'x', source: { type: 'model', ref: 'a', quote: 'b' }, state: 'verified', verified_by: 'human:qa' }), /R2/);
  assert.throws(() => inspectExpectation({ text: 'x', source: docSource, state: 'verified' }), /verified 必须由人签字/);
  // agent 给自己发证书：签名前缀不对，直接拒。
  assert.throws(() => inspectExpectation({ text: 'x', source: docSource, state: 'verified', verified_by: 'agent:test_case_agent' }), /verified 必须由人签字/);
  assert.equal(inspectExpectation({ text: 'x', source: docSource, state: 'verified', verified_by: 'human:qa' }).state, 'verified');
});

test('a quote is mandatory: a citation without original text is not a citation', () => {
  assert.throws(() => inspectExpectation({ text: 'x', source: { type: 'doc', ref: '§3.2', quote: '' } }), /quote 必填/);
  assert.throws(() => inspectExpectation({ text: 'x', source: { type: 'doc', ref: '§3.2' } }), /quote 必填/);
});

test('unknown fields are refused instead of silently dropped', () => {
  assert.throws(() => inspectExpectation({ text: 'x', kind: 'observe', confidence: 0.9 }), /未知字段：confidence/);
});

test('all-unverified cases are capped at inconclusive, and drifted counts as unverified', () => {
  const c = { id: 'TC-1', expectations: [unverified('状态为已支付')] };
  assert.equal(verdictCeiling(c).ceiling, 'inconclusive');
  assert.equal(applyCeiling('pass', c).verdict, 'inconclusive');
  assert.equal(applyCeiling('pass', c).downgraded, true);

  const drifted = { id: 'TC-2', expectations: [{ ...verified('状态为已支付'), state: 'drifted' }] };
  assert.equal(effectiveState(drifted.expectations[0]), 'unverified');
  assert.equal(applyCeiling('pass', drifted).verdict, 'inconclusive');
});

test('the ceiling never rescues a failure: fail stays fail', () => {
  const c = { id: 'TC-3', expectations: [verified('状态为已支付')] };
  assert.equal(applyCeiling('fail', c).verdict, 'fail');
  assert.equal(applyCeiling('fail', c).downgraded, false);
});

test('one verified assertion is enough for pass, and a case without reasoning assertions cannot pass', () => {
  const mixed = { id: 'TC-4', expectations: [verified('状态为已支付'), unverified('金额为 90 元')] };
  assert.equal(applyCeiling('pass', mixed).verdict, 'pass');
  const empty = { id: 'TC-5', expectations: [] };
  assert.equal(verdictCeiling(empty).ceiling, 'inconclusive');
  assert.equal(smokeEligible(empty).eligible, false);
});

test('smoke eligibility needs a source on every reasoning assertion and no drifted state', () => {
  assert.equal(smokeEligible({ id: 'A', expectations: [unverified('x')] }).eligible, true);
  assert.equal(smokeEligible({ id: 'B', expectations: [{ text: 'x', kind: 'decide' }] }).eligible, false);
  assert.equal(smokeEligible({ id: 'C', expectations: [{ ...unverified('x'), state: 'drifted' }] }).eligible, false);
});

test('the batch audit reports the share of cases that can support a pass at all', () => {
  const audit = auditExpectations([
    { id: 'TC-1', expectations: [verified('a')] },
    { id: 'TC-2', expectations: [unverified('b')] },
    { id: 'TC-3', expectations: [verified('c'), { text: 'd', kind: 'observe' }] },
    { id: 'TC-4', expectations: [unverified('e')] },
  ]);
  assert.equal(audit.summary.cases, 4);
  assert.equal(audit.summary.verified, 2);
  assert.equal(audit.summary.assertions, 5);
  assert.equal(audit.summary.unverified, 3);
  assert.equal(audit.passEligibleRatio, 0.5);
  assert.deepEqual(audit.blocking.map(row => row.caseId), ['TC-2', 'TC-4']);
  assert.match(describeExpectationAudit(audit), /50%/);
});

test('an agent proposal waits for a human, while a human edit on a human source takes effect at once', () => {
  const queue = new ExpectationAuditQueue();
  const agent = queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: '满100打9折', after: '满100减10', reason: '执行失败，原预期与文档不符', by: 'agent:test_case_agent' });
  assert.equal(agent.status, 'pending');
  const human = queue.propose({ caseId: 'TC-2', assertion: 'expected[0]', before: '显示 90', after: '显示 90.00', reason: '金额格式化规则来自文档第 4 节', by: 'human:qa_lead', sourceType: 'doc' });
  assert.equal(human.status, 'applied');
  assert.equal(queue.pending().length, 1);
});

test('a model-sourced expectation stays pending even when a person proposes the change', () => {
  const queue = new ExpectationAuditQueue();
  const record = queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'b', reason: '模型生成的预期需要复核', by: 'human:qa_lead', sourceType: 'model' });
  assert.equal(record.status, 'pending');
});

test('a change without a real reason or without an actor is refused', () => {
  const queue = new ExpectationAuditQueue();
  assert.throws(() => queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'b', reason: '改', by: 'human:qa' }), /变更理由必填/);
  assert.throws(() => queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'b', reason: '预期与文档不符', by: 'someone' }), /提案人必须是/);
  assert.throws(() => queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'a', reason: '预期与文档不符', by: 'human:qa' }), /没有需要审批的变更/);
});

test('only a person may approve or reject, and the decision must carry a reason', () => {
  const queue = new ExpectationAuditQueue();
  const record = queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'b', reason: '执行失败，原预期与文档不符', by: 'agent:test_case_agent' });
  assert.throws(() => queue.approve(record.proposalId, { by: 'agent:test_case_agent', reason: '我觉得可以' }), /必须由人签字/);
  assert.throws(() => queue.approve(record.proposalId, { by: 'human:qa', reason: '好' }), /批准理由必填/);
  const approved = queue.approve(record.proposalId, { by: 'human:qa', reason: '已核对文档第 3.2 节原文' });
  assert.equal(approved.status, 'approved');
  assert.throws(() => queue.approve(record.proposalId, { by: 'human:qa', reason: '重复批准一次' }), /只能批准待审提案/);
});

test('repeated edits to the same assertion mark the case as drifted', () => {
  const queue = new ExpectationAuditQueue();
  assert.equal(queue.driftedCases().length, 0);
  queue.propose({ caseId: 'TC-1', assertion: 'expected[1]', before: 'a', after: 'b', reason: '第一次修正预期', by: 'human:qa', sourceType: 'doc' });
  assert.equal(queue.driftedCases().length, 0);
  queue.propose({ caseId: 'TC-1', assertion: 'expected[1]', before: 'b', after: 'c', reason: '第二次修正同一条断言', by: 'agent:test_case_agent' });
  const approval = queue.pending()[0];
  queue.approve(approval.proposalId, { by: 'human:qa', reason: '核对后同意第二次修正' });
  const drifted = queue.driftedCases();
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].caseId, 'TC-1');
  assert.equal(drifted[0].assertions[0].changes, 2);
});

test('mass expectation edits block the cycle and point back at the requirement stage', () => {
  const queue = new ExpectationAuditQueue();
  for (const id of ['TC-1', 'TC-2', 'TC-3']) {
    queue.propose({ caseId: id, assertion: 'expected[0]', before: 'a', after: 'b', reason: '预期与文档不符', by: 'human:qa', sourceType: 'doc' });
  }
  // 同一个分子换一个分母，结论就该不同：3/40 = 7.5% 阻塞，3/100 = 3% 放行。
  const tight = queue.assess({ casesInCycle: 40 });
  assert.equal(tight.blocked, true);
  assert.equal(tight.ratio, 0.075);
  assert.match(tight.message, /复核需求阶段/);
  const loose = queue.assess({ casesInCycle: 100 });
  assert.equal(loose.blocked, false);
  assert.match(loose.message, /在 5% 阈值内/);
  // 被驳回的提案不计入分子：否则「提了又撤」也能把整轮拖停。
  const rejected = queue.propose({ caseId: 'TC-9', assertion: 'expected[0]', before: 'a', after: 'b', reason: '这条是误提，待驳回', by: 'agent:test_case_agent' });
  queue.reject(rejected.proposalId, { by: 'human:qa', reason: '核对后确认原预期正确' });
  assert.equal(queue.assess({ casesInCycle: 40 }).changedCases, 3);
  assert.throws(() => queue.assess({}), /casesInCycle 必须是正整数/);
});

test('the queue survives a round trip and keeps pending items pending', () => {
  const queue = new ExpectationAuditQueue();
  queue.propose({ caseId: 'TC-1', assertion: 'expected[0]', before: 'a', after: 'b', reason: '执行失败，原预期与文档不符', by: 'agent:test_case_agent' });
  const restored = ExpectationAuditQueue.fromJSON(JSON.parse(JSON.stringify(queue.toJSON())));
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.toJSON().items[0].proposalId, 'exp_0001');
  const health = restored.health({ casesInCycle: 50 });
  assert.equal(health.pendingCases, 1);
  assert.match(describeExpectationHealth(health), /1 条待审提案/);
});
