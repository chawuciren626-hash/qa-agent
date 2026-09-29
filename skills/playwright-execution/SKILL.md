---
name: playwright-execution
description: 根据结构化测试用例生成并执行 Playwright UI 测试，保存结果和证据。
version: 2.0.0
---

# Playwright 执行 Skill

## 适用场景

当需要将适合自动化的 UI 测试用例转换为 Playwright 脚本并执行时使用。

## 输入

- 当前 `run_id` 的结构化测试用例与 `execution/execution-plan.json`
- `config/test-env.json`
- 被测系统 URL

## 输出

- `tests/generated/*.spec.ts` 与 `tests/framework/` 可复用执行合同
- 当前 `run_id` 的 `execution/execution-plan.json`
- 当前 `run_id` 的 `execution/test_results.json`
- 截图、Trace、日志等证据文件

## 工作步骤

1. 将 `automation_feasible=true` 的用例转为执行计划，并为每条用例声明数据隔离、准备、断言和清理合同。
2. 调用 `execution:plan:validate`，再生成遵循执行合同的 Playwright 测试脚本。
3. 使用稳定选择器，优先 `getByRole`、`getByLabel`、`data-testid`。
4. 仅在用户批准后调用 `test:ui -- --run-id=<run_id>`；执行器会完成环境预检并只运行计划内用例。
5. 保存测试结果和失败证据，执行结束后仅保留 `execution/playwright/` 作为证据根目录。
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
- 禁止成功路径使用违反字段长度、格式或唯一性规则的测试数据。
- Toast/动态提示必须等待目标文本更新；禁止仅以元素已可见或固定等待作为通过依据。
- 禁止用例依赖前一个用例创建的数据；每条涉及写操作的用例必须独立准备和清理数据。

## 执行前置条件

1. 读取并解析 config/test-env.json。
2. 只有 execution.enabled=true、地址和账号不再是占位值、并且用户明确要求执行时，才允许启动浏览器。
3. 只运行已校验执行计划中的用例；用例筛选策略由总控或后续测试选择能力确定，不在执行器中写死优先级规则。
4. 未满足条件时，生成当前运行的 blocked 测试结果，不得访问网站。
5. 未观察到页面结构时，不能猜测 DOM 或声称脚本可执行。
6. 不得执行 `npm install`、`playwright install`、`npx` 下载或浏览器下载；只能复用项目已有依赖和本机 Chrome。缺项时输出 blocked 结果。

## 结果与证据

- 原始 Playwright 结果、HTML 报告、截图和 Trace 保存到当前运行的 `execution/playwright/`。
- 每条结果必须包含用例 ID、状态、耗时、失败分类与证据路径。
- 失败先分类为 needs_review；没有证据不得判为产品缺陷。
- 表单校验用例必须验证提交后新增或更新的真实提示元素及其文本。禁止以 `page.content()`、页面全文、placeholder 或静态标签中存在关键词作为通过依据。
- 生成脚本必须使用执行合同，明确数据隔离、准备、断言和清理。默认 `shared` 用例只能串行执行；只有 `read_only` 或 `isolated` 用例可使用环境允许的并发数。
