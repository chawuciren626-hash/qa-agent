# 一个月软件测试智能体搭建计划

目标：用 1 个月时间，从 0 基础开始，基于 PenguinHarness 搭建一套可运行的软件测试智能体 MVP，覆盖测试点梳理、用例编写、自动执行、Bug 记录和测试报告。

计划原则：

- 先跑通，再优化。
- 先本地文件闭环，再接平台系统。
- 先单 Agent + 多 Skill，再升级多 Agent。
- 每周都要有可见产物。
- 每个阶段都保留执行记录，便于复盘。

## 总体交付物

最终希望交付以下内容：

```text
qa-agent/
  docs/
    agent-development-learning-guide.md
    one-month-qa-agent-plan.md
  inputs/
    requirements.md
  skills/
    requirement-analysis/SKILL.md
    test-point-design/SKILL.md
    test-case-writing/SKILL.md
    playwright-execution/SKILL.md
    bug-reporting/SKILL.md
    test-report-writing/SKILL.md
  schemas/
    test_point.schema.json
    test_case.schema.json
    bug.schema.json
  tests/
    generated/
  output/
    test_points.md
    test_cases.json
    test_results.json
    bugs.md
    test_report.md
  scripts/
    run-ui-tests.mjs
    parse-playwright-result.mjs
```

## 第 1 周：基础学习与环境跑通

目标：理解基础概念，跑通 PenguinHarness，准备测试智能体项目骨架。

### Day 1：理解项目目标和 Agent 基础

学习内容：

- 什么是 Agent。
- Agent 和普通 ChatBot 的区别。
- 什么是 Prompt、Skill、Tool、Workflow、Trace。
- 软件测试智能体要解决什么问题。

实践任务：

- 阅读 `docs/agent-development-learning-guide.md` 的第 1-4 节。
- 明确你的测试智能体第一版范围。

产出：

- `docs/project-scope.md`，写清楚第一版做什么、不做什么。

验收：

- 能用自己的话说清楚测试智能体的完整流程。

### Day 2：安装和运行 PenguinHarness

学习内容：

- CLI 是什么。
- Web 服务是什么。
- 模型配置是什么。

实践任务：

- 安装 PenguinHarness。
- 配置模型。
- 启动 Web。
- 用 CLI 跑一次简单任务。

参考命令：

```powershell
irm https://penguin.ooo/install.ps1 | iex
penguin web
```

或者：

```bash
npm install -g @prismshadow/penguin-cli
penguin web
```

产出：

- `docs/environment-setup-notes.md`，记录安装命令、问题、解决方式。

验收：

- Web 能打开。
- CLI 能成功运行一次任务。

### Day 3：学习 Markdown、JSON 和项目目录

学习内容：

- Markdown 文档写法。
- JSON 数据格式。
- 项目目录组织方式。

实践任务：

- 创建项目目录。
- 创建 `inputs/requirements.md`。
- 创建 `output/`、`skills/`、`schemas/`、`scripts/`。

产出：

- 项目骨架。
- 一份简单需求文档。

验收：

- 能解释每个目录的作用。

### Day 4：学习测试基础

学习内容：

- 测试点。
- 测试用例。
- Bug 单。
- 测试报告。

实践任务：

- 用一个登录功能手工写 10 个测试点。
- 写 5 条测试用例。
- 写 1 个 Bug 示例。

产出：

- `output/manual_test_points.md`
- `output/manual_test_cases.md`
- `output/manual_bug_example.md`

验收：

- 用例包含前置条件、步骤、预期结果。

### Day 5：创建第一批 Skill 模板

学习内容：

- Skill 的作用。
- Skill 输入输出。
- Skill 质量标准。

实践任务：

- 创建 3 个 Skill：
  - `requirement-analysis`
  - `test-point-design`
  - `test-case-writing`

产出：

- `skills/requirement-analysis/SKILL.md`
- `skills/test-point-design/SKILL.md`
- `skills/test-case-writing/SKILL.md`

验收：

- 每个 Skill 有适用场景、输入、输出、步骤、质量标准、禁止事项。

### Day 6：用 Agent 生成测试点和用例

学习内容：

- 如何给 Agent 下任务。
- 如何约束输出格式。
- 如何检查 Agent 输出质量。

实践任务：

- 用 `inputs/requirements.md` 让 Agent 生成测试点。
- 再让 Agent 生成测试用例。

产出：

- `output/test_points.md`
- `output/test_cases.json`

验收：

- 测试点能覆盖主流程、异常流程、边界值。
- 用例 JSON 字段完整。

### Day 7：第 1 周复盘

任务：

- 整理本周问题。
- 优化 Skill。
- 补充学习笔记。

产出：

- `docs/week1-review.md`

验收：

- 能从一份需求生成测试点和测试用例。

## 第 2 周：自动化测试执行能力

目标：学习 Playwright，并让 Agent 能生成和执行基础自动化测试。

### Day 8：学习 Playwright 基础

学习内容：

- 安装 Playwright。
- 编写第一个测试。
- 运行测试。
- 查看报告。

实践任务：

```bash
npm init -y
npm install -D @playwright/test
npx playwright install
npx playwright test
```

产出：

- `tests/example.spec.ts`

验收：

- 能成功运行一个 Playwright 测试。

### Day 9：学习定位和断言

学习内容：

- `page.goto`
- `page.getByRole`
- `page.locator`
- `expect`
- 截图

实践任务：

- 写一个打开网页并断言标题的测试。
- 失败时保存截图。

产出：

- `tests/basic-ui.spec.ts`

验收：

- 能看懂成功和失败日志。

### Day 10：设计自动化用例格式

学习内容：

- 哪些用例适合自动化。
- 如何从 JSON 用例生成测试脚本。

实践任务：

- 给 `test_cases.json` 增加自动化字段。
- 编写 `test_case.schema.json`。

产出：

- `schemas/test_case.schema.json`

验收：

- 每条用例能标记是否适合自动化。

### Day 11：创建 Playwright 执行 Skill

实践任务：

- 创建 `skills/playwright-execution/SKILL.md`。
- 规定输入：测试用例、测试环境 URL。
- 规定输出：测试脚本、执行结果、截图、日志。

产出：

- `skills/playwright-execution/SKILL.md`

验收：

- Skill 能指导 Agent 生成和运行测试脚本。

### Day 12：生成第一条自动化测试

实践任务：

- 让 Agent 基于一条登录或首页访问用例生成 Playwright 脚本。
- 执行脚本。
- 保存结果。

产出：

- `tests/generated/smoke.spec.ts`
- `output/test_results.json`

验收：

- 至少有 1 条自动化用例成功执行。

### Day 13：解析测试结果

实践任务：

- 编写或生成 `scripts/parse-playwright-result.mjs`。
- 将 Playwright 输出转为统一 JSON。

产出：

- `scripts/parse-playwright-result.mjs`
- `output/test_results.json`

验收：

- 能看到用例通过、失败、耗时、错误信息。

### Day 14：第 2 周复盘

任务：

- 整理自动化测试常见报错。
- 优化执行 Skill。
- 确定第一版只支持哪些测试类型。

产出：

- `docs/week2-review.md`

验收：

- 能生成并执行至少 1 条自动化测试。

## 第 3 周：Bug 记录与测试报告闭环

目标：把测试失败转成 Bug 草稿，并生成测试报告。

### Day 15：学习 Bug 编写规范

学习内容：

- Bug 标题。
- 严重级别。
- 优先级。
- 复现步骤。
- 实际结果和预期结果。
- 证据。

实践任务：

- 手工写 3 个 Bug 示例。

产出：

- `output/manual_bugs.md`

验收：

- 每个 Bug 都能复现、能定位证据。

### Day 16：创建 Bug 记录 Skill

实践任务：

- 创建 `skills/bug-reporting/SKILL.md`。
- 定义 Bug JSON Schema。

产出：

- `skills/bug-reporting/SKILL.md`
- `schemas/bug.schema.json`

验收：

- Skill 明确区分产品 Bug、脚本问题、环境问题。

### Day 17：从失败结果生成 Bug 草稿

实践任务：

- 构造 1 条失败测试结果。
- 让 Agent 生成 Bug 草稿。

产出：

- `output/bugs.md`
- `output/bugs.json`

验收：

- Bug 草稿包含复现步骤、实际结果、预期结果、证据路径。

### Day 18：学习测试报告结构

学习内容：

- 测试范围。
- 执行概况。
- 缺陷分布。
- 风险说明。
- 上线建议。

实践任务：

- 手工写一份测试报告样例。

产出：

- `output/manual_test_report.md`

验收：

- 报告能让项目经理快速理解质量状态。

### Day 19：创建报告生成 Skill

实践任务：

- 创建 `skills/test-report-writing/SKILL.md`。
- 定义报告模板。

产出：

- `skills/test-report-writing/SKILL.md`

验收：

- Skill 要求报告基于测试结果和 Bug，不允许凭空总结。

### Day 20：串联测试闭环

实践任务：

- 从需求开始，完整执行：
  1. 生成测试点。
  2. 生成用例。
  3. 生成自动化脚本。
  4. 执行测试。
  5. 生成 Bug。
  6. 生成报告。

产出：

- `output/test_points.md`
- `output/test_cases.json`
- `tests/generated/*.spec.ts`
- `output/test_results.json`
- `output/bugs.md`
- `output/test_report.md`

验收：

- 全流程至少跑通一次。

### Day 21：第 3 周复盘

任务：

- 梳理闭环卡点。
- 优化目录、文件格式和 Skill。
- 标记暂时不能自动化的部分。

产出：

- `docs/week3-review.md`

验收：

- 测试全过程有完整产物。

## 第 4 周：工程化、稳定性与展示

目标：让项目更像一个可交付工具，而不是一次性演示。

### Day 22：统一配置

实践任务：

- 创建 `config/project.json`。
- 创建 `config/test-env.json`。
- 把测试环境 URL、账号、执行参数放到配置里。

产出：

- `config/project.json`
- `config/test-env.json`

验收：

- 不需要每次手动在 prompt 里写环境信息。

### Day 23：统一运行入口

实践任务：

- 创建 `scripts/run-ui-tests.mjs`。
- 统一执行测试、保存结果。

产出：

- `scripts/run-ui-tests.mjs`

验收：

- 一条命令能执行自动化测试并生成结果文件。

### Day 24：增加质量检查

实践任务：

- 检查 JSON 格式。
- 检查用例字段完整性。
- 检查报告是否引用真实结果。

产出：

- `scripts/validate-artifacts.mjs`

验收：

- 缺字段时能提示错误。

### Day 25：整理总控 Prompt

实践任务：

- 写一个完整的测试总控 Prompt。
- 明确每一步输入和输出。

产出：

- `docs/orchestrator-prompt.md`

验收：

- 把 Prompt 给 Agent 后，能按流程执行。

### Day 26：做一次完整演示

实践任务：

- 准备一份样例需求。
- 从 0 跑完整流程。
- 记录命令和截图。

产出：

- `docs/demo-record.md`
- 完整 `output/` 产物。

验收：

- 能向别人演示智能体如何完成测试全过程。

### Day 27：修复问题和补文档

实践任务：

- 修复演示中发现的问题。
- 补充 README。
- 整理常见问题。

产出：

- `README.md`
- `docs/faq.md`

验收：

- 新人按 README 能跑起来。

### Day 28：评估 Agent 输出质量

实践任务：

- 准备 3 份不同需求。
- 分别运行流程。
- 对测试点、用例、Bug、报告评分。

产出：

- `docs/evaluation.md`

验收：

- 能知道 Agent 哪些地方稳定，哪些地方需要人工复核。

### Day 29：最终整理

实践任务：

- 整理项目结构。
- 删除无用临时文件。
- 检查产物完整性。
- 固化版本。

产出：

- 最终项目目录。
- 最终文档。

验收：

- 项目可运行，文档可读，产物完整。

### Day 30：交付和下一阶段计划

实践任务：

- 写最终总结。
- 列出下一阶段计划。

产出：

- `docs/final-summary.md`
- `docs/next-stage-plan.md`

验收：

- 完成一个月 MVP。
- 明确下一阶段是否接 Jira、禅道、CI/CD、多 Agent。

## 每周里程碑

| 时间 | 目标 | 核心产物 |
|---|---|---|
| 第 1 周 | 环境跑通，能生成测试点和用例 | Skill 模板、测试点、用例 |
| 第 2 周 | 能生成并执行自动化测试 | Playwright 脚本、测试结果 |
| 第 3 周 | 能记录 Bug 和生成报告 | Bug 草稿、测试报告 |
| 第 4 周 | 工程化和演示交付 | 统一入口、README、演示记录 |

## 每天学习和开发节奏

建议每天 2-3 小时：

```text
30 分钟：学习当天概念
60 分钟：跟着任务实践
30 分钟：记录问题和笔记
30-60 分钟：让 Codex 帮你修复、完善、生成文档
```

如果时间不够，优先保证实践任务完成。

## 后续可以让我执行的任务清单

你可以直接用下面这些话让我继续推进：

```text
请帮我执行第 1 周 Day 3：创建测试智能体项目骨架。
```

```text
请帮我创建 requirement-analysis、test-point-design、test-case-writing 三个 Skill。
```

```text
请帮我基于一个登录功能样例生成 requirements.md、测试点和测试用例。
```

```text
请帮我接入 Playwright，并创建第一条可运行的自动化测试。
```

```text
请帮我实现 test_results.json、bugs.md、test_report.md 的生成流程。
```

```text
请按照 one-month-qa-agent-plan.md 继续执行今天的任务。
```

## MVP 验收标准

一个月后，MVP 至少要满足：

- 能读取一份需求文档。
- 能输出测试点。
- 能输出结构化测试用例。
- 能生成至少 3 条自动化测试脚本。
- 能执行自动化测试。
- 能保存测试结果。
- 能根据失败生成 Bug 草稿。
- 能生成测试报告。
- 有 README 告诉别人怎么运行。

## 下一阶段扩展方向

MVP 完成后再考虑：

- 接入 Jira、禅道或 GitHub Issues。
- 接入 CI/CD。
- 支持接口测试。
- 支持多 Agent 协作。
- 支持历史缺陷学习。
- 支持用例评审。
- 支持覆盖率评估。
- 支持 Allure 报告。
- 支持企业测试平台同步。

