# 测试任务编排引擎

## 目标

测试总控根据用户目标选择测试能力，但不直接以自然语言约束工作流。一次运行创建后，阶段依赖、Agent 归属、Skill、人工审批时机和状态流转由可版本化配置与脚本统一管理。

## 工作流来源

`config/orchestration-workflow.json` 是默认生命周期定义。每个阶段声明：

- `id`：稳定阶段标识。
- `agent`：唯一负责该阶段的专业 Agent。
- `skills`：专业 Agent 应使用的 Skill。
- `depends_on`：必须完成的前置阶段。
- `confirmation`：`before`、`after` 或 `none`。

后续增加 API、性能或安全 Agent 时，只需要新增阶段定义与对应 Agent/Skill，不应修改总控中的阶段顺序判断。

## 运行流程

```powershell
npm run run:create -- --run-id=run-example
npm run run:plan -- --run-id=run-example --stages=analysis,test_points,test_cases
npm run run:plan:show -- run-example
node scripts/assert-stage-ready.mjs run-example analysis
```

`--stages` 仅填写任务真正需要的目标阶段；系统会自动补齐它们的依赖。计划创建后不可修改，需求范围变更时创建新的运行。

## 状态机

可用阶段状态：`planned`、`in_progress`、`completed`、`awaiting_confirmation`、`revision_requested`、`blocked`、`failed`、`skipped`。

- `planned -> in_progress`：仅允许通过 `record-orchestration-event ... dispatched`。
- `in_progress -> completed|failed|blocked`：仅允许子 Agent 实际返回后记录事件。
- 产出后确认：`completed -> awaiting_confirmation -> completed`。
- 执行前确认：`planned -> awaiting_confirmation -> planned -> in_progress`。
- 执行前计划返修：`awaiting_confirmation -> revision_requested -> awaiting_confirmation`，修改计划后可再次申请审批；这一分支不派发执行、不自动批准。产出后确认阶段仍须返修完成后才能重新申请。
- 返工：`awaiting_confirmation -> revision_requested -> in_progress`。

所有状态改变必须使用运行管理脚本。`update-run-manifest.mjs` 已废弃，避免绕过状态机直接改写清单。

通用事件入口只接受 `dispatched`、`completed`、`failed`、`blocked`，拒绝自定义事件和 `--status`、`--type` 等覆盖参数。返修必须通过确认解析脚本处理旧请求，再重新检查就绪、记录派发并实际调用子 Agent。技术审查要求返修应明确记录审查来源，不能写成人工已批准。

派发事件会校验计划中的 Agent 与 Skill 是否一致。完成事件可通过 `--artifacts=路径1,路径2` 登记真实产物，供报告、恢复和审计使用。

## 恢复与审计

使用 `node scripts/get-run-resume-point.mjs <run_id>` 获取首个未完成计划阶段。`manifest.json` 的 `orchestration.plan` 保存本次选定阶段，`orchestration.events` 保存派发、完成、阻塞和审批记录，可用于审计 Agent 是否真实调用了专业角色。
## 2026-10-09 派发与恢复协议更新

最新入口见[受控阶段恢复与派发](controlled-stage-recovery.md)。以下旧命令示例若未包含父会话与派发编号，不适用于新派发：dispatched必须带真实parent-session-id，成功取得dispatch_id后才实际调用子Agent；后续completed/failed/blocked使用原编号与父会话。blocked/failed不能直接重派，须审查后使用recover-stage；旧无编号记录保留并新建run，不手改清单。
