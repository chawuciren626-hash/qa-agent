# 软件测试智能体

这是一个以 PenguinHarness 为运行入口的多 Agent 软件测试工程。它将需求理解、测试设计、受控自动化执行、缺陷治理和质量报告归档到一次独立的 `run_id` 中。

当前默认模型为 `tokendance / step-3.7-flash`。PenguinHarness 负责调度 Agent；本仓库负责版本化的工作流、Skill、脚本、数据契约和文档。

## 当前能力

- 六阶段编排：需求分析、测试点、测试用例、执行、缺陷、报告。
- XMind 测试点、JSON/Excel 测试用例、Markdown/Word/PDF 测试报告。
- 运行计划、阶段状态机、人工确认、恢复点和审计事件。
- 资产目录、执行合同、环境预检和本地 Playwright 执行。
- 测试选择 Profile、预算与变更定向选择。
- 失败证据评估、标准缺陷记录、质量门和跨运行趋势。
- 统一产物契约：Schema、跨文件引用、结果统计、导出一致性及阶段交接哈希复核。
- 独立执行批次、原始证据归档、执行锁、整批超时与显式中断恢复。
- [统一命令入口](docs/command-runtime.md)：原生Node/Python、依赖预检、参数数组、命令超时与独立日志，正常运行不下载依赖。
- [需求来源与语义治理](docs/requirement-provenance.md)：规则台账、原文引用、需求/观察/假设区分、测试点与用例追溯及确认边界。
- [结构化分析单一来源](docs/analysis-single-source.md)：从台账生成正文，拦截Markdown与结构化内容不一致，保留历史与审批边界。
- [受控阶段恢复与派发](docs/controlled-stage-recovery.md)：清单锁、派发编号、父子会话绑定、恢复审计及旧批准失效；不等同于操作系统权限隔离。
- 缺陷审计台账、独立复测关闭、历史未解决问题质量门及报告失效管理，详见[质量治理闭环](docs/quality-governance-lifecycle.md)。

## 使用边界

- [结构化动作入口](docs/structured-actions.md)：优先用JSON请求创建、规划、归档与交接，减少模型拼接CLI；失败摘要明确审计覆盖范围。

- [总控会话命令闸门](docs/controller-command-session.md)：生命周期帮助、run创建前失败记录、跨调用阻止继续及审查解除；Agent命令需传真实controller-session，不等同于工具隔离。

- [清单状态摘要](docs/run-status-summary.md)：只读生成阶段、最新确认、范围和审查提示，区分流程记录与产品测试结论。

- [命令与子任务停止契约](docs/command-stop-contract.md)：预启动参数检查、派发约束原文传递及失败后禁止登记完成；不等同于实时工具拦截。

- 正常测试运行不得执行 `npm install`、`pip install`、`playwright install` 或会隐式下载的 `npx` 命令。
- 真实浏览器执行必须先获得用户确认，并使用登记的非生产测试环境。
- 账号、密码、Token、真实环境地址和运行产物不提交 Git；它们由已忽略的本地配置和 `output/` 保存。
- Agent 的公开指令、Skill 映射和同步脚本已纳入 `penguin/`；模型密钥、环境凭据和应用内部配置仍只保留在本机。详见 [PenguinHarness 配置即代码](docs/penguinharness-configuration.md)。

## 快速开始

1. 在 PenguinHarness 中选择工作区 `E:\Codex\测试智能体`，使用“软件测试总控智能体”。
2. 将需求文字、文档或链接交给总控；它根据目标选择所需专业 Agent，而非强制执行全流程。
3. 新任务必须创建独立运行并生成计划：

```powershell
npm run run:create -- --run-id=run-example
npm run run:plan -- --run-id=run-example --stages=analysis,test_points,test_cases
```

4. 在分析、测试点、测试用例和真实执行节点完成人工确认。总控会将正式产物保存在 `output/runs/run-example/`。

真实执行前，先从样例创建本地环境配置：

```powershell
Copy-Item config/test-env.example.json config/test-env.json
Copy-Item config/test-environments.example.json config/test-environments.json
npm run environment:check -- --environment=<environment_id> --run-id=run-example
```

## 关键文档

- [第1项关键问题收口](docs/engineering-step-1-2026-10-09.md)
- [第2项统一产物契约与使用方式](docs/artifact-contracts.md)
- [第3项执行稳定性与批次归档](docs/execution-attempts.md)
- [用例设计质量与执行入口校验](docs/design-quality-gate.md)
- [评测基座修正与分层验收计划](docs/benchmark-remediation-2026-10-09.md)
- [当前状态与下一步](docs/current-status-and-next-steps.md)
- [运行编排](docs/orchestration-engine.md)
- [自动化执行框架](docs/automation-execution-framework.md)
- [资产管理](docs/test-asset-management.md)
- [测试选择与效率](docs/test-selection-and-efficiency.md)
- [结果可信度与质量度量](docs/result-trust-and-quality-metrics.md)
- [PenguinHarness 多 Agent 与桌面方案](docs/penguinharness-multi-agent-desktop-app-plan.md)
- [PenguinHarness 配置即代码](docs/penguinharness-configuration.md)
- [学习指南](docs/agent-development-learning-guide.md)

## 目录

```text
config/   工作流、资产、选择、质量治理与本地环境样例
docs/     使用、设计、学习和演进文档
inputs/   需求、接口描述等任务输入
schemas/  结构化产物契约
skills/   可复用专业测试能力
scripts/  运行管理、预检、执行、归档和质量治理脚本
tests/    执行框架与本地生成的测试脚本
output/   已忽略的运行产物、证据和报告
```
