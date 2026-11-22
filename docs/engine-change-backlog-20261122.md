# 引擎改动清单（2026-11-22）

本清单记录提示词/Skill 重写过程中暴露的引擎侧问题。提示词不再承载这些约束，改动落地前相关问题会复现。

优先级：P0 = 会导致阶段报废或结果错误；P1 = 会让 agent 空转浪费时间；P2 = 一致性清理。

## P0

### 1. handoff 对「被拒但从未执行」的命令做豁免

- 文件：`scripts/child-command-policy.mjs`
- 现状：`toolWasNotExecuted`（132 行）只认 `QA stage boundary:` 前缀，`wasRedirectedBeforeExecution`（80 行）只认 `QA shell redirect:` 前缀，且两处都要求 `allowRecovery`。handoff 走 `requireControlledCommands=true, allowRecovery=false`，所以**一次被 hook 拒绝的空操作足以让整个阶段报废**。
- 改法：
  1. 两处前缀匹配统一成 `Tool call denied by the qa-stage-boundary hook:`。
  2. 265 行、273 行去掉 `allowRecovery &&` 前置——未执行的命令不产生证据，不参与交接判定。
  3. 同一阶段被拒 ≥5 次时，handoff 回执给 warning，不阻断。
- 影响：11-22 测试点阶段 47 分钟（其中 40 分钟在修一条 grep 记录）的直接原因。

### 2. `defects` 缺 `api_execution` 依赖 —— **已修复（2026-11-22）**

- 文件：`config/orchestration-workflow.json`
- 原状：`defects.depends_on = ["execution"]`。接口支线跑完，失败结果不进缺陷分析。
- 已改为 `["execution", "api_execution"]`。安全性依据（已核源码）：
  - `plan-run.mjs:39-41` 给未选中阶段写 `status: "skipped"`，
    `artifact-contracts.mjs` 的 `assertDependencyArtifacts` 对 `skipped` 依赖直接 `continue`，
    所以只跑功能轨时不会因为多了这个依赖而卡住；
  - `run-plan-extension.mjs:24-27` 后补接口支线时本来就会把 `defects.depends_on` 重写成
    `[...execution_branches]`，新默认值与它一致；
  - 已冻结的旧 run 读的是自己 plan 里存下的 `depends_on`，不受本次修改影响。
- 剩余风险：接口轨与功能轨**同时**选中时，两边的失败都会进缺陷分析，
  此时需要靠 `layer` / `source_case_id` / `scenario_id` 区分，不能按业务编号合并
  （已写进 `bug-reporting` skill 的输入表）。

### 3. 脱敏层改写普通字段引用与追溯 ID —— **已修复（2026-11-22）**

- 现状：`qa-secret://...` 替换在不同通道生成不同 UUID，且会命中**非敏感内容**。
- 真实证据（`run-2026-11-22T09-08-30-388Z/design/test_cases.json`）：
  - `TC-003.related_test_point` 被改写成 `qa-secret://session-.../58850aaa-...`，原本应是 `TP-003`，追溯链断裂；
  - `TC-001.steps` 里对 `test_data.username` 的字段引用被替换成 `qa-secret://.../d93df8f0-....username`，步骤不可执行；
  - 需求分析阶段台账第 143 行曾出现引号丢失 + 混入无关凭据引用。
- **根因（解密 146 条受保护条目后确认）**：不是替换不严，而是**登记不严**。`protect()` 的散文扫描
  把 `密码：X` 后面的文本整段当成凭据登记，于是 `test_data`、`TP-003`、`测试数据`、
  甚至 `a` / `见` / `/` / `"值\""` 都成了"凭据"；随后自由文本替换命中一切出现位置。
  另外 8 字符以上的凭据走的是**子串**替换（`split().join()`），所以 `test_data.username`
  被切成 `<ref>.username`；散文正则还会跨 JSON 边界捕获，导致引号被吞。
- **改法（`scripts/protected-inputs.mjs`，已落盘）**：
  1. 新增 `notACredential` / `inferableSecret` / `hydratableSecret` 三个判定。散文扫描只接受
     "≥8 位、无空白、无中文、带数字或真实符号、不像字段名"的值；跨 JSON 边界的捕获一律拒绝。
  2. 从文本重新水合引用时，只接受通过 `hydratableSecret` 的值，避免旧脏数据继续扩散。
  3. 自由文本替换改为**整词边界**（含 `.` 前视），并转义正则元字符（原来没转义，
     含 `(`、`[` 的密码会直接抛错或错替换）。
  4. `TP-/TC-/RULE-` 形态的整串值不参与脱敏；`case_id`、`related_test_point`、`rule_ids`、
     `source_paths` 等追溯字段列入结构字段，不进入文本扫描。
- **验证**：`credential-protection.test.mjs` 通过；新增 17 项针对性断言全过
  （散文不登记、显式字段仍脱敏、`TP-003` 与 `test_data.username` 不被改写、
  含正则元字符可正常替换、JSON 引号完整、已有引用不二次包装、Bearer 仍脱敏）。
- **残留风险（已接受）**：形如 `TP-003` 的值若真是某账号的密码，不会被脱敏（宁可漏脱敏，
  也不破坏追溯链）；`<3` 字符的凭据只在结构化字段内脱敏，不进自由文本替换。
- **影响**：产物追溯失效、步骤不可执行，且校验不报错（字符串型字段照样通过 Schema）。

### 4. 平台执行员写不了自己的交接文件 —— **已修复（2026-11-22）**

- 文件：`scripts/child-tool-guard.mjs`（`stages` 映射）
- 现状：`qa-stage-boundary` hook 装给**所有**非队长角色，但 `stages` 只列了 7 个角色，
  `android_test_agent` / `miniprogram_test_agent` / `desktop_test_agent` 不在其中。
  这三个角色的 `write_file` 直接命中 `unknown professional role` → deny。
- 后果：`execution/execution-task.json` 是执行阶段的必需产物，而派发文案（`independent-task.mjs:388`）
  明确要求子 agent 自己写它 —— 移动端与桌面链路必然卡在交接这一步。
- 修法：三个角色映射到 `execution`，并用 `platformActions` 单独给动作白名单，
  避免它们顺带拿到 `browser_task` / `explore_url`。
- **验证**：`child-tool-guard.test.mjs` 新增「platform executors own the execution stage and only their own action」，
  同时断言能写交接、不能写受控证据、不能调别的平台动作；该套 8/8 通过。

### 5. 探索角色没有派发入口，Skill 描述的能力在 run 内不可用

- 文件：`config/orchestration-workflow.json`、`scripts/structured-actions.mjs`、`skills/system-map-exploration`
- 现状：
  1. `env_explorer_agent` 注册在 `penguin/agents.json`，但**没有任何代码派发它**：
     编排只有 7 个阶段（无 exploration），`plan-run.mjs` 的 `execution_platform` 只切
     android/miniprogram/desktop，动作目录里没有 `system_map_explore`。
  2. run 内真正可用的探索是 `explore_url` → `explore-task-url.mjs`：**单页只读 GET 导航**，
     产出 `execution/exploration.json` 与 `execution/test_results.json`（一条可达性用例），
     且只对 `execution` 阶段的 `automation_execution_agent` 开放。
  3. 旧 Skill 写的「≤80 页/轮、`maps/<env>/pages.json`、`coverage.json`、`login.captcha_chain`」
     在源码里都不存在；登录式深度建档是离线 CLI（`explore-authenticated.mjs` +
     `merge-explore-maps.py`），参数是 `--captcha-strategy`，产物是
     `structure/pages/observations/apis/explore-receipt.json`，没有 `coverage.json`。
- 本轮处理：提示词与 Skill 只写 run 内真实能力（单页只读 + 未探索清单），
  一句话说明登录式建档不归本角色，不写假参数、不写假产物路径。
- 待定（需要产品决策）：
  - 给探索角色一个正式入口（新阶段或 execution 的一个模式），并授权它用 `explore_url`；
  - 或者把「登录式建档」接成受控动作，让它能被派发。
  任选其一之前，这个角色只能在 UI 里手工起、且起起来也没有对口动作。

## P1

### 3b. 缺陷阶段派发时下发的字段清单与本阶段校验不一致

- 位置：`scripts/independent-task.mjs` 中 `stage==='defects'` 那段派发文案。
- 现状：下发的是
  `{defect_id,title,category,severity,severity_standard_version,severity_reason,severity_dimensions,severity_evidence?,evidence_refs,steps_to_reproduce,expected_result,actual_result,impact,recommendation}`，
  但 `validate_artifacts(stage=defects)` 会走 `records()` → `validateSchema('defect_record')`，
  该 schema 的 `required` 是
  `['defect_id','fingerprint','category','lifecycle_status','confidence','related_cases','evidence_refs','title']`。
  也就是说 **`fingerprint` / `lifecycle_status` / `confidence` / `related_cases` 四个必填字段，
  派发文案一个都没提**，agent 按文案写必然被拒；同时 `steps_to_reproduce` / `impact` / `recommendation`
  三个字段反而不在 schema 里（额外字段被允许，但会误导）。
- 改法：把派发文案的字段清单换成 schema 的 required + 建议项，或直接改成
  "字段以 `schemas/defect_record.schema.json` 为准"。
- 临时对策：`bug-reporting` skill 已写出完整字段表与三条交叉规则，agent 读 skill 能绕开。
- 影响：不做的话，缺陷阶段第一次 `validate_artifacts` 必失败一次，且报错只说缺哪个属性。

### 3c. 缺陷阶段隐含依赖 `quality/evidence-assessment.json`，派发文案未提

- 位置：`scripts/artifact-contracts.mjs:241-253`（`assessmentFor`）。
- 现状：`validate_artifacts(stage=defects)` 无条件读取 `quality/evidence-assessment.json`，
  并要求它的 `assessments` case_id 集合**恰好等于**本次 `status=failed` 的用例集合；
  文件不存在时直接抛错。该文件只能由 `assess_evidence` 动作生成。
- 矛盾点：`independent-task.mjs` 的缺陷派发文案写着 "Do not call lifecycle normalize_defects"，
  却没说必须先做证据评估；旧 skill 更明确写着"task 无需 assess_evidence"，与代码相反。
- 改法：派发文案补一句"先做证据评估生成 `quality/evidence-assessment.json`，再写记录"。
- 临时对策：`bug-reporting` skill 已把它列为硬前置。

### 3d. 报告正文被「事实装配」整体替换，Agent 的分析全部丢失

- 位置：`scripts/report-fact-body.mjs`（`reportFactBody` 签名无 prose 参数）、
  `scripts/draft-artifact-actions.mjs:179-197`。
- 现状：导出的入参是 `report-with-facts.md`（由 `reportFactBody` 重新拼装：
  `# 测试报告` + 运行编号 + 关键结论 + 未测与风险 + 执行事实段 + 覆盖/运行时段），
  导出成功后**用它覆盖 `report/test_report.md`**，Agent 写的那版只留在
  `audit/artifact-generations/<id>/before/` 归档里。
- 后果：交付的 HTML/Markdown 里没有"问题与证据分析""测试数据与清理""残余风险"
  这些只有 Agent 能写的叙述，只剩工具算出来的统计。而且**不会报错**——
  `validate_artifacts` 只检查正文含 `run_id` 与质量门状态，两段都在工具装配段里。
- 改法（二选一）：
  - A：`reportFactBody` 增加 `prose` 参数，保留 Agent 正文的非事实段落，事实段追加在后；
  - B：明确"报告只有工具装配段"，把 Agent 的判断口径收敛到 `issues.json`
    的 `impact`/`analysis`/`suggestion`（会进 HTML 问题清单表），并删掉 Skill 里的正文结构要求。
- 已按 B 写提示词：`test-report-writing` 明确说"交付正文由导出重装，判断类内容写进
  issues 与回执"，避免 Agent 把功夫花在会被丢掉的段落上。
- 建议：A 更符合"报告给人签字"的用途，尤其是缺陷影响面与残留数据风险，工具算不出来。

### 3e. `report/issues.json` 不在完整流程的必需产物里，但导出时是另一份数据

- 现象：lifecycle 模式下 `export_report` 的问题清单取 `defects/defect-records.json`，
  `report/issues.json` 被忽略；task 模式才用它。两种模式同名文件语义不同。
- 影响：Agent 在完整流程里写 issues.json 是白写（不报错、不进交付）。
- 改法：导出统一从 `report/issues.json` 取（task 模式已如此），或派发文案直接说明取哪一份。
- 提示词对策：`test-report-writing` 只说"问题清单写进 issues.json，条数与缺陷记录一致"，不声称它在两种模式都决定交付内容。

### 3f. `catalog` 输出不可完整读取（方案 A）

- 现状：`catalog` 返回 56KB **单行** JSON，`exec_command` 输出上限 16000 字，`field_rules` 位于中段被整段截掉；日志同为单行，无法分页。
- 后果链：参数看不到 → agent 去读 `structured-actions.mjs` 源码 → 想用 `findstr` / `grep` 翻 → 被 hook 拒 → 阶段报废。
- 改法（任选，可叠加）：
  1. 支持 `catalog --action=<name>`，只返回单个动作的 `field_rules`。
  2. `field_rules` 单独出口，或按 `stage` 过滤只返回本阶段动作。
  3. 输出改为多行格式化，便于按行读取。
- 影响：测试点阶段为此多耗 30+ 分钟，`coverage.py` 路径连猜 4 次。

### 4. 派发时注入本阶段必做动作提示（方案 C）

- 文件：`scripts/structured-actions.mjs`（派发追加段，参照 1070 行 `draft_records` 的做法）
- 现状：只对 `draft_records` 注入了批次协议；`diagnose_*` / `export_*` / `validate_artifacts` 的顺序与作用没有注入，靠 Skill 文字兜底。
- 改法：按 stage 注入一行，例如 test_points 注入「先 diagnose（只传 run_id，看 result.status）→ 再 export → 最后 validate_artifacts(stage=test_points)」。
- 目的：让 AGENTS.md / SKILL.md 彻底不出现动作名；顺序与参数由引擎当面告知。

### 5. 子 agent 动作白名单与 `STAGE_TOOL_PROTOCOLS` 口径不一致

- 文件：`scripts/child-tool-guard.mjs`（73 行）vs `scripts/stage-tool-scenarios.mjs`（32-36 行）
- 现状：`STAGE_TOOL_PROTOCOLS.test_points.required` 是 `testpoint.coverage` / `irval.check`，但子 agent 直接动作白名单里没有它们，只能经 `run_stage_tool` 间接调用。
- 风险：Skill 若照抄 required 的工具名，agent 直接调 → 被拒 → 阶段报废。
- 改法：两处口径对齐，或在 `STAGE_TOOL_PROTOCOLS` 里标注「引擎自动盖章 / agent 需显式调用」。

### 5b. 通用策略层 20KB 外挂所有角色，且写满工具名

- 文件：`penguin/command-runtime.md`（151 行 / 20KB）、`scripts/sync-penguin-agents.mjs:75`
- 现状：安装出来的 `agent_state/AGENTS.md` = 角色提示词 **+** 按 `<!-- qa-roles -->`
  过滤后的通用策略。真正生效的提示词是两份拼起来的，只改角色文件只瘦一半。
- 问题：通用段对 `android_test_agent` / `miniprogram_test_agent` / `env_explorer_agent`
  一视同仁地注入「单条 `catalog` 读全」「先 `write_file` 再 `execute`」「`draft_records` 分批」
  这些它们用不到的协议；同时散落大量工具名（`write_file`、`exec_command`、`browser_task`、
   `explore_url`、`project-action.mjs`）。
- 影响：角色提示词压到 3–4KB，agent 仍要背 20KB 与自己无关的调用协议——
  「校验太多、太混乱」的体感主要来自这一层，而不是角色文件。
- 建议：给平台角色与探索角色加 role gate，只保留能力范围、交付语言、证据边界三类；
  「怎么调动作」整体交给派发注入（对应第 4 条方案 C）。

## P2

### 6. `default_agent` 派发白名单

- 文件：`scripts/default-agent-guard.mjs`
- 现状：`run_subagent` 目标是任何 QA agent 一律 deny，提示词里的「可派发单点任务」无法兑现。
- 改法：只放开 `requirement_analysis_agent` / `test_point_agent` / `test_case_agent`；执行层与队长继续 deny。

### 7. 打包与校验清单同步（Skill 合并后）

- `config/release-resources.json` 第 432 行、460-465 行仍列着 `anchor-verification`、`test-design-methods` 的文件。
- 待 `test_case_agent` 决定 `test-design-methods` 去向后，一并删除对应 skill 目录与清单条目。
- 注意：`.bak` 不能放在 `skills/` 目录内，`skill-resources.mjs` 会报 `Unsupported skill resource`。

### 8. agent skill 绑定清理

- `penguin/agents.json`：
  - `requirement_analysis_agent`：`test-design-methods`、`change-analysis` 待移除（前者已并入测试点 skill，后者归回归选集）。
  - `test_case_agent`：`test-design-methods`、`api-testing` 待移除（待用例 skill 吸收）。
  - `test_agent`：`skills` 为空，待新增 `regression-selection`（合并 `change-analysis` + `test-selection`）。

### 9. `api_execution` 阶段声明了两个 skill

- **已解决（2026-11-22，接口执行轮）**：`config/orchestration-workflow.json` 与 `penguin/agents.json`
  都收成 `["api-test-execution"]`；`api-testing` 的判定底线、9 维场景检查并入该 skill，
  `api_check` 边界并入 `playwright-execution`；两个用它的 agent 均补了 `retired_skills`。

### 9b. `docs/api-execution.md` 与 skill reference 完全重复，且 docs 未打包

- 证据：`docs/api-execution.md`（7944 字节）与 `skills/api-test-execution/references/protocol.md`
  逐行 diff 仅差 3 行（开头能力范围段与末尾两段）。
- 更关键：`config/release-resources.json` 的 18 条 docs 白名单里**没有** `docs/api-execution.md`，
  但 `catalog.field_rules.api_task` 的 note 却写着 "Inspect docs/api-execution.md"。
  → 在已部署副本里这句话指向不存在的文件，agent 只能退回 skill reference。
- 改法（二选一）：
  - A：把 `docs/api-execution.md` 加进 `release-resources.json`，删除重复的 reference；
  - B：保留 reference 作为唯一随包真源，把 `field_rules.api_task` 的 note 改成指向 skill reference。
  推荐 B（少一个打包文件，且 reference 已在包内）。
- 时点：引擎批次；当前 skill 已写明"完整语义见 references/protocol.md"，不受影响。

### 9c. `api_execution` 的 `task.json` 是受控证据，agent 写不了

- 证据：`scripts/stage-registry.mjs:70` 的 `isControlledStageEvidence` 对 `api_execution` 判定
  `execution/api/**`（除 `scenario-draft.json`）全部为受控，而 `child-tool-guard.mjs:100`
  的受控检查**先于**阶段可写路径判断执行。
- 现实现状：`execution/api/task.json` 由 worker 自动写（`scripts/api-worker.mjs:46`），
  agent 若按其他阶段的习惯去写 `execution-task.json` 或改 `task.json` 会被直接拒绝。
- 提示词与 skill 已按此写：**本阶段唯一可手写文件是 `execution/api/scenario-draft.json`**。
- 可选改进（不改也能跑）：`prepare` 后计划不可变，写错只能显式重来；
  若希望支持"小修不重跑"，需要一个显式的 `revise` 动作，属功能增强，非缺陷。

### 10. 源码改动尚未部署到运行副本

- `scripts/protected-inputs.mjs` 的脱敏修复只改了 `E:\AItestHarness`（源码）。
  实际运行的是 `D:\AITestHarness`，未同步前该 bug 仍会在新 run 中复现。
- 改法：12 份提示词与引擎改动齐了之后统一部署 + 重启验证，避免反复重启。

## 已决定不改

- `api_contract.json` 不加 schema 强校验，靠 Skill 的字段约定约束（2026-11-22 决定）。
- `stage_finalize` 合并调用：Skill 已不提工具名，矛盾自然消解，不改白名单。
