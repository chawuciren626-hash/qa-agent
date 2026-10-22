# 用例设计质量与执行入口校验

## 使用方式

1. 用例Agent生成当前run的design/test_cases.json，补充下面的design_contract。
2. `npm run design:validate -- --run-id=run-example --draft`校验设计草稿；允许未决规则存在，仍拒绝错误数据和缺失来源。
3. 确认规则后，运行不带`--draft`的相同命令检查可自动化用例，再按既有选择流程生成执行计划。
4. create-execution-plan自动进行严格校验并保存design_gate；execution:plan:validate和test:ui都重新计算检查，不能只依赖旧报告中的passed。
5. 发现问题时修改设计，重新生成计划并重新申请执行确认。禁止直接启动Playwright绕过项目入口。

不改变用户在PenguinHarness交付需求的方式；所需结构由Agent生成，用户仍只需审查需求和授权范围。

## 用例合同

下面是结构示例，不是自动确认或业务规则模板。source和confirmation_ref相对本次run目录，文件必须真实存在且非空。JSON顶层保持原有数组/cases/test_cases格式均可。

```json
{
  "test_data": { "name": "abc", "gross": 10000, "discount": 4000, "paid": 6000 },
  "design_contract": {
    "basis": [{ "rule_id": "RULE-1", "source": "inputs/requirements.md", "rule": "名称长度按码点计数", "status": "confirmed" }],
    "assumptions": [],
    "data_checks": [
      { "kind": "length", "key": "name", "unit": "code_points", "expected": 3 },
      { "kind": "minor_unit_sum", "currency": "CNY", "terms": [{ "key": "gross", "sign": 1 }, { "key": "discount", "sign": -1 }], "total_key": "paid" }
    ]
  }
}
```

依据basis至少一项，每项rule写出具体业务规则，不只写“见需求”。status可以是confirmed、pending、conflicted；严格执行仅接受confirmed。必须先有`analysis/requirement-ledger.json`及原始来源快照，rule_id、rule、status、source与台账一致，确认假设也要引用台账rule_id和用户确认来源。上述片段仅展示用例字段，不是独立完整输入；详见[需求来源与语义治理](requirement-provenance.md)。

假设格式为 `{"statement":"具体未确定内容","status":"pending"}`。只有取得真实确认后才可改为confirmed，并补充 `confirmation_ref` 指向本次run内的确认文件。rejected假设也不能用于执行。没有假设使用空数组，不用模糊文本代替。

长度单位必须显式指定：code_points为Unicode码点、utf16为JavaScript字符串长度、utf8_bytes为UTF-8字节、graphemes为字素。不同单位不能互换；不擅自trim或规范化数据，应按业务规则提供实际输入及相应检查。

金额使用整数最小单位，currency说明币种，terms通过sign取1或-1进行求和，total_key指向预期合计字段。所有值必须是安全整数；内部用BigInt求和，拒绝小数或超出安全整数范围。该检查验证已声明公式，不推断退款/优惠政策，也不支持隐式跨币种换算。

data_checks可以为空，但仅适用于没有此类确定性数据约束的用例，不得为了跳过错误而清空。目前支持长度及整数金额公式；其他格式、范围、状态边界仍需人工或后续专用规则验证。

## 执行限制与追溯

- 用例来源、选择文件和引用依据必须属于当前run，拒绝路径越界及实际路径逃逸。检查重复ID、选择缺项和不可自动化条目，避免悄悄漏掉已选用例。
- design_gate记录用例文件及引用文件的SHA-256。内容变化、计划用例被修改或合同缺失时启动前阻塞。
- 仅对选中的用例执行严格规则检查，但源文件整体哈希变化也会使原计划失效；这是保守设计。
- 草稿校验检查全部用例，严格模式默认检查automation_feasible=true用例；显式选择时每个选中ID都必须满足条件。
- 质量报告是quality/design-validation.json；启动阻塞记录为execution/execution-blocked.json。已有test_results.json不会被启动阻塞覆盖，报告人员须区分历史结果与本次阻塞状态。

## 兼容与边界

旧产物和历史报告不修改。旧执行计划缺少design_gate时不再允许从test:ui重跑，需要补充真实依据、重新生成计划并申请确认。Schema允许旧用例作为设计资料读取，但执行入口严格要求合同。固定验收资产prepare-acceptance已迁移，仅准备不会启动浏览器。

本功能校验的是声明的数据约束及文件一致性，不是需求语义自动证明。来源文件存在、confirmed标签及confirmation_ref不能证明批准来自真实用户；目前没有签名或工具权限隔离。模型仍可能漏声明假设/检查或引用无关证据，需要评审，不宣称能自动拦截所有臆造规则。
