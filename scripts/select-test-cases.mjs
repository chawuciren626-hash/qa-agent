import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCases } from "./execution-plan.mjs";
import { matchesProfile, metadataFor, readJson, score } from "./test-selection.mjs";

const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, value] = arg.slice(2).split(/=(.*)/s);
  return [key, value];
}));
const runId = args["run-id"];
const sourceArg = args.cases;
const profileId = args.profile ?? "smoke";
if (!runId || !sourceArg) throw new Error("用法: node scripts/select-test-cases.mjs --run-id=<run_id> --cases=<test_cases.json> [--profile=smoke]");
const policy = JSON.parse(readFileSync(resolve(root, "config/test-selection-policy.json"), "utf8"));
const profile = policy.profiles[profileId];
if (!profile) throw new Error(`未知选择 Profile: ${profileId}`);
const sourcePath = resolve(root, sourceArg);
if (!existsSync(sourcePath)) throw new Error(`找不到测试用例文件: ${sourcePath}`);
const changedModules = (args["changed-modules"] ?? "").split(",").filter(Boolean);
const changedTags = (args["changed-tags"] ?? "").split(",").filter(Boolean);
const requestedIds = new Set((args["case-ids"] ?? "").split(",").filter(Boolean));
const environment = args.environment;
const budget = args["budget-ms"] === undefined ? profile.max_estimated_duration_ms : Number(args["budget-ms"]);
const candidates = extractCases(readJson(sourcePath)).map((testCase) => {
  const metadata = metadataFor(testCase, policy.default_estimated_duration_ms);
  return { testCase, metadata, score: score(testCase, metadata) };
});
const selected = [];
const excluded = [];
const eligible = candidates.filter((candidate) => {
  const { testCase, metadata } = candidate;
  if (environment && metadata.environment_dependencies.length && !metadata.environment_dependencies.includes(environment)) {
    excluded.push({ case_id: testCase.case_id, reason: "环境依赖不匹配" });
    return false;
  }
  const matches = requestedIds.size ? requestedIds.has(testCase.case_id) : matchesProfile(testCase, metadata, profile, changedModules, changedTags);
  if (!matches) {
    excluded.push({ case_id: testCase.case_id, reason: "未命中选择条件" });
    return false;
  }
  return true;
}).sort((a, b) => b.score - a.score || a.testCase.case_id.localeCompare(b.testCase.case_id));
let budgetUsed = 0;
for (const candidate of eligible) {
  const mandatory = profile.mandatory_priorities?.includes(candidate.testCase.priority) ?? false;
  const exceedsBudget = budget !== null && budgetUsed + candidate.metadata.estimated_duration_ms > budget;
  if (exceedsBudget && !mandatory) {
    excluded.push({ case_id: candidate.testCase.case_id, reason: "超出执行预算" });
    continue;
  }
  budgetUsed += candidate.metadata.estimated_duration_ms;
  selected.push({
    case_id: candidate.testCase.case_id,
    title: candidate.testCase.title,
    score: candidate.score,
    estimated_duration_ms: candidate.metadata.estimated_duration_ms,
    execution_metadata: candidate.metadata,
    reason: requestedIds.size ? "用户明确指定" : `命中 ${profileId} Profile${mandatory && exceedsBudget ? "，P0 保留并超出预算" : ""}`
  });
}
const result = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  profile: profileId,
  criteria: { changed_modules: changedModules, changed_tags: changedTags, environment: environment ?? null, budget_ms: budget, requested_case_ids: [...requestedIds] },
  source: sourceArg.replace(/\\/g, "/"),
  selected,
  excluded,
  summary: { total_cases: candidates.length, selected: selected.length, excluded: excluded.length, estimated_duration_ms: budgetUsed, budget_exceeded: budget !== null && budgetUsed > budget }
};
const targetDir = resolve(root, "output/runs", runId, "selection");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "test-selection.json");
writeFileSync(target, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, profile: profileId, selected: selected.length, estimated_duration_ms: budgetUsed, output: target }, null, 2));
