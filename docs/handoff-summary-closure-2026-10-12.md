# 交接摘要与输入顺序收口

日期：2026-10-12。工程：E:/Codex/AITestWorker。

## 变更

- catalog增加invocation_steps，明确先write_file保存动作JSON、等待成功、再execute。总控hook及专业角色使用的CLI在缺文件时提供相同纠正顺序，不创建猜测请求、不启动业务动作、不要求人工解锁。保留现有request_correction预算和失败回执。
- handoff完成登记后返回data.presentation：run_status为清单快照，analysis阶段另含analysis_summary。status为ready、unavailable或review_required。摘要失败不撤销已提交的交接、不重复确认；仅检查对应只读动作。后续状态或产物变化时重新读取摘要。
- 共同指令允许直接使用有效交接摘要，减少额外查询。父总控仍不能批准或修改专业产物。
- 需求Skill、派发提示、总控与摘要复核清单明确保留强制/禁止、条件否定、AND/OR关系、数值和指定文案。多个同时要求的结果不能改成任选其一；错误提示不能替代业务结果。这是通用语义审查要求，没有引入特定业务关键词或自动语义通过门槛。

## 真实复验

真实PenguinHarness本机接口提交文字需求，由tokendance / step-3.7-flash执行，不用合成trace替代。只到分析待确认，未生成测试点、用例或执行产品测试。

- 父会话：session-2026-10-12-10-08-06-941871e0。
- 子会话：session-2026-10-12-10-08-46-d97ee368。
- run：run-6d85ca51-00cc-4f5a-b909-81ea5285e05f。
- 工作空间：E:/QAWorkspaces/2026-10-12-10-08-06-941871e0。

本次规则正文保留“任务名称必填；空白名称不允许保存”及指定提示文字，不再使用“阻止保存或返回错误”。但规则2将“空白”表达为“为空”，未登记空白输入边界问题，因此不能宣称所有语义歧义已消除。

父总控先通过complete和request_confirmation分步登记，并未自主选择handoff。随后追加明确的工程回执检查，不批准业务，要求同run幂等handoff。返回already_recorded=true、presentation.status=ready，run_status.consistency=consistent，分析摘要包含2条实际需求。交接前后manifest逐字节一致，确认仍只有1条且为pending；3份来源/产物哈希一致，下游5阶段均skipped。父子任务已idle。

工程回执检查是人工明确提示后的真实调用，不代表总控已能稳定自主选择该入口。分析摘要本身没有status字段，ready属于data.presentation；模型最后回复将其简称为analysis_summary的status，应以结构化回执为准。

## 过程问题与边界

1. 总控第一次缩写了派发prompt，缺少策略原文，被hook拒绝后自行完整传递。未放宽派发边界。
2. 子Agent一次在请求文件写入前execute，收到request_correction后补写并成功。本次实机发生时CLI仍为原ENOENT提示；随后补齐CLI明确纠正信息并增加回归断言，未再次制造实机失败验证新文案。
3. 总控最终仍邀请用户补充长度、清除按钮、国际化等额外背景，问题收敛未完全稳定。此为可选范围/表达问题，未据此新增审批或执行下游。
4. 自然语言质量仍依赖专业复核；本轮没有NLP等价证明。交接摘要是文件快照，不保证跨文件事务、产品通过或获得执行授权。没有故障注入验证摘要读取期间的文件竞争。

不将上述问题重新变为用户解锁或补材料前置。后续宜单独优化派发参数复用和语义质量，不再靠重复堆叠提示词宣称零误用。本项结束后可回到执行准备检查，再做完整生命周期复验。

## 证据

外部证据目录：E:/QAWorkspaces/migration-check-2026-10-12。

- handoff-summary-submission.json：实际创建/提交回执。
- handoff-before-repeat.json：幂等交接前清单。
- handoff-summary-verification.json：父子工具调用、两次错误、最终文本、摘要及哈希核验。不包含令牌。

本轮同步9份角色/Skill文件，复核in_sync。未修改旧run或业务确认、未提交GitHub。工程回归结果见当前状态文档。
