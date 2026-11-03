import { expect, it } from "vitest";
import { normalizeStageMarkdown, splitStageMarkdown } from "../src/features/qa/stage-markdown";

it("keeps legacy field labels and values on one line without changing code fences", () => {
  const source = "## TP-1\n\n**测试点**\n\n空值提示\n\n**风险**\n\n高\n\n```md\n**风险**\n\n原样\n```";
  const result = normalizeStageMarkdown(source);
  expect(result).toContain("**测试点：** 空值提示");
  expect(result).toContain("**风险：** 高");
  expect(result).toContain("```md\n**风险**\n\n原样\n```");
});

it("separates points and execution results but ignores headings inside code fences", () => {
  expect(splitStageMarkdown("# 标题\n\n## TP-1\n内容\n## TP-2\n内容")).toHaveLength(3);
  const result = splitStageMarkdown("## 逐条结果\n```md\n### 不是用例\n```\n### C1\n通过\n### C2\n失败");
  expect(result.map(section => section.level)).toEqual([2, 3, 3]);
  expect(result[0]?.content).toContain("### 不是用例");
});

it("separates every requirement rule and source under its ledger heading", () => {
  const result = splitStageMarkdown("# 需求分析\n## 规则台账\n### REQ\\-LOGIN\\-001\n- 类型：requirement\n### REQ\\-LOGIN\\-002\n- 类型：constraint\n## 来源\n### SRC\\-1\n- 原文引用：登录");
  expect(result.map(section => section.level)).toEqual([0, 2, 3, 3, 2, 3]);
  expect(result[2]?.content).toContain("REQ\\-LOGIN\\-001");
  expect(result[3]?.content).not.toContain("001");
});
