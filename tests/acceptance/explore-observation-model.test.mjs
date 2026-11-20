import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPageObservations, buildQuestionsAndRules, dedupeObservations, buildEvidenceBundle,
} from '../../scripts/explore-observation-model.mjs';

test('semantic observation extraction normalizes prices, labels and options with stable hashes', () => {
  const page = '/inventory.html';
  const observations = buildPageObservations(page, {
    prices: [
      { verbatim: '$29.99', context: 'Sauce Labs Backpack', css: null, testid: null },
      { verbatim: 'v2.3.1', context: null, css: null, testid: null },          // 非货币文本不进证据
      { verbatim: '$ 1,299.00', context: null, css: null, testid: null },      // 千分位合法
    ],
    labels: [{ verbatim: 'Username', name: 'user-name', css: '#user-name' }],
    options: [{ verbatim: 'Name (A to Z) | Name (Z to A)', name: 'sort', css: null }],
  });
  const prices = observations.filter((o) => o.kind === 'price');
  assert.equal(prices.length, 2);
  assert.equal(prices[0].verbatim, '$29.99');
  assert.equal(prices[0].normalized, 'price.2999');
  assert.equal(prices[0].context, 'Sauce Labs Backpack');
  assert.equal(prices[0].verification, 'verified');
  assert.equal(prices[1].normalized, 'price.129900');
  const labels = observations.filter((o) => o.kind === 'field_label');
  assert.equal(labels.length, 1);
  assert.deepEqual(labels[0].element.locators, [{ type: 'css', value: '#user-name' }, { type: 'text', value: 'Username' }]);
  const options = observations.filter((o) => o.kind === 'option_list');
  assert.equal(options.length, 1);
  // 内容哈希是身份：同页同内容重复采集得到同一条
  const again = buildPageObservations(page, { prices: [{ verbatim: '$29.99', context: 'Sauce Labs Backpack', css: null, testid: null }], labels: [], options: [] });
  assert.equal(again[0].content_hash, prices[0].content_hash);
  assert.equal(again[0].id, prices[0].id);
});

test('dedupe keeps first occurrence across pages and caps run size', () => {
  const o1 = { id: 'a', page: '/', kind: 'price', verbatim: '$1.00', normalized: 'price.100', element: { locators: [] }, context: null, verification: 'verified', content_hash: 'h1' };
  const o1dup = { ...o1, id: 'a2' };
  const o2 = { id: 'b', page: '/x', kind: 'price', verbatim: '$2.00', normalized: 'price.200', element: { locators: [] }, context: null, verification: 'verified', content_hash: 'h2' };
  const merged = dedupeObservations([o1, o1dup, o2]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'a');
});

test('questions are decidable statements mapped to the hypothesis enum with capped generation', () => {
  const page = '/checkout.html';
  const observations = buildPageObservations(page, {
    prices: [], labels: [{ verbatim: 'First Name', name: 'first-name', css: null }], options: [],
  });
  const { questions } = buildQuestionsAndRules(observations, {
    authenticated: true, pagesOk: 2,
    forms: [{ label: 'Checkout Information', fields: 3, page }],
    selects: [{ label: '配送方式', page }],
    pagination: true,
  });
  assert.ok(questions.some((q) => q.statement === '表单「Checkout Information」各字段的校验规则（必填/格式/长度）未确认' && q.why_unknown === 'business' && q.module_key === page));
  assert.ok(questions.some((q) => q.statement === '登录会话可访问的页面与可执行操作范围未确认' && q.why_unknown === 'role'));
  assert.ok(questions.some((q) => q.statement === '「配送方式」选项与业务结果的联动未确认' && q.why_unknown === 'business'));
  assert.ok(questions.some((q) => q.statement === '列表分页、排序与筛选的业务行为未确认' && q.why_unknown === 'async'));
  for (const q of questions) {
    assert.match(q.id, /^q-[0-9a-f]{16}$/);
    assert.ok(q.statement.length > 0 && q.expectation.length > 0);
  }
  // 公开页模式不产生授权范围问题
  const { questions: publicQuestions } = buildQuestionsAndRules([], { authenticated: false, pagesOk: 1, forms: [], selects: [], pagination: false });
  assert.equal(publicQuestions.length, 0);
});

test('rules require object context: bare prices never become assertions', () => {
  const withContext = buildPageObservations('/p', { prices: [{ verbatim: '$29.99', context: 'Sauce Labs Backpack', css: null, testid: null }], labels: [], options: [] });
  const withoutContext = buildPageObservations('/p', { prices: [{ verbatim: '$9.99', context: null, css: null, testid: null }], labels: [], options: [] });
  const { rules: rulesWithContext } = buildQuestionsAndRules(withContext, { authenticated: false, pagesOk: 1, forms: [], selects: [], pagination: false });
  const { rules: rulesWithoutContext } = buildQuestionsAndRules(withoutContext, { authenticated: false, pagesOk: 1, forms: [], selects: [], pagination: false });
  assert.equal(rulesWithContext.length, 1);
  assert.equal(rulesWithContext[0].statement, '「Sauce Labs Backpack」定价 $29.99（当前版本实测）');
  assert.equal(rulesWithContext[0].verification, 'verified');
  assert.deepEqual(rulesWithContext[0].evidence_ids, [withContext[0].id]);
  assert.equal(rulesWithoutContext.length, 0);
});

test('evidence bundle shape is stable and counts stay honest', () => {
  const observations = buildPageObservations('/p', { prices: [{ verbatim: '$5.00', context: 'Item', css: null, testid: null }], labels: [], options: [] });
  const derived = buildQuestionsAndRules(observations, { authenticated: false, pagesOk: 1, forms: [], selects: [], pagination: false });
  const bundle = buildEvidenceBundle('site', '2026-11-21T00:00:00.000Z', observations, derived.questions, derived.rules);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.mode, 'site');
  assert.equal(bundle.counts.observations, observations.length);
  assert.equal(bundle.counts.questions, derived.questions.length);
  assert.equal(bundle.counts.rules, derived.rules.length);
  assert.deepEqual(Object.keys(bundle).sort(), ['captured_at', 'counts', 'mode', 'observations', 'questions', 'rules', 'version']);
});
