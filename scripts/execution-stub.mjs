/**
 * 外部依赖桩（P1-5 落地，对应 §25.2）。
 *
 * **不做这件事的后果**，工程里已经发生过很多次：第三方服务不可用 → 整批用例 fail →
 * 归因成「产品缺陷」→ 研发查半天说「这不是我们的问题」→ 平台的可信度掉一格。
 * 下一次还是这样，因为**没有地方可以声明「这一步依赖外部服务」**。
 *
 * 所以给 plan 加一个 `stub` 声明，并规定：
 *
 *     声明了 stub 的步骤，因外部依赖不可用而失败 → 结论降 `inconclusive`
 *     没声明 stub 的步骤失败 → 仍然是 `fail`
 *
 * ## 三条不能让步的边界
 *
 * 1. **没声明就不降级**。`inconclusive` 是个很舒服的结论——不用负责、也不算失败。
 *    一旦允许「失败就降级」，所有真缺陷都会被降级掉。所以必须先声明依赖，才谈得上降级。
 * 2. **打了桩还失败，不降级**。`mode: 'stub'` 意味着这条依赖已经被本地替身接管，
 *    此时失败说明是脚本或断言写错了，是真问题。
 * 3. **只有「连不上」才降级**。声明了依赖但失败原因是断言不成立（`expected 3 to equal 4`），
 *    那是产品行为不对，不是环境问题。判据看错误特征，不看「这一步有没有 stub」。
 */
import { pathToFileURL } from 'node:url';

export const STUB_MODES = ['stub', 'passthrough', 'record', 'replay'];

/** 网络类错误特征：只有这类失败才可能归因到「外部依赖不可用」。 */
const UNREACHABLE = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timeout|timed out|超时|连接被拒|连接失败|网络不可达|502|503|504)/i;
/** 断言类特征：出现这些就不是环境问题，是产品/脚本问题。 */
const ASSERTION_LIKE = /(expected .* to (equal|be|match|contain)|assertion|断言|expected_value|actual_value)/i;

/**
 * 从 plan 收集 stub 声明。
 *
 * 支持两种写法，因为 plan 由 agent 产出，两种都会出现：
 *   plan.stubs = [{ id, target, mode, steps: ['S1'] }]     // 依赖视角
 *   plan.steps[].stub = ['sms']                             // 步骤视角
 */
export function collectStubs(plan) {
  const collected = new Map();
  const add = (stub, stepIds) => {
    const id = typeof stub?.id === 'string' ? stub.id : (typeof stub === 'string' ? stub : null);
    if (!id) return;
    const existing = collected.get(id) ?? { id, target: null, mode: 'passthrough', steps: new Set() };
    if (typeof stub?.target === 'string') existing.target = stub.target;
    if (STUB_MODES.includes(stub?.mode)) existing.mode = stub.mode;
    for (const step of stepIds) existing.steps.add(step);
    collected.set(id, existing);
  };

  for (const stub of Array.isArray(plan?.stubs) ? plan.stubs : []) {
    add(stub, Array.isArray(stub?.steps) ? stub.steps : []);
  }
  for (const step of Array.isArray(plan?.steps) ? plan.steps : []) {
    const stepId = step?.step_id ?? step?.id;
    const declared = step?.stub;
    if (!stepId || !declared) continue;
    for (const stub of Array.isArray(declared) ? declared : [declared]) add(stub, [stepId]);
  }
  return [...collected.values()].map(stub => ({ ...stub, steps: [...stub.steps] }));
}

/** 一条失败结果对应的、生效的 stub（步骤级精确匹配优先，其次全局声明）。 */
export function stubsForRow(row, stubs) {
  const stepId = row?.step_id ?? row?.step ?? row?.stepId ?? null;
  const declared = (stubs ?? []).filter(stub => !stub.steps.length || (stepId && stub.steps.includes(stepId)));
  return declared;
}

function errorText(row) {
  return [row?.error?.message, row?.error?.type, row?.error?.stack, row?.failure_summary, row?.message, row?.output]
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n');
}

/**
 * 判断这条失败能不能归因到外部依赖不可用。
 *
 * 顺序很重要：先排断言类，再看网络类。反过来会让「超时」把断言不成立也吞掉。
 */
export function attributeToStub(row, stubs) {
  if (!row || !['failed', 'fail'].includes(row.status)) return null;
  const text = errorText(row);
  if (!text) return null;
  if (ASSERTION_LIKE.test(text) && !UNREACHABLE.test(text)) return null;

  for (const stub of stubsForRow(row, stubs)) {
    // 打了桩还失败 → 是真问题，不降级
    if (stub.mode === 'stub' || stub.mode === 'replay') return { stub, reason: 'stubbed_dependency_failed', downgradable: false };
    const hostMatch = stub.target ? text.includes(stub.target) : false;
    if (UNREACHABLE.test(text) || hostMatch) {
      return {
        stub,
        reason: 'dependency_unreachable',
        downgradable: true,
        detail: `${stub.id}${stub.target ? ` (${stub.target})` : ''} 不可用；按 stub 声明判为 inconclusive，不判产品缺陷`,
      };
    }
  }
  return null;
}

/**
 * 批量应用。
 *
 * `kept_fail` 与 `downgraded` 都要报出来：前者是「声明了依赖但失败跟依赖无关」，
 * 后者是「确实因为依赖挂了」。只报降级数会让「打了桩还挂 40 条」这件事消失。
 */
export function applyStubPolicy(rows, { stubs = [] } = {}) {
  const cases = [];
  const downgraded = [];
  const keptFail = [];
  const declared = new Set(stubs.map(stub => stub.id));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!declared.size) { cases.push(row); continue; }
    const attribution = attributeToStub(row, stubs);
    if (!attribution) { cases.push(row); continue; }
    if (!attribution.downgradable) {
      keptFail.push({ case_id: row.case_id, stub_id: attribution.stub.id, reason: attribution.reason, detail: '依赖已打桩仍失败，按真问题处理' });
      cases.push({ ...row, stub: { id: attribution.stub.id, mode: attribution.stub.mode, downgraded: false, reason: attribution.reason } });
      continue;
    }
    downgraded.push({ case_id: row.case_id, from: row.status, to: 'inconclusive', stub_id: attribution.stub.id, detail: attribution.detail });
    cases.push({ ...row, status: 'inconclusive', original_status: row.status, stub: { id: attribution.stub.id, mode: attribution.stub.mode, downgraded: true, reason: attribution.reason } });
  }
  return { cases, downgraded, kept_fail: keptFail, declared: [...declared] };
}

/** 报告里那段话。没有 stub 声明时明说「未声明」，而不是「没有外部依赖」。 */
export function describeStubPolicy(result) {
  if (!result?.declared?.length) {
    return '本轮计划未声明外部依赖桩。若存在第三方依赖，环境不可用会被记为产品失败——这不是判定错误，是缺少声明。';
  }
  const parts = [`已声明 ${result.declared.length} 个外部依赖桩（${result.declared.join('、')}）`];
  if (result.downgraded.length) parts.push(`${result.downgraded.length} 条因依赖不可用降为 inconclusive`);
  if (result.kept_fail.length) parts.push(`${result.kept_fail.length} 条依赖已打桩仍失败，按真问题计入失败`);
  if (!result.downgraded.length && !result.kept_fail.length) parts.push('本轮未出现依赖不可用导致的失败');
  return `${parts.join('；')}。`;
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/execution-stub.mjs --plan=<plan.json> [--results=] */
/* ------------------------------------------------------------------ */

function main() {
  console.log(JSON.stringify({
    hint: '本模块供编排层调用：collectStubs(plan) → applyStubPolicy(results, {stubs}) → describeStubPolicy(result)。',
    modes: STUB_MODES,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
