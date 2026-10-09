# 最小真实复验：总控命令阶段未通过

## 结论

2026-10-09由Codex在PenguinHarness界面新建对话并发送同范围需求分析复验，使用现有step-3.7-flash。真实会话为`session-2026-10-09-15-27-48-0a2310df`，界面标题“同范围最小真实复验需求分析”。

本轮未通过。总控命令失败后继续执行，Codex通过界面停止按钮中断。没有成功创建run，没有run_subagent调用，没有正式分析产物或审批。不能把本轮称为完整复验通过，也不能声称已验证子任务停止、分析一致性或状态摘要的真实Agent行为。

## 实际工具证据

以下北京时间根据结构化tool_call/tool_call_output核对，不采用模型推理文字作为证据。

1. 15:27:52，doctor返回ready，Node/Python及已有依赖可用，但总控同时拼接echo、ls和sed，输出不再是单一包装器JSON。
2. 15:27:58，调用`project-command.mjs run node scripts/create-run.mjs -- create-run --help`。入口只接受脚本文件名，返回runner_error、exit_code=2、automatic_retries=0、stop_and_request_review。调用ID为`chatcmpl-tool-86edb3e7f3c7837d`。
3. 15:28:01，没有停止，继续调用`help create-run.mjs`并拼接后续命令。该帮助尚未登记，返回input_rejected、exit_code=2。调用ID为`chatcmpl-tool-8c4079b823e37b03`。
4. 15:28:07，读脚本后仍继续拼接创建/解析/计划命令，再次传入scripts/create-run.mjs及scripts/plan-run.mjs，均被拒绝。还混用shell临时路径与Windows Node路径，出现ENOENT。最后echo使外层工具返回completed，但内部命令实际失败。调用ID为`chatcmpl-tool-b7392229c2cdd326`。
5. 15:28:12，继续请求未登记帮助；15:28:13工具记录aborted，界面显示“[已中断]：用户中断”。这是Codex点击停止的人工干预，不是Agent自主停止。调用ID为`chatcmpl-tool-b3a42f29abd95868`。

本轮exec_command共5次，run_subagent为0次。没有进入正式派发，因此没有dispatch_id，不能强行登记阶段blocked或failed。15:27:48后output/runs没有新增运行目录；检查时未发现命令行匹配此次project-command/create-run/plan-run的Node或Bash进程。这是范围限定的检查，不是操作系统全量进程证明。

原始trace保留于PenguinHarness的test_agent当日traces目录；截图仅留本机`output/minimal-recheck-20261009-stopped.png`。不向仓库提交原始会话。未主动清理Agent生成的临时shell文件，以免误删其他数据。

## 工程问题

- 现有CLI能拒绝非法脚本路径，但总控未遵守失败停止。automatic_retries=0只是输出字段与行为约定，不是跨调用的强制锁。
- 帮助/参数合同未覆盖create-run、plan-run及record-orchestration-event等核心生命周期入口，模型仍会试探调用。补齐帮助能减少误用，但不能单独保证停止。
- 外层允许多命令拼接，内部失败可被末尾成功命令掩盖。包装器内部shell=false不能约束其外层exec_command。
- 子任务完成闸门作用于派发后的子会话，覆盖不到创建run之前的总控错误。这是此前明确的边界，不应把子任务工程测试通过当作总控运行隔离完成。

## 下一步建议

优先补通用生命周期命令合同与可枚举帮助；随后设计总控会话级失败状态及恢复审查机制，使后续受控操作读取失败状态并拒绝未经审查继续。失败记录应覆盖尚无run的情况，并区分诊断读取、审计收口、恢复与业务变更。需要检查PenguinHarness实际支持的工具拦截机制，不能仅靠再加长提示词，也不能将CLI闸门宣称为不可绕过的工具隔离。

独立禁止或结构化封装外层多命令执行，防止尾部成功覆盖内部错误；所有业务共用，不为本次基座定制。完成工程回归和指令同步后再真实复验，保留本次失败记录。

本轮只验证与记录，未实施以上修复，等待用户确认下一项。原有92项Node/7项Python工程回归结论仍是此前的工程测试，本轮未重跑，不替代本次失败结果。未安装依赖、未修改工程代码/Skill/配置、未启动业务浏览器测试、未提交GitHub。

## 历史保护

旧失败run清单SHA256仍为`B4F6EDCF946DFFCE607D4B6CB418E124477E10D73F526895EB74889D49539DFD`。

旧恢复run清单仍为`8AA2CEEB495B7321A4286F638E7DDEA72B76634192BA5CDCAFF783C8A8A6942E`；分析正文仍为`3D232D6E308BBF30C6ADA33614C0DF259DB34156CB58937BE92100DAB5C2336E`。

台账完整核验值：`F53438C55F4EF610E6F4A3DFF30C70F230D3639B54D8F4DDDBE641438BED8E4E`。历史状态没有为此次复验修改。
