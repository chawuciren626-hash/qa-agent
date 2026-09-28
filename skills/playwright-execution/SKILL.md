---
name: playwright-execution
description: 根据结构化测试用例生成并执行 Playwright UI 测试，保存结果和证据。
version: 1.1.0
---

# Playwright 执行 Skill

## 适用场景

当需要将适合自动化的 UI 测试用例转换为 Playwright 脚本并执行时使用。

## 输入

- 当前 `run_id` 的结构化测试用例
- `config/test-env.json`
- 被测系统 URL

## 输出

- `tests/generated/*.spec.ts`
- 当前 `run_id` 的 `execution/test_results.json`
- 截图、Trace、日志等证据文件

## 工作步骤

1. 筛选 `automation_feasible=true` 且优先级为 P0/P1 的用例。
2. 生成 Playwright 测试脚本。
3. 使用稳定选择器，优先 `getByRole`、`getByLabel`、`data-testid`。
4. 执行测试命令。
5. 保存测试结果和失败证据。
6. 区分脚本问题、环境问题、产品缺陷。

## 质量标准

- 脚本可运行。
- 断言明确。
- 失败时有错误信息和证据。
- 执行结果可被后续 Bug 和报告流程消费。

## 禁止事项

- 禁止只生成脚本不执行。
- 禁止用固定等待替代可靠断言。
- 禁止把所有失败都判定为产品 Bug。

## 执行前置条件

1. 读取并解析 config/test-env.json。
2. 只有 execution.enabled=true、地址和账号不再是占位值、并且用户明确要求执行时，才允许启动浏览器。
3. 只选择 automation_feasible=true 且优先级为 P0/P1 的用例，除非用户明确扩大范围。
4. 未满足条件时，生成当前运行的 blocked 测试结果，不得访问网站。
5. 未观察到页面结构时，不能猜测 DOM 或声称脚本可执行。
6. 不得执行 `npm install`、`playwright install`、`npx` 下载或浏览器下载；只能复用项目已有依赖和本机 Chrome。缺项时输出 blocked 结果。

## 结果与证据

- 原始 Playwright 结果、HTML 报告、截图和 Trace 保存到当前运行的 `execution/playwright/`。
- 每条结果必须包含用例 ID、状态、耗时、失败分类与证据路径。
- 失败先分类为 needs_review；没有证据不得判为产品缺陷。
- 表单校验用例必须验证提交后新增或更新的真实提示元素及其文本。禁止以 `page.content()`、页面全文、placeholder 或静态标签中存在关键词作为通过依据。
