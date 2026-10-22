# 独立用例的预期依据

## 数据约定

既有`expected`仍是正式预期字符串。新生成的独立用例使用`expected_basis`为每个预期子句记录依据：

```json
{
  "expected": "显示请输入标题",
  "expected_basis": [{
    "expected": "显示请输入标题",
    "kind": "requirement",
    "source_path": "inputs/request.txt",
    "quote": "标题为空时提示请输入标题"
  }],
  "observations": [{
    "statement": "名称是否需要唯一性约束",
    "kind": "needs_confirmation",
    "reason": "当前资料未定义；仅为可选扩展建议，不作为当前任务失败依据"
  }]
}
```

正式依据类型：`requirement`、`contract`、`ui_explicit`。分别代表需求、接口/业务约定、界面明确声明的约束，不代表模型已自动验证其权威性。页面实际接受某值不等于业务要求允许该值；前端约束也不证明后端独立校验。

工程假设和缺少定义的可选建议放在`observations`，类型为`engineering_assumption`或`needs_confirmation`，不能冒充正式预期。可选扩展直接省略亦可；只有影响用户既定目标的必要业务歧义才进入任务`questions`，不是每条建议都让用户确认。

## 自动检查与边界

`scripts/expectation-basis.mjs`在独立任务诊断及交付校验时使用已验证的`task.source_paths`，不会按Agent给出的路径任意读文件。检查每条引用的文件是否可用、引文是否是连续原文、预期子句是否实际存在于`expected`、所有预期子句是否被关联。已读取来源的哈希仍进入原有产物证据清单。

缺字段、虚构引文、未覆盖预期等是草稿纠错，不是用户解锁事项。`expectation_diagnostics`明确返回`semantic_verified=false`和`approval_required=false`。来源定位成功只叫`source_located`，不称“需求语义通过”。

**确定性检查不能证明原文蕴含预期。** 如果Agent把“提示错误”和“不落库”一起写进同一关联项，引用真实的提示需求，机械检查不能自动识别后半句无依据。专业角色仍需逐句自检，后续真实复验应保留此类失败，不以字段齐全替代质量结论。本项也未实现通用语义模型裁判。

旧用例缺少`expected_basis`仅提示`not_recorded`，仍可读取及交付，不追溯改写历史产物、不补造前序台账。新用例由角色及Skill指导填写，尚不是不可绕过的强制元数据门禁。生命周期模式保留原有`design_contract`追溯，本项不迁移其合同。

## Excel交付

保留“测试用例”和“问题清单”原格式。有依据或建议时增加“预期依据”表，按用例ID展示预期、依据类型、来源路径、摘录和说明。观察/建议明确标注“非验收断言”；所有文本仍采用原导出器的文本单元格，不执行来源中的公式。

独立用例交付校验会重新读取Excel，并逐项与JSON依据表比对，避免JSON更新但Excel仍旧。没有新增数据时保持原双表输出。本项不重复要求用户原生Excel验收，也不开展字体、版式改造。
