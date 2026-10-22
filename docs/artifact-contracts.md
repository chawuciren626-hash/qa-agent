# 统一产物契约校验

## 使用方式

用户仍在PenguinHarness总控中提交需求，无需记住内部路径和命令。专业Agent按Skill交付，总控负责调用受控交接入口。排查时可以运行只读预检：

```powershell
npm run artifacts:validate -- <run_id> analysis
npm run artifacts:validate -- <run_id> test_points
npm run artifacts:validate -- <run_id> test_cases
npm run artifacts:validate -- <run_id> execution --mode=prepare --artifacts=execution/scripts/example.spec.ts
npm run artifacts:validate -- <run_id> execution
npm run artifacts:validate -- <run_id> defects
npm run artifacts:validate -- <run_id> report
```

将占位符换成真实run及脚本名。直接Node入口为`scripts/validate-artifacts.mjs`，返回JSON：version、run_id、stage、mode、status、files、errors。通过退出0，契约失败退出2；文件列表附SHA256。它不写manifest、不批准、不运行浏览器、不派发Agent、不安装依赖。

## 强制入口

1. `record-orchestration-event completed`先核验真实父子会话，再校验产物，全部通过才写入清单。回执位于`event.evidence.artifact_contract`。prepare仍记录preparation_completed，不冒充真实执行。
2. 产出后确认的request/approved复核完成回执与文件哈希。未提供产物列表时使用回执中的文件；显式提供未校验文件会被拒绝。
3. assert-stage-ready、dispatched及completed遍历前置阶段，复核它们的产物和引用文件哈希。批准后改文件不能继续派发或完成下游。

入口失败保留原清单及原证据，不偷偷修复业务内容。不论用户是否确认，结构错误都不能通过；结构通过也不等于用户已批准。

## 各阶段规则

| 阶段 | 核心检查 |
| --- | --- |
| analysis | 规则台账、来源类别、原文引用、范围与状态合法；Markdown与台账确定性渲染一致，拒绝独立添加/遗漏/改写；语义仍需审查 |
| test_points | Schema、非空字段、唯一ID、来源属于本run、rule_ids有效及范围内需求覆盖；XMind模块/场景/描述逐项匹配JSON |
| test_cases | Schema、唯一ID、关联测试点及规则一致、测试点覆盖；design_contract台账/假设/数据检查；Excel表头及全部导出行与JSON一致 |
| execution prepare | 计划Schema、设计哈希及用例投影、执行策略、真实脚本文件；不启动测试 |
| execution | 计划与结果ID集合严格一致（禁止漏项、重复、混入）；统计重算、时间顺序、最新invocation_id及状态、证据文件归属 |
| defects | 标准记录Schema、唯一缺陷ID、真实失败关联、每个失败有分类、分类计数、有效duplicate_of、置信度不高于实际证据评估 |
| report | 当前reportable-results与实际结果一致；设计数、执行数、计划数、通过率、分类及质量门对账；当前证据评估/执行状态一致；Word包及PDF基本格式检查 |

所有被读取并用作本次校验依据的run内文件进入回执。指向其他run、工作区根inputs、越界路径或越界符号链接会被拒绝；真实存在于当前run内的绝对路径可作为来源/证据读取。completed的产物参数继续要求run相对路径。

## 数据约定与示例

测试点支持数组，或含points/test_points数组的对象；用例支持数组，或含cases/test_cases数组的对象。封装对象提供run_id时必须匹配本次运行，不允许同时存在两个候选数组。执行计划、执行结果、标准缺陷和报告指标使用各自对象契约。

```json
{
  "run_id": "run-example",
  "title": "通知列表",
  "points": [{
    "id": "TP-001",
    "module": "通知",
    "feature": "列表展示",
    "description": "无通知时显示约定的空状态",
    "risk": "中",
    "coverage_type": ["异常"],
    "source": "analysis/requirement_analysis.md",
    "source_locator": "R-001"
  }]
}
```

source是文件引用，不能只填R-001、URL或一句说明。source_locator可记录规则定位，但当前不会自动证明该规则确实蕴含测试预期。每条用例必须有related_test_point及design_contract；pending规则/假设可以进入设计草稿，现有执行设计闸门仍禁止其进入执行。

新流程从JSON导出XMind：

```powershell
node scripts/generate-test-points-xmind.mjs <test_points.json> <test_points.xmind>
node scripts/generate-test-cases-xlsx.mjs <test_cases.json> <test_cases.xlsx>
```

旧Markdown脑图导出仍兼容，但阶段完成必须同时交付匹配的JSON。脑图不显示测试点编号；JSON/Excel保留编号追溯。Excel按既有“测试用例”工作表、表头和列顺序导出，手动另改展示内容须先同步JSON并重新导出。

失败结果可以完成“执行工作交付”，并不等于测试通过。零失败时defect-records.records允许为空；存在失败时至少给出needs_review分类，不能直接写无缺陷。报告正文必须包含真实run_id和质量门英文原始值。

最新执行状态为blocked/running时，允许校验真实阻塞报告：当前reportable-results必须是零统计空用例，invocation_id匹配当前状态，缺陷/评估也不得沿用旧失败。该报告不使执行阶段completed，也不绕过编排依赖。其他无法对账的中断状态先修复当前执行状态，不靠修改旧成功结果蒙混通过。

## 历史兼容与返修

- 不批量改写历史输出、trace或审批。旧完成事件没有artifact_contract时不自动视为通过新版契约。
- 推荐在新run进行新版完整复验。旧run仍待确认时，可明确请求revision_requested，再重新真实派发、完成和确认；不手填旧回执，也不绕过状态机补记历史。
- 回执是工程一致性检查，不是数字签名，也不是操作系统权限隔离。拥有文件写权限的进程仍能篡改脚本和清单。

## 验证与边界

Schema 使用锁定依赖中的 Ajv 校验。正常任务不隐式安装依赖；格式与结构检查不能作为恶意外部文件的安全解析边界，依赖风险需按当前版本另行检查。

使用`npm run engineering:contracts`运行独立工程回归，不启用暂停的模型评测。夹具明确标记synthetic；包含全阶段正例、错run、坏JSON、Schema错误、重复ID、来源越界、导出内容不一致、漏执行、过期批次、漏分类、报告统计错误、审批期间改文件及阻塞报告保护。

Word检查ZIP关键成员，PDF检查头尾标识；这些只是基础格式检查，不是完整解析、渲染、客户端打开或逐段语义对账。测试用格式夹具不作为可交付报告。XMind/Excel会进行内容对账，Markdown自由文本的语义和业务覆盖仍需Agent与人工审查。完整真实Agent端到端复验、文件打开复验留待后续统一安排。

## 治理状态与报告版本

原始缺陷观察的完成凭据保持不变，后续处置单独存于 `defects/lifecycle.json`。报告契约重放审计台账、核验来源及复测封存证据，要求 quality-metrics.governance 与当前治理视图一致，并记录台账及本运行内依据哈希。跨运行复测归档由台账重放验证，不把跨运行路径伪装为本运行产物。

治理变化使已完成报告进入 revision_requested，保留旧产物和事件；生成中的报告禁止同时变更台账。发布入口不把待重制文件当作当前报告。详见[质量治理闭环](quality-governance-lifecycle.md)。
