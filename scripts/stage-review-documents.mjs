// Human-readable views derived from the same structured evidence used by the stage contract.
import { mkdirSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readRunFile } from './design-quality.mjs';

export const reviewDocumentPaths = {
  test_points: 'design/test_points.md',
  execution: 'execution/test_brief.md',
  api_execution: 'execution/api/test_brief.md',
};
const plain = value => value == null ? '' : Array.isArray(value) ? value.map(plain).join('、') : typeof value === 'object' ? JSON.stringify(value) : String(value);
const escape = value => plain(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
const field = (label, value) => value == null || plain(value) === '' ? '' : `**${label}：** ${escape(value)}\n\n`;
const states = { passed:'通过', failed:'失败', blocked:'受阻', skipped:'未执行', partial:'部分完成', completed:'已完成', unknown:'未知' };

export function renderStageReview(stage, readJson) {
  if (stage === 'test_points') {
    const data = readJson('design/test_points.json');
    const rows = Array.isArray(data) ? data : data.points ?? data.test_points;
    if (!Array.isArray(rows) || !rows.length) throw Error('没有可展示的测试点');
    return `# 测试点分析\n\n共 ${rows.length} 个测试点。\n\n` + rows.map(row =>
      `## ${escape(row.id)} · ${escape(row.module)} / ${escape(row.feature)}\n\n` +
      field('测试点', row.description) + field('优先级', row.priority) + field('测试方法', row.design_method ?? row.method) +
      field('风险', row.risk) + field('覆盖类型', row.coverage_type) + field('来源', row.source) + field('关联规则', row.rule_ids) +
      field('预期结果', row.expected) + field('依据与规则', row.design_contract ?? row.basis) +
      field('待澄清问题', row.questions) + field('限制', row.limitations)).join('');
  }
  if (!['execution','api_execution'].includes(stage)) return '';
  const source = stage === 'api_execution' ? 'execution/api/test_results.json' : 'execution/test_results.json';
  const result = readJson(source) ?? (stage === 'execution' ? readJson('execution/execution-blocked.json') : null);
  if (!result || !Array.isArray(result.cases) || !result.summary) throw Error('执行结果不完整');
  const summary = result.summary;
  const task = readJson(stage === 'api_execution' ? 'execution/api/task.json' : 'execution/execution-task.json');
  const coverage = stage === 'execution' ? readJson('execution/browser-coverage.json') : null;
  let output = `# ${stage === 'api_execution' ? '接口自动化' : '自动化'}测试简报\n\n` +
    field('运行', result.run_id) + field('执行状态', states[result.status] ?? result.status ?? '未记录') +
    `## 执行统计\n\n共 ${summary.total ?? result.cases.length} 条；通过 ${summary.passed ?? 0}，失败 ${summary.failed ?? 0}，受阻 ${summary.blocked ?? 0}，未执行 ${summary.skipped ?? 0}。\n\n` +
    field('结果来源', result.result_origin) + field('未完成原因', result.reason ?? result.block_reason) +
    field('阶段结论', task?.summary) + field('待澄清问题', task?.questions) + field('执行限制', task?.limitations ?? result.limitations) + field('未完整执行用例', coverage?.incomplete_cases ?? coverage?.untested_cases) + field('待核查操作', result.unknown_operations ?? result.unknown_resources) +
    '## 逐条结果\n\n';
  for (const row of result.cases) output += `### ${escape(row.case_id)} · ${escape(row.title ?? row.name ?? '')}\n\n` +
    field('结果', states[row.status] ?? row.status) + field('预期', row.expected) +
    field('实际结果', row.actual_result ?? row.error_message ?? row.reason ?? row.verdict_reason) +
    field('断言', row.assertions) + field('证据模式', row.evidence_mode) + field('结果待核查', row.result_unknown === true ? '是' : null) + field('证据文件', row.evidence_paths);
  return output;
}

// Called only after the originating stage contract has passed, while holding the run lock.
export function writeStageReviewDocument(dir, stage, receipt) {
  const relative = reviewDocumentPaths[stage];
  if (!relative || receipt.mode === 'prepare') return null;
  const markdown = renderStageReview(stage, file => {
    const source = receipt.files.find(item => item.path === file);
    if (!source) return null;
    const actual = readRunFile(dir, file);
    if (source.sha256 !== actual.sha256) throw Error('简报来源不在本次已校验产物中');
    return JSON.parse(actual.data);
  });
  const target = resolve(dir, relative);
  if (realpathSync(dirname(target)) !== resolve(realpathSync(dir), dirname(relative)) || existsSync(target) && lstatSync(target).isSymbolicLink()) throw Error('简报目标路径已重定向');
  // readRunFile checks existing paths, including symbolic links, before overwriting.
  try { readRunFile(dir, relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown, 'utf8');
  const generated = readRunFile(dir, relative);
  receipt.files = [...receipt.files.filter(file => file.path !== relative), { path: relative, sha256: generated.sha256 }].sort((a,b) => a.path.localeCompare(b.path));
  return relative;
}
