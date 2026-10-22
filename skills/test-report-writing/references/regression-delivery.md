# 独立回归交付

用户要求修复回归、历史对照时才使用；普通报告不需要此文件或历史前序阶段。由Agent整理映射，不要求用户提供技术JSON、哈希或解锁材料。

## 工作顺序

1. 使用本次派发允许的历史材料、当前执行结果、修复说明。修复说明只是回归输入，不是关闭证据。历史结果完整保留在当前任务的inputs快照，原运行文件不修改；历史证据仅在明确提供时使用，不能遍历其他会话补齐。
2. 原始复现、邻近输入、合法路径、关联影响面分别描述。只执行当前授权范围；缺少环境/版本/业务前提时说明限制，不擅自扩大写入、权限、压力或故障测试。
3. 已有`inputs/regression-comparison.json`可继续使用，将其及实际引用的结果、证据加入report-task.json的source_paths。没有映射时，报告角色直接在report-task.json写可选`regression_comparison:{version:1,comparisons:[...]}`，每项格式与下方示例一致，但source_sha256可省略，由工具从允许索引绑定。无需写inputs、重派发或用户提供映射。已有映射有效时不要再创建重复映射；任务内字段若存在，整体优先于导入映射，不累计两份数量。无法明确关联时写空comparisons并在limitations说明，照常交付。
4. 从报告证据索引读取源文件sha256和记录。不得编造check_fingerprint、evidence_mode、执行时间或历史执行证据；缺少即标为无法对照。新旧记录ID不同可以明确关联，同ID不自动视为同用例。
5. 导出入口会自动附加回归对照到HTML、HTML使用的事实正文；独立Markdown正文应由Agent概述同样结论。Excel仍保留执行结果与问题清单，本批没有新增Excel回归工作表。不要宣称所有格式都新增了同一表格。
6. 最终回复只给完成内容、可点击产物、真正待确认事项；无法对照的工程细节放报告，不让用户逐项解锁。

## 可选映射格式

```json
{
  "kind": "regression_comparison",
  "version": 1,
  "comparisons": [
    {
      "id": "ISSUE-001-original",
      "layer": "original",
      "baseline": {"source_path": "inputs/baseline-results.json", "source_sha256": "源文件的实际SHA256", "case_id": "OLD-CHECK"},
      "current": {"source_path": "execution/test_results.json", "source_sha256": "源文件的实际SHA256", "case_id": "NEW-CHECK"}
    }
  ]
}
```

layer支持original、adjacent、valid_path、impact。这是Agent明确标注的范围，不是工具推断的影响面。id在单份映射内唯一；每条映射是一个观察对照，不等于一个缺陷。同缺陷多条结果不可相加为缺陷数。

工具仅在索引中存在精确哈希结果、记录唯一、独立后续轮次、有效顺序时间、real模式、相同预期与检查指纹、相同验证层且证据路径均在索引时给出对照观察：本次观察通过、仍失败、新增失败或两轮通过。其他情况保留无法形成有效对照。模拟/旧未标注记录、无指纹接口记录不会补造真实对照。

导入材料始终标注含导入，不冒充本Agent自主执行；文件哈希与对照条件不能验证导入内容真实性或业务语义。检查指纹相同不证明环境/账号/数据前提相同。通过观察不等于已修复、缺陷关闭或完整回归通过；部分修复结论须综合问题全部适用检查，不能按一条通过自动生成。生命周期正式关闭仍用已有缺陷治理规则，本批不改变其状态。


## 当前用户交付约定

报告默认只生成并交付 HTML，暂不生成 Word/PDF。内部 Markdown、JSON、执行版 Excel 用于证据校验，不作为默认用户交付。标题使用真实功能/模块名称加“功能测试报告”或“接口测试报告”，不要用 run_id 或 test_xxx 当报告标题。内部固定路径供工具使用；总控 handoff 后生成带功能/模块前缀的交付副本，总控只向用户给出 typed_delivery.files 中的命名链接。
