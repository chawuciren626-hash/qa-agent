# 会话闸门最小真实复验

## 结论

2026-10-09 15:43通过PenguinHarness界面发起同范围需求分析复验，模型step-3.7-flash。会话闸门真实拦截了失败后的变更重试，但需求分析流程未跑通；不能认定整体通过。Agent最终自然结束，本轮未人工点击停止，也未审查解锁重跑。

- 父会话：`session-2026-10-09-15-43-36-66f57ea7`。
- run：`run-2026-10-09-15-43-36-66f57ea7`，当前status=created，plan=null，stages为空。
- controller-session：stopped，原始失败为Unknown, empty or duplicate option。
- exec_command共11次，run_subagent为0次；没有dispatch_id、分析产物或确认请求。
- 原始材料已复制，requirements快照与原文件SHA256相同；补充依据注明Codex转达已有确认，非新增签字。复制使用了外层cp及&& echo，违反单命令入口约束，不能称为全程受控。

## 实际证据

时间为北京时间，依据结构化工具调用及返回，不使用模型推理文字作为证据。

1. 15:43:42查询已登记help，携带真实controller-session；随后create-run通过统一入口成功，未使用不存在run的外层日志参数。
2. 15:43:57调用plan-run时遗漏分隔符，把业务stages参数放在包装器层。返回input_rejected，调用ID为`chatcmpl-tool-898b84d8b92a45f3`。会话失败记录于15:43:58持久化为stopped。
3. 查看帮助后，15:44:06改正参数重试plan-run。入口返回Controller session stopped，调用ID为`chatcmpl-tool-9469befa29c5e7fd`。计划没有生成。这是闸门拦截成功，不是Agent没有重试。
4. 状态查询经历错误action、错误位置参数两次拒绝后才正确调用。允许诊断不代表这些错误尝试符合一次失败停止约定。
5. Agent尝试未派发阶段的blocked收口，因为没有dispatch-id被参数合同拒绝，调用ID为`chatcmpl-tool-bcb9758d2e2eff10`。这不是会话闸门禁止所有收口，更不能补造dispatch-id。
6. 最后通过show-run-status只读返回created、review_required、No selected plan stages、workflow_closed=false。命令审计目录为`output/command-runs/372aec7e-fa0b-4fb1-b05f-27f8932a7e9f`，exit_code=0、termination_confirmed=true。

最终界面汇报正确列出了created、无子会话、无dispatch及无确认，但声称“未改参数重试”，与第3项相反；还把blocked参数拒绝与会话拦截混为一谈。状态快照的事实部分有效，模型自行补充的行为解释仍需核验。

本次没有调用session-status，Agent根据拒绝消息推断闸门停止；Codex独立读取state.json确认stopped。正确状态查询也没有解除会话失败。观察时未发现命令行匹配本会话或project-command的Node/Bash进程，此为限定范围检查，不是全系统进程保证。

## 验证覆盖

- 已验证：真实会话身份、创建run、错误持久化、跨命令拒绝重试、stopped下允许只读状态查询、未派发时不允许补造阶段收口。
- 未通过：Agent失败后不重试、单入口命令约束、准确说明自身行为。
- 未进入：子Agent真实派发、分析台账与Markdown一致性、语义审查、阶段确认及后续流程。
- 未验证：实际审查解除闸门、工具层防绕过、完整端到端稳定性。

## 下一步建议

先收敛通用结构化动作入口：创建、计划、状态查询等使用统一的参数结构与机器可用动作目录，由适配层构造底层参数，不继续让模型猜测脚本位置参数与双层run-id。保留会话闸门和原有审批/阶段合同，参数错误不能自动纠正执行。

失败汇报应聚合会话失败记录、命令返回与阶段清单，明确区分输入拒绝、会话拒绝和阶段拒绝；“是否重试”等行为结论必须有实际工具证据，不能由模型自行宣称。created且尚未规划应和清单损坏/审计矛盾区分，当前No selected plan stages只是诊断提示，不证明清单损坏。

输入归档也应有受控动作，减少cp/重定向等外层shell需求。真正禁止外层命令与文件工具绕过仍需PenguinHarness工具层支持，不因增加适配层而宣称实现隔离。

本轮仅验证和记录，不实施上述下一项，等待用户确认。未修改工程代码/Skill/配置、未安装、未启动业务测试或模型评测、未提交GitHub；此前99项Node/7项Python工程测试不是本轮真实复验通过证明。

## 快照与历史保护

当前run清单SHA256：`B1F7CA47CFDBD1A867A12B192C2776721AE14EB57A642803E37F9D5AC42DA96D`。

当前会话状态SHA256：`D8794C7C5112BCF31CBF9306182D9C22D00AB608B9B9AECB3C075B26120158A7`。本记录不构成解除暂停授权。

需求原文及快照SHA256：`C5824466B7531AF2C00E2231657940A2B01ADB52F653CE060CC86392B50F82AD`。

旧失败run清单仍为`B4F6EDCF946DFFCE607D4B6CB418E124477E10D73F526895EB74889D49539DFD`，旧恢复run清单仍为`8AA2CEEB495B7321A4286F638E7DDEA72B76634192BA5CDCAFF783C8A8A6942E`。原始trace保留在PenguinHarness对应父会话，截图仅留本机`output/controller-gate-recheck-20261009.png`，不提交原始会话。
