# 入口修正与真实复验

日期：2026-10-12。范围：上一轮真实验收中的身份误用、共享文档寻址、旧状态查询入口及过度澄清。未更改审批政策或模型，不绑定具体业务系统。

## 实施

- project-action的catalog传入实际工程根，基于directoryContext提供runtime_context和带真实父ID的invocation。父子使用同一隔离上下文。旧模式无身份时返回null与占位提示，不猜身份；显式非法上下文不回退。
- 总控hook保留严格身份匹配，拒绝时提示宿主真实ID，不自动替换或放行。所有实际动作仍经过父会话、trace、目录与阶段校验；catalog不授予权限。
- 派发prompt明确共享文档绝对根；共同指令与需求Skill明确docs相对工程根，不相对会话或安装Skill目录。任务来源仍限当前run，不把工程历史输入当本次需求。
- 移除总控/共同状态说明中直接调用旧show-run-status的指引，统一run_status请求；总控优先采用handoff_template。
- 需求角色、Skill、总控和analysis_summary展示提示区分关键行为歧义、执行安全、可选建议及材料局限；保持实现中立，不把unresolved_ids当必答清单。不新增台账字段、不删未决记录、不代用户批准。没有引入基于业务词或固定数量的过滤器。

## 工程验证

npm run engineering:contracts：167项通过，0失败/跳过。通过独立临时工程副本执行，测试目录正常清理。新增目录测试覆盖catalog身份/路径、跨身份仍拒绝、坏上下文拒绝、旧模式不猜ID；补充hook纠错提示和派发规则断言。工程测试不证明自然语言语义正确。

本机同步9份角色/Skill文件，随后sync检查in_sync。git diff --check通过（仅CRLF转换警告）。未安装依赖、未修改宿主server补丁、未提交GitHub。

## 真实复验

使用运行中PenguinHarness原生localhost接口创建新默认空间会话并提交普通文字需求，由真实tokendance / step-3.7-flash执行；未使用合成trace。并未进行UI点击或完整六阶段测试。

- 父会话：session-2026-10-12-09-59-58-0d7b6fbb。
- 子会话：session-2026-10-12-10-00-49-a68b0c7b，requirement_analysis_agent。
- 运行：run-cb3ca55f-7f4c-4fb1-9e78-faf6ccc83b8a。
- 目录：E:/QAWorkspaces/2026-10-12-09-59-58-0d7b6fbb。
- 提交要求：仅分析“任务名称必填；空白名称不允许保存，提示文字为：请输入任务名称。”，交付后等待确认。
- 结果：真实子任务返回，父总控使用handoff；事件包含plan_created、dispatched、completed、confirmation_requested。manifest为awaiting_confirmation，confirmation为pending；其余5个阶段skipped。父子任务均idle。
- 分析Markdown、台账和原文共3份文件的SHA256与确认快照一致。工作空间未回到工程根。

上轮两次身份误用、两次共享docs读取失败、一次旧状态命令调用均未重现。子Agent直接读取E:/Codex/AITestWorker/docs下的说明；需要决定的问题由6项收敛为2项（保存场景、空白边界），其他校验维度作为候选建议说明。保留模型生成的不确定性，这只是一条需求的样本。

## 仍存在的问题

1. 总控第一次执行create_run之前未写请求文件，被hook以ENOENT拒绝；自行补写后成功，未要求用户解锁。尚未达到零错误调用。不能通过自动创建猜测请求来掩盖这一错误。
2. 台账RULE-1将“不允许保存”改写为“阻止保存或返回错误”。返回错误不能替代不保存的要求，存在弱化强制结果的风险。正式产物仍待用户确认，本轮未由维护者直接改写或批准。需后续通用语义保真检查，不应硬编码本例业务规则。
3. 总控最终直接读取了正文/台账，没有另外执行analysis_summary及run_status。实际状态由本轮独立读取manifest核验，不能宣称模型严格遵守全部汇报规则。后续可考虑在handoff返回统一状态和台账摘要，减少额外调用和提示遗漏，同时不把摘要当批准。

## 证据与下一步

机器记录：E:/QAWorkspaces/migration-check-2026-10-12/entry-fix-verification.json，保存父子工具调用、错误、最终文本及哈希核验，不含令牌。

结论：本项代码/配置修正、同步和真实最小验证完成，原三类技术误用本样本未复现；语义与调用顺序仍有残留，不宣称全流程质量通过。按逐项确认约定暂停，建议先收口上述残留，再继续执行准备检查与完整复验。旧待确认会话及历史数据不修改。
