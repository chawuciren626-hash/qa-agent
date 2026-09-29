import { readFileSync } from "node:fs";

const priorityScores = { P0: 400, P1: 300, P2: 200, P3: 100 };
const riskScores = { high: 80, medium: 40, low: 10 };
const maturityScores = { stable: 30, candidate: 10, manual_only: -20 };
const costPenalty = { low: 0, medium: 10, high: 25 };

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function normalizeRisk(value) {
  return ({ "高": "high", "中": "medium", "低": "low", high: "high", medium: "medium", low: "low" })[value] ?? "medium";
}

export function metadataFor(testCase, defaultDuration) {
  const metadata = testCase.execution_metadata ?? {};
  return {
    modules: metadata.modules ?? (testCase.module ? [testCase.module] : []),
    tags: metadata.tags ?? [],
    risk_level: normalizeRisk(metadata.risk_level ?? testCase.risk),
    execution_cost: metadata.execution_cost ?? "medium",
    data_impact: metadata.data_impact ?? testCase.execution_contract?.data_isolation ?? "shared",
    environment_dependencies: metadata.environment_dependencies ?? [],
    automation_maturity: metadata.automation_maturity ?? (testCase.automation_feasible ? "candidate" : "manual_only"),
    estimated_duration_ms: Math.max(1, Number(metadata.estimated_duration_ms ?? defaultDuration))
  };
}

export function score(testCase, metadata) {
  return (priorityScores[testCase.priority] ?? 0) +
    (riskScores[metadata.risk_level] ?? 0) +
    (maturityScores[metadata.automation_maturity] ?? 0) -
    (costPenalty[metadata.execution_cost] ?? 10);
}

export function matchesProfile(testCase, metadata, profile, changedModules, changedTags) {
  switch (profile.match) {
    case "priority_or_risk":
      return profile.priorities.includes(testCase.priority) || profile.risk_levels.includes(metadata.risk_level);
    case "priority":
      return profile.priorities.includes(testCase.priority);
    case "changed_scope":
      if (!changedModules.length && !changedTags.length) throw new Error("targeted Profile 必须提供 --changed-modules 或 --changed-tags。");
      return changedModules.some((module) => metadata.modules.includes(module)) || changedTags.some((tag) => metadata.tags.includes(tag));
    case "all":
      return true;
    default:
      throw new Error(`不支持的选择规则: ${profile.match}`);
  }
}
