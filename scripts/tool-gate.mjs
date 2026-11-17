/**
 * 工具闸门：把管理后台登记的「纪律型能力」真正接到 Agent 的调用路径上。
 *
 * 在此之前，工具模块只是一份台账——后台里点一下「停用」，Agent 照旧跑，
 * 因为 Agent 的真实调用面是 `project-action.mjs` 的 action，与工具表没有连线。
 * 这个模块就是那根线：每个 action 声明它依赖哪些工具，执行前逐个核对。
 *
 * 两条纪律：
 *
 * 1. **硬依赖停用即拦**。工具没了这个 action 就跑不对，放行等于产出一份看起来
 *    正常、实际少了校验的产物——这比直接失败更糟。
 * 2. **软依赖停用只降级**。action 还能跑，但要在回执里写明「哪条纪律没生效」。
 *    静默降级是最坏的一种：报告上一个字都不提，看的人以为都查过了。
 *
 * 状态文件由管理后台在启停时写入，本模块只读。**文件不存在 = 全部启用**——
 * 工具状态是纪律增强，不是安全边界，让它因为一个文件缺失就把整条流水线掐死，
 * 是把可用性押在一次写盘上。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** 运行期状态文件，相对 engine root。 */
export const STATE_PATH = 'config/tool-runtime-state.json';
/** 调用流水，相对 engine root。一行一次调用，追加写避免并发覆盖。 */
export const USAGE_PATH = 'output/runtime/tool-usage.jsonl';
export const CALLABLE_STAGE_TOOL_IDS = Object.freeze([
  'requirement.testability', 'requirement.acceptance', 'testpoint.coverage',
  'irval.check', 'plan.gates', 'report.reviewer', 'defect.evidence', 'defect.tools',
  'regression.impact', 'regression.select',
]);

/**
 * action → 工具绑定。
 *
 * `requires`：硬依赖，停用即拒绝执行。
 * `enhances`：软依赖，停用照跑但回执标注降级。
 * `when`：只在该 action 的某些形态下才校验（比如只有 case 阶段的产物才谈得上预期溯源）。
 *
 * 规划中的工具（knowledge.incremental / requirement.completeness）**故意不出现在这里**：
 * 它们还没有任何代码实现，把它们绑成软依赖，只会让每一次调用都背一条无意义的降级记录。
 * 等能力落地再接。
 */
export const TOOL_BINDINGS = {
  run_stage_tool: { conditional: parsed => parsed?.tool_id ? [parsed.tool_id] : [] },
  extract_word: { requires: ['requirement.parse'] },
  api_task: { conditional: parsed => ['start', 'resume'].includes(parsed?.operation?.type) ? ['exec.api_engine'] : [] },
  // —— 阶段状态机：建 run、排阶段、推进、确认、失效 ——
  create_run: { requires: ['plan.phases'] },
  plan_run: { requires: ['plan.phases'] },
  extend_plan: { requires: ['plan.phases'] },
  run_status: { requires: ['plan.phases'] },
  set_review_mode: { requires: ['plan.phases'] },
  preview_revision: { requires: ['plan.phases'] },
  revise_stage: { requires: ['plan.phases'] },
  request_confirmation: { requires: ['plan.phases'] },
  resolve_confirmation: { requires: ['plan.phases'], conditional: parsed => parsed?.stage === 'test_cases' && parsed?.decision === 'approved' ? ['expected.provenance'] : [] },
  prepare_execution_plan: { requires: ['plan.phases', 'regression.select'] },
  configure_delivery: { requires: ['plan.phases'] },
  plan_test_tracks: { requires: ['plan.phases'] },
  reuse_design: { requires: ['plan.phases'] },
  create_api_snapshot_report: { requires: ['plan.phases'] },

  // —— 派发契约：谁派给谁、交回来什么 ——
  dispatch: { requires: ['agent.contract', 'plan.phases'] },
  handoff: { requires: ['agent.contract', 'plan.phases'], conditional: parsed => stageChecks(parsed?.stage) },
  complete: { requires: ['agent.contract', 'plan.phases'], conditional: parsed => stageChecks(parsed?.stage) },
  block: { requires: ['agent.contract', 'plan.phases'] },
  fail: { requires: ['agent.contract', 'plan.phases'] },
  resolve_child: { requires: ['agent.contract'] },
  resolve_child_handle: { requires: ['agent.contract'] },

  // —— 结构化硬校验：产物不合格就不许往下走 ——
  diagnose_task: { requires: ['irval.check'] },
  diagnose_analysis: { requires: ['irval.check'] },
  diagnose_test_points: { requires: ['irval.check'] },
  diagnose_test_cases: { requires: ['irval.check', 'expected.provenance'] },
  validate_analysis: { requires: ['irval.check'] },
  validate_execution_prepare: { requires: ['irval.check'] },
  export_test_points: { requires: ['irval.check'] },
  export_test_cases: { requires: ['irval.check', 'expected.provenance'] },
  assess_evidence: { requires: ['irval.check'] },
  normalize_defects: { requires: ['irval.check'] },
  build_report_metrics: { requires: ['irval.check'] },
  draft_records: { requires: ['irval.check'] },

  // validate_artifacts 按阶段分：case 阶段才有预期溯源这一说
  validate_artifacts: {
    requires: ['irval.check'],
    conditional: parsed => stageChecks(parsed?.stage),
  },

  // —— 执行面快照：多 frame 页面没有 frame_path 就会假失败 ——
  browser_task: { requires: ['dom.snapshot'] },
  explore_url: { requires: ['dom.snapshot'] },

  // —— 报告：选集口径决定「能不能说没问题」 ——
  // requirement.completeness 是软依赖：报告照出，但若它被停用，覆盖率分母不会被修正，
  // 报告里那一段会写「未生成」——降级要留痕，不能静默当没这回事。
  export_report: { enhances: ['regression.select', 'requirement.completeness'] },
  analysis_summary: { enhances: ['plan.phases'] },
};

function stageChecks(stage) {
  if (stage === 'test_points') return ['testpoint.coverage'];
  if (stage === 'test_cases') return ['expected.provenance'];
  return [];
}

/**
 * 读运行期状态。返回停用的工具名集合。
 *
 * 任何读取失败都当成「没有停用的」：文件坏了、权限不对、路径没配好，都属于
 * 部署问题，不该由 agent 的一次业务调用去承担后果。
 */
export function readRuntimeState(root) {
  try {
    const path = resolve(root, STATE_PATH);
    if (!existsSync(path)) return { disabled: new Set(), versions: {}, updatedAt: null, source: 'absent' };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const disabled = Array.isArray(value?.disabled) ? value.disabled.filter(item => typeof item === 'string') : [];
    const versions = value?.versions && typeof value.versions === 'object' && !Array.isArray(value.versions) ? value.versions : {};
    return { disabled: new Set(disabled), versions, updatedAt: typeof value?.updated_at === 'string' ? value.updated_at : null, source: 'file' };
  } catch {
    return { disabled: new Set(), versions: {}, updatedAt: null, source: 'unreadable' };
  }
}

/**
 * 判断一个 action 现在能不能跑。
 *
 * 返回结构固定三件套，调用方不需要再判断形态：
 *   blocked 非空 → 拒绝执行，blocked 就是原因
 *   degraded     → 可以跑，但要在回执里带上
 *   tools        → 本次动作受约束的工具 ID；实际调用由执行回执单独记录
 */
export function gateAction(root, action, parsed) {
  const binding = TOOL_BINDINGS[action];
  if (!binding) return { blocked: null, degraded: [], requires: [], tools: [] };

  const { disabled } = readRuntimeState(root);
  const conditional = typeof binding.conditional === 'function' ? binding.conditional(parsed) ?? [] : [];
  const gated = typeof binding.when === 'function' && !binding.when(parsed) ? [] : binding.requires ?? [];
  const requires = [...new Set([...gated, ...conditional])];
  const enhances = binding.enhances ?? [];

  const blockedBy = requires.filter(name => disabled.has(name));
  if (blockedBy.length) {
    return {
      blocked: `工具「${blockedBy.join('」「')}」已停用，${action} 依赖它，本次不执行。`
        + `到管理后台把该工具重新启用后再试；不要绕过它改用别的 action，那会产出一份少了校验的产物。`,
      degraded: [],
      requires,
      tools: requires,
    };
  }

  const degraded = enhances.filter(name => disabled.has(name));
  return { blocked: null, degraded, requires, tools: requires };
}

/**
 * 记一次调用。追加一行 JSON，按天聚合交给读的一方。
 *
 * 为什么不写成汇总 JSON：多个子会话会并发跑 action，读-改-写会互相覆盖，
 * 而 `O_APPEND` 的小行追加是原子的。宁可在读取端多聚合一次。
 */
export function recordToolUsage(root, action, { tools = [], degraded = [], receipt = null, runId = null, stage = null, implementationSha256 = null } = {}) {
  // A passed policy gate is not a tool invocation. Only a completed implementation
  // with a durable receipt may increment the admin's call counter.
  if (!receipt || !tools.length) return;
  try {
    const path = resolve(root, USAGE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const row = { kind: 'execution', at: new Date().toISOString(), action, tools: [...new Set(tools)], degraded: [...new Set(degraded)], receipt,
      run_id: runId, stage, implementation_sha256: implementationSha256 };
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    // 计数是观测，不是业务。写不进去不能影响这次调用本身。
  }
}

// A separate diagnostic stream preserves failed/skipped/not-applicable checks
// without inflating the successful invocation counter.
export function recordToolCheck(root, action, check, { receipt = null, runId = null, stage = null } = {}) {
  if (!check || typeof check.tool_id !== 'string' || typeof check.status !== 'string' || !receipt) return;
  try {
    const path = resolve(root, USAGE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const summary = Object.fromEntries(['available', 'score', 'denominator', 'coverage_counts', 'missing_rule_ids',
      'located', 'not_recorded', 'verified', 'designed', 'executed', 'assigned_only', 'coverage_rate',
      'selected', 'excluded', 'stats', 'overall', 'merge_safety', 'error_code'].filter(key => check[key] !== undefined)
      .map(key => [key, check[key]]));
    const row = { kind: 'check', at: new Date().toISOString(), action, tool_id: check.tool_id,
      status: check.status, run_id: runId, stage, receipt, implementation: check.implementation ?? null,
      implementation_sha256: check.implementation_sha256 ?? null, input: check.input ?? null,
      output: check.output ?? null, summary };
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch { /* Observability must not mutate the business result. */ }
}

/** 读回调用流水并聚合，供管理后台展示。坏行直接跳过，不让一行烂数据带崩整张表。 */
export function readToolUsage(root, { since = null } = {}) {
  const path = resolve(root, USAGE_PATH);
  const perTool = new Map();
  const perAction = new Map();
  let total = 0;
  let firstAt = null;
  let lastAt = null;
  if (!existsSync(path)) return { version: 1, total: 0, per_tool: {}, per_action: {}, first_at: null, last_at: null };
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.kind !== 'execution' || typeof row?.receipt !== 'string' || typeof row?.at !== 'string') continue;
    if (since && row.at < since) continue;
    total += 1;
    if (!firstAt || row.at < firstAt) firstAt = row.at;
    if (!lastAt || row.at > lastAt) lastAt = row.at;
    for (const name of Array.isArray(row.tools) ? row.tools : []) perTool.set(name, (perTool.get(name) ?? 0) + 1);
    if (typeof row.action === 'string') perAction.set(row.action, (perAction.get(row.action) ?? 0) + 1);
  }
  return {
    version: 1,
    total,
    per_tool: Object.fromEntries([...perTool].sort((a, b) => b[1] - a[1])),
    per_action: Object.fromEntries([...perAction].sort((a, b) => b[1] - a[1])),
    first_at: firstAt,
    last_at: lastAt,
  };
}

/** 当前绑定关系的可读快照，给「这条工具到底管着什么」用。 */
export function bindingSummary() {
  const byTool = new Map();
  for (const [action, binding] of Object.entries(TOOL_BINDINGS)) {
    for (const name of binding.requires ?? []) {
      if (!byTool.has(name)) byTool.set(name, { hard: [], soft: [] });
      byTool.get(name).hard.push(action);
    }
    for (const name of binding.enhances ?? []) {
      if (!byTool.has(name)) byTool.set(name, { hard: [], soft: [] });
      byTool.get(name).soft.push(action);
    }
  }
  for (const name of CALLABLE_STAGE_TOOL_IDS) {
    if (!byTool.has(name)) byTool.set(name, { hard: [], soft: [] });
    byTool.get(name).hard.push('run_stage_tool');
  }
  return Object.fromEntries([...byTool].map(([name, value]) => [name, {
    hard: value.hard.sort(),
    soft: value.soft.sort(),
  }]));
}
