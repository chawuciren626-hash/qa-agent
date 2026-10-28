---
name: bug-reporting
description: 基于测试失败结果、日志和截图分类问题，生成可追溯的 Bug 草稿。
metadata:
  version: '1.3.0'
---

# Bug 记录 Skill

task和lifecycle遇到多种可能原因时，均可按需读取已安装的qa-investigation及其失败分类参考。只利用本次材料分析，不因此补建执行批次、启动复测或把反复失败直接定为产品缺陷。

## 独立任务（task）

直接分析提供的日志、结果和证据，写defects/defect-records.json（records数组）及bugs.md。条目包含defect_id、title、category、evidence_refs，补充复现、预期、实际、影响及建议；证据不足用needs_review，不为交付强求用户确认。无需执行批次、assess_evidence或normalize_defects，不伪造本次实测。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

以下流程、输入、Schema及规则台账/批次要求仅适用于lifecycle。task复用专业方法和展示样式，不执行本分支的前序检查或生命周期专用动作。

### 专业方法

需要多步骤根因分析时按需读取已安装的qa-investigation Skill。频率与原因分开判断，调查记录引用当前有效证据；调查本身不授权复现、脚本修改或缺陷关闭。


### 统一产物交付契约

新版执行批次的bugs.json必须为`{run_id, invocation_id, bugs: [...]}`，invocation_id引用真实最新批次；normalize-defects会拒绝旧批次分析，并在标准记录中保留批次ID。先重建当前证据评估。最新批次阻塞时，不沿用上轮失败或成功结论。细则见`docs/execution-attempts.md`。

交付前运行`npm run artifacts:validate -- <run_id> defects`，详见`docs/artifact-contracts.md`。标准defect-records包含本run_id、records与分类summary；无问题时records可为空，但每个实际失败用例必须有分类记录（不能确定时needs_review）。related_cases引用本次实际失败ID，evidence_refs引用本run文件，重复问题使用有效duplicate_of，置信度不得超过关联证据评估。校验失败交回来源阶段修复，不改写真实执行结果。

### 适用场景

当测试执行结果中存在失败、阻塞或异常时，用于生成 Bug 草稿或失败分析。

### 输入

- 当前 `run_id` 的测试结果和关联测试用例
- 截图、日志、Trace

### 输出

- 当前 `run_id` 的 `defects/bugs.md`
- 当前 `run_id` 的 `defects/bugs.json`
- 当前 `run_id` 的 `defects/defect-records.json`

### 工作步骤

1. 先通过project-action调用assess_evidence（只需run_id），读取 `quality/evidence-assessment.json`；证据不足的失败只能标记为 `needs_review`。
2. 读取失败用例、错误信息和关联证据。
3. 判断失败类型：产品缺陷、脚本问题、环境问题、数据问题、待确认。
4. 对产品缺陷生成 Bug 草稿，对非产品问题说明原因和处理建议。
5. 写入 `bugs.json`、`bugs.md` 后通过project-action调用normalize_defects（只需run_id），生成标准记录，再validate_artifacts（stage=defects）。仅按recovery.retry_allowed修正未确认草稿；若提示已登记观察不一致，保留原观察，交总控按生命周期治理处理，不改ID或删台账绕过。详见docs/draft-artifact-recovery.md。
6. 需要跨运行比较时，通过统一命令入口运行build-defect-index.mjs作为补充；不作为本run基本交付必需前置，不得把历史相似项重复作为新问题描述。

### 质量标准

- Bug 标题具体。
- 复现步骤清晰。
- 实际结果和预期结果明确。
- 证据路径真实存在，且结论置信度与证据数量一致。
- 每个标准缺陷记录均包含 `fingerprint`、`lifecycle_status`、`confidence`、`related_cases` 和 `evidence_refs`。

### 禁止事项

- 禁止没有证据就创建 Bug。
- 禁止把脚本错误直接写成产品 Bug。
- 禁止重复记录同一问题。

### 处理规则

- 原始观察与 `defects/lifecycle.json` 处置台账分离。规范化只能创建 draft/needs_review；已确认/已修复/已关闭以台账重放为准，不以模型文字为准。按 `docs/quality-governance-lifecycle.md` 使用本次派发许可的受控入口查询最新 revision，取得明确分类/修复依据后登记 actor、reason、evidence，不直接运行npm别名，也不为了基本交付强求用户确认缺陷。
- fixed 不等于 closed。真实复测交总控按授权派发，关联用例需在同批准设计与环境依据下的独立新批次全部通过。旧复测、跳过、漏测不得关闭；失败重新打开。不得改写原始观察、冒充人工审阅人或自动删除锁。
- 指纹索引仅是同 scope_id 重复候选，默认本次 run；跨运行需明确共享范围且不自动合并。报告已完成后治理变化会请求报告重制，通知总控恢复报告阶段。
- 仅为 failure_category=product_defect 或有充分证据的 needs_review 生成 Bug 草稿。
- 每条草稿同时写入当前运行的 bugs.json 和 bugs.md；若没有产品缺陷，两个文件明确记录“本次无产品缺陷草稿”。
- Bug 需包含 related_case、复现步骤、预期/实际结果、环境、证据路径和分类理由。
- 脚本、环境、测试数据问题只记录分析结论，不写成产品 Bug。
- `script_issue` 必须有可复现的脚本、数据或定位器根因；不能证明时保留 `needs_review`。存在 `needs_review` 不能得出“无产品缺陷”的结论。
- `needs_review` 和证据不足的失败应被报告为“未确认问题”，不生成已确认产品缺陷结论。
- 同一运行中指纹相同的问题使用 `duplicate_of` 关联；跨运行重复情况只由 `output/quality/defect-index.json` 统计，不覆盖历史记录。
