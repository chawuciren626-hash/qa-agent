# 技术文档导航

仓库保留使用说明、接口契约和工程开发指南。历史建设方案、修复计划、会话记录和验收产物仅在本地保存，不作为源码分发。

## 使用

- [用户指南](user-guide.md)
- [接口自动化协议](api-execution.md)
- [功能自动化工作流](automation-execution-agent-workflow.md)
- [独立专业任务](independent-professional-tasks.md)
- [输入与交付](word-and-text-input.md)

## 开发与验证

- [工程测试与 CI](engineering-tests-and-ci.md)
- [运行编排](orchestration-engine.md)
- [结构化动作](structured-actions.md)
- [专业子智能体任务书](delegation-task-brief-2026-10-30.md)
- [总控工具接口](controller-tool-interface.md)
- [输入与交付约定](input-and-delivery.md)
- [阶段注册](stage-registry.md)
- [产物契约](artifact-contracts.md)
- [设计质量门禁](design-quality-gate.md)
- [报告证据索引](report-evidence-index.md)
- [报告结果保真](report-result-fidelity.md)
- [凭据与数据保护](credential-security.md)
- [安装包构建](../packaging/README.md)

## 源码边界

- `input/`、`inputs/`、`output/`、生成测试、宿主数据、凭据及发行二进制不纳入 Git。
- 可复现的合成测试夹具保留在 `acceptance/`、`tests/`、`benchmarks/`；测试在隔离工作区创建自己的输入和输出。
- `docs/` 使用白名单，新增技术文档需明确加入 `.gitignore` 例外。历史计划与本地修复记录不加入白名单。
- 技术文档只描述使用方法、接口、约束和维护步骤。具体会话 ID、某轮测试计数、现场路径、同步结果及“下一项待确认”等过程记录保存到仓库外的本地归档；不能因为文件名不带日期就纳入技术文档。
- `docs/releases/` 保留版本发行说明，`docs/learning/` 保留学习材料；它们与本地调试和验收流水分别维护。
- 工程测试通过不代表真实模型流程或用户业务验收通过。源码与安装副本独立，发行包仅在明确要求时构建。
