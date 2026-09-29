---
name: bug-reporting
description: 基于测试失败结果、日志和截图分类问题，生成可追溯的 Bug 草稿。
version: 1.2.0
---

# Bug 记录 Skill

## 适用场景

当测试执行结果中存在失败、阻塞或异常时，用于生成 Bug 草稿或失败分析。

## 输入

- 当前 `run_id` 的测试结果和关联测试用例
- 截图、日志、Trace

## 输出

- 当前 `run_id` 的 `defects/bugs.md`
- 当前 `run_id` 的 `defects/bugs.json`
- 当前 `run_id` 的 `defects/defect-records.json`

## 工作步骤

1. 先运行 `node scripts/assess-execution-evidence.mjs --run-id=<run_id>`，读取 `quality/evidence-assessment.json`；证据不足的失败只能标记为 `needs_review`。
2. 读取失败用例、错误信息和关联证据。
3. 判断失败类型：产品缺陷、脚本问题、环境问题、数据问题、待确认。
4. 对产品缺陷生成 Bug 草稿，对非产品问题说明原因和处理建议。
5. 写入 `bugs.json`、`bugs.md` 后运行 `node scripts/normalize-defects.mjs --run-id=<run_id>`，生成带指纹、生命周期、置信度和证据引用的标准记录。
6. 运行 `node scripts/build-defect-index.mjs`，将当前结果与历史运行按指纹聚合；不得把历史相似项重复作为新问题描述。

## 质量标准

- Bug 标题具体。
- 复现步骤清晰。
- 实际结果和预期结果明确。
- 证据路径真实存在，且结论置信度与证据数量一致。
- 每个标准缺陷记录均包含 `fingerprint`、`lifecycle_status`、`confidence`、`related_cases` 和 `evidence_refs`。

## 禁止事项

- 禁止没有证据就创建 Bug。
- 禁止把脚本错误直接写成产品 Bug。
- 禁止重复记录同一问题。

## 处理规则

- 仅为 failure_category=product_defect 或有充分证据的 needs_review 生成 Bug 草稿。
- 每条草稿同时写入当前运行的 bugs.json 和 bugs.md；若没有产品缺陷，两个文件明确记录“本次无产品缺陷草稿”。
- Bug 需包含 related_case、复现步骤、预期/实际结果、环境、证据路径和分类理由。
- 脚本、环境、测试数据问题只记录分析结论，不写成产品 Bug。
- `script_issue` 必须有可复现的脚本、数据或定位器根因；不能证明时保留 `needs_review`。存在 `needs_review` 不能得出“无产品缺陷”的结论。
- `needs_review` 和证据不足的失败应被报告为“未确认问题”，不生成已确认产品缺陷结论。
- 同一运行中指纹相同的问题使用 `duplicate_of` 关联；跨运行重复情况只由 `output/quality/defect-index.json` 统计，不覆盖历史记录。
