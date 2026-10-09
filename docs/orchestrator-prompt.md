# 测试总控工作流说明

运行时总控指令以 PenguinHarness 中 `test_agent` 的 `AGENTS.md` 为准。本文件记录仓库侧的设计约束，便于审阅和后续配置即代码迁移；它不是把整段提示词复制到任意 Agent 的替代品。

## 总控职责

- 先理解用户目标、输入完整性、风险和授权范围，再选择需要的专业 Agent。
- 每个新任务创建独立 `run_id`，并使用 `run:create`、`run:plan` 形成不可变计划。
- 派发前验证阶段依赖，记录派发/完成/阻塞事件，收集真实产物。
- 正式派发通过加锁的dispatched入口一并校验，成功返回dispatch_id后才能实际调用子Agent；不得把就绪检查与登记并行。完成与失败事件携带派发编号和父会话；blocked/failed通过明确授权的受控恢复处理，不直接改manifest。见[受控阶段恢复](controlled-stage-recovery.md)。
- 在要求人工确认的阶段暂停；未经确认不得启动浏览器。
- 汇总各 Agent 的结果、质量门、证据和未覆盖风险，但不得代替专业 Agent 伪造产物。

## 默认角色

| 阶段 | Agent | 主要产物 |
|---|---|---|
| `analysis` | `requirement_analysis_agent` | 需求范围、风险、待澄清项 |
| `test_points` | `test_point_agent` | Markdown 与 XMind 测试点 |
| `test_cases` | `test_case_agent` | JSON 与 Excel 用例 |
| `execution` | `automation_execution_agent` | 执行计划、结果、证据 |
| `defects` | `defect_analysis_agent` | Bug 草稿、标准缺陷记录、索引 |
| `report` | `test_report_agent` | 质量指标、趋势、Markdown/Word/PDF 报告 |

## 强制规则

- 流程定义来自 `config/orchestration-workflow.json`，不能在对话中绕过已声明的依赖与审批。
- 普通运行禁止隐式安装或下载依赖。
- 使用已登记环境和已验证测试资产；不得将真实凭据写入脚本或产物。
- `needs_review`、证据不足、阻塞和未执行不能被汇总为测试通过。
- 外部缺陷平台和生产环境操作必须有单独的用户授权。

完整状态机与恢复规则参见 [运行编排](orchestration-engine.md)。
