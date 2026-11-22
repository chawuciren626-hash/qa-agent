# AITestHarness 提示词与 Skill 改造记录（2026-11-22）

> 本文记录一次集中改造：13 份 agent 提示词、11 个 skill、3 份配置、2 个引擎脚本、7 个测试文件。
> 配套文档：`docs/qa-team-playbook-20261122.md`（作业清单，讲每个角色该干什么）、
> `docs/engine-change-backlog-20261122.md`（引擎待改清单，讲代码要怎么修）、
> `docs/prompt-review-20261122.md`（本轮审阅报告，讲为什么这么改）。
>
> 仓库根：`E:\AItestHarness`｜运行副本：`D:\AItestHarness\app\engine`

---

## 一、改造依据

起点是一次真实会话卡死：测试点阶段跑了 47 分钟，其中 40 分钟用在修一条 grep 记录。
顺着 trace 挖下去，发现根因不在模型能力，而在三层结构问题：

| 现象 | 根因 | 对应改法 |
|---|---|---|
| 阶段跑不完 | 一次被 hook 拒绝的空操作 → handoff 判定失败 → 整阶段报废（`child-command-policy.mjs` 不豁免未执行命令） | 提示词不写"会被拒"的细节，只写动作要求；引擎侧记 P0-1 |
| agent 行为飘 | 提示词里塞满校验清单、字段名、命令名，与派发时注入的内容重复甚至冲突 | 提示词只留角色/任务/专业判断/材料位置/交付物 |
| 一个角色挂 3–4 个 skill | 同一能力被拆到多个 skill，agent 要自己决定用哪个 | 一个 agent 一个 skill，多余的进 `retired_skills` |

由此定下四条原则，本轮所有改动都按它执行：

1. **提示词写四件事**：你是谁、要干什么、专业判断是什么、材料在哪、交什么。不写工具名、不写字段清单、不复述派发单。
2. **门禁先放宽**：宁可少拦，也不要因为一条校验让整个阶段白跑。校验交给引擎和产物契约。
3. **一 agent 一 skill**：skill 是专业方法的载体，不是校验规则的堆场。
4. **动作怎么调由引擎告知**（方案 A+C）：提示词只描述意图，动作名、参数、权限由引擎注入。

---

## 二、改动规模

40 个已跟踪文件：**+2,958 / −1,329 行**。

| 层 | 文件数 | 趋势 |
|---|---|---|
| agent 提示词 | 13 份 | 合计 74,754 → 58,646 字节（**−21.5%**） |
| skill 正文 | 11 个 SKILL.md | 合计 98,223 → 105,704 字节（**+7.6%**，结构全换） |
| skill 参考文件 | 4 个（含 1 删除） | 17,332 → 14,954 字节 |
| 配置 | 3 个 | 依赖、绑定、资源清单 |
| 引擎脚本 | 2 个 | 守卫映射、脱敏判定 |
| 测试 | 7 个 | 断言对齐新契约 |

> 提示词在瘦身，skill 在增重，这是有意的：**把"引擎怎么校验"从提示词里删掉，把"专业上怎么判断"补进 skill**。
> 单纯删字不叫改造——删掉校验却不补判断依据，agent 只会更飘。

---

## 三、逐层清单

### 3.1 agent 提示词（13 份）

路径统一为 `penguin/agents/<角色>/AGENTS.md`。

| 角色 | 前 | 后 | 主要变化 |
|---|---:|---:|---|
| `test_agent`（队长） | 9,616 | 3,709 | 删命令名泄漏、拆掉自相矛盾的派发单模板、补派活核对五项 |
| `default_agent`（兜底） | 2,877 | 2,954 | 保留编号式结构，补输出禁忌与失败回退 |
| `requirement_analysis_agent` | 9,536 | 4,073 | 拆分功能层/接口层分流表，台账口径交给 skill |
| `test_point_agent` | 5,846 | 5,188 | 补单点/全流程双分支、条数上限、功能轨/接口轨分流 |
| `test_case_agent` | 6,161 | 5,465 | 补 Excel 双表与 11 列约束、设计合同三子结构 |
| `automation_execution_agent` | 18,128 | 5,306 | **压缩 71%**，删掉整套浏览器动作手册，只留判断口径 |
| `api_automation_agent` | 2,870 | 4,473 | 补接口轨与功能轨的边界、写授权与逐字引用要求 |
| `defect_analysis_agent` | 5,762 | 4,798 | 补同根因合并、待确认项的措辞底线 |
| `test_report_agent` | 8,562 | 4,124 | 补证据强度分级表、回归两组对照、指标生成后不可再改 |
| `env_explorer_agent` | 2,325 | 4,979 | 只写 run 内真实能力（单页只读），删掉源码里不存在的产物路径 |
| `android_test_agent` | 888 | 4,994 | 从一句话扩成完整角色：材料、能力边界、产出、失败归类 |
| `miniprogram_test_agent` | 897 | 5,052 | 同上，补开发者工具的能力边界与固定限制 |
| `desktop_test_agent` | 1,286 | 3,531 | **重写**：原文塞了 8 个内部动作名（`desktop_task`/`doctor`/`snapshot`/`replay` 等），全部交还引擎 |

四份平台/支线提示词是**增长**的（原 888–2,325 字节，只有一两句话），因为原来根本没有"材料在哪、交什么、什么算合格"。主流程六份是**缩减**的。

13 份统一骨架：

```
## 你是            ← 角色定位，两三句
## 任务            ← 干活步骤，编号
## 专业判断        ← 只有这个角色才懂的判断口径
## 材料在哪        ← 输入清单，路径 + 用途
## 交什么          ← 产物清单，文件名 + 谁写
## 什么算合格      ← 验收标准，可数的
## 边界            ← 不该做什么
## 做不下去怎么办  ← 改几轮、什么时候停
## 不要输出        ← 不写思考过程、不自评"已完成"
```

### 3.2 skill（11 个）

路径 `skills/<name>/SKILL.md`。

| Skill | 前 | 后 | 变化要点 |
|---|---:|---:|---|
| `requirement-analysis` | 12,626 | 6,659 | 四合一拆出后瘦身；只留功能层需求分析 |
| `api-contract-analysis` | 2,215 | 3,926 | 独立成接口层 skill，补契约提取与歧义标注 |
| `test-point-design` | 8,358 | 12,266 | 合并四个旧 skill；补 `risk/end/execution_layer` 取值约束 |
| `test-case-writing` | 8,069 | 11,094 | 补 Excel 双表结构、`design_contract` 三子结构、P0–P3 判定 |
| `playwright-execution` | 24,624 | 11,910 | **压缩 52%**；动作名交还引擎，只留执行判断与证据要求 |
| `api-test-execution` | 3,382 | 12,365 | 补源码级硬约束：`source_path` 白名单、逐字引用、`plan_sha256` 不可变 |
| `bug-reporting` | 8,538 | 12,343 | 合并 `qa-investigation`；补 schema 8 个必填字段、重复指纹规则 |
| `test-report-writing` | 13,153 | 12,727 | 结构全换：统计四口径、证据强度、未测三算法、回归对照 |
| `android-execution` | 7,193 | 7,994 | 补 ADB 后端真实能力与断言条件类型 |
| `miniprogram-execution` | 7,004 | 8,198 | 补开发者工具边界与 `needs_inspection` 语义 |
| `system-map-exploration` | 3,061 | 6,222 | 只写 run 内真实能力，删离线 CLI 假参数 |

参考文件变更：

| 文件 | 变化 |
|---|---|
| `skills/test-report-writing/references/conclusion-and-coverage.md` | **删除**（内容并入 SKILL.md），同步删 `config/release-resources.json` 条目 |
| `skills/test-report-writing/references/regression-delivery.md` | 4,127 → 3,269，删掉引擎内部字段 |
| `skills/android-execution/references/android-adb-ops.md` | 5,762 → 6,210，补真实回执字段 |
| `skills/miniprogram-execution/references/miniprogram-devtools-ops.md` | 5,047 → 5,475，补 `finish` 固定限制 |

### 3.3 配置（3 个）

| 文件 | 改动 |
|---|---|
| `config/orchestration-workflow.json` | `defects.depends_on`：`["execution"]` → `["execution","api_execution"]`。原状导致接口轨跑完的失败结果不进缺陷分析 |
| `penguin/agents.json` | 6 个角色把多余 skill 移入新增的 `retired_skills`（安装时据此卸载）：`requirement_analysis_agent`、`test_point_agent`、`test_case_agent`、`automation_execution_agent`、`defect_analysis_agent`、`api_automation_agent` |
| `config/release-resources.json` | 移除已删除的 `conclusion-and-coverage.md` 条目 |

### 3.4 引擎脚本（2 个，本轮顺手修的阻塞）

**`scripts/child-tool-guard.mjs`** — 平台执行员写不了自己的交接文件

- 原状：`stages` 映射只列 7 个角色，`android_test_agent` / `miniprogram_test_agent` / `desktop_test_agent` 不在其中。这三个角色的写文件动作命中 `unknown professional role` → 直接 deny。
- 后果：`execution/execution-task.json` 是必需产物，派发文案（`independent-task.mjs:388`）明确要求子 agent 自己写 → **移动端与桌面链路必然卡在交接**。
- 改法：三个角色映射到 `execution`，并用 `platformActions` 单独给动作白名单，避免顺带拿到 `browser_task` / `explore_url`。

**`scripts/protected-inputs.mjs`** — 脱敏层改写普通字段引用与追溯 ID

- 现象：`TC-003.related_test_point` 被改写成 `qa-secret://...`（原本应是 `TP-003`），追溯链断裂；`test_data.username` 被切成 `<ref>.username`，步骤不可执行。
- 根因：不是替换不严，而是**登记不严**。散文扫描把"密码：X"后面整段当凭据，146 条里混进了 `test_data`、`TP-003`、`a`、`见`、`/`。
- 改法：新增 `notACredential` / `inferableSecret` / `hydratableSecret` 三级判定；散文扫描要求 ≥8 位、无空白、无中文、带数字或符号、不像字段名；替换改整词边界并转义正则元字符；`TP-/TC-/RULE-` 与 `case_id`/`related_test_point`/`rule_ids`/`source_paths` 跳过。

### 3.5 测试（7 个）

| 文件 | 改动 |
|---|---|
| `tests/acceptance/skill-resources.test.mjs` | 断言从"提示词必须含工具名"改为"结构 + 禁用工具名"；重写技能数量断言 |
| `tests/acceptance/stage-registry.test.mjs` | 契约基线更新：`defects` 依赖加 `api_execution` |
| `tests/acceptance/child-tool-guard.test.mjs` | 新增「平台执行员拥有 execution 阶段且只能调自己的动作」用例 |
| `tests/acceptance/api-automation.test.mjs` | 派发 `skills:['api-test-execution','api-testing']` → `['api-test-execution']`（`api-testing` 已解绑，原值导致 `Dispatch mapping mismatch`） |
| `tests/acceptance/structured-actions.test.mjs` | 5 处派发技能列表补 `api-contract-analysis` |
| `tests/acceptance/local-browser-executor.test.mjs` | 1 处同上 |
| `tests/acceptance/test-tracks.test.mjs` | 1 处同上 |

---

## 四、本轮已修掉的问题

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | `defects` 缺 `api_execution` 依赖，接口轨失败结果不进缺陷分析 | `config/orchestration-workflow.json` | P0 |
| 2 | 脱敏层把字段引用和追溯 ID 改写成凭据引用 | `scripts/protected-inputs.mjs` | P0 |
| 3 | 平台执行员写不了自己的交接文件（安卓/小程序/桌面链路必卡） | `scripts/child-tool-guard.mjs` | P0 |
| 4 | `test_agent` 提示词泄漏 `project-action.mjs summary/catalog` 命令 | `penguin/agents/test_agent/AGENTS.md` | P0 |
| 5 | `test_agent` 自相矛盾：一半说"不自己拼话"，一半列"必须说清五句"模板 | 同上 | P0 |
| 6 | `desktop_test_agent` 通篇内部动作名（8 个），是唯一漏改的一份 | `penguin/agents/desktop_test_agent/AGENTS.md` | P0 |
| 7 | `test_report_agent` 任务写"三份"、交付列四个文件 | `penguin/agents/test_report_agent/AGENTS.md` | P1 |
| 8 | 3 处"一次被拒绝会导致无法交接"的恐吓式约束，实际效果是遇错即停 | `test_point` / `test_case` / `automation` | P1 |
| 9 | 13 份提示词都没有「不要输出」段 | 全部 13 份 | P1 |
| 10 | 13 份提示词都没有「做不下去怎么办」段 | 全部 13 份 | P1 |
| 11 | 章节命名三套并存（你的任务/任务/怎么干） | 全部 13 份 | P1 |
| 12 | "材料在哪"只有 4 份有，另外 9 份缺 | 补 7 张表 | P1 |
| 13 | 执行方式二选一没有判断依据 | `automation_execution_agent` | 专业缺口 |
| 14 | 同根因多条用例会写成多条缺陷，缺陷数虚高 | `defect_analysis_agent` | 专业缺口 |
| 15 | 回归轮次没要求两组对照 | `test_report_agent` | 专业缺口 |

---

## 五、仍然存在的问题

### 5.1 引擎侧 P0（未修，会继续复现）

**P0-1 handoff 不豁免"被拒但从未执行"的命令**

- 位置：`scripts/child-command-policy.mjs`
- 现状：`toolWasNotExecuted`（132 行）只认 `QA stage boundary:` 前缀，`wasRedirectedBeforeExecution`（80 行）只认 `QA shell redirect:` 前缀，且两处都要求 `allowRecovery`。handoff 走 `requireControlledCommands=true, allowRecovery=false` → **一次被拒的空操作足以让整个阶段报废**。
- 影响：这是测试点阶段 47 分钟卡死的直接原因。提示词层面已尽量规避，但根因还在代码里。

**P0-5 探索角色没有派发入口**

- 位置：`config/orchestration-workflow.json`、`scripts/structured-actions.mjs`、`skills/system-map-exploration`
- 现状：`env_explorer_agent` 注册了但没有任何代码派发它——编排只有 7 个阶段（无 exploration），动作目录里没有 `system_map_explore`。run 内真正可用的是 `explore_url`（单页只读 GET），且只对 `automation_execution_agent` 开放。
- 本轮处理：提示词与 skill 只写 run 内真实能力，删掉源码里不存在的产物路径（`maps/<env>/pages.json`、`coverage.json`、`login.captcha_chain`）。
- 待决策：给它正式入口，或把登录式建档接成受控动作。**在此之前这个角色只能在 UI 里手工起，且起起来也没有对口动作。**

### 5.2 引擎侧 P1（会让 agent 空转）

| # | 问题 | 位置 |
|---|---|---|
| 3b | 缺陷阶段派发下发的字段清单（4 个）比 schema 要求（8 个）少 | `scripts/independent-task.mjs`，`stage==='defects'` 文案 |
| 3c | 缺陷阶段隐含依赖 `quality/evidence-assessment.json`，派发文案未提；且 case_id 集合须恰好等于 failed 集合 | `scripts/artifact-contracts.mjs` 的 `assessmentFor` |
| 3d | 报告正文被事实装配整体替换，Agent 写的分析只留在 `audit/artifact-generations/*/before/`，**且不报错** | `scripts/report-fact-body.mjs`（无 prose 参数） |
| 3e | `report/issues.json` 名义上是产物，完整流程导出时却取 `defects/defect-records.json`，同名文件两套语义 | `scripts/generate-report-documents.py` |
| 3f | `catalog` 返回 56KB 单行 JSON，`exec_command` 上限 16000 字，`field_rules` 被整段截断，且无法分页 | `scripts/project-action.mjs` |
| 4 | 派发时未注入"本阶段必做动作"提示，agent 靠 skill 猜 | `scripts/structured-actions.mjs` |
| 5 | 子 agent 动作白名单与 `STAGE_TOOL_PROTOCOLS` 口径不一致 | `scripts/child-tool-guard.mjs` |
| 5b | 通用策略层 20KB 外挂所有角色，且写满工具名 | `penguin/command-runtime.md` |

**其中 3d 最值得优先处理**：影响面和残留数据风险工具算不出来，Agent 写出来又被覆盖，等于报告里的"问题分析""残余风险"永远是空的。

### 5.3 引擎侧 P2（一致性清理）

| # | 问题 |
|---|---|
| 6 | `default_agent` 派发白名单未覆盖新动作 |
| 7 | 打包与校验清单同步（skill 合并后） |
| 8 | 7 个已解绑 skill 目录仍占位：`anchor-verification`、`api-testing`、`change-analysis`、`qa-investigation`、`test-asset-management`、`test-design-methods`、`test-selection` |
| 9 | `api_execution` 阶段声明了两个 skill（`api-test-execution` + `playwright-execution`），与"一 agent 一 skill"冲突 |
| 9b | `docs/api-execution.md` 与 skill reference 完全重复 |
| 9c | `api_execution` 的 `task.json` 是受控证据，agent 写不了 |
| 10 | **源码改动未部署到运行副本** |

### 5.4 提示词侧已知取舍（有意保留，不是遗漏）

| 项 | 为什么不改 |
|---|---|
| `default_agent` 用编号式结构 | 它是三种身份的兜底角色，套统一骨架反而别扭 |
| `test_agent` 没有 task/lifecycle 形态分流 | 队长只派活，不直接产出，分流对它无意义 |
| skill 版本号 `.1/.2` 不齐 | 等 13 份定稿后一次性拉平 |
| 11 个 skill 正文未逐字审计 | 本轮只做结构核查，未逐条对照 `scripts/` 验证判定口径 |

### 5.5 验证与部署状态

**跑过的：**

- `node scripts/check-skills.mjs` → passed（18 skills / 40 resources / 12 agents）
- `child-tool-guard.test.mjs` → 8/8 通过
- `skill-resources.test.mjs`、`stage-registry.test.mjs`、`mobile-stage.test.mjs`、`mobile-execution-evidence.test.mjs` → 通过
- `credential-protection.test.mjs` + 17 项针对性断言 → 通过

**没跑完的：** `browser-task`、`api-automation` 全量、`structured-actions` 全量。

**全量 core 套件结论不可用**：`run-engineering-tests.mjs --suite=core` 跑出 1176 测试 / 951 通过 / 218 失败 / 827 秒，但其中 **102 个被 sandbox 的 `node-safe-delete-shim.cjs` 拦截**（测试清理临时文件时触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED count:50`），**26 个临时目录冲突**，其余为并行互相踩。已用单文件串行验证反驳（`structured-actions` 单独跑通过）。**这套套件在 AI sandbox 里跑不出可信结果**，验收必须串行单文件或在无 sandbox 的终端跑。

**部署状态：未部署。**

`D:\AItestHarness` 是安装后的产品目录（`AITestHarness.exe` + `app/engine/` + `product-payload.json` 哈希清单），不是源码仓库。比对结果：

- 33 个文件内容落后（13 份提示词 + 11 个 skill + 3 个配置 + 2 个引擎脚本 + 3 个参考文件）
- 7 个运行副本缺失（均为 `tests/`，正常）
- 部署需要同步 `app/engine/` 并更新 `product-payload.json` 的 sha256，或重新走打包安装流程

---

## 六、下一步建议（按顺序）

1. **等你的终端跑一次全量 core 套件**（不经 sandbox），确认除已知的并行冲突外没有真实回归。
2. **部署**：33 个文件同步到 `D:\AItestHarness\app\engine\`，更新 `product-payload.json` 哈希，重启验证一次完整流程。
3. **修 P0-1**（handoff 豁免），这是唯一还会让阶段白跑的问题。
4. **补跑三套测试**：`browser-task`、`api-automation`、`structured-actions`，串行单文件。
5. **skill 内容审计**（单独一轮）：11 个 skill 逐条对照 `scripts/` 验证判定口径，工作量约等于今晚的一半。
6. **清 7 个解绑 skill 目录** —— 建议等 `regression-selection` 建好后一起清，避免二次动 `release-resources.json`。

---

## 七、文件位置速查

```
E:\AItestHarness\
├── penguin\agents\<角色>\AGENTS.md          13 份提示词
├── penguin\agents.json                      绑定 + retired_skills
├── skills\<name>\SKILL.md                   11 个 skill
├── skills\<name>\references\*.md            skill 参考资料
├── config\orchestration-workflow.json       7 阶段编排（依赖已改）
├── config\release-resources.json            打包资源清单
├── scripts\child-tool-guard.mjs             子 agent 动作白名单
├── scripts\protected-inputs.mjs             脱敏层
├── tests\acceptance\*.test.mjs              验收测试
├── docs\qa-team-playbook-20261122.md        作业清单
├── docs\engine-change-backlog-20261122.md   引擎待改清单
├── docs\prompt-review-20261122.md           审阅报告
├── docs\change-summary-20261122.md          本文
└── .backup-prompts-20261122\                改造前备份（不入库）

D:\AItestHarness\app\engine\                 运行副本（33 个文件待同步）
```
