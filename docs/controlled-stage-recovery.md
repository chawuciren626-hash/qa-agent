# 受控阶段恢复与派发

新派发补充命令停止协议：成功返回的event.child_command_policy必须完整传入实际子任务prompt，不能只复制dispatch_id。失败、拒绝、超时或未知结果须停止；重试成功不能抹去该派发失败。完成登记核验父子提示和结构化命令结果，旧派发不回填。详见[命令与子任务停止契约](command-stop-contract.md)。

## 派发协议

`record-orchestration-event.mjs ... dispatched` 是正式入口。在同一个 manifest 锁内读取最新状态、核验依赖/批准/产物和父会话，生成唯一 dispatch_id 并原子写入。`assert-stage-ready`仅为可选只读诊断，不发放许可，不应与登记并行。

```text
dispatched校验及登记成功
  -> 取得event.dispatch_id
  -> 一次真实run_subagent，prompt包含run_id与dispatch_id
  -> 返回真实子会话
  -> completed/failed/blocked，携带同一dispatch-id与parent-session-id
```

```powershell
node scripts/record-orchestration-event.mjs <run_id> dispatched --stage=analysis --agent=requirement_analysis_agent --skills=requirement-analysis --parent-session-id=<parent_session>
node scripts/record-orchestration-event.mjs <run_id> completed --stage=analysis --dispatch-id=<returned_uuid> --parent-session-id=<parent_session> --session-id=<child_session> --artifacts=analysis/requirement_analysis.md
node scripts/record-orchestration-event.mjs <run_id> blocked --stage=analysis --dispatch-id=<returned_uuid> --parent-session-id=<parent_session> --reason=<actual_failure>
```

示例末两行是互斥结果，不可连续执行。执行准备在dispatched追加`--mode=prepare`，实际执行仍需本次批准。完成入口验证真实子调用prompt中的编号、父子trace及产物，不接受旧编号、别的父会话或同一编号下反复子调用。一个run同时只允许一个阶段in_progress；不同run不共用此锁。

## 恢复协议

1. 明确停止/清理原调用。仅工具句柄不可访问不足以证明OS进程退出；核对真实子会话结束状态、执行锁与环境清理证据。
2. 把审查理由、授权来源和清理依据保存到本run内真实文件。操作者及approval-ref为审计声明，不等于身份认证或新增授权。
3. 使用`get-run-resume-point.mjs`读取当前manifest_sha256；审查后把该哈希传给恢复命令。
4. 恢复只将blocked/failed变为revision_requested，记录完整原阶段、事件、证据哈希及核验的子会话，不自动派发、不执行测试。

```powershell
node scripts/get-run-resume-point.mjs <run_id>
node scripts/recover-stage.mjs <run_id> analysis --expected-sha256=<reviewed_hash> --actor=<reviewer> --reason=<reason> --approval-ref=<authorization_reference> --evidence=audit/recovery-review.md --parent-session-id=<original_parent>
```

拒绝条件：旧哈希、无审查依据、跨run路径、未选阶段、不是blocked/failed、其他活跃阶段、待处理确认、明确rejected授权、执行锁或running状态、旧无编号/所有者派发、父会话不符、子调用尚无返回或结束状态未知。旧批准失效为superseded，原批准内容和历史事件保留；恢复执行阶段需重新准备/确认，不复用旧执行授权。

旧运行不补造新协议历史。例如`run-acceptance-base-20261009`保留原blocked与越界审计，后续真实验证应新建run。对仍在执行的新调用，先得到真实终止/失败事实并正式登记blocked，再审查恢复，不能强行把in_progress恢复为planned。

## 并发与完整性

计划、派发/结果、审批、恢复、资产登记、缺失引用修复及会影响报告状态的生命周期变更共享`manifest.json.lock`；受控写入使用临时文件+原子替换，竞争失败不等待、不自动删锁。异常退出遗留锁须维护者先核对拥有者和清理情况，不由Agent自动接管。

后续受控操作核对阶段状态与最新审计事件；只将blocked改为planned但不产生恢复事件会被拒绝。此机制不能防止拥有任意工作区写权限的程序同时伪造manifest和事件，也不能从项目CLI阻止PenguinHarness在外部直接调用run_subagent。工具侧另有[派发内容绑定](delegation-content-binding.md)，但它也不是操作系统写权限隔离。

## 验证边界

新增合成工程回归覆盖恢复保留历史/产物、批准失效、陈旧编号、非法恢复、活跃子会话、并发派发、锁冲突、手工状态改写及真实调用prompt编号绑定。合成trace明确标记，不冒充PenguinHarness实际复验；旧真实失败现场未改变。完整流程验收还需单独验证真实模型恢复链路。
