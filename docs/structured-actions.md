# 结构化动作与失败说明

## 2026-10-12目录与身份更新

后续补充：catalog.invocation_steps明确先write_file成功、再execute；缺请求文件的hook拒绝提供操作顺序，且不创建猜测请求、不启动动作或解锁会话。handoff成功响应的data.presentation包含run_status快照，analysis阶段另含analysis_summary。status=ready时可直接用于当前回复；unavailable/review_required时检查errors和摘要一致性，不把展示故障当成完成登记失败再次登记。状态或产物后续变化时重新调用只读动作；摘要不批准业务、不保证语义正确。

catalog由CLI传入真实工程根，返回runtime_context中的engine_root、session_root、controller_session与shared_docs_root。隔离会话的invocation包含QA_DIRECTORY_CONTEXT中经过目录验证的父会话ID，供原样复制；仍须先写请求JSON再执行，不能只复制命令而跳过写文件。共享docs按工程根读取，任务输入按run读取。

旧模式controller_session为null，不猜身份；显式坏上下文报错，不回退。此帮助不批准阶段、不绕过父trace和身份校验。错误controller-session仍由hook拒绝，并提示宿主实际ID。状态查询使用run_status结构化动作，不由总控直接运行show-run-status。派发prompt明确共享文档绝对根和需求实现中立性。

## 目的与入口

dispatch成功还返回delegation（agent_id、description、prompt），供总控直接传给run_subagent。agent_id来自已登记专业角色，不能换成Caller agent或省略。prompt包含真实派发编号、父会话、策略原文和职责边界，可追加业务目标，不应删改这些约束。子任务只交付，父总控在调用返回后才登记complete。返回此对象不是实际子Agent调用，也不是工具层强制拦截；真实父子证据仍须核验。

2026-10-10派发修复：catalog新增field_rules与examples，actions只列允许字段。普通dispatch省略mode，只有execution准备使用prepare；default不合法。非法mode在结构化输入层给出完整纠正提示，不再先提示“只支持prepare”再由底层拒绝非execution。archive_input的source/text二选一，另一字段须省略，不能填空占位。

减少模型拼接双层CLI参数导致的误用。动作适配层以固定映射构造参数数组，继续调用原脚本和同一个controller-session闸门。2026-10-10起，明确安全的输入和草稿错误允许限次纠正，见[总控技术恢复](controller-recovery-policy.md)；不跳过阶段审批、不代替专业Agent。

先查看目录：`node scripts/project-action.mjs catalog`。无参数、help、--help也返回目录；帮助查询支持可选controller-session。用文件工具将请求JSON保存到本机output/action-requests内，随后每次仅运行一个命令：

```text
node scripts/project-action.mjs execute --controller-session=<真实总控会话ID> --request=<请求JSON路径>
node scripts/project-action.mjs summary --controller-session=<真实总控会话ID>
```

以上两行是不同操作，不合并执行。请求文件可在run创建前保存。身份有效时，读取失败、JSON错误、未知字段或参数拒绝会写入失败审计，返回recovery决定是否可纠正；已停止会话不会因为请求改正而自动解除。

## 请求示例

下面各对象是独立请求，示例ID替换为实际run。每个请求都只含一个动作，不接受批量动作、cmd、script或shell字段。

```json
{"action":"create_run"}
```

2026-10-10补充：create_run省略run_id时由入口生成UUID编号，写入动作回执的generated_run_id和run_id，再调用创建脚本；返回run_id供后续原样使用。只有省略才自动生成，显式非法值仍报错，不偷偷改名。创建不是幂等重试接口：成功后不要再次创建，结果未知先读原回执和运行状态。其余动作仍必须提供真实run_id。显式编号格式为`^run-[A-Za-z0-9-]+$`。

```json
{"action":"plan_run","run_id":"run-example","stages":["analysis"]}
```

```json
{"action":"archive_input","run_id":"run-example","name":"requirements.md","source":"acceptance/requirements.md"}
```

```json
{"action":"run_status","run_id":"run-example"}
```

| 动作 | action之外的字段 |
| --- | --- |
| create_run | run_id可选；省略由入口生成，返回值用于后续动作 |
| plan_run | run_id、stages数组 |
| archive_input | run_id、name，以及source或text二选一 |
| dispatch | run_id、stage、agent、skills数组；可选mode=prepare |
| complete | run_id、stage、dispatch_id、artifacts数组；child_session可选 |
| resolve_child | run_id、stage（只读定位真实返回子会话） |
| analysis_summary | run_id（只读台账摘要，保留条目原声明/状态/范围，不批准或自动排序） |
| extract_word | run_id、path（已归档inputs/<name>.docx；生成正文表格文本和提取限制元数据，原件不变） |
| read_source | run_id、path、start_line、end_line（本run inputs内，最多请求200行） |
| block / fail | run_id、stage、dispatch_id、reason |
| request_confirmation | run_id、stage |
| resolve_confirmation | run_id、stage、decision、reason |
| generate_analysis / validate_analysis / run_status | run_id |

stage、decision等仍受原合同检查，不能用不存在的dispatch_id收口，也不能凭用户“继续”自动批准。派发只记录受控事件，真正run_subagent仍由总控随后调用；子任务完成证据校验已覆盖新旧两个入口。

dispatch还返回completion_template，实际子调用正常返回后才可使用。complete省略child_session时从真实父trace自动定位唯一匹配子任务，核验正常结束、角色、工作区及派发关系；resolve_child成功仅表示身份查到，completion_verified仍为false，不替代交付核验。catalog列出必需产物，无需搜索脚本猜测。

dispatch的source_read_templates按本run实际输入文件生成读取请求，避免把示例文件名当真实路径；默认只读前200行，材料较长时按返回total_lines继续读取。空输入列表仍表示缺资料，不自动创造来源。

--request仅接受请求文件路径，不接受内联JSON。read_source保留连续原文和换行，结束行超出末尾时截断并报告requested_end_line、实际范围和truncated；起始行越界仍报错。只读与请求纠错使用独立预算，详见恢复策略。

## 输入归档

Word使用archive_input.source归档原件后调用extract_word，读取返回text_path与metadata_path，再专业分析。它不是OCR或版式验收，上传附件路径接入也尚待宿主验证，见[Word与文字输入](word-and-text-input.md)。文字text不自动绑定宿主原消息，需总控忠实复制，不能将重述标成逐字原文。

source仅允许实际文件位于项目inputs或acceptance目录内，其他文件先由维护者明确准备到输入目录，避免默认读取任意本机文件。text保存明确给定的文字，不作需求分析；转达来源必须如实标明。name为简单文件名，目标固定为已存在run的inputs目录，拒绝路径穿越、目录链接及不同字节覆盖；相同字节重复归档返回already_archived。返回路径和SHA256，不自动登记已批准来源或正式专业产物。

归档在当前进程内执行，不调用cp、不执行shell；合同错误可限次纠正，覆盖既有文件等其他错误仍停止。源码路径通过真实路径校验，但任意文件写权限下不承诺抵御并发换链接等对抗行为。

## 返回与审计

脚本成功时业务结果放在data，原始命令日志和output_tail仍保留；若无法解析完整JSON，data为null并提示读取日志，不猜测、不自动再运行。归档返回result.path/sha256。每次结构化请求在output/action-audit/<session>保存独立回执，包括请求哈希、动作、时间、分类和命令日志位置；不复制请求正文或整份输入到审计。

分类包括input_rejected、session_stopped、session_running、script_failure及runner_error。script_failure只说明底层脚本非零退出，不代表产品缺陷，也不擅自推断业务失败原因。硬中断遗留started回执由摘要列为incomplete，不能当成功。

summary只读聚合当前会话闸门和动作回执：action_attempts是动作调用数，blocked_after_stop是停止后被拒绝的动作数，failures保留分类与证据。被拒绝的新动作不一定是同一业务任务的重试，因此不自动判断重试意图。user_summary明确声明不覆盖直接CLI/任意工具，零条拒绝不证明“没有重试”。原会话失败清单哈希不因新增动作回执变化；恢复仍按既有审查入口。

## 边界与验证

analysis_summary核验台账来源和生成正文一致后返回精确条目及文件哈希，用于减少口头汇报超出实际记录。它不推断语义覆盖，不创建新交付门槛；流程状态另读run_status。说明与澄清排序原则见[分析摘要与澄清优先级](analysis-summary-and-clarification.md)。

2026-10-10最新验证：129项Node测试通过，最小真实需求分析已正式完成并等待确认；其余旧测试结论按时点保留。详见连续修复记录（本地历史记录，不随源码分发）。

目录/catalog、summary是只读查询，不解除闸门。stopped时仅run_status、block/fail按既有诊断/收口规则处理；参数正确也不保证阶段允许收口。身份、审批、语义及工具权限边界沿用原设计。旧CLI保留给未覆盖脚本及维护者，新层不能禁止直接工具绕过，不修改PenguinHarness安装包。

本轮工程测试覆盖适配参数、真实CLI请求文件、合成运行创建/归档/规划/状态、错误JSON停机、跨调用拒绝、审计覆盖、输入越界/覆盖拒绝和无派发收口拒绝。全部使用合成父trace，不是PenguinHarness真实Agent复验。历史失败记录不迁移、不补造动作审计。

下一步待确认后进行新会话最小真实复验。本轮不自动解除15:43会话暂停，不执行完整业务测试、不恢复模型评测、不提交GitHub。

2026-10-09验证：106项Node工程测试及7项Python报告逻辑测试通过，新增7项结构化动作测试已纳入全量工程回归。七个角色公开指令同步后差异0，15:43失败清单和会话状态哈希未变。日志为本机output/structured-actions-regression.log；工程测试不能证明真实Agent已正确使用新入口。

## 2026-10-10：同一运行计划增补

下游生成新增export_test_points、export_test_cases、assess_evidence、normalize_defects、build_report_metrics、export_report，仅传run_id。仅当前拥有的专业派发可用，自动保存输入及旧输出快照；具体修正预算、失败边界与验证要求见[下游技术返修](draft-artifact-recovery.md)。生成成功不等于完成登记或批准。

首次计划用plan_run；用户继续同一任务的后续阶段用extend_plan，字段为run_id、stages数组、reason。它只增补目标阶段与依赖，不重置旧结果或确认，重复范围返回unchanged=true。增补不是派发或执行授权，仍按最新run_status、阶段依赖与确认规则继续。详见[运行计划增补](run-plan-extension.md)。

## 2026-10-10：分析用户修订补充

`resolve_confirmation`在`stage=analysis`、`decision=revision_requested`时同时支持待确认与已批准状态，`reason`必须记录用户明确提出的修改意见。自动归档版本并使依赖阶段旧批准失效，返回`archive`和`affected_stages`。随后正常派发分析，`event.revision_context`提供归档与修改信息，新版仍须登记完成并重新确认。不要用此动作冒充用户意图或替代自动技术返修；详见[分析用户修订](analysis-user-revision.md)。

## 草稿诊断补充（2026-10-12）

五个非执行草稿阶段的preview_revision成功资格与revise_stage成功结果现提供revision_budget；受控修订后的生成、导出、validate_artifacts、handoff按新派发隔离动作额度，旧计数保留。不得把ineligible外层completed当作恢复成功，执行阶段不适用。详见[通用有限返修预算](draft-revision-budgets.md)。

`diagnose_test_points`（run_id）只读汇总测试点JSON、规则引用和必覆盖缺漏，不要求XMind。检查result.status、error_count、coverage与coverage_counts。停止状态下可诊断但不解锁，不消耗正式生成/校验预算；通过后仍需导出和正式校验。详见[测试点批量诊断](test-point-diagnosis.md)。

`apply_analysis_feedback`（run_id、text）用于用户补充、澄清回答及范围修改；核对当前父会话原话并归档，自动请求分析修订、使下游旧结果失效。不可用批准备注代替。新版由需求角色生成，停在待确认；详见[补充接入](analysis-feedback-intake.md)。

`preview_revision` 接收 run_id、stage、reason，只读返回 result.status=eligible/ineligible 和原因。允许诊断 stopped 控制器，但不会解锁。`revise_stage` 在写锁内重复检查；资格不符返回 completed 包装下的 result.status=ineligible，不清空历史或全局停止，不能按外层状态宣称返修成功。只有 revision_requested 才能重新派发；锁冲突、实际写入故障等仍按工程错误处理。

历史非受控命令需要工程侧审查，沿用 recover-stage/review-session 的证据和哈希校验，不让总控编造审查或用户业务批准。审查恢复会保留草稿快照，新派发使用独立生成预算，原失败次数保留。

`{"action":"diagnose_analysis","run_id":"<实际run_id>"}` 在无 Markdown 时诊断台账结构与原文引用。外层 completed 不代表草稿通过，必须检查 result.status。仅在 passed 后正式生成并验证；不代替用户确认。read_source.quote_json 提供保留原始换行的 JSON 字符串值。有限返修与本次真实会话限制见 修复记录（本地历史记录，不随源码分发）。
