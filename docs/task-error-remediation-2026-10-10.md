# 任务执行报错审计与修复

后续更新：12:01最小真实流程已完成到待确认，仍有5次被纠正的工具错误。详见[连续修复记录](continuous-remediation-2026-10-10.md)。下文是此前审计时点的结论。

最新状态：用户授权重启后已进行11:22真实复验，Shell配置与实际总控派发hook通过，但端到端交付失败。详见[真实复验记录](restart-real-verification-2026-10-10.md)。下文“待复验/仅check”描述的是修复提交前的验证时点，不是当前结论；本次实测也确认子Agent可直接调用底层脚本，不能把此hook当作全工具隔离。

## 范围与事实

审计父会话session-2026-10-10-09-16-29-48ce107b及其两次真实子调用：09:37的974e7c3d和10:21的b54f1cff，二者实际都运行于test_agent。只统计结构化工具返回stop_reason=fatal，不将模型思考或“已修复”口头声明当作证据。

共40条工具失败；139次输出包含Bash profile警告，不等同139次业务失败。运行 `node scripts/audit-agent-errors.mjs <父会话ID>` 可重新生成本机审计，结果位于output/maintenance/<会话>/tool-errors.json，包含工具调用ID、时间、会话和分类，不复制需求正文、账号或整段命令。

| 分类 | 次数 | 原因与处理 |
| --- | ---: | --- |
| 参数合同 | 11 | 阶段mode、source/text互斥、双层CLI参数；已补目录规则，生成/校验旧入口适配结构化动作 |
| 停止/预算连锁拒绝 | 11 | 不能当成11个独立根因；恢复仍按原始错误核验，不绕过状态 |
| 来源类型 | 1 | api_document/openapi_spec不是合同枚举；错误现返回来源ID、实际值和允许枚举，catalog同步公布 |
| 路径不存在 | 4 | 把run_id当目录、把输入文档提到的路径当工程文件；提供run内原文读取动作并明确路径来源 |
| 重复计划 | 1 | 错派总控子任务重复规划；真实派发hook校验角色，不以允许覆盖计划掩盖错误 |
| 命令过长 | 1 | 大段代码塞入命令行，spawn ENAMETOOLONG；使用文件工具和现有项目脚本 |
| 编辑匹配失败 | 2 | CRLF多行old_string不匹配；结构化解析编辑，不反复猜转义 |
| 引文不匹配 | 4 | 非连续OpenAPI字段被拼接、转义后的换行不是实际换行；新增read_source返回连续原文，不放松匹配 |
| 内联脚本语法 | 2 | node -e引号和import.meta模块模式错误；用既有入口及文件脚本，避免临时eval |
| 模块导入路径 | 3 | 临时脚本位于run目录却假定项目根目录；引用校验由项目入口完成，不让模型复制核心校验代码 |

工具拒绝会重复出现；上述统计不是独立缺陷数量，也不声称所有行为问题已自动消失。临时调试脚本、用户输入和历史草稿不删除、不重写。

## 已落地的工程修复

1. **总控派发前hook**：安装包内确认支持pre_tool_use接口。仓库penguin/hooks/qa-delegation-guard包含公开hook，通过同步脚本安装到test_agent的agent_state/hooks。实际调用run_subagent前检查本地父会话身份、ready状态、唯一in_progress阶段、登记角色、派发编号/完整策略、重复调用。错目标、缺登记、会话停止返回deny，不启动子任务；被此hook拒绝的调用不计作一次真实子派发。
2. **引用读取动作**：read_source只读当前run的inputs，验证路径及最多200行的整数范围，返回源哈希、总行数和保留CRLF/Unicode的quote。大材料分段读取，不扩大输入访问边界、不自动更改台账。
3. **统一草稿错误恢复**：普通旧入口分析生成、产物校验映射到executeAction，使用同一回执及预算，避免同一种草稿错误因选不同入口而锁死。带自定义超时/prepare参数的旧入口暂不自动适配，实际执行失败仍不放行。
4. **可操作的枚举诊断**：来源类型/分类错误提供允许值；API和OpenAPI需求文件是specification，非功能规则根据实际内容选择constraint或risk，不凭文件类型创设新枚举。
5. **编码及Shell启动方案**：受控Python子进程明确UTF-8。Windows启动器start-penguin-qa.mjs利用应用已支持的PENGUIN_SHELL选择原生PowerShell，并设置Python UTF-8，仅影响新进程，不改全局PATH、模型或安装文件。

## 生效边界

PenguinHarness源码说明hook按会话加载，且子Agent不加载hook。安装文件不证明正在运行的旧会话已经加载；必须在新会话检查实际hook事件。此hook只约束总控run_subagent，不是exec_command/文件工具沙箱，也不能防止总控直接改业务草稿。脚本崩溃等宿主行为仍需真实验证，不能宣称系统级隔离。

Shell选择在应用进程缓存；修改启动环境需要关闭后重启。当前进程不会因写入启动器自动改变。启动器拒绝在应用仍运行时启动，不杀进程，不更改ExecutionPolicy。

```powershell
node scripts/start-penguin-qa.mjs 'D:\Program Files\PenguinHarness\PenguinHarness.exe' --check
# 用户允许并正常退出应用后，去掉 --check 才启动。
```

真实Agent复验仍待进行：错误角色调用应被hook拒绝，正确角色调用应执行；输入来源修正后草稿可继续校验，最终由父总控登记并请用户确认。现有商城草稿不是专业角色验收通过的证明。不得直接标记完成或代答业务歧义。

## 验证

119项Node工程合同测试通过，含hook角色/状态/重复调用拒绝、可修正拒绝不重复计数、连续CRLF原文读取、路径越界拒绝和旧入口适配回执。完整日志output/task-error-remediation-regression.log。Windows启动器已仅做check验证，未因此重启应用。真实工具层端到端验证与Shell警告消失的验证另行记录，不用合成测试替代。

另有7项Python报告测试通过；已安装hook的stdin负向冒烟返回deny，七角色和hook同步检查差异0，diff检查通过。没有对旧会话再次解锁，没有改写现有需求台账/正式报告，也没有把新生成文件标成专业阶段完成。新会话是否实际加载hook、真实正确/错误派发的行为及应用重启后的编码仍待验收。
