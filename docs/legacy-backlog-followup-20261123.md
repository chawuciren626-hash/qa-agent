# 提示词/Skill 改造遗留问题跟进（2026-11-23）

> 依据：`docs/change-summary-20261122.md` §5「仍然存在的问题」与 `docs/engine-change-backlog-20261122.md`。
> 本文记录逐条核实结果、本轮修改与未改原因。核实基准：`main@16359c1`（11-22 22:36 之后无触及这些项的提交）。

## 一、核实结论总表

| 项 | 文档状态 | 代码实际 | 本轮处理 |
|---|---|---|---|
| P0-1 handoff 豁免被拒未执行命令 | 未修 | 部分过时：`stage-evidence.mjs` 现在默认走 V3，`allowRecovery=true`；但两处只认狭窄 reason 前缀 | **已修**（安全部分） |
| P0-5 探索角色派发入口 | 未修 | 未修，需产品决策 | 不改，说明理由 |
| 3b 缺陷派发字段清单 | 未修 | task 模式与 lifecycle 是两套契约，文档建议套的是 lifecycle schema | **已修**（按 task 实际契约） |
| 3c 缺陷阶段证据评估前置 | 未修 | `assess_evidence` 是 lifecycle 前置；task 模式明确禁止调用 | 不改，说明理由 |
| 3d 报告正文被事实装配覆盖 | 未修 | 未修；skill/提示词已按方案 B 写好 | 不改，需产品决策 |
| 3e issues.json 两套语义 | 未修 | 未修，涉及 lifecycle/task 数据流 | 不改，需产品决策 |
| 3f catalog 输出被截断 | 未修 | 未修（实际是 58KB/1106 行 pretty-print，非文档说的单行） | **已修** |
| 4 派发注入必做动作 | 未修 | lifecycle 分支已注入，task 模式由 `independentPrompt` 覆盖 | 不改，说明理由 |
| 5 子 agent 白名单口径 | 未修 | 未修，required 工具经 `run_stage_tool` 间接调用 | **已修**（协议文案标注） |
| 5b 通用策略层 20KB | 部分修 | 有 role gate 壳，20KB 与工具名未收敛 | 不改，工作量大需单列 |
| 6 default_agent 派发白名单 | 未修 | 未修，且有测试明确断言「所有 QA agent 一律 deny」 | 不改，与测试契约冲突 |
| 7/8 打包清单与解绑 skill 目录 | 未修 | 未修；清单条目与 skill 目录耦合 | 不改，需联动 |
| 9b note 指向未打包文档 | 未修 | 未修 | **已修** |
| 9c api_execution 受控证据 | 未修 | 设计现状，非缺陷 | 不改 |

## 二、本轮已修改（5 处引擎改动 + 3 处测试）

1. **P0-1（安全部分）** `scripts/child-command-policy.mjs`
   - 两处「执行前被拒」判定统一为裸前缀 `Tool call denied by the qa-stage-boundary hook:`，提取常量 `STAGE_BOUNDARY_DENIAL`。原状只认 `QA shell redirect:` / `QA stage boundary:` 两个狭窄后缀，hook 改写 reason 就会漏判，把未执行的空操作当成失败命令，导致 handoff 失败。
   - 同步放宽 `isCatalogLookup`，使 `catalog --action=<name>` / `--stage=<name>` 仍被识别为只读查询。
   - **未采纳**文档建议的「去掉 allowRecovery && 前置」：文档写于 V2 默认时期，现在 handoff 走 V3（`allowRecovery=true`），去掉前置会破坏 V1「零重试」严格契约及 `stage-evidence.test.mjs:370` 的明确断言。「≥5 次 warning」需改 `assertChildCommands` 回执契约，影响面大，留待单列。

2. **3b** `scripts/independent-task.mjs`
   - task 模式缺陷派发文案补齐 `related_cases`（browser/移动端校验实际要求关联 failed 用例）、明确 `defects/bugs.md` 必填、把字段清单指向「本任务契约而非 `schemas/defect_record.schema.json`」。文档建议的「schema 8 必填」属于 lifecycle 契约，套进 task 文案会误导 agent 生成一堆用不上的 lifecycle 字段。

3. **3f** `scripts/structured-actions.mjs` + `scripts/project-action.mjs`
   - `actionCatalog(root, filter)` 支持 `{action}` / `{stage}` 过滤；`project-action.mjs catalog` 解析 `--action=` / `--stage=`。完整 catalog 保持原样（49 动作、7 模板）；单动作视图从 58,149 字节降到 872 字节，彻底绕开 `exec_command` 16000 字上限导致的 `field_rules` 截断。
   - 顺带完成 **9b**：`api_task` note 从「Inspect docs/api-execution.md」（该 docs 未随包发布）改为指向随包的 `<shared_skills_root>/api-test-execution/references/protocol.md`。

4. **5** `scripts/stage-tool-scenarios.mjs`
   - `stageToolProtocol` 文案明确 `required` 里的 `testpoint.coverage` / `irval.check` 等是**确定性工具 ID，不是可直接调用的动作名**，须经 `run_stage_tool` 调用，直接写进 `qa_request.action` 会被阶段白名单拒绝。

5. **测试** `tests/acceptance/stage-evidence.test.mjs`、`efficiency-contracts.test.mjs`、`stage-tool-scenarios.test.mjs`
   - 新增 3 组回归断言：任意 reason 的阶段边界拒绝都算「执行前被拒」；catalog 过滤视图保持小而完整且不影响全量视图；阶段工具协议标注间接调用。

## 三、本轮不改及原因

- **P0-5 探索角色入口**：文档明确「待产品决策（新阶段 or execution 模式）」，且涉及平台侧派发链路，不是引擎单侧可闭环的改动。
- **3c**：task 模式缺陷阶段明确「Do not call lifecycle assess_evidence/normalize_defects」；补「先做证据评估」只适用于 lifecycle，文档把它写在了 task 派发文案上。
- **3d 报告正文**：文档自己说「已按方案 B 写提示词」（判断写进 `issues.json`，正文由导出重装）。改方案 A 要连带改 skill、提示词和交付契约，属报告语义决策，需单独一轮。
- **3e issues.json 语义**：lifecycle 取 `defects/bugs.json`、task 取 `report/issues.json`，统一会改变 lifecycle 数据流。
- **4 派发注入顺序**：lifecycle 分支已有 diagnose→export→validate 注入；task 模式由 `independentPrompt` 按阶段给出完整顺序，缺口已不在文档描述的位置。
- **5b 通用策略层**：role gate 机制已在，但 20KB 公共段与工具名未收敛，需改 `command-runtime.md` 结构及 5 处拼接调用，工作量大。
- **6 default_agent 白名单**：`role-boundaries.test.mjs:56` 明确断言所有 QA agent 一律 deny，放开与现有测试契约和「default 不是测试总控」定位冲突。
- **7/8 打包清单与解绑 skill 目录**：`check-skills.mjs` 要求所有实际 skill 资源都在 allowlist，只删清单条目会报错；删目录需与 `regression-selection` 一起做，文档 §6 也建议延后。
- **9c**：受控证据设计现状，非缺陷；小修不重跑属功能增强。

## 四、验证

- 语法：`node --check` 全部通过。
- 定向测试（串行单文件）：report-fact-body 3/3、child-tool-guard 8/8、stage-evidence 35/35、child-history-recovery 9/9、stage-registry 6/6、efficiency-contracts 9/9、stage-tool-scenarios 2/2、stage-tool-runtime 2/2 —— 0 失败。
- `ci:contract` 的 A 段（工具登记）通过；B4 段 3 条失败为存量问题（`test-report-writing` skill 小节归类），本轮未触及。
- 存量失败：`role-boundaries.test.mjs:47` 断言旧提示词短语「不是软件测试总控」，昨晚重写为「不冒充 test_agent」，属 11-22 重构遗留未对齐断言。
- core 套件在 AI sandbox 内因 `safe-delete-shim` 拦截与临时目录冲突不可信（文档 §5.5 已记录），未作为验收依据。

## 五、部署

按用户要求：**仅提交源码，不部署**。`D:\AItestHarness` 运行副本未同步，`product-payload.json` 哈希未更新，运行中的应用行为不变。
