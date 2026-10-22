# 总控会话命令闸门

结构化动作中的安全输入/草稿错误不再一律stopped，按进展控制策略纠正，详见[总控技术恢复](controller-recovery-policy.md)。下文停止/哈希审查接口保留给旧入口、历史失败和非白名单风险故障，不是用户日常测试的操作前提。技术留档由总控或维护流程负责，不要求用户制作审查文档。

后续调用方式：常用操作优先采用[结构化动作入口](structured-actions.md)，仍共享本页会话状态与审查机制。旧CLI保留为底层接口及未覆盖脚本入口；历史失败不会自动转成动作审计。

## 目的

15:27真实复验在创建run之前失败，总控仍继续命令。新闸门以真实总控会话ID为键，不依赖run已存在；覆盖统一CLI入口的预启动错误、实际非零返回、超时及中断。记录位于本机`output/controller-command-sessions/<session>/state.json`，不提交仓库。

## 使用

以下占位符必须替换为当前真实值。每次工具调用只执行一条命令，不把示例合并为shell脚本。

```text
node scripts/project-command.mjs help
node scripts/project-command.mjs help create-run.mjs --controller-session=<parent_session>
node scripts/project-command.mjs doctor --controller-session=<parent_session>
node scripts/project-command.mjs run node create-run.mjs --controller-session=<parent_session> -- --run-id=<new_run_id>
node scripts/project-command.mjs run node plan-run.mjs --controller-session=<parent_session> -- --run-id=<run_id> --stages=analysis
node scripts/project-command.mjs session-status --controller-session=<parent_session>
```

脚本只传文件名，不含scripts/。分隔符前run-id是日志归档，后面才是脚本参数。创建run不能使用外层run-id，因为审计目录要求清单已存在。子Agent使用总控在prompt中明确传入的parent_session。入口通过本机PenguinHarness总控trace核对身份与工作区，脚本parent-session-id若存在必须与controller-session相同。

新增生命周期帮助和预启动参数检查覆盖create-run、plan-run、record-orchestration-event、request-stage-confirmation、resolve-stage-confirmation，以及三个只读状态查询。既有分析生成、产物验证、阶段恢复合同保留。参数检查不是业务授权，原脚本仍校验阶段、审批、来源和产物。

## 状态与审查

- 首条带身份的调用创建running状态；正常结束回到ready，失败变为stopped。参数错误即使未启动脚本也记录失败，新的CLI进程仍读取该状态。
- stopped拒绝后续受控变更。允许help、doctor、session-status、show-run-status、show-run-plan、get-run-resume-point及正式blocked/failed收口；不会清除原失败或修改其哈希。诊断/收口自身命令证据按原运行器保存。
- completed、dispatched、生成产物、创建run、阶段恢复等均不能以收口名义执行。其他未列入只读白名单的脚本保守视为需正常会话。
- 状态更新采用短时独占锁与原子替换；running状态拒绝重入，即使来自另一个命令进程。硬中断遗留running或锁时失败关闭，不自动判断进程已死、不自动删锁，本版不提供自动恢复此类状态的命令，需维护者另行核验处理。
- stopped解除需要外部审查，审查文件放在项目output内，记录失败原因、清理情况、允许继续的范围及授权依据。随后按精确SHA256调用：

```text
node scripts/project-command.mjs review-session --controller-session=<parent_session> --expected-sha256=<session_state_hash> --actor=<reviewer> --reason=<review_reason> --approval-ref=<approval_reference> --evidence=<review_file_path>
```

审查入口要求stopped和当前哈希匹配、非空实际文件位于output内，归档审查文件哈希及原始失败，拒绝旧哈希重复使用。解除只置ready，不启动命令、不恢复业务阶段、不批准、不修改run。参数中的审查人和授权引用仍需外部核实，不构成电子签名或真实性证明。

## 能力边界

这是项目CLI的跨调用失败闸门，不是操作系统或PenguinHarness实时工具拦截。未确认供应商可用的拦截接口，未修改安装包。不能阻止直接调用脚本、任意shell、修改state/trace、使用另一个合法会话ID；身份核对证明trace存在，不证明实际调用者拥有该会话。

外层多命令拼接由指令禁止，CLI无法看到shell已拆分的原命令。只要后续仍走同一会话的CLI，其变更会被stopped拒绝；但末尾echo可能仍使外层工具返回成功，必须检查内部JSON。真正禁止外层多命令及任意工具绕过需要后续工具层接入，不宣称本版已解决。

无身份的help/doctor及白名单状态查询供维护者只读诊断，不形成会话失败记录；其他CLI调用缺身份时拒绝且不会创建匿名状态。历史真实会话不会根据旧错误自动补写失败，新闸门从新带身份调用开始生效。底层runProjectCommand库保留供工程测试，不能当作绕过CLI的Agent入口。

## 验证

专项测试使用合成父trace和工程夹具，不是实际Agent派发：覆盖创建前失败、新进程拒绝、帮助可用、身份/父会话不匹配、重复/未知参数、诊断保留失败、哈希恢复、证据路径限制、重复审查、并发及收口白名单。执行工程测试期间不得修改执行授权指纹所包含的脚本/配置。

本项完成后等待确认，再安排新会话最小真实复验；先前15:27失败记录保留，不补跑后改写为通过。未恢复模型评测或完整业务测试。
