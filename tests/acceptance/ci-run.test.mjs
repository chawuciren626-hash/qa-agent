import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTap, toJUnit, SUITES } from '../../scripts/ci-run.mjs';

const root = resolve(import.meta.dirname, '../..');

const TAP = `TAP version 13
# Subtest: 闸门拦住停用工具
ok 1 - 闸门拦住停用工具
  ---
  duration_ms: 1.5
  ...
# Subtest: 闸门放行启用工具
ok 2 - 闸门放行启用工具
  ---
  duration_ms: 0.4
  ...
# Subtest: 结论合成不吃预期上限
not ok 3 - 结论合成不吃预期上限
  ---
  duration_ms: 12.25
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    + 'passed'
    - 'inconclusive'
  ...
1..3
# tests 3
# suites 0
# pass 2
# fail 1
`;

test('TAP 解析：通过/失败/耗时/错误正文都能拿到', () => {
  const parsed = parseTap(TAP);
  assert.equal(parsed.declared_total, 3);
  assert.equal(parsed.cases.length, 3);
  assert.equal(parsed.cases[0].ok, true);
  assert.equal(parsed.cases[2].ok, false);
  assert.equal(parsed.cases[2].duration_ms, 12.25);
  assert.match(parsed.cases[2].error, /inconclusive/);
});

test('JUnit 根节点合法，计数与用例一致', () => {
  const xml = toJUnit(parseTap(TAP), { suite: 'smoke' });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites name="aitest-smoke" tests="3" failures="1"/);
  assert.match(xml, /<testsuite name="smoke" tests="3" failures="1"/);
  assert.equal((xml.match(/<testcase /g) ?? []).length, 3);
  assert.equal((xml.match(/<failure /g) ?? []).length, 1);
});

test('XML 转义：用例名里的尖括号与引号不能把 XML 弄坏', () => {
  const parsed = parseTap('ok 1 - a < b & "c"\n# tests 1\n');
  const xml = toJUnit(parsed);
  assert.ok(!/name="a < b/.test(xml));
  assert.match(xml, /a &lt; b &amp; &quot;c&quot;/);
});

test('控制字符被清掉：CI 解析器遇到会直接报错', () => {
  const parsed = parseTap('ok 1 - bad\u0007name\n# tests 1\n');
  const xml = toJUnit(parsed);
  assert.ok(!xml.includes('\u0007'));
});

test('重复用例名去重：node 的 Subtest 行会重复计数', () => {
  const parsed = parseTap('ok 1 - x\nok 2 - x\n# tests 2\n');
  assert.equal(parsed.cases.length, 1);
});

test('空 TAP 不崩，产出 0 条的空套件', () => {
  const xml = toJUnit(parseTap(''));
  assert.match(xml, /tests="0"/);
});

test('smoke 套件登记的文件都存在：CI 里指一个不存在的文件是最常见的翻车方式', () => {
  for (const file of SUITES.smoke) assert.ok(existsSync(resolve(root, file)), `缺少 ${file}`);
});
