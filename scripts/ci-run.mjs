/**
 * CI 入口（P2-3 落地，对应 §25.3）。
 *
 * 企业采购第一问通常是「能不能接我们的流水线」。答不上来的原因不是没接口，
 * 而是**没有标准输出**：JUnit XML 是 Jenkins/GitLab/GitHub Actions 的通用语言，
 * 没有它，CI 里就只能看到一个退出码，看不到「哪条用例挂了」。
 *
 * 所以这里做两件事，不做第三件：
 *
 * 1. 定义 `smoke` 套件（一组跑得快、失败要立刻拦的动作）；
 * 2. 把 TAP 输出翻成 JUnit XML。
 *
 * **不做**「一条命令跑完整条测试流水线」的产品化 CLI——那是另一件事，
 * 塞进来会让这个入口变成一个半成品。
 *
 * 一条纪律：**`smoke` 不等于「业务冒烟用例集」**。它是我这本仓的工程冒烟集
 * （结构契约、闸门、结论合成跑得通）。业务冒烟集属 §13.3，是另一套东西。
 * 名字容易混，注释里写清楚，报告里也写清楚。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 工程冒烟集：改坏了这里，说明主干断了。
 *
 * 只收「跑得快 + 失败必须拦」的：全部加起来应在 1 分钟内跑完。
 * 全量 `all` 留给夜间，CI 的每次提交只跑这个。
 */
export const SUITES = {
  smoke: [
    'tests/acceptance/tool-gate.test.mjs',
    'tests/acceptance/stage-tool-scenarios.test.mjs',
    'tests/acceptance/trace.test.mjs',
    'tests/acceptance/execution-verdict.test.mjs',
    'tests/acceptance/expected-provenance.test.mjs',
    'tests/acceptance/artifact-contracts.test.mjs',
    'tests/acceptance/partial-submit.test.mjs',
    'tests/acceptance/regression-sampling.test.mjs',
    'tests/acceptance/defect-cluster.test.mjs',
    'tests/acceptance/requirement-completeness.test.mjs',
    'tests/acceptance/release-probe.test.mjs',
    'tests/acceptance/golden-runner.test.mjs',
    'tests/acceptance/execution-stub.test.mjs',
    'tests/acceptance/coverage-split.test.mjs',
    'tests/acceptance/consistency-report.test.mjs',
    'tests/acceptance/data-lifecycle.test.mjs',
    'tests/acceptance/confirm-gate.test.mjs',
  ],
};

function xmlEscape(value) {
  return String(value ?? '')
    // XML 1.0 不允许的控制字符：不清掉会让 CI 解析器直接报错
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 解析 TAP。
 *
 * 只认 `ok/not ok` 行与紧随其后的 `duration_ms` / `error` 块——**不追求 TAP 全量兼容**。
 * 解析器写得越"完整"，越容易在 node 换输出格式时悄悄错位，那时 CI 会显示"全绿"。
 * 所以另有一条保险：解析出的用例数必须与 TAP 末尾 `# tests N` 对齐，对不上就报错。
 */
export function parseTap(text) {
  const lines = String(text ?? '').split('\n');
  const cases = [];
  let declaredTotal = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const total = line.match(/^# tests (\d+)$/);
    if (total) { declaredTotal = Number(total[1]); continue; }
    const match = line.match(/^(not ok|ok) (\d+) - (.+)$/);
    if (!match) continue;
    const testCase = { name: match[3].trim(), ok: match[1] === 'ok', duration_ms: null, error: null };
    // 向后吞掉这个用例的附注块，直到下一个 ok/not ok 或文件结束
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^(not ok|ok) \d+ - /.test(lines[j]) || /^# tests /.test(lines[j])) break;
      const duration = lines[j].match(/^\s+duration_ms:\s*([\d.]+)/);
      if (duration) testCase.duration_ms = Number(duration[1]);
      const errorLine = lines[j].match(/^\s+error:\s*\|-?\s*$/);
      if (errorLine) {
        const body = [];
        for (let k = j + 1; k < lines.length; k += 1) {
          if (!/^\s{4,}/.test(lines[k]) && lines[k].trim()) break;
          body.push(lines[k].replace(/^\s{4}/, ''));
        }
        testCase.error = body.join('\n').trim() || null;
      }
    }
    // 子测试（# Subtest:）会重复计数，用名字去重
    if (!cases.some(item => item.name === testCase.name)) cases.push(testCase);
  }
  return { cases, declared_total: declaredTotal };
}

/**
 * TAP → JUnit。
 *
 * `testsuites` 根节点是 GitLab / GitHub Actions / Jenkins 都能吃的结构。
 * `skipped` 不单独生成：本仓的跳过一律视作通过（没有 `todo`），
 * 真出现 skipped 会体现在用例数对不上，而不是被悄悄吞掉。
 */
export function toJUnit(parsed, { suite = 'smoke', timestamp = new Date().toISOString() } = {}) {
  const cases = parsed.cases ?? [];
  const failures = cases.filter(item => !item.ok);
  const totalTime = cases.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0) / 1000;
  const body = cases.map(item => {
    const time = ((item.duration_ms ?? 0) / 1000).toFixed(3);
    if (item.ok) return `    <testcase classname="aitest.${xmlEscape(suite)}" name="${xmlEscape(item.name)}" time="${time}"/>`;
    const message = (item.error ?? 'failed').split('\n')[0].slice(0, 300);
    return [
      `    <testcase classname="aitest.${xmlEscape(suite)}" name="${xmlEscape(item.name)}" time="${time}">`,
      `      <failure message="${xmlEscape(message)}" type="AssertionError">${xmlEscape(item.error ?? '')}</failure>`,
      '    </testcase>',
    ].join('\n');
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="aitest-${xmlEscape(suite)}" tests="${cases.length}" failures="${failures.length}" errors="0" time="${totalTime.toFixed(3)}" timestamp="${xmlEscape(timestamp)}">`,
    `  <testsuite name="${xmlEscape(suite)}" tests="${cases.length}" failures="${failures.length}" errors="0" skipped="0" time="${totalTime.toFixed(3)}">`,
    body,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].filter(Boolean).join('\n');
}

/** 跑一套并返回结构化结果（CLI 与编排层共用）。 */
export function runSuite(root, { suite = 'smoke', files = null, timeoutMs = 900_000 } = {}) {
  const selected = files?.length ? files : SUITES[suite];
  if (!selected?.length) throw new Error(`未知套件 ${suite}；可选：${Object.keys(SUITES).join('/')}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['scripts/run-engineering-tests.mjs', ...selected], {
    cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const parsed = parseTap(stdout);
  const elapsed = Date.now() - started;

  // 保险：解析出来的条数必须与 TAP 自报的总数一致。对不上时宁可报错，也不出一个「全绿」的假 XML。
  if (parsed.declared_total !== null && parsed.cases.length !== parsed.declared_total) {
    return {
      status: 'parse_mismatch',
      exit_code: result.status ?? 1,
      suite, files: selected,
      parsed: parsed.cases.length,
      declared: parsed.declared_total,
      message: `TAP 解析出 ${parsed.cases.length} 条，TAP 自报 ${parsed.declared_total} 条。拒绝生成 JUnit——对不上的 XML 会让 CI 显示假绿。`,
      stdout: stdout.slice(-4000), stderr: stderr.slice(-2000),
      elapsed_ms: elapsed,
    };
  }
  const failed = parsed.cases.filter(item => !item.ok);
  return {
    status: (result.status ?? 1) === 0 && !failed.length ? 'passed' : 'failed',
    exit_code: result.status ?? 1,
    suite,
    files: selected,
    tests: parsed.cases.length,
    failures: failed.length,
    failed_cases: failed.map(item => ({ name: item.name, error: (item.error ?? '').split('\n')[0] })),
    elapsed_ms: elapsed,
    parsed,
    stderr: stderr.slice(-2000),
  };
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/ci-run.mjs [--suite=smoke] [--junit=<path>]        */
/* ------------------------------------------------------------------ */

function main() {
  const root = resolve(import.meta.dirname, '..');
  const suite = process.argv.find(arg => arg.startsWith('--suite='))?.slice(8) ?? 'smoke';
  const junitArg = process.argv.find(arg => arg.startsWith('--junit='))?.slice(8) ?? null;
  const result = runSuite(root, { suite });
  const paths = [];
  if (result.status === 'parse_mismatch') {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }
  const junitPath = junitArg ? resolve(root, junitArg) : resolve(root, 'output/ci', `junit-${suite}.xml`);
  mkdirSync(dirname(junitPath), { recursive: true });
  writeFileSync(junitPath, toJUnit(result.parsed, { suite }));
  paths.push(junitPath);
  const { parsed, ...summary } = result;
  console.log(JSON.stringify({ ...summary, junit: junitPath }, null, 2));
  process.exitCode = result.exit_code === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
