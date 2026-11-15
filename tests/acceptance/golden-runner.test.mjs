import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  checkSample, summarize, compareToBaseline, runSuite, loadSuite, listPoints,
  recordBaseline, normalizeText, DEFAULT_FORBIDDEN_FIELDS,
} from '../../scripts/golden-runner.mjs';

const root = resolve(import.meta.dirname, '../..');

function sample(overrides = {}) {
  return {
    id: 'S1',
    input: { text: '预算必须是非负整数，负数不得保存' },
    expect: { required: ['items'], items_path: 'items', expected_count: 1, must_include: ['预算'], must_not_include: ['折扣'] },
    recorded_output: { items: [{ statement: '预算必须是非负整数', source: { quote: '预算必须是非负整数' } }] },
    ...overrides,
  };
}

test('全部满足时 ok，六类计数全 0', () => {
  const s = sample();
  const result = checkSample(s, s.recorded_output);
  assert.equal(result.ok, true);
  assert.deepEqual(result.metrics, { schema_invalid: 0, count_out_of_range: 0, missing_keyword: 0, hallucination: 0, broken_citation: 0, unauthorized_field: 0 });
});

test('无输出直接判结构非法，不继续解引用', () => {
  const result = checkSample(sample(), null);
  assert.equal(result.ok, false);
  assert.equal(result.metrics.schema_invalid, 1);
});

test('缺必需字段被抓住', () => {
  const result = checkSample(sample(), { points: [] });
  assert.equal(result.metrics.schema_invalid, 1);
  assert.match(result.problems[0].detail, /items/);
});

test('空数组不算缺字段：空输入下的空输出是合法结果', () => {
  const s = sample({ expect: { required: ['items'], items_path: 'items', expected_count: 0, check_citations: false } });
  assert.equal(checkSample(s, { items: [] }).ok, true);
});

test('条目数量超出 0.7~1.3 倍被抓住：漏抽与幻觉膨胀是两种病', () => {
  const s = sample({ expect: { required: ['items'], items_path: 'items', expected_count: 10, check_citations: false } });
  const tooFew = checkSample(s, { items: Array(3).fill({}) });
  const tooMany = checkSample(s, { items: Array(20).fill({}) });
  assert.equal(tooFew.metrics.count_out_of_range, 1);
  assert.equal(tooMany.metrics.count_out_of_range, 1);
  assert.match(tooFew.problems[0].detail, /超出 \[7, 13\]/);
});

test('必含关键词缺失被抓住', () => {
  const s = sample({ recorded_output: { items: [{ statement: '随便写点别的', source: { quote: '负数不得保存' } }] } });
  const result = checkSample(s, s.recorded_output);
  assert.equal(result.metrics.missing_keyword, 1);
});

test('不得含关键词被抓住——这是幻觉最直接的信号', () => {
  const s = sample({ recorded_output: { items: [{ statement: '预算必须是非负整数并支持折扣', source: { quote: '预算必须是非负整数' } }] } });
  const result = checkSample(s, s.recorded_output);
  assert.equal(result.metrics.hallucination, 1);
  assert.match(result.problems[0].detail, /输入中不存在/);
});

test('引用无法反查原文被抓住（编造原文位置）', () => {
  const s = sample({ recorded_output: { items: [{ statement: '预算必须是非负整数', source: { quote: '预算可以是负数' } }] } });
  const result = checkSample(s, s.recorded_output);
  assert.equal(result.metrics.broken_citation, 1);
});

test('极短引用不做子串比对：单字命中没有意义，只会制造假阳性', () => {
  const s = sample({ recorded_output: { items: [{ statement: '预算必须是非负整数', source: { quote: '预算' } }] } });
  assert.equal(checkSample(s, s.recorded_output).metrics.broken_citation, 0);
});

test('越权字段被抓住：agent 不许自己写 verdict / approved_by', () => {
  const s = sample({ recorded_output: { items: [{ statement: '预算必须是非负整数', source: { quote: '预算必须是非负整数' }, verdict: 'passed' }] } });
  const result = checkSample(s, s.recorded_output);
  assert.equal(result.metrics.unauthorized_field, 1);
  assert.ok(DEFAULT_FORBIDDEN_FIELDS.includes('verdict'));
});

test('引用检查可在样本上关闭（无原文可反查的场景）', () => {
  const s = sample({ expect: { required: ['items'], items_path: 'items', expected_count: 1, check_citations: false }, recorded_output: { items: [{ statement: '预算', source: { quote: '编的' } }] } });
  assert.equal(checkSample(s, s.recorded_output).metrics.broken_citation, 0);
});

test('文本归一化让全角/半角/标点差异不误判', () => {
  assert.equal(normalizeText('预算（必须）是非负整数。'), normalizeText('预算(必须)是非负整数'));
});

test('汇总给出计数与比例：趋势靠比例，不靠绝对数', () => {
  const s = sample();
  const results = [
    checkSample(s, s.recorded_output),
    checkSample(s, { items: [{ statement: '预算必须是非负整数并支持折扣', source: { quote: '预算必须是非负整数' } }] }),
  ];
  const summary = summarize(results);
  assert.equal(summary.samples, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.rates.hallucination, 0.5);
});

test('没有基线时 verdict=no_baseline，不是 pass：第一次跑不是合格证', () => {
  const result = compareToBaseline({ rates: { hallucination: 0 } }, null);
  assert.equal(result.verdict, 'no_baseline');
  assert.match(result.note, /不代表质量通过/);
});

test('错误率上升超过容差才算退化；单条失败不算', () => {
  const baseline = { rates: { hallucination: 0, missing_keyword: 0.1 } };
  assert.equal(compareToBaseline({ rates: { hallucination: 0.05, missing_keyword: 0.12 } }, baseline).verdict, 'pass');
  const bad = compareToBaseline({ rates: { hallucination: 0.3, missing_keyword: 0.1 } }, baseline);
  assert.equal(bad.verdict, 'regression');
  assert.equal(bad.regressions[0].metric, 'hallucination');
  assert.match(bad.note, /不允许「先合再修」/);
});

test('真实样本集可加载并通过：两个 ready 点的录制输出必须自洽', () => {
  for (const task of ['requirement_extract', 'testpoint_fill']) {
    const suite = loadSuite(root, task);
    assert.ok(suite, `${task} 样本应存在`);
    assert.ok(suite.samples.length >= 6);
    for (const item of suite.samples) {
      const result = checkSample(item, item.recorded_output);
      assert.equal(result.ok, true, `${task}/${item.id} 录制输出不满足自身断言：${JSON.stringify(result.problems)}`);
    }
  }
});

test('runSuite 回放模式跑通，且未记基线时 verdict=no_baseline', async () => {
  const result = await runSuite(root, 'requirement_extract');
  assert.equal(result.available, true);
  assert.equal(result.mode, 'replay');
  assert.equal(result.failed, 0);
  assert.equal(result.verdict, 'no_baseline');
});

test('produce 注入失败输出时能抓到问题（框架真的在判，不是摆设）', async () => {
  const result = await runSuite(root, 'requirement_extract', { produce: () => ({ items: [{ statement: '折扣', source: { quote: '不存在的原文内容' } }] }) });
  assert.equal(result.mode, 'live');
  assert.ok(result.failed > 0);
  assert.ok(result.metrics.hallucination > 0 || result.metrics.broken_citation > 0 || result.metrics.missing_keyword > 0);
});

test('登记表：8 个点，未登记的不算已覆盖', () => {
  const index = listPoints(root);
  assert.equal(index.points.length, 8);
  const ready = index.points.filter(point => point.status === 'ready');
  assert.ok(ready.length >= 2);
  assert.ok(index.points.some(point => point.status === 'pending'));
});

test('基线可落盘并被后续比较使用', async () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'qa-golden-'));
  try {
    mkdirSync(resolve(temp, 'tests/golden/demo'), { recursive: true });
    writeFileSync(resolve(temp, 'tests/golden/index.json'), JSON.stringify({ version: 1, points: [{ task: 'demo', status: 'ready' }] }));
    writeFileSync(resolve(temp, 'tests/golden/demo/samples.json'), JSON.stringify([sample()]));
    const first = await runSuite(temp, 'demo');
    assert.equal(first.verdict, 'no_baseline');
    recordBaseline(temp, 'demo', first);
    assert.ok(existsSync(resolve(temp, 'tests/golden/demo/baseline.json')));
    const second = await runSuite(temp, 'demo');
    assert.equal(second.verdict, 'pass');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
