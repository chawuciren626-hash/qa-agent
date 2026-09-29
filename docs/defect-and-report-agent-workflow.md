# 缺陷分析与测试报告 Agent 工作流

本工作流将测试失败、缺陷草稿和测试报告统一到可追溯的运行目录。它适用于 Web、API、桌面端和移动端的自动化或人工执行结果，不依赖某个具体业务系统。

## 结果可信度与缺陷治理

执行阶段先产出 `execution/test_results.json`。每条失败至少应包含错误信息和可访问的证据引用（例如日志、截图、视频或 trace）。缺陷分析 Agent 的顺序为：

1. 执行 `quality:evidence`，生成 `quality/evidence-assessment.json`。证据不足的失败只能进入 `needs_review`，不能作为确认缺陷。
2. 生成面向人工审阅的 `defects/bugs.json` 与 `defects/bugs.md`。
3. 执行 `quality:defects`，标准化为 `defects/defect-records.json`。每条记录均包含指纹、生命周期、置信度、关联用例和证据。
4. 执行 `quality:defect-index`，把不同运行中相同指纹的问题聚合为历史出现记录。它不会覆盖历史缺陷。

分类包括 `product_defect`、`script_issue`、`environment_issue`、`test_data_issue` 和 `needs_review`。只有有充分证据且已完成分析的问题才能被描述为产品缺陷草稿；`needs_review` 始终表示产品结论尚未确认。

## 报告与质量度量

报告 Agent 在写报告前执行 `quality:metrics` 与 `quality:trends`。`report/quality-metrics.json` 是当前运行的事实源，包含：测试设计覆盖、选择范围、执行统计、失败证据可信度、缺陷分类与生命周期，以及质量门状态。

质量门的含义如下：

- `blocked`：执行被阻塞，或失败证据不足；不能得出测试通过结论。
- `review_required`：存在待确认问题或未确认的产品缺陷草稿；需要人工判断。
- `risk_present`：存在高严重度风险；需在发布决策中显式接受或处置。
- `informational`：未触发上述门禁，但仍只代表当前范围内的观察结果。

Markdown、Word 和 PDF 均应使用同一份 `quality-metrics.json` 中的运行编号、执行统计和质量门状态。未执行内容必须作为未覆盖范围列出，不能计入通过。
