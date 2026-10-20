# 第5项真实Agent短任务验收

日期：2026-10-19，时间使用北京时间。结论：首轮短任务未通过，停止扩大长流程验收，保留失败现场。工程回归通过不能替代本次真实模型运行结果。

## 实际执行

- 通过运行中的PenguinHarness原生会话与任务API创建总控任务，真实模型派发automation_execution_agent并控制浏览器。未在Codex中代写业务产物、修改manifest或清除失败记录；没有向运行中的Agent追加纠错提示。
- 会话：session-2026-10-19-18-18-32-5e8d7efc；子会话：session-2026-10-19-18-19-37-0520cd3a。
- 工作区：E:\QAWorkspaces\2026-10-19-18-18-32-5e8d7efc；run：run-75a70f9d-0f42-4602-9570-82de119bf3a5。
- 当前模型为tokendance / step-3.7-flash，沿用已有设置；未修改模型、代理、凭据及其他用户任务。
- 目标为自建虚构站点http://127.0.0.1:4317/unavailable?scope=canary-20261019-a，无真实用户数据。只授权此scope查看、填写和一次创建尝试，不删除种子数据。
- 要求3至4项必要检查，环境异常时保留未完成范围，继续缺陷分析和Excel、Word/PDF交付，不补造前序阶段。
- 总控实际计划仅execution、defects、report，未强制需求分析、测试点和用例设计；用户介入与审批次数均为0。

## 结果矩阵

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 安装与运行时 | 通过 | 只读自检ready，宿主installed、changed=false，角色同步检查沿用4B/4C部署记录 |
| 独立URL直接执行 | 部分通过 | 真实打开浏览器、填写、点击、断言和finish；无前序文件门槛 |
| 异常后不重复提交 | 通过本样本 | 网络记录中仅1次POST，返回503；随后检查错误反馈，没有重放创建 |
| 子Agent单次结构化调用 | 未通过效率目标 | 执行子Agent有10次qa_request调用，但仍有10次请求文件写入；接口可用不等于减少往返已达成 |
| 执行到缺陷/报告交接 | 失败 | 修正CLI并校验成功后，handoff仍拒绝历史失败；随后complete使控制会话stopped，后续派发失败 |
| 部分结果可信交付 | 未通过 | JSON和截图存在，但阶段摘要completed，正式partial报告未交付；未测与失败语义仍需统一 |
| 断言与结论一致 | 未通过 | CASE1/CASE2仅检查标题可见或标题文本，却将预算120、状态draft一起写入通过预期和最终结论 |
| 文件链接可点击 | 当前降级证据失败 | JSON和证据目录链接渲染为span，不可点击；不代表所有Windows路径或Office链接均失败 |
| Excel、Word/PDF打开 | 未执行 | 本轮未生成这些文件，不能用历史打开结果代替本轮验收 |
| 中文和简洁答复 | 部分通过 | 派发和最终答复主体中文，但最终回答仍转述handoff、resolve_child_handle、stopped等内部细节 |
| 完整流程、独立用例/报告、worker故障注入 | 未开展本轮真实验收 | 短任务已有关键阻塞，暂不扩大；之前合成故障回归记录继续有效，但不算真实验收通过 |

原始test_results.json记录5项断言、4通过、1失败。这只是当前工具判定的事实，不是审核确认的4项业务检查全部通过；本轮额外识别了断言范围不足的问题。服务503是故意选择的环境故障，不能将本轮预设故障直接认定为产品缺陷。

## 主要问题与根因

### A5-01 已纠正CLI错误仍阻断交接 P1

18:22:16子Agent调用`node scripts/project-action.mjs validate_artifacts --stage=execution`，缺少父会话标识且将动作名当作CLI子命令。入口18:22:19返回input_rejected，无业务动作执行。18:22:24子Agent改用合法execute和qa_request，validate_artifacts通过，18:22:35正常返回结果。

18:22:40父Agent的handoff仍被拒绝，原因是`Child command failed or was rejected; cannot complete this dispatch after retry`。代码交叉验证：scripts/project-action.mjs的CLI异常分支仅在能唯一解析controller-session时生成可核验的恢复回执；本次只能返回无绑定的input_rejected。scripts/child-command-policy.mjs的assertChildCommands不认可该形式，直接拒绝，后续成功校验不能消除此错误。

修复方向：在工具执行前利用已经验证的原生子会话和派发上下文绑定安全CLI拒绝；记录明确的未执行事实，并让后续同派发成功动作按证据纠正。不得仅因任意文本声称input_rejected就放行，不能放宽未知副作用或真实越权检查。

### A5-02 错误恢复操作扩大为全局停止 P1

总控在handoff拒绝后尝试input_subagent，错误使用session-...子会话ID而非宿主返回的subagent-...句柄；工具报unknown subagent_id。正常结束的同步子任务没有可恢复运行句柄，resolve_child_handle返回unavailable不等于子任务未完成。总控最终把它当作主要故障解释，偏离A5-01的真正根因。

18:23:42总控又调用complete，尽管派发说明明确指出该动作与handoff共用校验，不是失败回退。此调用失败后控制会话stopped；后续标记execution失败，defects/report仍不能派发。修复应给出可执行的同范围处理分支，并防止handoff失败被错误升级为全局禁止离线报告；保留未完成状态，不伪造成功。

### A5-03 结构化调用仍伴随重复抄写 P2

子Agent10次请求仍先write_file再qa_request，使用同一请求文件反复覆盖。总控首次独立执行误传lifecycle专用mode=browser，修正时重用不同内容的请求文件被拒绝；随后派发prompt又因路径转义和数组空格改变两次不匹配，第三次才启动子任务。命令还反复包含`/etc/profile: line 113: which: command not found`警告，本次未阻止执行，但应单独处理启动环境噪声。

后续以真实采用率验收：单次请求无需先写文件；请求名由程序管理或明确唯一策略；已注册派发正文由程序按受管引用装载，不让模型重复抄写，仍核验同父会话、run、角色和派发归属。不能通过取消校验来减少错误。

### A5-04 通过结论超出实际断言范围 P1

CASE1实际为标题可见，CASE2实际为标题文本等于Sample document，两个断言均未比较预算和状态；最终答复却把预算120、draft一起归入通过。两项还高度重叠，要求3至4检查实际生成5断言。expectation_provenance均为not_recorded，本次没有采用已支持的依据引用。

修复方向：把需要独立验证的字段落实为实际检查，或收窄结论，只陈述观察到且被验证的范围；有现成用户原文时关联依据。创建因环境故障未完成应在覆盖和报告中明确标出，工具断言失败不能自动等同产品缺陷。

### A5-05 异常降级证据没有可点击入口 P2

父Agent最终给出两个JSON文件和证据目录Markdown链接；页面DOM实际为span，无链接按钮。penguin/ui/delivery-ui.mjs的extensions白名单不包含json和目录，components.a不支持时退化成span。这是异常降级交付未覆盖，不是Office文档损坏，也不是Windows绝对路径全都不支持。

后续为受管、安全的结构化证据提供只读预览/下载，或产出支持预览的中文摘要；目录仅提供受控展示入口。保持工作区边界与敏感文件保护，不能开放任意文件原生执行。正式文档仍需修复主链路后另验点击打开。

## 耗时与记录

- 开始18:18:32，最终答复18:24:30，父会话trace跨度358.514秒，约5分58秒。
- 浏览器开始18:20:06，finish18:21:48，约102秒。真实浏览器启动前约94秒；finish到最终答复约162秒，后段主要是产物校验、失败交接和恢复尝试。
- 父/子各30次模型请求，分别29/29次已结束工具调用。父工具等待包含子Agent运行，不能把两者耗时相加。
- 模型报告累计token含重复上下文和缓存，不是唯一输入长度，不据此推算费用。无同条件修复前对照，不计算提速百分比。
- 原始证据保留在上述工作区。工程验收辅助记录位于output/acceptance5-20261019：canary.txt、canary.json、canary-observation.json、canary-running.png、canary-final.png。这些不是业务交付替代品。
- 自建浏览器已正常finish并closed；验收后关闭本轮专用浏览器观察会话和自建夹具服务，不关闭PenguinHarness或其他用户任务，不删除现场。

## 下一轮顺序

1. 修复A5-01与A5-02，补“无controller-session的未执行CLI拒绝、后续有效校验、正常子任务返回”的回归，以及禁止complete回退导致全局stopped的覆盖。
2. 修复A5-04和异常结果收口，确保检查内容、覆盖统计、环境分类与报告表述一致。
3. 修复A5-03和A5-05：减少重复传输，补异常交付可点击入口。沿用现有模型验证，不把换模型当修复。
4. 重新运行同范围短任务，通过后再验独立用例/报告、完整流程和四格式文件打开。任何需要人工才能推进的内部恢复须如实标记，不计为自主通过。

本轮仅验收、诊断和更新文档，未修改工程业务逻辑、未提交或推送GitHub。第5项保持未完成。
