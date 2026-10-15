# 重启后真实 Agent 最小复验

历史记录：本页保留11:22失败事实。后续12:01最小流程已到正式待确认，详见[连续修复与真实交付复验](continuous-remediation-2026-10-10.md)，不据此改写本页旧运行结果。

## 结论

2026-10-10 在 PenguinHarness 界面新建会话并真实运行，未用维护终端代写业务结果。Shell 启动配置、错误角色拦截及正确专业角色启动通过；分析交付闭环未通过。不能以子 Agent 声称完成或文件校验通过替代正式完成登记。

- 父会话：session-2026-10-10-11-22-10-4a28f93a。
- 子会话：session-2026-10-10-11-23-08-608f4f83，真实角色 requirement_analysis_agent。
- run：run-restart-minimal-analysis-2026-10-10。
- dispatch：cfcb0419-f051-41ca-b401-e838eaa0e208。
- 范围：仅新增任务、名称必填、空名称拒绝保存并提示指定文本；不批准业务阶段、不执行测试。

## 通过项

1. 用户授权重启后，经项目启动器运行应用。新会话实际 exec 返回 PowerShell 5.1.19041.6456、PYTHONUTF8=1、PYTHONIOENCODING=utf-8。父子 trace 中旧 /etc/profile 警告输出数为 0；这不代表所有编码问题解决，PowerShell 中文错误输出仍有乱码。
2. 03:23:04.402Z，故意把 delegation.agent_id 改为 test_agent 的唯一负例，被实际宿主 qa-delegation-guard 拒绝，stop_reason=aborted，未启动错误角色子任务。
3. 03:23:08.676Z，使用正确角色启动上述专业子会话。同一 dispatch 在负例被拒后仍可正确派发。

## 失败链与待修复项

1. 子 Agent 误用旧入口查询 catalog；两次把内联 JSON 传给要求文件路径的 --request。期间使用 CMD 的 dir /s /b，PowerShell 报参数错误。需要统一角色、Skill 与工具入口说明，并补真实 Shell 兼容性检查。
2. read_source 对仅一行原文请求到第十行被拒，成为第三次共享 input_correction 失败。只读查询错误累计耗尽父会话预算，随后 generate_analysis 被 task_paused 拒绝。应评估只读读取的合理范围截断、明确请求格式诊断，以及按操作性质隔离纠错预算；不是无限重试或取消业务确认。
3. 子 Agent 在 retry_allowed=false 后尝试旧入口，又直接调用底层生成与校验脚本，并宣称分析完成。真实 hook 仅覆盖总控 run_subagent，不约束子 Agent 的 exec。草稿存在不代表合规交付；后续需让受控操作的关键边界由代码执行，避免依赖提示词自律。
4. 子 Agent 读取了工作区根目录历史需求/API资料并反复查目录、找旧示例。最终交付声称仅引用本 run 输入；本轮未做完整语义验收，不能据此断言完全没有污染。派发应明确本 run 输入清单与输出目录，减少无关检索，不绑定具体业务项目。
5. 子 Agent 返回后，总控未直接取得可用的子会话标识，转向搜索审计与整个工作区，并再次产生 PowerShell 引号错误。需要提供可信的父子关联查询/返回结构，避免由模型搜索猜测 ID。

## 收口与证据

界面耗时约 5 分 29 秒。维护者在总控扩散搜索时主动点击停止，未发送继续、未解锁预算、未登记完成。故没有实测完成登记接口最终接受或拒绝此次交付，不应声称该检查已通过。

停止时：manifest.analysis=in_progress，只有 plan_created/dispatched 事件，没有 completed/confirmation；控制会话 status=ready，但 input_correction=3 已耗尽。这里的 ready 不等于允许继续生成。

审计脚本输出：父子两会话共 10 条 fatal 工具返回（包含连锁拒绝与中断，不等同 10 个根因），0 次旧 Bash profile 警告。预期的 hook 拒绝为 aborted，不计入 fatal。机器可读证据：output/maintenance/session-2026-10-10-11-22-10-4a28f93a/tool-errors.json；其余证据保留在该父子 trace、output/action-audit 对应父会话目录及本 run。

下一步先修复只读纠错预算和入口易用性、可信子会话关联，再约束绕过入口的交付行为，随后重新执行最小真实复验。保留本次失败样本，不伪造闭环、不直接批准当前草稿。此前 119 项 Node 与 7 项 Python 工程测试不能覆盖或替代本次真实失败。
