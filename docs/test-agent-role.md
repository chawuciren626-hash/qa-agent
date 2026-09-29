# 历史单 Agent 角色说明

本文件记录项目早期“一个 `test_agent` 搭配多个 Skill”的手工配置方式，仅供理解项目演进。它不再是运行时的权威指令。

当前运行时角色已拆分为总控 `test_agent` 与五个专业子 Agent，工作流、审批、产物路径和质量规则以以下内容为准：

- `config/orchestration-workflow.json`
- PenguinHarness 中各 Agent 的 `AGENTS.md`
- 工作区 `skills/` 中的 Skill 源文件
- [总控工作流说明](orchestrator-prompt.md)
- [运行编排引擎](orchestration-engine.md)

不要根据本文件手工覆盖 PenguinHarness 中的现行 Agent 指令。
