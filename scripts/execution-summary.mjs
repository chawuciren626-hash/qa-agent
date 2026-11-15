import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRunFile } from './design-quality.mjs';
import { buildCeilingIndex, summarizeWithCeilings, describeCeilings } from './execution-verdict.mjs';
import { applyStubPolicy, describeStubPolicy } from './execution-stub.mjs';

/**
 * 执行结果汇总。
 *
 * `caseCatalog` 是可选的用例清单：给了就把预期可信度套到结论上（L-3），
 * 不给就保持原样——**默认不改行为**，因为这条路径被报告、状态页、交付多处共用，
 * 悄悄改语义会让一条已经在跑的报告突然变脸。要收权的地方显式传清单。
 *
 * `stubs` 同理：只有显式传入已声明的外部依赖桩，才把「依赖不可用」判为 inconclusive（P1-5）。
 */
export function executionSummary(dir, manifest, { partial = false, caseCatalog, stubs = null } = {}) {
  const selected = manifest.orchestration?.plan?.execution_branches ?? manifest.orchestration?.plan?.stages?.filter(s => s.selected && ['execution','api_execution'].includes(s.id)).map(s => s.id) ?? [];
  const sources = [], limitations = [], cases = [];
  for (const stage of selected) {
    const path = stage === 'api_execution' ? 'execution/api/test_results.json' : 'execution/test_results.json';
    const dispatch = manifest.orchestration?.events?.filter(e => e.type === 'dispatched' && e.stage === stage).at(-1);
    const state = manifest.stages?.[stage]?.status;
    if (!existsSync(resolve(dir, path))) { limitations.push(`${stage}: no result`); continue; }
    const file = readRunFile(dir, path), value = JSON.parse(file.data);
    if (value.run_id !== manifest.run_id || stage === 'api_execution' && value.dispatch_id !== dispatch?.dispatch_id) throw new Error('Execution summary rejected stale branch identity');
    if (stage === 'execution') {
      const event = manifest.orchestration.events.filter(e => e.type === 'completed' && e.stage === stage && e.dispatch_id === dispatch?.dispatch_id).at(-1);
      const bound = event?.evidence?.artifact_contract?.files?.find(f => f.path === path);
      if (!bound || bound.sha256 !== file.sha256) { limitations.push('execution: unsealed UI result'); continue; }
    }
    if (!value.finished_at || !['completed','failed','blocked','cancelled'].includes(state) && stage !== 'api_execution') limitations.push(`${stage}: running or waiting`);
    if (value.status === 'partial') limitations.push(`${stage}: partial scope`);
    sources.push({ stage, path, sha256: file.sha256, dispatch_id: dispatch?.dispatch_id, status: value.status, statistics: value.statistics ?? null });
    for (const row of value.cases ?? []) cases.push({ ...row, source_branch: stage, source_path: path, source_sha256: file.sha256 });
  }
  const terminal = sources.length === selected.length && sources.every(s => JSON.parse(readRunFile(dir,s.path).data).finished_at);
  if (!partial && !terminal) throw new Error('Selected execution branches are not terminal; only a requested partial snapshot is available');
  // 套上限时 cases 与 summary 都换成收权后的口径；不套时与原实现逐字段一致。
  const verdict = Array.isArray(caseCatalog) && caseCatalog.length
    ? summarizeWithCeilings(cases, buildCeilingIndex(caseCatalog))
    : null;
  const rows = verdict ? verdict.cases : cases;
  // 外部依赖不可用 → inconclusive（P1-5）。只有显式传入声明才生效，否则原样返回。
  const stubPolicy = Array.isArray(stubs) ? applyStubPolicy(rows, { stubs }) : null;
  const finalRows = stubPolicy ? stubPolicy.cases : rows;
  const recount = list => ({
    total: list.length,
    ...Object.fromEntries(['passed', 'failed', 'blocked', 'skipped', 'inconclusive'].map(status => [status, list.filter(item => item.status === status).length])),
    ...(verdict ? { downgraded: verdict.summary.downgraded, expectation_unknown: verdict.summary.expectation_unknown } : {}),
  });
  return { version: 1, run_id: manifest.run_id, snapshot_at: new Date().toISOString(), status: terminal && !limitations.length ? 'completed' : 'partial', selected_branches: selected, sources, limitations, cases: finalRows, summary: stubPolicy ? recount(finalRows) : (verdict ? { total: rows.length, ...verdict.summary } : { total: cases.length, ...Object.fromEntries(['passed','failed','blocked','skipped'].map(s => [s,cases.filter(c => c.status === s).length])) }),
    ...(verdict ? {
      expectations: {
        applied: true,
        pass_rate: verdict.passRate,
        // 不套上限时会是的样子：并排给出来，「差一点报出去的那个数」才看得见。
        inflated_pass_rate: verdict.inflatedPassRate,
        downgraded: verdict.downgraded,
        unmatched: verdict.unmatched,
        note: describeCeilings(verdict),
      },
    } : { expectations: { applied: false, note: '未提供用例清单，执行结论未做预期可信度收权。' } }),
    ...(stubPolicy ? {
      stubs: {
        applied: true,
        declared: stubPolicy.declared,
        downgraded: stubPolicy.downgraded,
        kept_fail: stubPolicy.kept_fail,
        note: describeStubPolicy(stubPolicy),
      },
    } : { stubs: { applied: false, note: '未提供外部依赖桩声明，环境类失败会照常计为产品失败。' } }) };
}
