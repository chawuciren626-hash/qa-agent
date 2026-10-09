# 项目命令运行时

Agent常用生命周期操作现优先使用[结构化动作入口](structured-actions.md)，JSON请求由代码适配到底层参数；本页命令入口继续用于未覆盖脚本和工程维护，不要求模型手工拼接已覆盖动作的参数。

当前调用增加[总控会话闸门](controller-command-session.md)：Agent调用绑定真实controller-session，生命周期帮助已覆盖创建/计划/派发/确认。会话失败后持续拒绝受控变更，原有子任务完成校验保留。历史无身份命令仅保留诊断兼容，不代表新变更调用方式。

新增[命令与子任务停止契约](command-stop-contract.md)：`help [脚本名]`只读帮助、三个关键脚本的预启动参数合同、失败结果的automatic_retries=0及next_action。参数拒绝也需停止审查，不自动换参数重试；新派发在完成登记时核验停止约束传递和命令结果。

## 问题与修复边界

真实PenguinHarness调用中，npm脚本包装器报`/usr/bin/env: bash: No such file or directory`；转用`cmd /c`出现交互式命令提示符并持续等待。这不是Playwright、Excel或Word插件需要重新下载的证据。

本轮增加统一原生进程入口，规避该包装器链路，不修改PenguinHarness安装包、系统PATH、系统安全设置或用户应用配置。最外层PenguinHarness工具仍可能经过其默认shell，所以其profile警告不等于已修复；最外层工具被强制杀死时，也不能保证项目清理钩子运行。

## 用法

状态汇报新增 `show-run-status.mjs <run_id>`，同样纳入帮助及预启动位置参数/运行编号校验。详见[清单状态摘要](run-status-summary.md)；摘要不替代调度许可。

在项目根目录先执行：

```powershell
node scripts/project-command.mjs doctor --controller-session=<parent_session>
```

检查当前Node、可解析的Playwright/XLSX/XMind依赖及可导入python-docx/reportlab的Python。仅检查命令/报告环境，不打开浏览器、不授权执行、不安装依赖。QA_PYTHON若设置，必须为已存在的原生Python绝对路径；错误时不静默回退，否则从当前进程PATH找原生Python。路径不写死到仓库。

```powershell
node scripts/project-command.mjs run node show-run-plan.mjs --controller-session=<parent_session> -- <run_id>
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> --run-id=<run_id> --timeout-ms=60000 -- <run_id> analysis
node scripts/project-command.mjs run python generate-report-documents.py --controller-session=<parent_session> --run-id=<run_id> --timeout-ms=120000 -- <markdown> <reportable_results> <bugs> <docx> <pdf> <metrics>
```

只接受项目scripts目录直属的`.mjs`/`.py`文件名及匹配的运行时；拒绝路径穿越、shell命令、node -e、递归运行本入口。`--`前是运行器参数，后面是底层脚本原参数。使用参数数组、shell:false和关闭stdin，中文、空格、分号等作为普通参数，不进行额外shell解释。

最外层若找不到node，应由维护者提供此前核验的可执行文件绝对路径；当前会话不能自行下载或猜测安装路径。最外层引号仍受PenguinHarness工具影响，因此复杂JSON/多行数据应写入输入文件后传文件路径，不能声称任意shell转义已被完全消除。

## 结果与清理

默认120秒，显式预算范围100毫秒至30分钟。实际浏览器用例的业务预算和授权仍以执行计划为准，外层时限不能用来绕过批准。

每次调用保存独立`command.json`和`command.log`，有run则在其`audit/commands/<uuid>`，否则在`output/command-runs/<uuid>`。记录解释器、脚本、参数数量、拥有者/子进程PID、时限、结果及清理确认。默认不记录完整参数；子脚本输出可能仍含敏感内容，日志不提交或外发。控制台仅返回最多16KB末尾，完整输出在日志。

- `completed`且exit_code=0才表示命令成功；底层业务是否通过仍需读原结果。派发编号取成功日志中底层JSON的event.dispatch_id。
- 非零退出码保留，超时返回124，中断返回130。超时和中断复用managed-process，仅停止本次子进程树。
- cleanup_required、命令记录仍running或宿主工具硬中断时不自动继续、不自动删锁；核对已记录PID/进程树和实际清理依据后使用已有恢复机制。
- 工具句柄not found不能证明OS进程已结束。不得猜PID、杀整个node/cmd进程组或“重跑覆盖失败”。

此入口不是安全沙箱：允许执行的项目脚本仍可能修改产物或启动已批准测试；原脚本的审批和契约继续生效。具有任意shell/文件写权限的Agent仍可绕过入口，需要后续工具侧限制。

## 指令同步

`penguin/agents.json`中的shared_instructions指向`penguin/command-runtime.md`。同步器将角色源指令和共同命令规则组合成安装后的AGENTS.md；Skill仍单独同步。检查时比较组合内容，避免七份重复规则漂移。同步后使用新会话读取新指令，旧会话不宣称自动更新。

## 验证

专项工程测试使用标记的合成脚本，验证参数完整性、失败码、超时中断、路径/脚本限制、Python错误配置及run内日志归档。它不代替真实PenguinHarness命令冒烟或完整Agent流程。真实冒烟结果在本轮进度记录中单列；尚未完成的恢复链路、业务流程和四格式报告验收不能由doctor通过代替。

### 2026-10-09验证结果

- 工程回归：65项Node测试、7项Python报告测试通过；其中命令入口专项6项。
- 七个角色指令同步检查：`in_sync`，差异0。
- 真实PenguinHarness总控会话：`session-2026-10-09-14-41-35-b17d3a42`，模型step-3.7-flash。通过界面发送明确限定的两条诊断命令，结构化工具记录确认顺序执行且没有额外派发。
- doctor返回ready，发现既有原生Node/Python及三个项目依赖；随后只读运行`show-run-plan.mjs`，completed、exit_code=0，子进程duration_ms=114，termination_confirmed=true。会话整体约23秒，不等于脚本耗时。
- 实际审计目录：`output/command-runs/643e8448-e76a-4c8b-bfc8-db932307d4d6`，包含`command.json`和`command.log`。真实工具追踪保留在本机PenguinHarness test_agent的同日traces中，不将运行日志提交仓库。
- 被读取的旧run为`run-acceptance-base-20261009`；清单前后SHA256均为`B4F6EDCF946DFFCE607D4B6CB418E124477E10D73F526895EB74889D49539DFD`，仍blocked。
- 外层shell仍输出which/locale缺失警告；本轮仅绕开故障包装器，不修复供应商shell。未安装、启动被测浏览器、修改旧run或开展完整测试流程。

本次成功不证明子Agent能自主选择新入口，不证明所有脚本/导出格式均经真实Agent验证，也不解除历史阻塞。后续需完成需求来源治理后再安排恢复链路和完整流程复验。
