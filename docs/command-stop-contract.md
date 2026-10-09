# 命令调用与子任务停止契约

后续增强：生命周期命令帮助已补齐，CLI变更调用必须携带controller-session；同一会话失败后持续拒绝后续变更，审查后才可解除。详见[总控会话闸门](controller-command-session.md)。下文早期仅三个脚本的覆盖范围及提示约束边界作为实现历史保留，当前命令目录以help输出为准。

## 目标与使用

本项针对真实最小复验暴露的参数混淆、错误后继续试错以及派发遗漏停止要求，适用于所有业务，不针对某个测试站点定制。

执行前在项目根目录查看帮助，无业务子进程启动：

```powershell
node scripts/project-command.mjs help
node scripts/project-command.mjs help validate-artifacts.mjs
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> --run-id=run-example -- run-example analysis
```

示例run必须替换为实际运行编号。分隔符前的run-id仅用于命令日志归档，后面的run_id是业务脚本参数。当前预启动参数合同仅覆盖validate-artifacts、generate-analysis-markdown、recover-stage：位置参数、阶段、未知/重复选项与运行编号一致性提前检查。恢复仍必须提供全部审查依据，由原脚本验证状态、清单哈希和授权，参数格式正确不等于恢复获批。

帮助未登记的脚本应只读查看其源代码或文档，不通过执行错误命令探测用法。输入拒绝返回input_rejected、exit_code=2、automatic_retries=0及stop_and_request_review；runner_error可能发生在进程启动后，不能当作尚未执行。

## 派发与停止

1. 总控成功登记dispatched，取得dispatch_id及child_command_policy。
2. 将约束原文完整放入实际run_subagent提示，和run_id、目标角色、交付要求一起发送。约束带本次派发编号，不能复用旧派发文本。
3. 子任务任何命令失败、拒绝、超时、中断或未知结果立即停止；保留原始错误、日志、退出码、进程结束依据，不安装、不静默修复、不重试、不派下游。
4. 总控只读审查并记录blocked/failed。若有遗留进程，按已有受控恢复要求确认并清理。恢复需要审查依据及新授权派发，不是直接再次调用子Agent。
5. completed检查父提示和子任务实际输入包含该约束；检查结构化exec_command结果。有失败、未知响应或未确认终止时拒绝完成，即使随后命令成功也不消除失败。

执行报告中的正常测试失败与工程命令失败不同：测试失败应保留为产品/环境/工程分类依据；若运行器以非零退出或失败状态结束，本派发仍须停止审查，不能自行决定忽略后继续。既有质量治理逻辑不因本契约而改变。

## 边界

- 这是提示约束、CLI参数校验及事后完成登记闸门，尚无实时工具拦截。父Agent命令重试主要由指令约束。
- 结构化检查覆盖exec_command的响应完整性，以及包含project-command.mjs的包装器JSON状态、退出码、终止确认；不全面识别原始shell命令的业务语义或其他工具的文件修补。
- 旧派发没有child_command_policy时保留原校验路径，不回填历史、不宣称旧记录通过新契约。任意文件写权限下，不承诺清单或trace不可篡改。
- 正式阶段完成仍需要原有审批、父子会话唯一绑定和产物合同；本项不会放宽任何原有条件。
- 不更改PenguinHarness安装包、系统PATH、模型设置或历史真实产物。

## 验证与后续

工程测试包含参数错误和帮助、失败审计、约束漏传、错误派发编号、失败后成功、未知/超时响应，以及完整阶段登记拒绝后清单不变。所有合成trace只写工程夹具目录，不冒充真实Agent调用。

真实PenguinHarness复验尚待执行，工程回归不能证明模型始终遵守停止要求。下一项为从清单生成状态摘要；本项完成后等待用户确认，不自动启动下一项。

2026-10-09验证：84项Node工程回归、7项Python报告逻辑测试通过；完整登记负向检查覆盖父提示漏传、子输入漏传和失败后重试成功，均拒绝且清单不变。七个角色指令已同步；历史真实run及分析产物未改写。未提交GitHub。
