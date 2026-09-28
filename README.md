# 软件测试智能体 MVP

本项目用于基于 PenguinHarness 搭建一套软件测试智能体，目标是在一个月内完成可运行的 MVP，覆盖：

- 测试点梳理
- 测试用例编写
- 自动执行测试用例
- 记录 Bug
- 生成测试报告

## 当前阶段

已具备可追溯的多 Agent 测试闭环基础：运行归档、阶段确认、环境预检、测试点 XMind、用例 Excel、报告 Word/PDF。

## 推荐推进顺序

1. 总控根据任务选择并实际派发专业子 Agent。
2. 分析、测试点、用例和真实执行前等待人工确认。
3. 自动化执行前通过环境预检，复用现有环境，不自动下载依赖。
4. 继续补充接口、性能、安全等专业智能体。

## 关键文档

- `docs/agent-development-learning-guide.md`
- `docs/one-month-qa-agent-plan.md`
- `docs/orchestrator-prompt.md`

## 目录说明

```text
config/   项目配置和测试环境配置
inputs/   输入需求、接口文档等
skills/   测试智能体 Skill
schemas/  结构化产物 JSON Schema
tests/    自动化测试脚本
output/   测试点、用例、结果、Bug、报告等输出
scripts/  辅助执行脚本
docs/     学习文档和实施计划
```

## 运行管理

首次使用时，先复制并填写本机配置。真实环境地址、测试账号和历史运行产物默认不会提交到 Git。

```powershell
Copy-Item config/test-env.example.json config/test-env.json
Copy-Item config/test-environments.example.json config/test-environments.json
```

```powershell
npm run run:create -- --run-id=run-example
npm run environment:check -- --environment=local-gov-bid --run-id=run-example
node scripts/get-run-resume-point.mjs run-example
```

总控会在 `analysis`、`test_points`、`test_cases` 和 `execution` 阶段请求确认。确认、返工和阻塞状态均保存于该运行目录的 `manifest.json`。
