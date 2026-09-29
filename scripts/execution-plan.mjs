import { readFileSync } from "node:fs";

const isolationLevels = new Set(["read_only", "isolated", "shared"]);
const assertionModes = new Set(["dynamic_ui", "dom_state", "navigation", "api_response", "storage_state"]);

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
  return testCases.filter((testCase) => testCase.automation_feasible === true).map((testCase) => {
    if (!testCase.case_id || !testCase.title) throw new Error("自动化用例必须包含 case_id 和 title。");
    if (ids.has(testCase.case_id)) throw new Error(`测试用例 ID 重复: ${testCase.case_id}`);
    ids.add(testCase.case_id);
    return {
      case_id: testCase.case_id,
      title: testCase.title,
      asset_refs: testCase.asset_refs ?? [],
      execution_contract: normalizeContract(testCase)
    };
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateExecutionPlan(plan) {
  const errors = [];
  if (!plan?.run_id) errors.push("缺少 run_id。");
  if (!Array.isArray(plan?.cases)) errors.push("cases 必须为数组。");
  if (!plan?.execution_policy) errors.push("缺少 execution_policy。");
  const ids = new Set();
  for (const testCase of plan?.cases ?? []) {
    if (!testCase.case_id || !testCase.title) errors.push("执行用例缺少 case_id 或 title。");
    if (ids.has(testCase.case_id)) errors.push(`执行用例 ID 重复: ${testCase.case_id}`);
    ids.add(testCase.case_id);
    try { normalizeContract(testCase); } catch (error) { errors.push(error.message); }
  }
  if ((plan?.execution_policy?.workers ?? 0) < 1) errors.push("execution_policy.workers 必须大于 0。");
  return errors;
}
