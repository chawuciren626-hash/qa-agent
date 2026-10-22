# 测试点批量诊断与规则分类

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
