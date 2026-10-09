# 结构化分析单一来源

2026-10-09。针对真实复验中“Markdown有假设和未决，台账却只有已确认需求”的问题。本项修复内容一致性，不包含命令失败策略和状态汇报修复。

## 工作方式

需求Agent先保存原始输入快照、维护`analysis/requirement-ledger.json`，再通过确定性脚本生成`analysis/requirement_analysis.md`。正文不再独立写作：声明、范围、状态、原因、模块、分类、引文及来源定位全部来自台账，脚本不补写业务判断。

```powershell
node scripts/project-command.mjs run node generate-analysis-markdown.mjs --controller-session=<parent_session> -- <run_id>
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> -- <run_id> analysis
```

运行器的`--run-id=<run_id>`仅影响命令日志归档，不能替代上述`--`后脚本的位置参数。生成器先校验台账和真实引文，失败不写文件；不会改manifest、通过确认或派发Agent。

## 内容映射

继续采用version=1及原有source/rule ID。规则允许增加可选module（非空文字）、category（functional、constraint、context、environment、risk、clarification）。旧规则省略它们时显示“未分类”，不改变kind、scope或status。

| 内容 | 结构表达 |
| --- | --- |
| 明确业务要求 | requirement，引用适用的用户材料/正式规格 |
| 背景、隔离、初始化及环境约束 | 按原文登记requirement，category=context/constraint/environment；是否范围内明确标注 |
| 实现现状 | observation + observed，不能定义业务正确预期 |
| 待确认问题或推断 | assumption + pending，category=clarification，reason说明缺口，引用相关原文上下文 |
| 风险建议 | 依据材料选择observation或pending assumption，category=risk；无获批范围时标out_of_scope |
| 排除项 | scope=out_of_scope并填写reason，不能伪装为范围内已确认需求 |

category只是分类，不是授权。不能把预算“非负整数”解释为默认机器整数上限，也不能把trim后长度校验扩大为存储值必须trim；不确定时登记pending，不从当前实现反推业务要求。待确认问题确认后仍走原有确认来源与审批机制，不靠重新渲染升级状态。

根对象只接受version/run_id/sources/rules；来源只接受id/kind/path/origin/locator；规则只接受id/statement/kind/scope/status/citations/reason/module/category；引文只接受source_id/quote。未知字段拒绝，避免自行添加assumptions/notes等字段却未出现在正文。完整必填项和状态规则仍见[需求来源治理](requirement-provenance.md)。

## 一致性与历史

analysis契约按同一台账重新渲染并逐字比较正文；测试点和用例交接也执行该检查，不能直接跳到下游绕过。允许Windows/Linux换行差异，追加段落、删项、改写声明、台账改动后不重生成均拒绝。原始引文的Markdown及HTML被转义为文字，不能插入伪造标题/链接；这不是对文档提示注入的全面防护。

生成器只创建不存在的正文，或在已有内容完全相同时幂等返回；不同内容不覆盖。修订必须先走已有正式退回/恢复流程，由需求角色保留旧Markdown和台账到本run审计位置，再生成新正文并重新登记/确认。生成器不是版本管理或恢复入口，没有force选项。不会自动迁移历史run，不将原来的错误产物重写成“通过”。

正文渲染及其引用进入既有产物回执；渲染规则升级可能使旧正文需要审查修订，这是明确的失败关闭策略。XMind/Excel布局不变，规则ID和用例引用机制不变。

## 验证边界

自动检查证明“正文等于台账渲染”，不能证明台账涵盖原文全部要求、引文真的支持推断或用户身份真实。若Agent同时漏掉原文中的某项要求，仍需要人工语义审查。没有额外模型判分，也不把原先工程回归等同真实Agent通过。

新增工程测试覆盖全部类别展示、正文追加/删改、台账变更、下游检查、未知字段、HTML/Markdown转义、换行兼容、生成幂等/拒绝覆盖/无效输入不写入，以及不修改确认状态、pending不进入执行。本轮不重跑PenguinHarness流程；历史`run-acceptance-recovery-20261009`仍保留revision_requested。

最终工程回归79项Node、7项Python全部通过，其中新增一致性测试6项。七个角色及相关Skill同步后差异0；`git diff --check`通过。旧失败run清单及恢复run两份分析产物哈希保持原值，未自动迁移或批准，未提交GitHub。下一项为命令/子任务停止契约，需用户确认后继续。
