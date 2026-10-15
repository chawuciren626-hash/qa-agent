# 10:32真实复验会话排查

检查日期：2026-10-12。只读检查真实会话、子会话、动作回执、清单、附件及最终台账；未重新派发、批准、生成正文、重置预算或执行产品测试。

## 对象与结论

父会话session-2026-10-12-10-32-28-d11f649c，标题“测试点梳理与报告输出”。子会话session-2026-10-12-10-33-14-5ca0116f，角色requirement_analysis_agent。

run-2b9301e8-66fb-42af-86da-c16e62e94b8c，位于E:/QAWorkspaces/2026-10-12-10-32-28-d11f649c/output/runs下。

本次约11分51秒，停在需求分析，不是Playwright执行故障。create_run、三份附件归档、六阶段规划、真实专业派发成功；测试点、用例、执行、缺陷、报告尚未派发。应用任务idle，manifest与analysis仍为in_progress，控制器状态ready；并非整个控制器stopped。

## 故障链

1. 10:35:26第一次generate_analysis失败：RULE-FUNC-001对requirement.md的引用不是连续原文。
2. 10:38:22第二次生成失败：RULE-ENV-003对requirement.md的引用不匹配。
3. 10:39:02第三次生成失败：同一规则对api.md的另一引用不匹配。生成动作累计3次失败（初次加2次修正），下一次被task_paused拒绝，不是“3次修正后第4次修正”。
4. 中途一次读取请求文件尚不存在；随后并行提交的多个读取JSON缺少结尾右花括号，消耗共同unbound:request:预算。现在read-requirement-3.json、read-api-1.json、read-api-2.json仍为非法JSON。
5. 子Agent使用临时PowerShell/Python脚本修正引用和换行，随后发现observed/pending记录缺reason。只读摘要与正式验证都依赖尚未生成的Markdown，不能充当“生成前全量台账诊断”。
6. 10:44总控尝试自行generate_analysis，被专业职责hook拒绝。未登记failed/blocked，仅口头说明阻塞并建议维护解锁或重建run；正式状态未收口。

起步时另有project-command.mjs doctor被总控hook拒绝。子Agent的临时脚本方式与既定受控命令规范不一致，不能因为后来结构修好就当成正式专业交付通过。

## 独立核对

- requirement.md、api.md、openapi.json的归档字节与当前上传原件完全一致。前两份为LF，OpenAPI含2374处CRLF；格式差异确实存在，但不是源文件损坏证据。
- 以现有inspectRequirementLedger只读检查当前磁盘台账：58条规则，结构、来源种类、引用、reason等检查通过。未评估58条规则的业务正确性、完整覆盖或优先级。
- requirement_analysis.md仍不存在，没有正式分析交付、业务确认、下游产物或测试执行结果。
- 父子最终摘要均称35条规则，与当前文件58条不一致，是沿用旧统计而非最终文件事实。
- 控制器ready，但generate_analysis及unbound:request:各累计3次失败；analysis_summary累计2次失败，validate_analysis累计1次失败。局部预算耗尽被对话描述成需要全局维护解锁，不准确。

原件SHA256：

- requirement.md：6bb7efa5ccb06e59cbc1ece15239357ad89397e0350a5e4990465a68d2818bd4
- api.md：28a13bf9f8a3fb70c7e97b7b8cc5ba3f85a5157ca2a76f23b66e05d1067aa3a4
- openapi.json：1b8e2c9b8b62cc65e7707372ab1e059dd9bf65a631f5f7f352798a63c38a07f4

## 工程原因与建议顺序

1. 先补不依赖Markdown的只读全量台账诊断：一次返回所有字段/引用问题，标明规则ID、引用位置与源文件，不靠重复生成逐个发现错误。不得放宽来源匹配或修改原文迎合引用。
2. 降低请求JSON和精确引文的手工拼写负担：从结构化输入生成请求、按来源位置提取真实连续引文；保留原文哈希和来源位置，不靠模型手工转换换行。对实际JSON错误给明确修复位置。
3. 完善同run专业草稿恢复：在真实子任务已结束、原文未变、未批准且无执行副作用时，核验修订后再决定有限续办；留存失败证据，不直接改state.json清零、不靠重建run绕过预算。
4. 子任务失败后由总控准确登记阶段结果并展示磁盘事实；区分局部暂停、整体停止与业务待确认，不把未记录的阻塞描述成正式状态，也不复用过时规则数量。
5. 使用这次真实的多文件、混合换行输入复验修复，再继续原全流程。此前单句样例与169项工程回归未覆盖本次组合故障，不能作为真实多文档已通过的依据。

本轮仅诊断与记录，不实施恢复，不要求用户重新上传或重建会话。当前真实run保留原状，后续修复需先核验现有恢复入口对本次失败证据的适用性。
