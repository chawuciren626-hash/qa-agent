# 从清单生成状态摘要

## 使用

Agent优先以结构化`run_status`动作请求下述只读摘要；失败行为说明另用`project-action.mjs summary`读取动作审计，不由阶段状态推断是否重试。详见[结构化动作入口](structured-actions.md)。下述CLI仍供底层诊断使用。

在项目根目录执行只读命令：

```powershell
node scripts/project-command.mjs help show-run-status.mjs
node scripts/project-command.mjs run node show-run-status.mjs -- <run_id>
```

将占位符替换为实际编号。正式摘要JSON在包装器output_tail中；命令失败必须停止，不把上次输出当作当前状态。该脚本一次读取manifest原始字节，摘要及SHA256均基于同一快照，不写清单、不请求审批、不派发Agent。

## 字段与含义

- recorded_status：清单原有总状态；derived_status：复用现有状态机按已选阶段计算的状态。两者不一致提示审查，不自动纠正。
- stages：计划中的全部阶段，分别列出是否属于本次范围、当前状态、最新确认、派发编号、最新审计事件及阻塞/返修原因。范围外skipped不是测试通过。
- confirmation：只取该阶段最新决定，历史approved不能掩盖新返修或待确认。历史原因不当作当前正常阶段的阻塞理由。
- workflow_closed：本次已选阶段记录均已结束，且产出后确认阶段已获最新批准、未发现状态矛盾。它不代表全部六阶段都执行，也不代表交付质量通过。
- next_action：只读审查提示，包括等待确认、返修审查、恢复前审查、检查派发就绪等，不授予任何操作权限。
- user_summary：确定性生成的状态正文，供总控直接采用。附带原始状态标识、范围及限制，不允许改写成“全部测试通过”。
- manifest_sha256：本次快照标识。清单变化后重读，不缓存为持续有效的状态证明。

## 一致性与限制

总状态矛盾、已识别审计事件与阶段不符、待确认状态不匹配、未知状态、无已选计划时返回review_required和问题列表。无法解析、错run或重复计划阶段则命令失败。review_required是成功读取后的诊断结论，总控仍必须停止推进并审查；不会自动恢复或修改数据。

摘要不读取实时进程、重新执行测试、校验产物哈希或评判需求语义。in_progress只表示阶段记录，不证明子Agent正在运行；completed也不等于产品合格。最终报告仍必须依据既有执行证据、质量度量和审批校验，不用本摘要替代。

## 验证

专项回归命令：`npm run status:contracts`。覆盖返修覆盖历史批准、产出完成但未批准、待确认与拒绝、执行准备、状态矛盾、无计划、快照哈希及范围外阶段。工程回归与真实Agent行为验证分别记录，不把合成测试称为端到端实测。

本项完成后待用户确认，下一步建议在PenguinHarness进行最小真实复验，联合验证分析单一来源、停止约束及状态汇报；不自动开展完整业务测试或模型评测。
