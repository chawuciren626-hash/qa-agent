# 第1项：关键问题收口

日期：2026-10-09。只处理原工程主计划第1项的关键缺陷；不开始第2项全链路契约，不恢复模型评测。

## 完成内容

1. 最新执行状态：执行器写execution/execution-state.json，包含invocation_id。启动被阻塞或中断时，质量汇总不再沿用旧成功；旧test_results保留，报告使用新生成的report/reportable-results.json。无批次关联的历史blocked记录保守判阻塞，新批次完成且结果ID一致后可恢复报告。
2. 混合用例：选择结果记录manual_pending及execution_mode，计划区分自动化cases与人工待办。全人工选择明确不能生成自动化计划，不静默删除；缺失ID、重复ID仍拒绝。
3. 执行授权：只认最后一条确认。请求确认和批准之间、批准与派发/启动之间均验证快照；环境URL必须等于授权登记。快照覆盖执行计划、环境及登记文件、设计依据、测试目录、tests/framework、scripts、Playwright配置及package文件。旧批准无快照不自动迁移。
4. 完成证据：completed必须提供真实父/子会话ID和必需产物。核对本次run的父run_subagent返回、子Agent身份、工作区、任务run_id、结束响应；保留产物哈希。同一子会话不能重复完成阶段，缺少证据不能补记完成。

## 执行流程调整

执行Agent先以prepare模式生成脚本，再执行审批，避免“需要批准才能生成待批准脚本”的循环。

```text
用例阶段完成并批准
  -> dispatched execution --mode=prepare
  -> 子Agent仅准备计划和脚本
  -> completed附会话和产物，记录preparation_completed
  -> request-stage-confirmation execution保存快照
  -> 用户确认后resolve-stage-confirmation approved
  -> dispatched execution（不带mode）
  -> 子Agent调用test:ui
  -> completed附本次会话和执行结果
```

总控派发prompt必须包含run_id与专业Agent ID，子会话使用工程工作区或本run工作区。完成命令新增--session-id和--parent-session-id；数据来自实际返回，不手工编造。校验目前使用本机PenguinHarness traces布局；布局不匹配时失败关闭，不能以模拟会话替代真实调用。

## 兼容说明

- 原历史运行和审批不补造快照、会话记录。新执行必须按新流程确认。
- prepare-acceptance仍能生成固定参考资产，但旧run-acceptance自动启动方式没有本次人工审批时会阻塞。这是有意取消绕过授权的执行方式，不添加allow-all开关。真实基座执行也须经PenguinHarness准备/批准后进行。
- Markdown、Word/PDF要共同使用当前质量指标与reportable-results。导出器拒绝输入统计、状态或invocation_id与指标不一致。
- scripts目录采用保守全量哈希，任何脚本改动都可能要求重新审批；后续可以收窄到声明的依赖图，但本轮不暗示任意动态导入都被完全隔离。

## 安全边界与后续

以上是项目CLI入口的校验，不是操作系统级沙箱或签名授权。拥有工程和trace写权限的进程仍可能篡改文件；也不能证明用户身份、子Agent回答语义或每个产物内容正确。不得宣传为强权限隔离或全自主验收通过。

本轮invocation_id只负责区分最新启动状态，不是独立attempt归档；结果完整对账、失败历史全归档、报告全链路引用及强工具权限属于后续项。未启动真实浏览器或模型评测；工程回归使用明确标记的合成数据及trace夹具，另有下述最小真实Agent派发验证，两者分别记录。

第1项完成后停下，等待用户确认；下一项为统一产物契约校验。

## 验证结果

- `npm run engineering:contracts`：22/22通过，独立于暂停的模型评测。涵盖最新审批、审批后改脚本/计划/环境、prepare不可执行、缺失父会话、混合用例、旧成功/新阻塞/恢复及既有工程回归；新增4项父子事件绑定回归。
- `python tests/acceptance/report-text.test.py`：5/5通过，包含阻塞状态与旧结果冲突、错误invocation及当前阻塞结果导出前检查。这是逻辑测试，不是新报告页面渲染验收。
- 最小真实需求分析派发在修复后通过；尚未做新流程完整端到端复验，不宣称全流程通过。

## 最小真实派发及兼容修复

- 运行：`run-integration-analysis-20261009-1791511110473`，仅需求分析，不执行浏览器、业务环境或后续阶段。
- 父会话：`session-2026-10-09-09-58-32-67942bfe`；真实子会话：`session-2026-10-09-10-05-30-a8bced7d`。
- 初次登记被误拒：真实返回正文不包含子会话ID，ID实际位于父trace的结构化`event_msg/subagent`事件。原有两次拒绝历史保留，不改写为一次通过。
- 修复后要求该事件唯一对应一个尚未返回的`run_subagent`调用，同时检查Agent、run、返回和时间顺序。正文出现ID不能替代结构化证据。多个调用并行重叠且无法唯一绑定时拒绝登记，不猜测归属；后续支持并行需要更明确的调用关联契约。
- PenguinHarness在原父会话中实际重试完成登记并请求确认。只发生一次子Agent派发，未重写产物；完成证据已登记，最终manifest为`awaiting_confirmation`，确认记录为`pending`。Agent回复中的`completed`描述的是请求确认前状态，最终以manifest为准。
- 产物`analysis/requirement_analysis.md`重试前后SHA256一致：`311654920b5d06e0d33bf7aaf67f971d2b4c2f1b62302fff08568638c7736df9`。
- 这是经过工程修复及明确指引的受监督验证，不是完全自主稳定性验收。当前暂停，等待用户确认；不启动第2项。
