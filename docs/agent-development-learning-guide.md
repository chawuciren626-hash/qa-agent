# Agent 搭建开发学习文档

适用对象：从 0 基础开始，计划在一个月内基于 PenguinHarness 搭建一套可运行的软件测试智能体。

目标：理解 Agent 搭建的完整流程，掌握测试智能体所需的核心知识，知道每个阶段要做什么、产出什么、注意什么。

## 1. 你要先建立的整体认识

Agent 不是一个简单的聊天机器人。一个可工作的测试 Agent 通常由以下部分组成：

| 组成 | 作用 | 在测试智能体中的例子 |
|---|---|---|
| 大模型 | 负责理解、推理、生成内容 | 分析需求、生成测试点、写用例 |
| Prompt | 告诉模型扮演什么角色、按什么规则做事 | “你是测试负责人，请基于 PRD 输出测试点” |
| Skill | 可复用的专业能力说明 | 需求分析 Skill、Bug 编写 Skill、报告生成 Skill |
| Tool | Agent 可以调用的外部工具 | 文件读取、Playwright、pytest、Git、Jira API |
| Memory / Context | 当前任务上下文和历史信息 | 项目背景、需求文档、测试结果 |
| Workflow | 多步骤任务流程 | 需求分析 -> 用例设计 -> 执行 -> 缺陷 -> 报告 |
| Trace | 执行过程记录 | 查看 Agent 是否真的执行了测试命令 |
| Evaluation | 评估 Agent 输出质量 | 用例覆盖率、Bug 准确率、报告完整性 |

你最终要做的不是“问模型几个问题”，而是搭建一条稳定的测试生产线。

## 2. PenguinHarness 在项目中的定位

PenguinHarness 适合作为 Agent 运行底座。它的价值在于：

- 提供本地优先的 Agent 运行环境。
- 支持 CLI、Web、Docker、SDK 等多种使用方式。
- 支持 Skill，将测试方法沉淀成可复用能力。
- 支持 Trace，用于复盘 Agent 执行过程。
- 后续可以接入评估、插件和更多外部工具。

在本项目中，建议先采用：

```text
PenguinHarness Web / CLI
  -> 测试总控 Agent
  -> 多个测试 Skill
  -> 本地脚本和测试工具
  -> 测试产物与报告
```

第一版不追求架构复杂，先追求跑通闭环。

## 3. 测试智能体要覆盖的全过程

软件测试全过程可以拆成 6 个核心环节。

### 3.1 需求理解

输入：

- PRD 文档
- 用户故事
- 接口文档
- 原型图说明
- 代码变更 Diff
- 历史 Bug

输出：

- 模块列表
- 功能点列表
- 业务规则
- 正常流程
- 异常流程
- 风险点
- 不明确问题清单

注意点：

- Agent 不能凭空补需求。
- 遇到不明确规则要标记为“待确认”。
- 需求来源要保留，方便后续追溯。

### 3.2 测试点梳理

输出示例：

```json
{
  "id": "TP-001",
  "module": "登录",
  "feature": "账号密码登录",
  "description": "验证正确账号密码可以登录成功",
  "risk": "高",
  "coverage_type": ["功能", "主流程"],
  "source": "requirements.md#登录模块"
}
```

常见测试点类型：

- 主流程
- 分支流程
- 异常流程
- 边界值
- 权限
- 数据一致性
- 兼容性
- 性能
- 安全
- 可用性

注意点：

- 测试点不是测试用例，它更像测试覆盖地图。
- 每个重要需求至少应该对应一个测试点。
- 高风险功能要有更多异常和边界测试点。

### 3.3 测试用例编写

输出示例：

```json
{
  "case_id": "TC-001",
  "title": "正确账号密码登录成功",
  "priority": "P0",
  "type": "UI",
  "preconditions": ["测试账号已存在", "账号状态正常"],
  "test_data": {
    "username": "test_user",
    "password": "correct_password"
  },
  "steps": [
    "打开登录页",
    "输入正确账号",
    "输入正确密码",
    "点击登录按钮"
  ],
  "expected": "登录成功并跳转首页",
  "automation_feasible": true
}
```

用例质量标准：

- 标题清晰。
- 前置条件完整。
- 步骤可执行。
- 预期结果可验证。
- 有优先级。
- 有测试类型。
- 可以追溯到测试点。

注意点：

- 不要写“检查是否正常”这种模糊预期。
- 自动化用例要避免依赖不稳定数据。
- 每条用例最好只验证一个核心目标。

### 3.4 自动执行测试

常用工具：

| 测试类型 | 推荐工具 |
|---|---|
| Web UI | Playwright |
| API | pytest + requests / Newman |
| JavaScript 单测 | Vitest / Jest |
| Python 单测 | pytest |
| 性能测试 | k6 / JMeter |
| 安全扫描 | ZAP / Semgrep |

第一版建议优先做：

- Web UI：Playwright。
- API：pytest 或 Newman。
- 报告：Markdown + JSON。

执行结果至少要记录：

- 用例编号
- 执行状态
- 失败原因
- 命令输出
- 日志路径
- 截图路径
- Trace 路径

注意点：

- “脚本失败”不等于“产品 Bug”。
- 要区分环境问题、数据问题、选择器问题、产品缺陷。
- Agent 必须基于真实执行结果写报告，不能只生成看起来像报告的文本。

### 3.5 Bug 记录

Bug 草稿结构：

```json
{
  "bug_id": "BUG-001",
  "title": "登录成功后未跳转首页",
  "severity": "Major",
  "priority": "P1",
  "environment": "test",
  "related_case": "TC-001",
  "steps_to_reproduce": [
    "打开登录页",
    "输入正确账号密码",
    "点击登录按钮"
  ],
  "actual_result": "页面停留在登录页",
  "expected_result": "跳转到系统首页",
  "evidence": {
    "screenshot": "output/screenshots/BUG-001.png",
    "log": "output/logs/TC-001.log"
  },
  "analysis": "根据执行截图和日志，登录接口返回成功，但前端未跳转"
}
```

注意点：

- Bug 标题要具体。
- 复现步骤要能让开发复现。
- 证据要保留路径。
- 不确定原因时不要强行下结论。
- 相似失败要做去重，避免重复报 Bug。

### 3.6 测试报告生成

报告建议包含：

- 测试范围
- 测试环境
- 执行时间
- 用例总数
- 通过数
- 失败数
- 阻塞数
- Bug 汇总
- 高风险问题
- 遗留问题
- 上线建议

报告结论示例：

```text
本轮共执行 25 条用例，通过 21 条，失败 3 条，阻塞 1 条。
发现 Major 缺陷 1 个，Minor 缺陷 2 个。
登录、订单提交主流程通过；支付回调存在阻塞问题。
建议修复支付回调问题后再进入下一轮回归。
```

注意点：

- 报告必须来自测试结果，而不是凭空总结。
- 失败用例要能追溯到 Bug。
- 上线建议要谨慎，明确风险。

## 4. 从 0 学习路线

### 第 1 层：基础工具

需要掌握：

- 命令行基础：进入目录、运行命令、查看文件。
- Git 基础：clone、status、diff、commit。
- Markdown：写文档。
- JSON：理解结构化数据。
- Node.js 基础：安装依赖、运行 npm 脚本。

学习目标：

- 能打开项目。
- 能运行命令。
- 能看懂 JSON 和 Markdown。
- 能知道命令报错大概发生在哪里。

### 第 2 层：测试基础

需要掌握：

- 测试点是什么。
- 测试用例怎么写。
- Bug 单怎么写。
- 测试报告怎么写。
- 什么是功能测试、接口测试、自动化测试、回归测试。

学习目标：

- 能独立把一个登录功能拆成测试点。
- 能写出 5 条合格测试用例。
- 能根据失败现象写出可复现 Bug。

### 第 3 层：自动化测试

需要掌握：

- Playwright 基本用法。
- 定位元素。
- 断言。
- 测试报告。
- 截图和 Trace。

学习目标：

- 能写一个打开网页、点击按钮、断言结果的测试。
- 能运行测试。
- 能看懂失败日志。

### 第 4 层：Agent 基础

需要掌握：

- Prompt 编写。
- Tool 调用。
- Skill 编写。
- Agent 工作流设计。
- 上下文管理。

学习目标：

- 能写一个“需求分析 Skill”。
- 能让 Agent 读取需求并输出固定格式结果。
- 能让 Agent 调用测试命令并总结结果。

### 第 5 层：工程化

需要掌握：

- 项目目录设计。
- 配置管理。
- 日志与 Trace。
- 结果文件规范。
- CI/CD 基础。
- 评估和回归。

学习目标：

- 能把 Agent 从一次性演示变成可重复运行的工具。
- 能保存每轮执行产物。
- 能定位 Agent 哪里做错了。

## 5. 项目建议目录

```text
qa-agent/
  README.md
  docs/
    agent-development-learning-guide.md
    one-month-qa-agent-plan.md
  config/
    project.json
    test-env.json
  inputs/
    requirements.md
    api.yaml
  skills/
    requirement-analysis/
      SKILL.md
    test-point-design/
      SKILL.md
    test-case-writing/
      SKILL.md
    playwright-execution/
      SKILL.md
    bug-reporting/
      SKILL.md
    test-report-writing/
      SKILL.md
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

## 6. Skill 设计模板

每个 Skill 可以按这个模板写：

```markdown
# Skill 名称

## 适用场景

说明什么时候使用该 Skill。

## 输入

说明需要哪些输入文件、参数或上下文。

## 输出

说明必须输出什么文件、什么字段、什么格式。

## 工作步骤

1. 读取输入。
2. 分析信息。
3. 生成结构化结果。
4. 自检质量。

## 质量标准

- 字段完整。
- 结论可追溯。
- 不编造信息。
- 不确定项要标记。

## 禁止事项

- 禁止凭空补充需求。
- 禁止忽略失败日志。
- 禁止把脚本错误直接判定为产品 Bug。
```

## 7. Agent 工作流设计

建议第一版工作流：

```text
输入需求
  -> 需求分析
  -> 测试点生成
  -> 测试用例生成
  -> 自动化脚本生成
  -> 执行测试
  -> 解析结果
  -> Bug 草稿
  -> 测试报告
```

每一步都要有文件产物，不能只停留在聊天窗口。

## 8. Agent 搭建注意事项

### 8.1 防止 Agent 幻觉

做法：

- 要求输出引用来源。
- 不确定就标记“待确认”。
- 重要结论必须基于文件、日志、截图、命令输出。
- 把输出结构化，减少自由发挥。

### 8.2 防止只生成不执行

做法：

- 工作流中明确要求执行命令。
- 保存命令、退出码、输出。
- 执行失败也要记录。
- 报告中区分“未执行”和“执行失败”。

### 8.3 防止测试不可复现

做法：

- 固定测试环境。
- 使用测试账号。
- 准备测试数据。
- 每次运行记录环境变量和版本。
- 对数据创建和清理写清楚。

### 8.4 防止自动化脚本脆弱

做法：

- 优先使用稳定选择器，如 `data-testid`。
- 避免依赖等待固定秒数。
- 使用断言等待。
- 失败时截图。
- 对 flaky 用例单独标记。

### 8.5 防止 Bug 误报

做法：

- 先判断是否环境不可用。
- 再判断是否脚本错误。
- 再判断是否测试数据问题。
- 最后判断是否产品缺陷。
- 无法判断时输出“待人工确认”。

## 9. 第一版能力边界

建议第一版做到：

- 能读取 Markdown 需求。
- 能生成测试点。
- 能生成测试用例。
- 能生成少量 Playwright 用例。
- 能执行测试。
- 能生成 Bug 草稿。
- 能生成测试报告。

第一版暂不做：

- 完整测试管理平台。
- 大规模多 Agent 调度。
- 全自动创建线上 Bug。
- 复杂权限系统。
- 高级视觉回归。
- 性能压测平台。

## 10. 最小可运行闭环

最小闭环可以定义为：

1. 输入 `inputs/requirements.md`。
2. Agent 输出 `output/test_points.md`。
3. Agent 输出 `output/test_cases.json`。
4. Agent 生成 `tests/generated/login.spec.ts`。
5. 执行 `npx playwright test`。
6. 生成 `output/test_results.json`。
7. 失败时生成 `output/bugs.md`。
8. 生成 `output/test_report.md`。

只要这 8 步跑通，就说明测试智能体 MVP 成立。

## 11. 后续你和 Codex 的协作方式

建议每次只推进一个明确任务，例如：

```text
请帮我完成第 1 周第 2 天任务：初始化 qa-agent 项目目录，并创建基础 Skill 模板。
```

或者：

```text
请基于 docs/one-month-qa-agent-plan.md，继续执行今天的任务。
```

我可以后续继续帮你：

- 创建项目目录。
- 编写 Skill。
- 写脚本。
- 接 Playwright。
- 设计 JSON Schema。
- 生成样例需求。
- 跑通测试闭环。
- 修复运行报错。
- 生成报告模板。

