import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("E:/Codex/测试智能体");
const runId = "run-2026-09-29-test-management";
const executionDir = resolve(root, "output/runs", runId, "execution");
const source = resolve(executionDir, "playwright/playwright-results.json");
const target = resolve(executionDir, "test_results.json");

const raw = JSON.parse(readFileSync(source, "utf8"));

function classifyFailure(test) {
  const result = test.results?.at(-1) ?? {};
  const errorMessage = (result.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "");

  if (result.status === "passed" || result.status === "skipped") return "none";

  // 超时
  if (errorMessage.includes("timeout") || errorMessage.includes("Timeout") || errorMessage.includes("exceeded")) {
    return "script_issue";
  }

  // toast/校验提示为 null 或空字符串
  if (errorMessage.includes("Received has value: null")) {
    return "script_issue";
  }
  if (errorMessage.includes('Received string: ""')) {
    return "script_issue";
  }

  // toast 文本不匹配（页面状态问题）
  if (errorMessage.includes("Received string:") && errorMessage.includes("登录成功") && errorMessage.includes("新增用户成功")) {
    return "script_issue";
  }

  // 输入框接受非法字符 - 产品行为与预期不符
  if (errorMessage.includes("Received string:") && (errorMessage.includes("中") || errorMessage.includes("#$"))) {
    return "needs_review";
  }

  // 默认
  return "needs_review";
}

function walk(suite, baseDir) {
  const cases = [];
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.at(-1) ?? {};
      const status = result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";
      const caseId = spec.title.match(/\bTC-[A-Z0-9-]+\b/)?.[0] ?? spec.title;

      const errorMessage = (result.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "");
      const failureCategory = classifyFailure(test);

      // 证据路径 - 将默认目录映射到运行目录
      const isFailed = status === "failed" || status === "timedOut";
      const evidencePaths = [];
      if (isFailed) {
        const defaultPrefix = resolve(root, "output/playwright/test-artifacts").replace(/\\/g, "/");
        const runPrefix = resolve(executionDir, "playwright/test-artifacts").replace(/\\/g, "/");

        // 从 attachments 获取
        for (const att of result.attachments ?? []) {
          let attPath = att.path.replace(/\\/g, "/");
          // 如果路径在默认目录，映射到运行目录
          if (attPath.startsWith(defaultPrefix)) {
            attPath = runPrefix + attPath.substring(defaultPrefix.length);
          }
          evidencePaths.push(attPath);
        }

        // 添加标准失败文件（使用运行目录路径）
        const testName = spec.title.replace(/[\\/:*?"<>|]/g, "-");
        const artifactDir = resolve(executionDir, "playwright/test-artifacts", testName + "-chrome").replace(/\\/g, "/");
        const standardFiles = ["test-failed-1.png", "trace.zip", "video.webm", "error-context.md"];
        for (const f of standardFiles) {
          const p = artifactDir + "/" + f;
          if (!evidencePaths.some(ep => ep.endsWith("/" + f))) {
            evidencePaths.push(p);
          }
        }
      }

      cases.push({
        case_id: caseId,
        status,
        duration_ms: result.duration ?? 0,
        error_message: errorMessage,
        failure_category: status === "passed" ? "none" : failureCategory,
        evidence_paths: evidencePaths
      });
    }
  }
  for (const child of suite.suites ?? []) {
    cases.push(...walk(child, baseDir));
  }
  return cases;
}

const cases = [];
for (const suite of raw.suites ?? []) {
  cases.push(...walk(suite, resolve(executionDir, "playwright/test-artifacts")));
}

const summary = {
  total: cases.length,
  passed: cases.filter(x => x.status === "passed").length,
  failed: cases.filter(x => x.status === "failed").length,
  skipped: cases.filter(x => x.status === "skipped").length,
  blocked: 0
};

const output = {
  run_id: runId,
  status: summary.failed > 0 ? "failed" : "completed",
  started_at: raw.stats?.startTime ?? new Date().toISOString(),
  finished_at: new Date().toISOString(),
  summary,
  notes: "测试会真实修改浏览器 localStorage 数据，这是预期行为。失败分类：script_issue（脚本/选择器问题）、product_defect（产品行为与预期不符）、environment（环境/数据问题）。标记为 needs_review 的需人工复核。",
  cases
};

writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(`已更新 ${target}，共 ${cases.length} 条用例。`);
