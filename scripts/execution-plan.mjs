import { readFileSync } from "node:fs";

const isolationLevels = new Set(["read_only", "isolated", "shared"]);
const assertionModes = new Set(["dynamic_ui", "dom_state", "navigation", "api_response", "storage_state"]);
const priorities = new Set(["P0", "P1", "P2"]);
export const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });

export function normalizePriority(testCase) {
  const value = testCase?.priority ?? "P2";
  if (!priorities.has(value)) throw new Error(`${testCase?.case_id}: priority 必须是 P0 / P1 / P2。`);
  return value;
}

/** 模块推定：显式 module 优先，否则用 TC-<模块>-<序号> 的中间段。 */
export function caseModule(testCase) {
  if (testCase?.module) return String(testCase.module);
  const segments = String(testCase?.case_id ?? "").split(/[-_]/);
  return segments.length >= 3 ? segments[1].toUpperCase() : "default";
}

export function caseResourceKeys(testCase) {
  const keys = testCase?.resource_keys ?? testCase?.execution_contract?.resource_keys ?? [];
  return Array.isArray(keys) ? [...new Set(keys.map(String))].sort() : [];
}

export function extractCases(source) {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.cases)) return source.cases;
  if (Array.isArray(source?.test_cases)) return source.test_cases;
  throw new Error("测试用例文件必须是数组，或包含 cases/test_cases 数组。");
}

export function normalizeContract(testCase) {
  const input = testCase.execution_contract ?? {};
  const dataIsolation = input.data_isolation ?? "shared";
  const modes = input.assertion_mode ?? ["dom_state"];
  if (!isolationLevels.has(dataIsolation)) throw new Error(`${testCase.case_id}: data_isolation 不受支持。`);
  if (!Array.isArray(modes) || modes.some((mode) => !assertionModes.has(mode))) throw new Error(`${testCase.case_id}: assertion_mode 不受支持。`);
  return {
    data_isolation: dataIsolation,
    setup: Array.isArray(input.setup) ? input.setup : [],
    assertion_mode: modes,
    cleanup_required: input.cleanup_required ?? dataIsolation !== "read_only"
  };
}

export function createExecutionCases(testCases) {
  const ids = new Set();
  const cases = testCases.filter((testCase) => testCase.automation_feasible === true).map((testCase) => {
    if (!testCase.case_id || !testCase.title) throw new Error("自动化用例必须包含 case_id 和 title。");
    if (ids.has(testCase.case_id)) throw new Error(`测试用例 ID 重复: ${testCase.case_id}`);
    ids.add(testCase.case_id);
    return {
      case_id: testCase.case_id,
      title: testCase.title,
      module: caseModule(testCase),
      priority: normalizePriority(testCase),
      resource_keys: caseResourceKeys(testCase),
      asset_refs: testCase.asset_refs ?? [],
      anchors: Array.isArray(testCase.anchors) ? testCase.anchors : [],
      execution_contract: normalizeContract(testCase)
    };
  });
  // 优先级分层：P0 冒烟先执行，同一优先级保持设计顺序。
  return cases.sort((left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 执行阶段入口（D4）：smoke 只跑 P0 冒烟，regression 跑非 P0 的全量回归；
 * 不传 stage 时保持原计划全集。
 */
export function filterCasesByPhase(cases, stage) {
  if (stage == null) return cases;
  if (stage === 'smoke') return cases.filter(testCase => normalizePriority(testCase) === 'P0');
  if (stage === 'regression') return cases.filter(testCase => normalizePriority(testCase) !== 'P0');
  throw new Error(`未知执行阶段 ${stage}，可选 smoke|regression。`);
}

export function validateExecutionPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['执行计划必须是对象。'];
  if (!plan?.run_id) errors.push("缺少 run_id。");
  if (!Array.isArray(plan?.cases)) errors.push("cases 必须为数组。");
  if (!plan?.execution_policy) errors.push("缺少 execution_policy。");
  const ids = new Set();
  for (const testCase of Array.isArray(plan.cases) ? plan.cases : []) {
    if (!testCase || typeof testCase !== 'object') { errors.push('执行用例必须是对象。'); continue; }
    if (!testCase.case_id || !testCase.title) errors.push("执行用例缺少 case_id 或 title。");
    if (testCase.priority !== undefined && !priorities.has(testCase.priority)) errors.push(`${testCase.case_id}: priority 必须是 P0 / P1 / P2。`);
    if (testCase.module !== undefined && (typeof testCase.module !== 'string' || !testCase.module.trim())) errors.push(`${testCase.case_id}: module 必须是非空字符串。`);
    if (testCase.resource_keys !== undefined && (!Array.isArray(testCase.resource_keys) || testCase.resource_keys.some(key => typeof key !== 'string' || !key))) errors.push(`${testCase.case_id}: resource_keys 必须是字符串数组。`);
    if (ids.has(testCase.case_id)) errors.push(`执行用例 ID 重复: ${testCase.case_id}`);
    ids.add(testCase.case_id);
    try { normalizeContract(testCase); } catch (error) { errors.push(error.message); }
  }
  if (!Number.isSafeInteger(plan.execution_policy?.workers) || plan.execution_policy.workers < 1) errors.push("execution_policy.workers 必须是正整数。");
  if (plan.execution_policy?.sandbox_backend !== undefined && !['host', 'wsl'].includes(plan.execution_policy.sandbox_backend)) errors.push('Unsupported execution sandbox backend');
  for (const [key, fallback, min, max] of [['global_timeout_ms', 900000, 1000, 86400000], ['preflight_timeout_ms', 60000, 1000, 300000]]) {
    const value = plan.execution_policy?.[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) errors.push(`${key} must be an integer between ${min} and ${max}`);
  }
  const replays = plan.execution_policy?.replays;
  if (replays !== undefined && (!Number.isSafeInteger(replays) || replays < 1 || replays > 5)) errors.push("execution_policy.replays 必须是 1..5 的整数（重放是拿一致性，不是拿算力堆通过率）。");
  const deadline = plan.execution_policy?.replay_deadline_ms;
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 1000 || deadline > 86400000)) errors.push("execution_policy.replay_deadline_ms 必须是 1000..86400000 的整数。");
  const tier = plan.execution_policy?.target_tier;
  if (tier !== undefined && !['source', 'isolated', 'installed'].includes(tier)) errors.push("execution_policy.target_tier 必须是 source / isolated / installed 之一。");
  const sharding = plan.execution_policy?.sharding;
  if (sharding !== undefined) {
    if (!sharding || typeof sharding !== 'object' || typeof sharding.enabled !== 'boolean') errors.push('execution_policy.sharding 必须是包含布尔 enabled 的对象。');
    if (sharding?.enabled === true && (plan.execution_policy?.sandbox_backend ?? 'host') !== 'host') errors.push('分片并行目前只支持 host 后端。');
  }
  if (plan.phases !== undefined) {
    const assigned = new Set();
    for (const phase of Array.isArray(plan.phases) ? plan.phases : []) {
      if (!phase?.id || !Array.isArray(phase.case_ids)) { errors.push('phases 每项必须包含 id 与 case_ids 数组。'); continue; }
      for (const caseId of phase.case_ids) {
        if (!ids.has(caseId)) errors.push(`阶段 ${phase.id} 引用了不存在的用例 ${caseId}。`);
        if (assigned.has(caseId)) errors.push(`用例 ${caseId} 在 phases 中重复。`);
        assigned.add(caseId);
      }
    }
    for (const caseId of ids) if (!assigned.has(caseId)) errors.push(`用例 ${caseId} 未归入任何执行阶段。`);
  }
  return errors;
}
