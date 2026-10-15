# 测试点批量诊断与规则分类

日期：2026-10-12。本轮对应第2项，不包含第3项通用返修预算或第4项测试点真实重生成。

## 使用方式

草稿JSON写好后，将请求保存为独立JSON文件，再通过project-action执行：

```json
{"action":"diagnose_test_points","run_id":"run-example"}
```

使用真实run_id。外层completed/exit_code=0只代表诊断运行完成；检查result.status=passed或needs_correction。集中处理errors后重新诊断，通过后才export_test_points、validate_artifacts。正式交付复用相同诊断逻辑，同时继续检查分析正文、反馈来源、归档哈希和XMind内容一致性。

诊断不要求已生成XMind，不执行导出或产品测试，不修改run、输入、台账、草稿、阶段确认或控制器重试计数。结构化入口仍保存请求审计回执，因此不是整个会话目录零写入。停止状态允许只读检查，但不会因此解锁。没有新增用户授权或技术解锁文档。

## 返回内容

- errors/error_count：一次返回各条可诊断错误，包括结构字段、重复编号、来源路径、不可用规则引用、缺漏覆盖；错误条数不是出错测试点条数。
- coverage.required：必须有有效测试点覆盖的规则ID。
- coverage.supporting：明确分类为context/environment的背景和准备前提。
- coverage.optional：范围内尚未确认的假设；可列草稿，不代表获准执行或用户同意新增范围。
- coverage.excluded：不能作为预期依据的观察、范围外或驳回规则；不等于这些内容全部都是用户排除项。
- coverage.missing：required中尚无有效测试点覆盖的子集，不与前四类相加。
- coverage_counts：上述各数组的程序计算数量，汇报直接采用，不从ID范围估算。
- coverage_evaluated：台账完整校验通过才能计算覆盖。台账损坏时false，不能把空missing当作零缺漏。
- exports_checked=false、approval_granted=false：本入口不证明脑图可打开、语义充分或已通过业务审批。

JSON无法解析时不能推断其内部所有条目；台账不可信时仍报告可识别的测试点结构错误，但不编造规则覆盖结论。非法或重复测试点不能用其rule_ids填充覆盖率。

## 分类契约

规则按已有kind/scope/status/category判断，不增加业务关键词、项目ID或特定网站分支。

范围内未驳回requirement及confirmed assumption要求覆盖，category=context/environment除外。已确认假设有明确用户回答，不能继续漏测。旧规则缺category时保持必覆盖行为，不能默认为背景。未确认requirement仍要求设计覆盖，但不能因此进入执行；执行入口继续要求confirmed。

context仅表示背景/架构说明，environment仅表示运行准备前提；其原文和来源仍保留在分析中，不是删除需求。真实性能、安全、兼容性、运行环境验收约束归functional/constraint，不因是非功能需求就免测。混合规则由分析角色拆分，沿既有修订/确认流程处理，测试点角色不得改上游分类消除报错。

背景/环境、观察、范围外及驳回规则不能作为测试点或用例的预期依据。此前将背景直接用于执行预期的旧产物会被重新校验拒绝；不能静默更新旧回执或重写历史材料。分类正确性仍需语义审查，本功能不是自然语言分类器。

## 验收边界与实机记录

工程测试覆盖批量错误、有效覆盖计数、明确背景/环境分类、缺category兼容、非功能约束、已确认假设、未决假设、损坏台账/JSON、停止状态下重复诊断不改变预算和阶段，以及正式校验与诊断的一致性。

在原PenguinHarness父会话session-2026-10-12-10-32-28-d11f649c运行新动作，检查原run-2b9301e8-66fb-42af-86da-c16e62e94b8c的旧70条草稿。实际返回needs_correction：17条错误，包括13条不可用规则引用和4项覆盖缺漏。分类为required=35、supporting=3、optional=5、excluded=21；missing=4，属于required子集。

缺漏ID为RULE-NF-003、RULE-NF-005、RULE-NF-006、RULE-FUNC-021。旧权限测试点已不符合新版范围；环境条目中可能混入可访问性/文档可用性等真实行为，需分析角色复核分类，不能仅凭诊断建议删除测试点。正文、台账或范围未在本轮改写。

首次原生回复将required和excluded的数量算错，故新增coverage_counts并要求原会话只读重查纠正。本轮没有重生成XMind、批准分析、派发测试点子任务或执行产品测试。真实诊断成功不等于旧测试点修复完成，更不等于全流程验收。

最终工程回归183项全部通过，临时副本已清理；60项前期专项与全量有重叠，不累加。旧样例原本将context规则作为执行预期，已调整为独立背景规则，并补充将执行依据改为context时应被拒绝的断言，保留正文生成覆盖。发布资源白名单130项有效，不代表EXE已就绪；本机角色/Skill同步完成。

原会话第二次只读诊断准确汇报17条错误及35/3/5/21/4的分类计数，明确分类不等于语义正确。前后核对manifest、analysis正文/台账、test_points JSON/XMind及controller state共6份文件哈希完全一致，原分析待确认节点及旧预算未变。新入口会保存审计请求，因此不宣称整个工作空间零写入。旧测试点仍需第3项返修机制与第4项真实重生成；不在本轮继续。
