#!/usr/bin/env node
/**
 * 数据生命周期纪律（v3 §9.4，评审 P1-6）
 *
 * 问题描述：上一轮建的订单留在库里，下一轮查「最新一笔」查到脏数据——
 * 测试数据只建不清，用例越跑越脏，而且脏数据造成的失败会被误判为产品缺陷。
 *
 * 三条硬纪律（方案原文）：
 *   1. `data/` 里每个数据集除内容外，必须声明 `setup` 与 `teardown`；
 *      执行前按 setup 造数，执行后必跑 teardown；清理失败必须进报告
 *      （`data_residue: [...]`），不许静默。
 *   2. 未声明 teardown 的数据集只允许只读用途（查、比对），不允许增删改。
 *   3. 跨轮共用的基础数据标 `persistent: true` 并纳入建档，与用例级
 *      临时数据严格分开——persistent 数据不许被用例级步骤增删改。
 *
 * 与全仓口径一致：
 *   - 「不知道」是可输出结论：step 是否有写语义判不出来时归入 unknown_mutation
 *     正面列出，不冒充只读，也不冒充违规。
 *   - 失败要留痕：data_residue 由调用方（执行器）传入 teardown 结果汇总而来，
 *     本模块只做判定与呈现，不假装自己执行了清理。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// ---------------------------------------------------------------- 声明解析

const READONLY_ACTIONS = /^(get|read|query|list|search|fetch|verify|compare|assert|navigate|wait|observe)/i;
const MUTATING_ACTIONS = /^(create|insert|add|update|delete|remove|write|setup|teardown|fill|submit|register|place|cancel|import|reset)/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * 归一化一条数据集声明。缺字段是历史债务的常态，这里只记录事实，
 * 不替调用方发明值。
 */
export function parseDataset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  return {
    id,
    setup: raw.setup ?? null,                       // 造数操作声明（null = 未声明）
    teardown: raw.teardown ?? null,                 // 清理操作声明（null = 未声明 → 只读）
    persistent: raw.persistent === true,
    filed: raw.filed === true,                      // 是否已纳入建档
    readonly_only: raw.teardown == null,
  };
}

export function parseDatasets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseDataset).filter(Boolean);
}

// ---------------------------------------------------------------- 写语义判定

/**
 * 判定一个步骤是否有写语义。返回 { mutates, reason }：
 *   - mutates=true  → 明确的增删改；
 *   - mutates=false → 明确只读；
 *   - 两者都不是   → mutates=false 但 reason='unknown'，进 unknown_mutation。
 * 显式声明（step.writes / step.readonly）优先于推断——人说了算。
 */
export function stepMutates(step = {}) {
  if (step.writes === true) return { mutates: true, reason: 'declared: writes=true' };
  if (step.readonly === true) return { mutates: false, reason: 'declared: readonly=true' };
  const method = typeof step.method === 'string' ? step.method.toUpperCase() : null;
  if (method && MUTATING_METHODS.has(method)) return { mutates: true, reason: `http ${method}` };
  if (method && method === 'GET') return { mutates: false, reason: 'http GET' };
  const action = typeof step.action === 'string' ? step.action : '';
  if (MUTATING_ACTIONS.test(action)) return { mutates: true, reason: `action=${action}` };
  if (READONLY_ACTIONS.test(action)) return { mutates: false, reason: `action=${action}` };
  return { mutates: false, reason: 'unknown' };
}

/**
 * 收集步骤引用的数据集 id：`${data.xxx}` 占位与 `dataset` 字段两种写法都认。
 */
export function stepDatasetRefs(step = {}) {
  const refs = new Set();
  if (typeof step.dataset === 'string' && step.dataset) refs.add(step.dataset);
  const text = JSON.stringify(step.inputs ?? step.params ?? step ?? {});
  for (const m of text.matchAll(/\$\{data\.([A-Za-z0-9_.-]+)\}/g)) refs.add(m[1].split('.')[0]);
  return [...refs];
}

// ---------------------------------------------------------------- 计划审计

/**
 * 审计计划对数据集的使用。三条纪律逐条落实为 finding：
 *   - UNDECLARED_DATASET：用了没声明的数据集——连生命周期都没进系统，谈不上清理；
 *   - MISSING_SETUP：写步骤引用的数据集没声明 setup——造数靠「碰巧库里有一条」；
 *   - MUTATING_WITHOUT_TEARDOWN：对无 teardown 的数据集做写操作（纪律 2）；
 *   - PERSISTENT_MUTATED：对基础数据做用例级增删改（纪律 3）。
 * 全部只读或无引用 → findings 为空，clean。
 */
export function auditPlan(plan, datasets) {
  const declared = new Map(datasets.map(d => [d.id, d]));
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const findings = [];
  const unknown_mutation = [];
  let mutating_steps = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const verdict = stepMutates(step);
    const refs = stepDatasetRefs(step);
    if (verdict.reason === 'unknown' && refs.length) {
      unknown_mutation.push({ step: step.id ?? `steps[${i}]`, refs });
    }
    if (!verdict.mutates) continue;
    mutating_steps += 1;
    for (const ref of refs) {
      const ds = declared.get(ref);
      if (!ds) {
        findings.push({ code: 'UNDECLARED_DATASET', step: step.id ?? `steps[${i}]`, dataset_id: ref,
          detail: `步骤有写语义（${verdict.reason}）却引用未声明数据集——数据生命周期没有进系统，清理无从谈起` });
        continue;
      }
      if (!ds.setup) {
        findings.push({ code: 'MISSING_SETUP', step: step.id ?? `steps[${i}]`, dataset_id: ref,
          detail: '写步骤引用的数据集未声明 setup——前置数据依赖「库里碰巧有」，首轮能过、重跑就脏' });
      }
      if (!ds.teardown) {
        findings.push({ code: 'MUTATING_WITHOUT_TEARDOWN', step: step.id ?? `steps[${i}]`, dataset_id: ref,
          detail: '对未声明 teardown 的数据集做写操作（纪律 2：无 teardown 只允许只读用途）——本步骤产生的增量将成为下一轮的脏数据' });
      }
      if (ds.persistent) {
        findings.push({ code: 'PERSISTENT_MUTATED', step: step.id ?? `steps[${i}]`, dataset_id: ref,
          detail: '对 persistent 基础数据做用例级增删改（纪律 3）——基础数据是跨轮共享资产，不是用例的私有沙盒' });
      }
    }
  }

  return { mutating_steps, findings, unknown_mutation };
}

// ---------------------------------------------------------------- 残留汇总

/**
 * 汇总 teardown 执行结果 → data_residue。
 * results 形如 [{dataset_id, ok, reason}]（执行器产出，本模块不执行清理）。
 * 口径：
 *   - ok=false → 进 residue，不许静默；
 *   - 声明了 teardown 但 results 里没有 → 也进 residue（没跑 = 没清理，不是没残留）；
 *   - 未声明 teardown → 不进 residue（纪律 2 下它本就不许写），归 readonly 数据集单列。
 */
export function collectResidue(datasets, results = []) {
  const withTeardown = datasets.filter(d => d.teardown);
  const byId = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && typeof r.dataset_id === 'string') byId.set(r.dataset_id, r);
  }
  const residue = [];
  const cleaned = [];
  for (const ds of withTeardown) {
    const r = byId.get(ds.id);
    if (!r) {
      residue.push({ dataset_id: ds.id, reason: 'teardown 未执行——声明了清理但没有执行记录' });
    } else if (r.ok !== true) {
      residue.push({ dataset_id: ds.id, reason: r.reason || 'teardown 执行失败' });
    } else {
      cleaned.push(ds.id);
    }
  }
  // 孤儿结果：执行器报了某数据集的清理结果，但该数据集没在声明里。
  // 静默丢弃就等于「清理了不知道什么」，同样不许静默。
  const declaredIds = new Set(datasets.map(d => d.id));
  for (const [id, r] of byId) {
    if (!declaredIds.has(id)) {
      residue.push({ dataset_id: id, reason: `清理结果对应的数据集未声明（ok=${r.ok}）——声明与执行不一致` });
    }
  }
  const readonly_sets = datasets.filter(d => !d.teardown).map(d => d.id);
  return { data_residue: residue, cleaned, readonly_sets };
}

// ---------------------------------------------------------------- 汇总入口

/**
 * 全量检查。available=false 只在「既没有声明也没有计划」时出现——
 * 那意味着本轮根本没有数据生命周期可谈，报告里要如实说。
 */
export function inspectLifecycle({ datasets: rawDatasets = [], plan = null, teardown_results = [] } = {}) {
  const datasets = parseDatasets(rawDatasets);
  const hasPlan = plan != null;

  if (!datasets.length && !hasPlan) {
    return {
      available: false,
      reason: 'no_declaration',
      note: '本轮没有数据集声明，也没有可审计的计划。无法核对数据生命周期纪律——若执行确实造了数，这些数据未纳入任何清理机制。',
      data_residue: null,
      findings: [],
    };
  }

  const audit = hasPlan ? auditPlan(plan, datasets) : { mutating_steps: 0, findings: [], unknown_mutation: [] };
  const residuePart = collectResidue(datasets, teardown_results);

  // 声明级检查：persistent 未建档
  const declFindings = [];
  for (const ds of datasets) {
    if (ds.persistent && !ds.filed) {
      declFindings.push({ code: 'PERSISTENT_UNFILED', dataset_id: ds.id,
        detail: '标记 persistent 却未纳入建档——基础数据的变更将没有 diff 可查' });
    }
  }

  const findings = [...declFindings, ...audit.findings];
  return {
    available: true,
    counts: {
      declared: datasets.length,
      persistent: datasets.filter(d => d.persistent).length,
      readonly_only: datasets.filter(d => d.readonly_only).length,
      mutating_steps: audit.mutating_steps,
    },
    findings,
    unknown_mutation: audit.unknown_mutation,
    ...residuePart,
  };
}

// ---------------------------------------------------------------- 呈现

export function renderLifecycleSection(result) {
  if (!result?.available) {
    return `数据生命周期：本轮未提供数据集声明。${result?.note ?? ''}若执行写入了数据，这部分不在任何清理机制之内。`;
  }
  const lines = [];
  const c = result.counts;
  lines.push(`数据集声明 ${c.declared} 个（persistent ${c.persistent} 个、只读约束 ${c.readonly_only} 个），写步骤 ${c.mutating_steps} 个。`);
  if (result.data_residue.length) {
    lines.push(`**数据残留（data_residue）：${result.data_residue.length} 个数据集清理失败或未执行——**`);
    for (const r of result.data_residue) lines.push(`- ${r.dataset_id}：${r.reason}`);
    lines.push('残留数据会污染后续轮次（如「查最新一笔」查到本轮遗留）。下次执行前需人工处理或修正 teardown。');
  } else {
    lines.push('清理结果：已清理 ' + result.cleaned.length + ' 个数据集，无残留。');
  }
  if (result.readonly_sets.length) {
    lines.push(`未声明 teardown、只允许只读用途的数据集：${result.readonly_sets.join('、')}。`);
  }
  if (result.findings.length) {
    lines.push(`**生命周期纪律违规 ${result.findings.length} 处：**`);
    for (const f of result.findings) lines.push(`- [${f.code}] ${f.dataset_id ?? ''}（${f.step ?? '声明'}）${f.detail}`);
  }
  if (result.unknown_mutation.length) {
    lines.push(`另有 ${result.unknown_mutation.length} 个步骤的写语义无法判定（列出但不计违规）：${result.unknown_mutation.map(u => u.step).join('、')}。`);
  }
  if (!result.findings.length && !result.unknown_mutation.length) {
    lines.push('数据生命周期纪律检查通过。');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
  const cwd = process.cwd();
  const planPath = args.plan ? resolve(cwd, args.plan) : null;
  const dsPath = args.datasets ? resolve(cwd, args.datasets) : null;
  const trPath = args.teardown ? resolve(cwd, args.teardown) : null;

  const load = p => {
    if (!p || !existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const plan = load(planPath);
  const rawDs = load(dsPath);
  const datasets = Array.isArray(rawDs) ? rawDs : (rawDs?.datasets ?? []);
  const teardown_results = load(trPath) ?? [];

  const result = inspectLifecycle({ datasets, plan, teardown_results });
  const markdown = `## 数据生命周期（P1-6）\n\n${renderLifecycleSection(result)}\n`;

  const outPath = args.out ? resolve(cwd, args.out) : resolve(cwd, 'output/report/data-lifecycle.md');
  mkdirSync(basename(outPath) === outPath ? '.' : resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, markdown);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(markdown);
  if (result.available && (result.data_residue.length || result.findings.length)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
