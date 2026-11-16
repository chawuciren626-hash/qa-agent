# Codex 接手说明：重构的来龙去脉、已建设什么、还差什么、从哪读起

> 写于 2026-11-16。面向对象：接手验收与后续建设的 Codex。
> 一句话：**这次重构不是因为"功能不够"，而是因为"跑出来的结果不可信"——把概率性的执行路径换成确定性的编译 + 硬闸 + 可复现执行，并用证据层保证"没测不许说通过"。**
> 相关文档：`docs/AITestHarness测试平台架构重构方案-v3.md`（2430 行，决策与方案全量）、`docs/refactor-batches-v3.md`（B1~B12 批次与验收）、`docs/handover-20261115.md`（最近两天仓库/打包/形态/模型改动）。

---

## 0. 先看这张坐标图

| 维度 | 现状 |
| --- | --- |
| 产品形态 | 云上控制面（管理后台：账号/权限/Agent/Skill/插件/工具）+ 本地执行面（Windows 客户端，本机服务 + 内置浏览器 + 引擎） |
| 已打通 | **治理与证据层**（B1~B12，全部有脚本 + 用例 + 文档）、IR 契约 v1.1、打包发布链路、客户端形态统一、模型设置 |
| 未打通 | **真实执行能力层**：探索器运行时、四类 Adapter 真采集、回归三闸/影响分析、需求→用例确定性编译、缺陷闭环提效、有效性基线（种子缺陷集） |
| 一句话风险 | 现在能保证"不撒谎"，还证明不了"测得准"——后者要靠被测环境 + 种子缺陷集才能量化 |

---

## 1. 为什么重构（动机与根因，务必先理解这一节）

### 1.1 触发事件（2026-11 演示翻车）
给一个测试环境地址 + 账号密码做探索性测试：**十几分钟没进入可测状态、消耗 100 万+ token、没有产出有效结果**。领导评价「不如直接用 codex」「很鸡肋」，建议「自己写工具插件优化执行流程（比如登录遇验证码）」。

### 1.2 根因不是工具少，是执行路径由 LLM 现场决定
原工程（10 Agent + 15 Skill + 七阶段编排 + 大量治理机制）的问题在于：**每一步"截图→理解→猜→点→确认"都要问模型**。后果是三重必然：
- 路径不可复现 → 两次结果不一致是**必然**，不是 bug；
- token 随步数线性爆炸，且大头花在阶段产物/Schema/回执/证据链这些**治理开销**上；
- 演示不可控，无法向业务证明"这套东西有用"。

原工程自评也写了：`真实测试有效性基线 = 未建立`；三大风险：① 工程完整性高于真实测试有效性；② 源码/候选/安装版/工作区四层漂移；③ Agent/Skill/提示词偏多偏重。

### 1.3 五层问题诊断（重构的立论）

| 层面 | 问题 | 后果 |
| --- | --- | --- |
| 架构层 | 执行路径 LLM 运行时决定 | 不可复现、token 爆炸、演示不可控 |
| 模式层 | 只有"从需求开始"的七阶段，**没有"只有 URL+账号"的探索模式** | 演示场景被硬塞进需求链，前三阶段凭空产出 |
| 治理层 | 校验是"事后审计 + LLM 自查"，不是"事前编译 + 程序硬校验" | 管得住"会不会说谎"，管不住"跑得稳不稳" |
| 资产层 | 元素/定位器/断言库、回归集**定义了但没绑任何 Agent** | 每轮从零，没有护城河 |
| 度量层 | 无种子缺陷集、召回率、误报率、错误通过率 | 无法回答"你到底有没有用" |

### 1.4 六项能力缺口（方案要补的东西）
1. 探索模式缺失（演示翻车直接原因）；2. 编译层缺失（无固化/无硬闸/无重放）；3. 资产层未接线；4. 回归集与影响分析未落地；5. flaky 无治理（"两次不一致"）；6. 有效性基线缺失。

### 1.5 对标结论（为什么选"重放优先"）
对标 Hifox（5 专项 Agent + 队长；Playwright 无头 + Agent 现场找元素；接口 1008 个/848 万 token）后得出修正结论：
> **执行可以探索，但"什么算对"必须事先固定，"探索"必须有硬预算，"稳定"必须由 N=3 验收。**

我们的差异化：把"稳定"从验收环节（连跑 3 次筛掉 flaky）**提前到编译环节**（固化后 1 次即稳、改动可 diff）。所以路线图是 **M1 重放先行，探索器放 M2**——上次失败正是"探索先行"。

---

## 2. 重构建设了什么（按层清点，可逐项验证）

### 2.1 方案与契约层
- **《架构重构方案 v3》**（2430 行）：75 条已确认决策速查、风险登记、16 条评审闭环（含 4 条不采纳理由）、实施路线图 M1~M5、度量口径。
- **《IR 契约规范》v1 → v1.1**：测试点/用例升级为带 `source` + `state` 的一等对象（预期结果收权）；`exec` 增 `verdict_cap`；新增 S 层规则 `EXPECT_UNVERIFIED_PASS` / `EXPECT_DRIFT`；附录 C 记变更。**目的：消除"两套契约"这一复发点。**
- **可运行的校验器 `aitestharness-ir/irval`**：契约 38 条规则中 23 条做成代码，**114 个用例全通过**（含 V-39/V-40），支持 `suite` / `validate` / `check-payload` 三种用法。

### 2.2 治理与证据层：B1~B12（本期主战场，全部 ✅）

| 批次 | 建设内容 | 关键产物 | 自检 |
| --- | --- | --- | --- |
| B1 | 全链路 trace | `scripts/trace.mjs` + executeAction 接入 + CLI 回放（凭据不入盘） | 12/12 |
| B2 | 缺陷根因聚类 | `scripts/defect-cluster.mjs`（40 同类失败聚 1 组，**缺陷单数不变**） | 12/12 |
| B3 | 需求完备性检查 | `scripts/requirement-completeness.mjs`（5 项零 LLM 可判，无输入报 `available=false` 不给 0 分） | 18/18 |
| B4 | 发版探针 | `scripts/release-probe.mjs`（失败率 >20% → `blocked`） | 19/19 |
| B5 | golden set 框架 | `scripts/golden-runner.mjs` + `tests/golden/`（8 点/12 样本，无 baseline 报 `no_baseline` 不假绿） | 20/20 |
| B6 | stub 声明 | `scripts/execution-stub.mjs`（有 stub 声明失败不得产 `fail`） | 12/12 |
| B7 | CI + JUnit | `scripts/ci-run.mjs`（`--suite=smoke --junit` 合法 XML，失败退出码非 0） | 7/7 |
| B8 | 覆盖度真话 + 降级进报告 | `coverage-split.mjs`（已执行/仅分配两口径并排）、`report-runtime-sections.mjs` | 9/9、8/8 |
| B9 | M1 一致性验收 | `scripts/consistency-report.mjs`（N=3 一致率可算；真实 run 产 `not_ready` 而非编造通过） | 23/23 |
| B10 | 契约升 v1.1 | 文档 + irval V-39/V-40 + 2 新 fixture + 10 用例 | 114/114 |
| B11 | 测试数据生命周期 | `scripts/data-lifecycle.mjs`（残留不静默、无 teardown 只读、persistent 不许用例级改） | 22/22 |
| B12 | 确认卡点三件套 | `scripts/confirm-gate.mjs`（diff/sample/risk 三层可算，抽样可复现，反绕过退出码 1） | 19/19 |

另有更早落地的 L-1/L-2/L-3/L-6/L-7/L-11：`expectation-audit`、`artifact-scope`（`partially_stale`）、`expected-source` + `execution-verdict`（R1~R5）、`regression-sampling`、`partial-submit`、多模块 scope。
**共同特征（Codex 验收重点）**：每一批都能指着代码说「以前这里是空的」；每一批都有可复跑用例；口径都写进 docs（`runtime-trace.md`、`coverage-truthfulness.md`、`data-lifecycle.md`……共 20+ 篇）。

### 2.3 平台与产品层（桌面壳 + 服务端 + Web）
- **控制面/执行面成型**：账号中心（用户/权限/模块）、Agent/Skill/插件/工具注册（后台 33 个工具注册表，含 `central-tools` 运行面闸门）、发布与授权、审计。
- **客户端与 Web 同构**（提交 `08abd5f`）：登录 → 项目管理页 → 进项目 = 聊天工作台 + 项目视图/项目资料/定时任务；admin 登录客户端就是普通用户；删除账号中心"跳板页吞树"分支。
- **模型设置 WorkBuddy 化**（`15f4dc3` → `4d8b844`）：设置 → 模型对所有用户可见；用户添加的模型自动写入**按用户的全局模型配置文件** `<数据根>/.account-models/<hash>.json`，并同步到该用户所有项目的 `.project_config.toml`；新建项目自动继承；会话下拉天然可选。
- **打包发布链路**：`windows-release.yml`（workflow_dispatch，artifact `windows-installation-candidate`）；`config/release-resources.json` 白名单 + `check-release-resources.mjs`（白名单有效性）+ `assertReleaseImportClosure`（**import 闭包强检**，打包阶段就失败，杜绝"装完点图标打不开"）。

### 2.4 仓库治理
- main 历史重置为干净基线（B1~B12 全量源码），develop 仅留历史；`v0.1.0-preview.4` 标签删除；
- `.gitignore` 白名单式提交 `docs/`（避免历史过程稿混入）：新增文档需 `git add -f` 并在 `.gitignore` 补 `!/docs/xxx.md`，否则会被静默忽略。

---

## 3. 还有哪些没建设（明确边界，别当成漏做也别当成已做）

### 3.1 路线图未完成部分（M2~M5）

| 里程碑 | 内容 | 现状 | 说明 |
| --- | --- | --- | --- |
| **M1** 执行引擎 + 固化链路 + 冒烟集 | 单类型打通、DSL 计划、五道闸、五档结论、取证包、N=3 | **治理/证据层已完成（B1~B12）**；真实 N=3 实跑仍 `not_ready` | 需要真实被测系统与稳定环境才算验收通过 |
| **M2** 探索器 + 四类 Adapter | 冷启动到可测 ≤1 分钟、token ≤20 万、路由覆盖 ≥80% | **未做**：仅有旧的 `explore-task-url.mjs` 雏形；Playwright/Appium/小程序宿主运行时真实采集全部 🔜 | 需真机/真浏览器环境，沙箱只能验规则层 |
| **M3** 回归三闸 + 影响分析 + flaky 治理 | 变更→选回归集→准入结论 | **部分**：`regression-sampling`（分层采样，L-6）已落；三闸编排、`touched` 影响分析主路、flaky 检测与隔离区**未做** | |
| **M4** 需求→测试点→用例确定性编译 | 含 OpenAPI 零 LLM 路径、血缘增量重算 | **未做**：现有 analysis/test_points/test_cases 仍是旧 Agent 链路（概率性），未替换为编译层 | L-1/L-3 机制已备好，等编译层接 |
| **M5** 缺陷闭环 + 报告 + 知识沉淀 | 归因下沉执行末端、去重、提单、复测、知识回流 | **部分**：`defect-cluster`、`defect-lifecycle` 存在；提单集成、复测闭环、知识回流**未做** | |

### 3.2 能力缺口（对应 §1.4，仍未补齐的）
- **有效性基线**：种子缺陷集（植入 20~30 个已知缺陷）、召回率/误报率/错误通过率 — **未建**，这是回答"你到底有没有用"的唯一途径，属人工工作（需可控被测系统）。
- **资产层接线**：元素库/定位器/断言库、回归集仍未绑定 Agent，跑一轮不沉淀。
- **探索预算硬闸**：token/时间预算截断只设计了，未接运行时。
- **客户端版本协商机制**（方案 §24.3 标"必须实现"）：契约版本区间、策略下发兼容、离线快照兜底 — **未实现**（反面事故：老客户端 + 新策略 = 全部产物校验失败）。
- **完整 CLI**：`harness run --suite` 一条命令跑完全链 — 未做（B7 只做 CI 入口 + JUnit）。

### 3.3 近期产品侧遗留
- **辅助任务模型未接引擎**：`ui_prefs.aux_model` 已落库，标题/摘要生成仍走默认模型（二期）。
- **管理后台模型配置**未做"供应商视角"重排（当前是全表视图）。
- **web 测试 39 个既有失败**：环境性（端口/依赖相关），改动前后逐条对比一致，非本次引入；建议接手后排一次环境。
- **develop 分支去留**待产品决定。

---

## 4. 整合时需要注意什么（踩过的坑，逐条都是事故换来的）

1. **打包白名单是双闸，别只过一关**：`check-release-resources.mjs` 只管"白名单里的文件存在"；`assertReleaseImportClosure` 才管"import 闭包完整"。新增脚本必须同时进 `config/release-resources.json` 的 files 与闭包校验，否则安装包会"装得上、点不开"（已发生一次）。
2. **`docs/` 是白名单提交**：`.gitignore` 里 `/docs/*` 全忽略 + 逐条 `!/docs/xxx.md`。新文档要么加白名单，要么 `git add -f`；**不要**用 `git add docs/` 一把梭（会静默漏掉）。
3. **`config/tool-runtime-state.json` 是运行噪音**：跑过脚本就会带时间戳改动，提交前 `git checkout -- config/tool-runtime-state.json`，别把它带进 commit。
4. **产品形态不要"猜"**：桌面客户端与 web **完全同构**（登录→项目管理→项目工作区），admin 登录客户端就是普通用户。不要再引入"管理员专属入口/跳板页"这类分支——上一轮删的就是它。
5. **模型权限链路**：项目模型 API 的写权限是**项目 owner**（不是 admin）；账号中心里 admin 专属的只有 `/admin/model-config`（管理目录）。用户级"全局模型"是通过 `publishSharedModels` 落 `.account-models/<hash>.json` 再同步全项目，**不要**改回"写管理目录"。
6. **不要动宿主（PenguinHarness）**：产品以版本锁定 + 兼容层跟随上游，不直接改宿主；`AGENTS.md` 明确"不为每轮优化出安装包/Release"，只有用户明确要求才提交/推送/打包。
7. **结论必须有防线**：任何"通过"都要能回答三条——预期从哪来（`expected-source` R1~R5）、有没有被 stub 降级（`execution-stub`）、覆盖率是不是把"仅分配"算成"已执行"（`coverage-split`）。写新判定逻辑时先接这三条，否则会重演"看起来正确的错误结论"。
8. **口径变更要同步契约**：改 IR 字段/判定规则，必须同步 `docs/AITestHarness-IR契约规范-v1.md`（现 v1.1）与 `irval` 规则，否则出现"两套契约"。
9. **N=3 是入库门，不是运行期要求**：运行期按 §20.2.1 分层采样，别把成本乘三。
10. **安全**：仓库推送用的 classic PAT 曾在对话明文出现（`ghp_QXR6...MTd`），**必须吊销轮换**；后续用 fine-grained PAT / deploy key。模型凭据、宿主数据、安装二进制不入库。

---

## 5. 拉取代码后，从哪开始熟悉（建议 2 小时路线）

### 第一步：看三份文档（30 分钟）
1. `README.md` — 仓库定位、分支、如何跑测试、安装包从哪来；
2. `docs/refactor-batches-v3.md`（70 行）— **最快理解"这次改了什么"**：起点盘点 + B1~B12 + 明确的不做清单；
3. `docs/AITestHarness测试平台架构重构方案-v3.md` 的 §0~§2（动机/诊断/缺口）、§18（路线图）、§25.5（落地清单）——只读这几段就够建立判断，不必通读 2430 行。

### 第二步：跑起来（20 分钟）
```bash
npm ci
npm test                 # 全量工程测试（run-engineering-tests.mjs）
npm run test:core        # 核心套件，快
npm run test:browser     # 浏览器相关
npm run check:static     # 静态预检
npm run release:check    # 发布白名单校验（改打包必跑）
node scripts/ci-run.mjs --suite=smoke --junit   # CI 入口 + JUnit
```
> web 包另有 vitest：`cd platform/packages/web && pnpm exec vitest run`（注意：有 39 个既有环境性失败，属基线，不是回归）。

### 第三步：按"证据链"读代码（40 分钟，从判定往回读）
| 想理解什么 | 读哪里 |
| --- | --- |
| 一次执行怎么被串起来 | `scripts/structured-actions.mjs`（入口，B1 trace 挂在 finally） |
| 结论怎么被"压"住 | `scripts/expected-source.mjs` + `scripts/execution-verdict.mjs` + `scripts/execution-summary.mjs` |
| 覆盖率/降级/数据残留怎么进报告 | `scripts/coverage-split.mjs`、`scripts/report-runtime-sections.mjs`、`scripts/report-fact-body.mjs`、`scripts/data-lifecycle.mjs` |
| 失败怎么归因 | `scripts/defect-cluster.mjs`、`scripts/assess-execution-evidence.mjs` |
| 一致性/发版/确认卡点 | `scripts/consistency-report.mjs`、`scripts/release-probe.mjs`、`scripts/confirm-gate.mjs` |
| 契约校验器 | `aitestharness-ir/irval/`（`suite` / `validate` / `check-payload`） |

### 第四步：服务端与前端骨架（30 分钟）
- 服务端：`platform/packages/server/src/platform.ts`（模块注册总表，先看 `@Module` 列表）→ `src/http/control-plane.ts`（/admin 路由与权限）→ `src/http/routes/models.ts`（模型路由，含 `modelConfigChanged`）→ `src/services/project-config-service.ts`（`publishSharedModels` / `writeInitialConfig`）。
- 前端：`platform/packages/web/src/router.tsx`（路由，形态统一在这里）→ `features/settings/settings-dialog.tsx` + `lib/settings-sections.ts`（设置页可见性）→ `features/models/user-models-settings.tsx`（WorkBuddy 式模型页）→ `features/admin/admin-users-page.tsx`（建号）。
- 桌面壳：`packaging/` + `Launcher` 链路（`product-installed-start.mjs` → 宿主 `PenguinHarness.exe`）。

### 第五步：验收切入（明天实机验收按此顺序）
1. 装包 → 启动（异常看 `desktop.log`）；
2. admin 登录 → 项目管理页 → 进项目 → 会话可发消息；
3. 管理后台 → 用户管理 → 建普通用户 → 该账号登录：同样进项目管理页、可自己配模型；
4. 设置 → 模型 → 添加模型（供应商预设 + API Key + 测试连接）→ 回会话下拉可见 → **新建项目自动继承**；
5. 跑 `npm run release:check` 与 `node scripts/ci-run.mjs --suite=smoke --junit`，确认交付基线绿。

---

## 6. 给 Codex 的三条判断建议（避免重演旧问题）

1. **先问"没有它，这个阶段的数据还可信吗"，再问"将来要不要返工"**——前者决定做不做，后者决定留什么接口（方案 §18.2.1 的判据）。
2. **任何新能力先接证据链再上线**：没有 `expected-source` / `execution-stub` / `coverage-split` 三条，不要产出"通过率""覆盖率"这类对外数字。
3. **不要用"功能数量"证明进展**：这次重构的验收标准是"同一用例跑 3 次结果一致 + 失败可定位根因"，不是"又加了几个 Agent"。
