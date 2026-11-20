# AITestHarness 执行引擎与 MCP 架构方案 v2.3

> 日期：2026-11-18（v1 同日发布，v2 同日修订；v2.1 追加 §十，v2.2 按"项目层/任务层"两层重写 §五 与 §十，v2.3 新增 §3.5 明确 computer-use 引入边界并补"取原料层"空白。文件名保持 `-v2` 不变以免打断既有引用）
> 背景：研发组长确认技术方向调整——自动化测试执行采用 **computer-use 能力 + MCP 协议**，skill 层瘦身。
> 本文档整合：①方向决策依据 ②现状资产去留 ③目标架构 ④选型 ⑤实现后效果与核心流程 ⑥改造批次重排 ⑦风险对策 ⑧里程碑 ⑨明确不做 ⑩全流程缺口与重构建议。
> 取代范围：《AITestHarness测试平台架构重构方案-v3》中执行层（u2/u3 Playwright 定位）与工具协议、skill 编排相关章节；以及 **v1 全文**。其余章节（意图层、IR 契约、报告缺陷闭环）继续有效。
> v1 保留为决策记录，不删除。

---

## 〇、v2 相对 v1 的修订摘要

**先看这一节。** v1 的方向站得住，但有 3 处会阻断落地的问题、4 处会踩的坑、1 处资产盘点缺口。逐条处置如下。

> **v2.1 增量**：§十 补的是另一条线——不是"执行引擎怎么建"，而是整条流程在**运行时与治理面**还缺什么、**代码层**该重构什么。
>
> **v2.2 修正（重要）**：v2 / v2.1 把流程压成了一条直线，漏掉了**两层结构**——「建档/探索/地图」是**项目层的一次性资产**，「需求分析→测试点→用例→计划→执行→缺陷→报告」是**任务层每次按需求重走的流程**，两者是"资产"与"使用者"的关系（咬合点是 `plan` 阶段 `requires: ["cases","maps"]`）。已在 §五 重写。
>
> **v2.3 澄清（重要）**：**computer-use 与 MCP 是两个正交维度，不是上下游**。建档探索的默认路径（静态解析 + 结构巡检）**完全不需要 computer-use**，它只是第③层兜底与执行期首轮固化才用的手段。同时本节补一个此前未被识别的空白：**"取原料层"当前是空的**（全包无浏览器驱动依赖），这才是 M2 的真实工作量。详见 **§3.5**，并按此把 M2 拆为 **M2a（不依赖 computer-use）/ M2b（视觉兜底）**。§5.0 已补两层总览与九阶段表，§5.4 已补任务主线，§十 由 6 项缺口改为 9 项（新增 G7 任务不是实体、G8 环境未贯通、G9 地图无版本）。其中 G7/G2/G8 缺失会让 M2.5 的验收判据没有载体，建议与 §6.3 批次一起读。

| # | 级别 | v1 的问题 | v2 处置 | 影响章节 |
|---|---|---|---|---|
| R1 | **阻断** | v1 §5.3 把 computer-use 引擎画成 MCP 适配器的上游（"引擎启动，每步操作经 adapter"）。Midscene 自持 Playwright/ADB 连接、自闭环定位动作，与 playwright-mcp 争夺同一实例；两者锚点体系（视觉坐标 vs a11y ref）不可互换，嵌套调用不成立 | 改为 **Driver 单一装配**：同一任务只装一个 driver 实现，复用 IR 既有 `driver_kind`；跨 driver 只靠 `context_flow` 传值，不嵌套 | §1.2 / §3.2.1 / §4.4 |
| R2 | **阻断** | v1 §1.1 前提 3 用"仅几十条回归"论证逐步推理开销可接受，实则是把探索整体改成视觉操作；与 `explore/explorer.py` 已确立的结论（路由表解析比"点着看"快 100 倍且零 token）相反，会把"十几分钟跑不起来 / 百万 token"的病灶重新引入 | 探索改为 **三层递进**：静态解析（零 LLM，默认入口）→ 结构巡检 → 视觉探索（仅兜底） | §1.1 / §3.2.2 / §5.3 |
| R3 | **红线** | v1 §5.4"剧本失败 → 自动重新探索修复锚点 → 入库"违反 `exec/infra.py` 已立的红线（L3 改步骤/改目标禁止自动；decide 断言失败永不自愈）。静默更新基准会让"该失败的变成通过" | 失败 **三分归因**；仅"定位漂移"可自修，且必须产出 diff 报告经人工确认后才入库；断言失败一律 L3 转人工 | §3.2.4 / §5.5 / §七 |
| R4 | 坑 | v1 §3.2"视觉断言兜底（含置信度）"与 `regression/selector.py` 的"smoke 必须 100% 规则断言、语义断言禁入"冲突；且置信度阈值无法可靠校准 | 断言 **decide/observe 分级**：decide 只允许规则断言；给出结构化断言覆盖率 ≥70% 的准入线 | §3.2.3 / §5.4 |
| R5 | 坑 | v1 §3.3 只写"tools/list 动态发现 + 按授权过滤"。33 自有 + playwright-mcp(25+) + mobile-mcp(30+) ≈ 90 个工具进同一清单，会显著拉低工具选择准确率；授权过滤 ≠ 语义过滤 | 任务级子集装配（每任务 8-12 个）。**注意：这套白名单已经存在**——`agent/tasks.py` 的 `TASK_CONTRACTS.tools`（精确到函数名，"调用即拒"）+ `tool-gate.mjs` 的 `CALLABLE_STAGE_TOOL_IDS`（10 个）。v2 不是新建机制，而是把既有白名单**桥接到 MCP `tools/list` 的过滤上** | §3.3 / §5.6 |
| R6 | 坑 | §七称"回归以剧本重放为主（不烧模型）"，v1 §5.4 又保留"视觉断言兜底"——两者互斥 | 明确分层：探索用模型、固化层产出结构化锚点、**重放层零模型**；新增成本模型一节给出算式 | §3.4 / §5.5 |
| R7 | 坑 | v1 把 tool-gate 当成"敏感操作确认闸门"（§3.2.4 "复用 tool-gate 思路——敏感操作强制确认"）。**这是误读既有资产**：`scripts/tool-gate.mjs` 实际是 action → 工具的**依赖完整性闸门**（`requires` 硬依赖停用即拒、`enhances` 软依赖停用只降级），且文件头明确写着"工具状态是纪律增强，**不是安全边界**" | ① 更正 tool-gate 职责定位；② 安全防线另立一层并**下移到环境层**（数据快照可回滚 / 支付 mock / 无生产权限）；③ 说明为何 computer-use 下依赖闸门无法兜住危险动作 | §2.3 / §3.2.5 / §七 |
| R8 | 缺口 | §2 资产盘点只把 IR 当"契约 + 校验器"保留，完全遗漏 `aitestharness-tools/exec/*`、`explore/*`、`agent/tasks.py`，以及 `central-tools.ts` / `tool-gate.mjs` 的真实形态——而这些恰是 §3.2/§3.3 多项设计要点的既有落地 | 新增 §2.2 资产清单；新增 **M0 前置核实批次**（已核部分直接写入，未核部分列清单） | §2.2 / §6.2 |
| R9 | 缺口 | v1/v2 未区分 **computer-use（定位方式）** 与 **MCP（调用协议）** 两个正交维度，且未识别"取原料层"为空（全包只有 `requests`，Playwright 从未接入）——后果是 M2 被当成"接个库"，computer-use 被塞进一期关键路径 | 新增 **§3.5**：四象限正交矩阵、`probe/` 适配器（全仓唯一碰浏览器处）、三层取法 + `source` 标记、computer-use 三个落点与"**产出必须降级为结构化锚点**"硬约束；M2 拆为 **M2a（不依赖 computer-use）/ M2b（视觉兜底，移出一期）** | §3.5 / §5.3 / §六 / §八 |

---

## 一、方向决策与依据

### 1.1 三个前提（修正表述）

| # | 前提（v2 表述） | 与 v1 的差异 | 对架构的影响 |
|---|---|---|---|
| 1 | 被测对象包含 **App、小程序、桌面客户端**，非纯 Web。四端的差异主要在**启动方式 / 权限模型 / 取证手段**，不在"点击"这个动作 | v1 写"computer-use 是唯一目标无关的统一执行引擎"。**修正为：统一的是动作/定位/断言的抽象，不是引擎。** 目标无关 ≠ 部署无关；"唯一引擎"的表述会系统性低估 M3/M5/M7 的工程量（v1 自己承认 M5 无现成方案，即是反证） | 执行层按 **driver 抽象 + 多实现** 设计，不为"一个引擎通吃"做妥协 |
| 2 | **接现成引擎**，不自研视觉 agent | 不变 | 一期成本控制在一周量级仍成立 |
| 3 | 回归规模 = **仅本次测试任务相关模块**（几十条量级） | v1 据此认为整体开销可接受。**修正为：几十条的量级让"探索阶段的逐步推理"可接受；但回归本身必须零模型重放**，否则成本随回归频次线性上升（见 §3.4） | 探索层可承担模型成本，重放层必须确定性 |

### 1.2 决策结论（四条）

1. **执行层**：一个 driver 抽象、多实现并列；**单任务单 driver**；混合用例遵守 `exec/hybrid.py` 既有四约束（最多 2 段、切走不许切回、必须声明 `main_driver`、跨段必须显式 `context_flow`）。
2. **探索**：三层递进——静态解析（零 LLM，默认入口）→ 结构巡检 → 视觉探索（兜底）。硬预算与危险动作白名单沿用 `explore/explorer.py`。
3. **协议层**：全部工具走 MCP，但必须做**任务级子集装配**（复用 `TASK_CONTRACTS.tools`，不新建清单）；工具描述作为一等公民维护（LLM 靠描述选工具，不靠函数签名）。
4. **知识层**：skill 瘦身按**三类分离**处理——执行类（"怎么做"由 driver 承载，"判什么"保留）、编排类（业务路径知识**迁移**进剧本/检查单，不直接删）、知识包（保留）。

---

## 二、现状资产盘点与去留判定

### 2.1 总表

| 资产 | 现状 | 判定 | 说明 |
|---|---|---|---|
| IR 契约 + irval 校验器（114 用例通过） | `aitestharness-ir/` 已入库 | **保留** | 契约与执行引擎无关；`operation_script` 以附件制品形式挂靠，**不侵入 schema**（见 §6.4） |
| **执行层工具集 `exec/*`（v1 遗漏）** | 已实现，见 §2.2 | **保留并作为重构基座** | v1 §3.2 四条设计要点这里已有落地；不认领就会重复造并推翻既有铁律 |
| **探索器 `explore/explorer.py`（v1 遗漏）** | 四阶段 + 硬预算 + 危险动作白名单已实现 | **保留，升为探索主路径** | 其"静态解析优先"结论是 R2 的直接依据 |
| 回归选集与 flaky 判定 `regression/*` | 三档选集 + flaky + quarantine 已实现 | **保留** | 本方案的结构化断言门槛落在这里约束 |
| 项目建档链路（零 LLM bootstrap） | `aitestharness-tools/onboard` 已实现 | **保留** | 建档知识地图（`knowledge/maps.py`）归入知识包 |
| 条款化 → 测试点矩阵 → 用例固化 → 候选代价 → 接入任务 | 批次 4 建设中 | **保留** | 意图层链路不变 |
| 报告审批 / 缺陷归因去重提单 | 批次 5 建设中 | **保留** | 结果闭环不变 |
| central-tools 33 工具 + tool-gate | 已核实落点：`platform/packages/server/src/http/central-tools.ts`（SQLite 表 `central_tools`，`grep -c 'name: "'` 计 33 条，含 `permissions`/`parameters`/`returns`/`enabled`/`version`/`builtin`）+ `central_tool_audit` 审计表 + 引擎侧 `scripts/tool-gate.mjs`（action → 工具依赖闸门） | **改造（转协议）** | 工具定义转 MCP server；**tool-gate 职责原样保留**（它管的是"某 action 依赖的校验工具是否被停用"，不是敏感操作确认），`syncRuntimeState()` 写 `config/tool-runtime-state.json` 的链路要跟着 MCP 化一起走通 |
| 执行切片 u2/u3（Playwright 采集、Web 登录、脚本转时） | 批次 3 建设中 | **转向** | Playwright 从"执行主力"降为**结构化 driver 的一个实现**；批次 3 暂停改向 |
| skill：执行类（playwright/android/miniprogram-execution） | 已建 | **改造** | 保留其中"判什么/怎么判"的判定规则与"结果未知时不重放"纪律，退役"怎么做"的驱动细节 |
| skill：编排类 | 部分已建 | **迁移** | 业务路径知识逐条迁入操作剧本与领域检查单，不允许直接 rm |
| 全局模型配置 / 渠道管理 / 管理后台 / 设置页 | 已上线 | **保留** | 视觉模型与 VLM 调用同样走渠道，是引擎接入前置 |
| 平台底座（用户/项目/会话/机器/unattended） | 稳定运行 | **保留** | 不动 |

> 结论：本方案**不是推倒重来**——意图层与平台闭环全部复用，改造集中在「执行末端的装配方式」与「工具协议」。

### 2.2 既有资产清单（v1 遗漏部分）

这是 v1 最大的信息缺口。以下模块已经实现了 v1 §3.2 / §3.3 声称要"新建"的大部分能力，Codex 落地前必须先读，**能复用的一律复用，不得推翻其铁律**。

| 文件 | 已提供的能力 | 与本方案的关系 |
|---|---|---|
| `exec/hybrid.py` | 混合 driver 四约束：C1 必须声明 `main_driver`；C2 最多 2 段、切走不许切回；C3 跨段必须显式 `context_flow`；C4 引用变量必须已声明。附"分配审计闸"：接口可验证却被分配为 UI 的比例 >30% 提示不合理 | **§3.2.1 driver 装配规则的直接依据**，不是新设计 |
| `exec/infra.py` | 自愈分级判定：L1 换指纹（自动）/ L2 延长或追加等待（限一次，自动）/ L3 跳过或替换步骤、改变操作目标（**禁止自动**）；`decide` 断言失败**永不自愈**。注释原话："只允许让用例能跑通，绝不允许让该失败的变成通过"。另含凭证与环境中心（环境域名切换、token 刷新，禁止写进计划） | **§3.2.4 自愈红线**。R3 的修正依据 |
| `exec/wait_assert.py` | 封闭等待枚举 8 种；断言引擎；定位解析三条硬规则（按优先级尝试 / 多命中拒绝执行 / 降级必须记录） | §3.2.3 断言与等待的唯一来源，禁止 LLM 自由发挥 |
| `exec/native_mini.py` | `LocResolver` 多指纹（web：testid>aria>css>text>xpath；native：accessibility_id/id/class_chain/xpath），**要求 ≥2 指纹**；`DeviceQueue` 单设备串行；`PopupPolicyChain` 宿主级弹窗策略 | §3.2.1 锚点唯一表示的实现基础；§2.3 设备矩阵表述纠偏依据 |
| `exec/snapshot.py` | 结构化 DOM 快照 + iframe/shadow 显式标注 + 基线 diff。**开头即写明分工原则：Playwright 只负责取原料，判定由纯函数完成**（"这是 M2 能不能顺利接上的关键"） | **这正是 R1 要求的"取原料 / 判定分离"**，v1 的引擎↔适配器嵌套恰好违反了这条已写下的原则 |
| `exec/pools.py` | 四池调度：接口 20~50、Web=CPU 核数、设备 1~2、小程序 1~2；混合用例进主 driver 池 | §六 批次与 M3 容量的约束 |
| `exec/debug.py` | `DebugController` 断点/单步/接管，不依赖浏览器，可在任意 driver 上复用 | M2a 探索的"演示可见 / 单步"与 M4 人工接管直接复用，不新建 |
| `explore/explorer.py` | 四阶段（环境建档 / 结构巡检 / 功能试触 / 固化沉淀）；`DEFAULT_BUDGET` 硬预算（inspect 50 页 / probe 10 页 / 每页 5 动作）+ 三种终止条件；`DANGEROUS_ACTIONS` + `action_policy`（**默认只读**，提交类需显式 `readwrite` 且页面在白名单）；控件 → 测试点确定性映射 | **§3.2.2 探索主路径** |
| `regression/selector.py` | 三档选集 smoke(≤5min)/core(≤1h)/full；smoke 要求 **flaky 率 0 + 语义断言禁入**；quarantine 全档剔除 | §3.2.3 结构化断言门槛的守门处 |
| `irval/enums.py` | `driver_kind`(web/api/native/miniprogram/db)、`assert_level`(decide/observe)、`assert_type`(14 种含 semantic)、`heal_level`(L1/L2/L3)、`verdict`(含 flaky/inconclusive)、`inconclusive_kind`(5 类) | 全部复用；本方案不新增枚举维度 |

**协议层与契约层既有资产（v1 同样遗漏）：**

| 文件 | 已提供的能力 | 与本方案的关系 |
|---|---|---|
| `aitestharness_tools/agent/tasks.py` | `TASK_CONTRACTS`：每类任务声明 `inputs` / `scope_keys` / **`tools`（工具白名单，精确到函数名）** / `must` / `must_not`。三条硬纪律：不在白名单的工具**调用即拒**（不是"不建议用"）；`program`/`exec_fact` 字段**写不进**（剥离 + 留痕）；`manual` 档不发起模型调用 | **§3.3 任务级工具子集装配的现成实现**，不是新设计。R5 的落地方式是把这份白名单桥接到 MCP `tools/list` |
| `platform/packages/server/src/http/central-tools.ts` | 33 条工具台账（SQLite `central_tools`）+ 变更审计（`central_tool_audit`，禁止静默改）+ 启停同步（`syncRuntimeState()` → `config/tool-runtime-state.json`）+ 调用流水读取（`output/runtime/tool-usage.jsonl`） | M1 的改造对象。台账结构（`permissions`/`parameters`/`returns`/`version`）可直接映射为 MCP tool schema |
| `scripts/tool-gate.mjs` | action → 工具的 **依赖完整性闸门**：`requires`（硬依赖，停用即拒，理由写在注释里——"放行等于产出一份看起来正常、实际少了校验的产物，这比直接失败更糟"）、`enhances`（软依赖，停用只降级但回执必须写明）、`when`（形态条件）。另有 `CALLABLE_STAGE_TOOL_IDS` 10 个可调用工具 id | **§3.2.5 的关键更正来源**：v1 把它当敏感操作闸门是误读；它自己声明"不是安全边界" |

### 2.3 v1 表述纠偏（四处）

| v1 原文 | 问题 | v2 表述 |
|---|---|---|
| "computer-use 是唯一目标无关的统一执行引擎" | 概念上把"抽象"说成了"引擎"，导致低估非 Web 端工程量 | "统一的是动作/定位/断言的抽象；各端由不同 driver 实现" |
| "skill 瘦身——砍掉步骤编排类 skill" | 编排知识里的业务路径（如"下单必须走完支付才发券"）是验收语义，删了会丢 | "编排类的**业务路径知识迁移**进剧本与检查单；只退役驱动细节" |
| "机器/设备矩阵管理" | 与 §11.7 已定的"设备 1~2 池、初期不做真机池"不一致 | "设备矩阵作为机器扩展，容量仍受四池约束；一期 Android 模拟器单设备串行" |
| "复用 tool-gate 思路——敏感操作（删除/支付/不可逆操作）强制确认" | **误读既有资产**。`tool-gate.mjs` 是 action → 工具的依赖完整性闸门，不做敏感操作识别，且文件头明确声明"工具状态是纪律增强，不是安全边界" | "tool-gate 原职责保留（依赖完整性）；敏感操作防线另立，重心在环境层可回滚"（见 §3.2.5） |

---

## 三、目标架构

### 3.1 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│ 意图层（不变）                                                │
│   项目建档 → 需求条款化 → 测试点矩阵 → 用例固化 → 候选代价      │
│   数据模型：IR 契约（irval 校验）                              │
├─────────────────────────────────────────────────────────────┤
│ 执行层（重构：一个抽象、多实现、单任务单装配）                   │
│   Driver 抽象（复用 IR driver_kind: web|api|native|miniprogram|db）│
│     · 视觉探索 driver   Midscene / UI-TARS                    │
│     · 结构化 driver     playwright-mcp / mobile-mcp / 小程序适配器│
│     · 剧本运行 driver   零模型确定性重放                        │
│   装配铁律：单任务单 driver；混合 ≤2 段且切走不回；跨段走 context_flow│
│   取原料层（新增 probe/）：全仓唯一碰浏览器处，三取法共用同一实例   │
│   共用判定层（纯函数，可单测）：快照判定 / 定位解析 / 等待 /       │
│                              断言引擎 / 自愈分级                 │
├─────────────────────────────────────────────────────────────┤
│ 协议层（重构）                                                │
│   MCP：tools/list 动态发现 + 任务级子集装配（8-12 个/任务）      │
│   · 平台自有工具 → TS SDK / FastMCP（tool-gate 原职责不动）      │
│   · 适配器工具 → 现成 server 接入                              │
├─────────────────────────────────────────────────────────────┤
│ 知识层（瘦身：三类分离）                                       │
│   保留：建档地图、领域检查单、条款化规则（知识包）               │
│   迁移：编排类的业务路径知识 → 操作剧本 / 检查单                │
│   退役：执行类的"怎么做"（由 driver 承载），保留"判什么"         │
├─────────────────────────────────────────────────────────────┤
│ 平台闭环（不变）                                              │
│   证据留存 → 报告审批 → 缺陷归因/去重/提单 → 持续回归            │
│   底座：用户/项目/会话/机器管理/unattended/全局模型配置         │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 执行层设计要点

#### 3.2.1 Driver 抽象与装配规则

**唯一装配原则：一个执行任务只装配一个 driver 实现，不做引擎与适配器的嵌套。**

- 视觉 driver（Midscene / UI-TARS）：自闭环，自己截图→定位→动作。装配它就**不要**再接 playwright-mcp。
- 结构化 driver（playwright-mcp / mobile-mcp / 小程序适配器）：agent 自己按原子工具编排。
- 剧本运行 driver：读操作剧本确定性重放，零模型。

三者的取舍见 §4.4 冲突矩阵。共同约束：

1. **取原料 / 判定分离**（沿用 `exec/snapshot.py` 已写下的原则）：driver 只负责把页面拉成原料（DOM/a11y 树/截图），元素归类、指纹提取、diff 判定全部走纯函数，可单测。禁止把判定逻辑写进 driver。
2. **锚点唯一表示**：一个用例的锚点只有一套表达（IR `target.locators` 多指纹，≥2 指纹），由 driver 负责把通用锚点翻译成自身能执行的形式。**不允许在剧本里同时存视觉坐标和 a11y ref 两套**——否则 M4 的剧本无法跨 driver 复用。
3. **混合用例遵守 `exec/hybrid.py` 四约束**：最多 2 段、切走不许切回、必须声明 `main_driver`、跨段必须显式 `context_flow`。超出的用例应拆分，不得放宽约束。
4. **结果未知不重放**（沿用执行类 skill 已立纪律）：动作已发出但结果未知时，不自动重放，转 `inconclusive`（`inconclusive_kind` 五类已定义）。

#### 3.2.2 探索：三层递进，视觉仅兜底

**这是对 v1 最重要的方向修正。** `explore/explorer.py` 的结论要保留：

> 现代 Web 应用的路由表几乎都在 JS 里，直接解析比"点着看"快 100 倍且零 token。

| 层 | 手段 | 成本 | 何时用 |
|---|---|---|---|
| ① 静态解析 | 解析 JS bundle 路由表、控件结构、接口文档、`detect_stack` 判定渲染策略 | **零 LLM，秒级** | **默认入口，永远先跑** |
| ② 结构巡检 | a11y 树 / DOM 快照广度优先遍历（`snapshot.py` + `BudgetGuard`） | 零或极低 LLM | ①拿不到结构时（纯客户端渲染、动态路由） |
| ③ 视觉探索 | computer-use 逐步操作（截图→定位→动作） | 高（每次动作 1 次 VLM） | **仅前两层拿不到的页面**：验证码、文件对话框、跨窗口、Canvas/游戏化界面、桌面客户端 |

硬性约束（全部沿用既有实现，不重新发明）：

- `BudgetGuard` 硬预算：inspect 50 页 / probe 10 页 / 每页 5 动作，超预算**拒绝执行**（不是建议）。
- 三种终止：`budget_exhausted`（优先）/ `routes_covered` / `no_new_info`。
- 危险动作白名单：默认 `readonly`；提交/扣款/删除/发信等需显式 `readwrite` 且页面在白名单内。
- 探索产出必须标注**来源层**（static / structural / visual），测试点矩阵据此标注证据强度——视觉层产出的测试点默认需人工确认。

#### 3.2.3 断言分级与结构化覆盖率门槛

`assert_level`（decide / observe）已存在，本方案只是把门槛钉死：

| 级别 | 允许的断言类型 | 用途 |
|---|---|---|
| `decide` | 仅规则断言：`url_*` / `visible` / `hidden` / `text_*` / `value_equals` / `attribute_equals` / `count_equals` / `status_code` / `json_path` / `db_row` / `schema_match` | 决定用例 verdict，**禁止 `semantic`** |
| `observe` | 上述 + `semantic`（视觉/语义断言，带置信度） | 只记录不判定；低置信进报告"待人工确认"区 |

**准入线（v2 新增，量化）：**

- 探索产出的用例，`decide` 级断言中**结构化断言占比 ≥ 70%**，否则该用例不进回归集，只进"人工复核队列"。
- `smoke` 档 100% 规则断言且 `semantic` 禁入（沿用 `regression/selector.py` 既有规则，不放宽）。
- 视觉断言的置信度**不作为自动判定依据**——原因：置信度与正确率不单调相关，无法可靠校准。它只用于排序人工复核优先级。

#### 3.2.4 自愈红线（不可放宽）

沿用 `exec/infra.py` 的分级，并明确"重新探索"的归属：

| 级别 | 内容 | 是否自动 | 是否入库 |
|---|---|---|---|
| L1 | 换指纹（按备选序列降级，`LocResolver` ≥2 指纹保证有备选） | 自动 | 记录并计入资产健康度，**不入库改写剧本** |
| L2 | 延长等待 / 追加等待条件 | 自动，**限一次** | 同上 |
| L3 | 跳过步骤、替换步骤、改变操作目标 —— **含"重新探索出一条新路径"** | **禁止自动** | 必须人工确认 |
| — | `decide` 断言失败 | **永不自愈** | 直接 fail，按缺陷流程处理 |

**v1 的 §5.4 正是在这里出错**：把"失败 → 重新探索 → 修复锚点 → 入库"写成自动链路。重新探索会重走一条操作路径，极可能改变业务语义（这就是 L3），且静默更新基准后，回归不再是"同输入、只有被测系统变了才失败"——通过率会很好看，漏 bug 会变多。

**v2 的替代方案：失败三分归因（见 §5.6）。**

#### 3.2.5 安全闸门：重心在环境层

先更正一处对既有资产的误读。v1 §3.2.4 写"复用 tool-gate 思路——敏感操作（删除/支付/不可逆操作）强制确认"，但 `scripts/tool-gate.mjs` 并不做这件事：它是 **action → 工具的依赖完整性闸门**（`requires` 硬依赖停用即拒、`enhances` 软依赖停用只降级、`when` 形态条件），文件头自己写着"工具状态是纪律增强，**不是安全边界**"。把敏感操作识别压在它身上，等于让一个不做安全的东西承担安全职责。

更根本的问题是：**computer-use 的动作语义在运行时才确定。** 绑定表是编译期静态映射（"这个 action 依赖哪几个校验工具"），而视觉 driver 产出的是"点击屏幕某处的元素"——同一个 `click` 既可能是"查看详情"也可能是"确认删除"。静态绑定无法预知；靠元素文本 / AX name 做高危白名单也极易绕过（"确定"按钮可能就是删库）。

因此分三层，**重心在最下层**：

| 层 | 措施 | 定位 |
|---|---|---|
| **环境层（主防线）** | 每条用例前数据快照可**一键回滚**；支付/短信/邮件走 **mock**；执行账号**无生产权限**；测试环境独立域名与独立数据源 | 把"不可逆"从根上消灭。**这是唯一真正有效的措施**——只要后果可回滚，误操作就只是成本问题，不是事故 |
| **动作层（辅助）** | 沿用 `explore/explorer.py` 的 `action_policy`（默认 `readonly`，提交类需显式 `readwrite` 且页面在白名单）+ `DANGEROUS_ACTIONS` 清单 | 拦住"明显不该做"的动作。**只对结构化 driver 可靠**（有控件语义）；视觉 driver 下仅供参考 |
| **工具层（原职责，与安全无关）** | `tool-gate.mjs` 保持现状：依赖完整性校验 + `central_tool_audit` / `tool-usage.jsonl` 留痕 | 保证"不该静默降级的校验没被静默降级"；**不承担敏感操作识别** |

---

### 3.3 协议层设计要点

- 平台内所有 agent（会话/任务/无人值守）作为 **MCP client**，工具经 `tools/list` 动态发现。
- **任务级工具子集装配**：授权过滤只解决"能不能用"，不解决"该不该出现在上下文里"。33 自有 + 25+ + 30+ ≈ 90 个工具进同一清单会显著拉低工具选择准确率。
  - **不新增 `tool_profile` 清单**——`agent/tasks.py` 的 `TASK_CONTRACTS.tools` 已经是权威白名单（精确到函数名，"调用即拒"），`tool-gate.mjs` 的 `CALLABLE_STAGE_TOOL_IDS` 也已是 10 个工具的子集。再造一份必然漂移，而这正是 `central-tools.ts` 注释里明确批评过的反模式（"这份映射只有一份，放在执行路径上。后台再抄一份必然会漂：改了代码忘了改后台……比不显示更糟"）。
  - 落地方式：MCP server 以 `TASK_CONTRACTS.tools` 为**唯一来源**，按当前任务的 `task` 键过滤 `tools/list` 返回集；自有工具的 MCP tool name 与契约里的函数名保持一致（`requirement.testability.check_testability` 这类点分名可直接作 MCP tool name）。
  - 适配器工具（playwright-mcp / mobile-mcp）不在 `TASK_CONTRACTS` 里，需为"探索类任务"补一份**适配器工具白名单**，同样只保一份、放在执行路径上。目标量级：每任务 **8-12 个**。
  - 超出白名单的工具不在 `tools/list` 返回（不是靠 prompt 约束 Agent 别用）。
- **工具描述是一等公民**：函数签名只解决"怎么调"，**不解决"该不该调"**。每个工具必须有描述写明：**何时用 / 前置条件 / 副作用 / 幂等性**。缺描述的条目不得进白名单。
- **两套 server，一个命名空间**：`central-tools.ts` 的 33 工具在 TS 侧用 `@modelcontextprotocol/sdk` **同进程**暴露（不要再包一层 HTTP 转给 Python）；`aitestharness_tools` 的 Python 工具用 FastMCP。传输：本机 stdio，多机/远程用 Streamable HTTP（绑定 127.0.0.1 + Origin 校验 + Bearer）。
- **工程铁律**：stdio 模式 stdout 被协议独占，日志一律走 stderr。
- 鉴权与审计沿用既有三张表：`central_tool_agents`（工具 ↔ agent 授权，每工具已带 `agents: string[]`）、`central_tool_categories`、`central_tool_audit`（变更审计）。注意：这里解决的是**能不能用**，与 §3.3 的"该不该出现"是两件事。

### 3.4 成本模型（v2 新增）

必须先把账算清，否则"重放不烧模型"与"视觉兜底"的矛盾会在二期上线时被账单打脸。

**分层原则：探索用模型，固化层产出结构化锚点，重放层零模型。**

| 阶段 | VLM 调用量（量级估算） | 说明 |
|---|---|---|
| 探索-静态层（①） | **0 次** | `extract_routes` / `detect_stack` 是纯解析，inspect 50 页也零模型 |
| 探索-结构层（②） | **0-极低** | DOM/a11y 遍历是解析，不调 VLM |
| 探索-视觉层（③，仅兜底页面） | `probe_pages(10) × actions_per_page(5)` ≈ **50 次/次探索**（硬上限） | 有 `BudgetGuard` 卡住，且只在①②拿不到的页面触发，实际远低于上限 |
| 固化 | 与探索同批（不额外增加） | 探索过程中同步记录结构化锚点（selector/a11y id/接口断言/DB 快照） |
| **回归（零模型重放）** | **0 次** | 剧本运行 driver 只做确定性重放 |
| 若误走"视觉兜底重放" | 单条用例 ~20 步 × 1-2 次 = **20-40 次**；30 条用例/次 = **600-1200 次**；每日一次 = **每月 1.8 万-3.6 万次** | 这就是 R6 必须消除的路径：成本随回归频次线性上升，且与"无人值守每日回归"直接冲突 |

**判据：重放阶段出现任何 VLM 调用，都视为质量缺陷（剧本没固化到位），计入剧本健康度。** 视觉兜底只允许存在于 `observe` 级断言，且只记录不判定。

### 3.5 computer-use 的引入边界与取原料层（v2.3 新增）

> 本节回答一个被 v1/v2 含糊过去的问题：**computer-use 到底在流程的哪一步出现？建档探索要不要用它？**
> 结论：**建档探索的默认路径完全不用 computer-use；它是第③层兜底与执行期首轮固化才用的手段。**
> 同时本节补一个此前完全没被识别出来的空白：**取原料层当前是空的。**

#### 3.5.1 先分清两个正交维度

v1 §5.3 把 computer-use 画成 MCP 适配器的上游，是因为把两件不同的事当成了同一个东西。

| | computer-use | MCP |
|---|---|---|
| 本质 | 一种**定位/决策方式**：截图 → 视觉理解 → 决定操作哪个像素/元素 | 一种**调用协议**：工具怎么被发现、传参、回结果 |
| 解决 | 页面结构拿不到时，怎么还能操作 | 能力怎么被 agent 用起来 |
| 可否省掉 | 可（结构化定位覆盖绝大多数场景） | 可（进程内直调也能跑） |
| 位置 | **只在兜底层** | **纵向贯通**，每层都能暴露 |

四象限里只有一格不成立：

|  | 结构化定位（DOM/a11y/接口） | 视觉定位（截图+VLM） |
|---|---|---|
| **进程内直调** | 已具备：`explorer.py` / `snapshot.py` 纯函数 | 自闭环：Midscene 自己持有 page |
| **经 MCP 暴露** | 目标形态：包成 `explore.*` 工具 | **不成立**：坐标系装不进协议 |

**为什么"视觉 + MCP"不成立**：MCP 的入参是 JSON，而视觉定位依赖"当前屏幕长什么样"这个隐含上下文。协议里没有"屏幕状态"这个概念，每次调用都要重新截图重传，等于把状态机打碎在协议边界上。**这就是 v1 那条链跑不起来的根本原因**——不是画错了图，是这条路本身不通。

因此：**"引入 MCP" ≠ "引入 computer-use"。** MCP 化不改变任何一层的技术实现，它只改变能力的暴露方式。

#### 3.5.2 取原料层是当前空白（不是选型问题）

核对代码，这是本节最需要先钉死的事实：

- `aitestharness-tools` 全包外部依赖**只有 `requests`**（`exec/api_engine.py` 用），**没有任何浏览器/设备驱动依赖**；
- `exec/snapshot.py` 开头写"Playwright 只负责取原料"，但 **Playwright 从未接入**，`build_snapshot` 至今只被单测调用过；
- `exec/native_mini.py` 开头明写"运行时依赖 Playwright/Appium，**M2 建**"。

也就是说：**不管用不用 computer-use，"把页面变成原料"这件事都还没开始做。** 这是 M2a 的真实工作量主体，不是"接个库"。

#### 3.5.3 Probe 适配器：全仓唯一碰浏览器的地方

延续 `snapshot.py` 已确立的分工（取原料 / 判定分离），把取原料收敛成**一个接口、一份实现**：

```python
# probe/base.py —— 全仓唯一允许出现 Playwright/Appium/ADB 的模块
class WebProbe(Protocol):
    def fetch_bundle(self, url: str) -> str: ...           # ① 取 JS 原文（也可纯 HTTP）
    def flat_dom(self, url: str) -> dict: ...              # ② 拉扁平元素列表（含 frame/shadow 路径）
    def screenshot(self, url: str) -> bytes: ...           # ③ 只给兜底层用
    def act(self, target: dict, action: str) -> dict: ...   # 执行：按结构化 target 动作

class PlaywrightProbe:      # M2a 交付
class AppiumProbe:          # M3
class MiniProgramProbe:     # M5
```

**关键：①②③ 共用同一个 browser/page 实例**，只是调用 API 不同（`page.evaluate` 拿数据 / `page.screenshot` 拿图）。所以不存在 v1 担心的"两套引擎启动冲突"——只有一个 driver，三种取法。

第③层尤其要说清：**不是另起一个浏览器，而是把 `PlaywrightProbe` 已持有的 page 交给 Midscene 接管**（`agentFromPage(page)` 之类的入口）。这与 §4.4"Midscene + playwright-mcp 不可共存"并不矛盾——不可共存的是**两个独立持有者争抢同一实例**；"接管已有实例"只有一个持有者。

判定层一律不 import probe，保持纯函数可单测。这条是 `snapshot.py` 已经写下的原则，此处只是把它抬成架构约束。

#### 3.5.4 三层的取原料手段（对应 §5.3）

| 层 | 取什么 | 手段 | LLM | computer-use | 产出可信度 |
|---|---|---|---|---|---|
| ① 静态解析 | JS bundle / 路由表 / 接口文档 | `fetch_bundle`（HTTP GET 即可，不必开浏览器）→ `extract_routes` / `detect_stack` | 0 | **否** | 高（原文提取） |
| ② 结构巡检 | 扁平 DOM / a11y 树 | `flat_dom`（`page.evaluate`）→ `build_snapshot` / `extract_controls` | 0 | **否** | 高（确定性可单测） |
| ③ 视觉探索 | 截图 | `screenshot` → VLM 定位 → `act` | 每步 1 次 | **是（唯一落点）** | 低（不可复现） |

**探索产出必须带 `source` 标记**（`static` / `dom` / `visual`），随页面写入 maps。三个用处：maps 里能看出哪些页是"猜出来的"；§10 的"结构化断言占比 ≥70%"可直接用它计算；回归失败时优先怀疑 `source=visual` 的用例。

#### 3.5.5 computer-use 的三个落点与一条硬约束

| 落点 | 场景 | 批次 |
|---|---|---|
| ① 建档第③层 | canvas 渲染、纯图片按钮、地图/图表、DOM 被混淆的第三方 SDK——**这些页 DOM 里没有语义**，结构化定位无从下手 | M2b / M3 |
| ② 执行首轮固化 | 用例只写"点击提交订单"，不知道是哪个元素：视觉走一遍，**记下实际点的元素，再反查其稳定指纹** | M3 |
| ③ 人工接管 / 有头演示 | `exec/debug.py` 的 headed 模式已预留接口，与"单步调试"是同一套能力 | M4 |

**硬约束：computer-use 的产出必须当场降级为结构化锚点**（selector / testid / a11y role / 接口断言），**不得直接进剧本**。

理由：坐标是"这一版像素的位置"，UI 改版即失效；而 §5.5 的三分归因里，"定位漂移"是**可自修**的，"坐标漂移"是不可修的——它会让剧本每轮都废，且归因不出来。这条约束不写死，computer-use 就会把可维护性吃光。

#### 3.5.6 MCP 在这里的角色：保默认路径，接异常路径

一个反直觉但关键的判断：**建档探索不需要 agent 驱动，应当跑确定性流水线。**

`explore` 的本质是"取一次原料 + 跑几个纯函数"，没有需要判断的岔路。让 agent 拿着工具"自己探索"，会把 10 秒的事做成十几分钟——这正是 R2 要消除的病灶。

MCP 化探索的真正价值不是"让 agent 探索"，而是**让 agent 接管局部失败**：

```
默认：explore/pipeline.py 直跑（零 LLM，确定性）
  → 某页 ① 拿不到路由 → 自动降级 ②（记录 source=dom）
  → 某页 ② 仍失败     → 抛 PartialFailure（带页面/原因/已试手段）
  → 只有此时才起 agent，装 explore.visual_probe 工具补这一页
  → 补完仍失败 → 标 source=unresolved，交人工圈选，不猜
```

这样既保住成本与确定性（默认路径零模型），又保住覆盖率（异常路径有出口），且**失败是显式的**——不会出现"探索跑完了，但一半页面其实是空的"。

---

## 四、选型清单

### 4.1 现成 MCP server（拿来即用）

| 工具 | 覆盖 | 定位 | 备注 |
|---|---|---|---|
| **microsoft/playwright-mcp** | Web | **结构化 driver**（非"适配器"） | 微软官方；a11y 树驱动，无需视觉模型；Docker/HTTP 常驻 |
| **mobile-next/mobile-mcp** | Android + iOS 真机/模拟器 | **结构化 driver** | 手机 MCP 事实标准；30+ 工具；a11y 优先 |
| Maestro | App 回归 | **剧本运行 driver 参考实现** | 稳定可重复，无 AI 自主性；作固化层范本 |
| MCP Inspector | 调试 | 全量工具验证 | `npx @modelcontextprotocol/inspector` |

### 4.2 视觉 / computer-use 引擎（driver 实现之一）

| 引擎 | 覆盖 | 期次 | 说明 |
|---|---|---|---|
| **Midscene.js** | Web + Android（ADB） | 一期 | 自然语言驱动、视觉断言；**自闭环，装配它就不接 playwright-mcp** |
| UI-TARS | 任意 GUI（可自部署） | 二期 | 桌面客户端；**硬件成本需单独评估**（7B/72B + GPU），v1 未提 |
| Anthropic computer use | 任意 GUI | 备选 | 海外 API，合规/稳定性存疑 |

### 4.3 自建封装

| 项 | 选型 |
|---|---|
| 33 自有工具 MCP 化 | **TS 侧用 `@modelcontextprotocol/sdk`**（工具就在 server 进程内，同进程暴露，不要再包一层 HTTP 转给 Python）；逐工具补副作用/幂等性描述 |
| `aitestharness_tools` 的 Python 工具 | **FastMCP**（装饰器 + docstring）。两套 server 用统一命名空间，避免同名工具 |
| 小程序 driver | 官方 `miniprogram-automator` 自包（无现成可用方案） |
| MCP client | platform Node 服务用 `@modelcontextprotocol/sdk` |
| 任务级工具子集装配 | 以 `TASK_CONTRACTS.tools` 为唯一来源，MCP server 侧按任务过滤 `tools/list`（**不新增清单**，见 §3.3） |

### 4.4 选型冲突矩阵（v2 新增，回答"谁能和谁共存"）

| 组合 | 可否共存 | 原因 |
|---|---|---|
| Midscene（视觉）+ playwright-mcp | **否** | 争夺同一浏览器实例；锚点体系不可互换（R1） |
| Midscene **接管** `PlaywrightProbe` 已持有的 page | **是** | 只有一个持有者，Midscene 只是换一种取法（§3.5.3）；这是第③层的推荐形态 |
| Midscene（视觉）+ mobile-mcp | **否** | 同上，争夺同一 ADB 设备 |
| playwright-mcp + 剧本运行 driver | **是**（不同阶段） | 探索期用前者产锚点，回归期用后者重放；不并发 |
| 视觉 driver + 结构化 driver | **仅限同一用例拆段** | 必须遵守 hybrid 四约束：≤2 段、切走不回、`context_flow` 显式 |
| mobile-mcp + 小程序 driver | **是** | 目标不同（原生 App vs 开发者工具），资源池不同 |

---

## 五、实现后的效果与核心流程

### 5.0 两层流程总览（v2.2 修正）

> **v2 / v2.1 的表述错误**：把流程写成了一条直线「建档 → 探索 → 测试点 → 用例 → 执行 → 缺陷 → 报告」。
> 实际是两层：**建档/探索是项目层的一次性资产建设**，**需求分析→报告是任务层每次按需求重走的流程**。两者不是上下游，是"资产"与"使用者"的关系。
> 代码里已经写死了这个分层——`plan/phases.py` 的九阶段：`onboard`/`explore` 产出 `maps`，`requirement` 起才是任务，且 `plan` 阶段 `requires: ["cases","maps"]`，两层在这里咬合。

**项目层（建一次，长期复用，按 env 分片）**

```
项目 project
  ├─ 环境 project_environments（可多 env：test / staging …，键为 (project_id, env)）
  │    └─ 建档 onboard（零 LLM，10s 级，runtime_cli onboard.bootstrap）
  │         → 项目地图 maps/<env>/（页面 pages[].registered / 接口 apis / 接口模块）
  │         → 摘要写回本表；登录形态 login_captcha；失败只写 failed + last_error
  ├─ 探索 explore（三层递进，见 §5.3）→ 地图增量 + 环境知识
  │    └─ qa_environment_knowledge（module / flow / wall / interface 四层，带 round 与 source_session_id）
  ├─ 规则 qa_knowledge_candidates（候选）→ 人工确认 → qa_project_rules（版本化、可退役）
  └─ 资料 qa_documents（项目级：需求、接口文档；任务启动时被 pin 快照引用）
```

**任务层（每次按任务需求新建，一轮一结论）**

```
测试任务（UI 路由 /qa/project/tasks/:sessionId；代码里 = session 及其下 runs）
  → 启动时 pin 上下文：qa_task_context_snapshots{documents, rules, capabilities}
  → ① 需求分析 requirement：输入只能是条款，每条挂原文位置，无位置即丢弃（confirm）
  → ② 测试点分析 testpoint：矩阵由程序算、agent 只补空格子，必须完成验证方式分配（confirm）
  → ③ 用例设计 case：断言必须回指测试点，过条数预算与枚举对账（confirm）
  → ④ 计划固化 plan：requires cases + maps，五道闸全过才入库（闸 5 编译期恒 pending）
  → ⑤ 执行 execute：run 为单位，重放零 LLM；缺计划应拒绝执行而非让 agent 现编
  → ⑥ 缺陷分析 defect：取证包由程序组装，偶发要上报、不许自动改脚本
  → ⑦ 报告 report：数字只读，洞察可空，必须能回答回归三问
  → 回流（两层唯一写回通道）：漏测 → qa_exploration_hypotheses；经验 → qa_knowledge_candidates
```

**两层咬合点**：项目地图是任务层 `plan` 阶段的**必需前置**（`requires: ["cases","maps"]`）。地图不新鲜 → 用例建在错误假设上 → 回归全绿也无意义。这是 §十 里 G8/G9 两条缺口的分量所在。

| §5 小节 | 层 | 触发频率 | 说明 |
|---|---|---|---|
| 5.2 流程 A 建档 | 项目层 | 建项目时一次；换环境/换地址重跑 | 零 LLM，产物 `maps/<env>/` |
| 5.3 流程 B 探索 | 项目层 | 按需（新模块、地图过期） | 三层递进，有硬预算 |
| 5.4 流程 C 任务主线（v2.2 补齐） | 任务层 | 每次任务 | ①–④ 段；契约以 `plan/phases.py` 为准，本方案只写接入点 |
| 5.5 流程 D 固化与回归 | 任务层 | 每次任务 | ⑤ 段的前半：用例 → 剧本 |
| 5.6 流程 E 失败归因 | 任务层 | 失败时 | ⑤ 段的后半：三分归因 |
| 5.7 流程 F 工具链路 | 跨层 | 常驻 | MCP + 子集装配 |
| 5.8 流程 G 结果闭环与回流 | 任务层 → 项目层 | 每次任务末 | ⑥⑦ 段 + 回流 |
| 5.9 能力清单 | — | — | — |

### 5.1 端到端效果（用户视角）

> 用户**建项目**后先完成建档与探索，得到项目地图；之后**每次有任务需求就新建一个测试任务**，平台按七段推进：条款化 → 测试点矩阵 → 生成用例 → 计划固化 → 真实走一遍（静态解析为主、视觉兜底）→ 固化为零模型可重放剧本 → 产出证据链报告；失败项先三分归因，只有"定位漂移"才提请修复，缺陷自动去重提单。任务结论回流到项目知识，下次任务起点更高。全程用户只看结果与审批。

### 5.2 流程 A：项目建档（项目层，不变）

```
用户创建项目 → onboard.bootstrap（零 LLM）
  → knowledge/maps 建档地图（知识包形态）
  → 生成项目档案（模块/接口/环境信息）
  → irval 校验档案 → 入库
```

### 5.3 流程 B：智能探索（项目层，三层递进，v2.3 按"取原料/判定分离"重写）

```
用户圈定被测模块 → 平台跑探索流水线（默认不启 agent，见 §3.5.6）
  → ① 静态解析（零 LLM，必跑）
       probe.fetch_bundle → extract_routes + detect_stack + 接口文档
       → 页面清单 + 控件清单（秒级，零 token）
  → ② 结构巡检（零 LLM，仅补①覆盖不到的页面）
       probe.flat_dom → build_snapshot + extract_controls
       → 控件树 + 多指纹 + frame/shadow 路径标注
  → ③ 视觉探索（唯一使用 computer-use 的一层，仅②仍失败时）
       触发条件：canvas 渲染 / 纯图片按钮 / 地图图表 / DOM 被混淆的第三方 SDK
       driver = Midscene（自闭环，与①②共用同一 page 实例）
       每动作经 action_policy 闸（默认只读）+ BudgetGuard 硬预算
       产出必须当场降级为结构化锚点，禁止直接进剧本（§3.5.5 硬约束）
  → 每页落 source 标记：static / dom / visual / unresolved
  → 产出：maps（页面+控件+接口+source）、截图证据、测试点草稿
  → 测试点进矩阵，人工确认后进入用例固化

异常路径（仅此处才启 agent）：
  ①② 均失败 → 抛 PartialFailure（带页面/原因/已试手段）
    → agent 装配 explore.visual_probe 补这一页
    → 仍失败 → source=unresolved，交人工圈选，不猜
```

### 5.4 流程 C：测试任务主线（任务层，v2.2 补齐）

> 这一段 v2/v2.1 整段漏了，而这正是用户设计的主干。骨架已经在 `plan/phases.py`（`PHASES` / `check_prereq` / `PhaseState` / `invalidate`），本方案**不重新定义**，只写它与执行层的接线处。

```
新建测试任务（= session，pin 上下文快照）
  → ① 需求分析 requirement
       输入：qa_documents 的条款（项目级资料，任务 pin 时冻结 documents_json）
       产出：requirements{lineage, items}；每条必须挂原文位置，无位置即丢弃
       卡点：confirm=True（人审需求理解，防止"需求理解错"污染下游）
  → ② 测试点分析 testpoint
       输入：requirements（check_prereq 硬校验，缺则拒绝执行，不给 LLM 编造机会）
       产出：testpoints{lineage, items, matrix}；矩阵由程序算，agent 只补空格子；必须完成验证方式分配
       卡点：confirm=True
  → ③ 用例设计 case
       输入：testpoints；产出：cases{lineage, items}；断言必须回指测试点
       卡点：confirm=True
  → ④ 计划固化 plan
       输入：cases + maps（**跨层依赖在此**）；产出：plans{lineage, steps, gates, touched}
       五道闸全过才入库；闸 5 编译期恒 pending
       卡点：无（自动），但闸门失败即拒绝入库
  → ⑤ 执行 execute（见 §5.5 / §5.6）
```

三条既有铁律，落地时不得绕过：

1. **不许合并阶段**（`phases.py` 文件头"模式 B"）：需求/测试点/用例一次出、只审一次，会让人审无法分头定位问题。
2. **不许跳步**：`check_prereq(strict=True)` 连"空壳产物"都算缺（实测坑：空 `plans` 目录被当成已有计划，跑出 0 步还标 pass）。
3. **上游变更 → 下游 stale**：`invalidate` 保留产物只标失效，不删。

**已知缺口（详见 §10.2 G7）**：任务的"范围"是**事后由产物体现**的，事前没有声明——同一条款被两个任务各跑一遍，系统无法察觉。当前 `qa_task_context_snapshots` 只 pin 了 documents/rules/capabilities，没有"本次任务纳入哪些条款/模块"。

### 5.5 流程 D：用例固化与回归（任务层，改造）

```
用例（IR 表达）
  → 固化为操作剧本：NL 步骤 + 结构化锚点（≥2 指纹）+ decide 级断言
  → 固化质量校验（准入线）：
       · decide 中断言结构化占比 ≥70%
       · 剧本不含视觉坐标作为唯一锚点
       · 重放时不得产生 VLM 调用
  → 通关 → 剧本入库（script_id 挂回 IR，见 §6.4）
  → 被测模块变更 → 影响面圈定相关剧本 → 一键回归
  → 回归执行：剧本运行 driver 确定性重放（零模型）
  → 结论：pass / fail / flaky / inconclusive（flaky 与 inconclusive 分开，不混为 fail）
  → fail → 进入流程 E（三分归因，§5.6）
```

### 5.6 流程 E：失败归因与修复（任务层，v2 新增，红线所在）

```
剧本失败
  → 三分归因（确定性规则优先，不靠模型猜）
      ① 环境问题  → inconclusive（env_unreachable / resource_timeout / session_failed …）
                     不记缺陷，不修剧本，触发环境重试
      ② 定位漂移  → 进入 L1/L2 自愈：换指纹 / 延长等待（各限次）
                     自愈成功 → 记录健康度，**不改入库剧本**
                     自愈失败 → L3 候选，转人工
      ③ 真实缺陷  → fail，进缺陷归因/去重/提单流程（断言失败永不自愈）
  → 若判定需要"重新探索"（L3）：
       生成 diff 报告：「原路径 / 新路径 / 断言变化 / 影响用例」
       → 人工确认 → 才允许更新剧本入库
       → 人工拒绝 → 保持原剧本，用例标 quarantined 或转人工排查
```

### 5.7 流程 F：工具调用链路（跨层，MCP + 子集装配）

```
平台 agent（会话/任务/无人值守）
  → dispatch 按 task 键取 TASK_CONTRACTS.tools（既有白名单，调用即拒）
  → MCP client（tools/list，已按白名单 + 授权双重过滤，仅 8-12 个）
  → MCP server（TS 侧 33 工具 | Python FastMCP | playwright-mcp | mobile-mcp | 小程序 driver）
  → tool-gate.mjs：依赖完整性校验（硬依赖停用即拒 / 软依赖降级须写明）
     + central_tool_audit / tool-usage.jsonl 留痕
     （敏感操作防线不在这里，在环境层可回滚，见 §3.2.5）
  → 执行 → 结果/证据回传
```

### 5.8 流程 G：结果闭环与回流（任务层 → 项目层）

```
执行完成 → 证据留存（截图/录像/接口记录）→ 缺陷分析 → 报告生成 → 用户审批
  → 失败项 → 缺陷归因（错误记录聚类）→ 去重 → 提单
  → 回归计划 → 持续跟进
  → 【回流，两层唯一的写回通道】
       · 漏测/未知风险 → qa_exploration_hypotheses（statement / why_unknown / expectation）
       · 业务经验/约束 → qa_knowledge_candidates → 人工确认 → qa_project_rules（版本化）
       · 地图增量      → qa_environment_knowledge（round+1，带 source_session_id 可回溯）
```

> **为什么回流要单列**：没有回流，每个任务都从零开始读文档、猜业务，项目层资产只进不出；有了回流，第二个任务的起点才是第一个任务的终点。当前**只有"规则"这一条通道是通的**，漏测回流与地图增量尚未接线（§10.2 G4、§10.2 G9）。

### 5.9 实现后的能力清单

| 角色 | 能力 |
|---|---|
| 普通用户 | 建档、条款输入、探索发起、用例确认、回归触发、报告审批、缺陷确认 |
| Agent | 三层探索（静态优先）、剧本重放、L1/L2 自愈、证据链留存 |
| 管理员 | 渠道管理（模型/引擎配置）、MCP 工具与白名单管理（授权/审计）、机器与设备容量管理 |
| 平台 | 探索→固化→零模型回归闭环，skill 知识包沉淀，全链路 irval 契约校验 |

---

## 六、改造清单与批次重排（供 Codex 执行）

### 6.1 原五批次处置

| 原批次 | 处置 |
|---|---|
| 批次 1 统一工具执行通道 | **已完成部分保留**；收尾项并入 M1（验证码 OCR 路线作废） |
| 批次 2 项目建档切片 | **继续**（不变） |
| 批次 3 稳定执行切片 | **暂停改向**：Playwright 采集降级为结构化 driver 接入项；Web 登录/脚本转时并入 M2a/M5 |
| 批次 4 业务入口接全链 | **继续**（不变） |
| 批次 5 结果闭环 | **继续**（不变） |

### 6.2 M0 前置核实（已核结论 + 剩余待办）

**已核实（2026-11-18，可直接作为 M1 输入）：**

| 项 | 核实结果 |
|---|---|
| 33 工具落点 | `platform/packages/server/src/http/central-tools.ts`（729 行），`grep -c 'name: "'` = **33**，与 v1 的"33 工具"一致 |
| 存储形态 | SQLite 表 `central_tools(id,name,display_name,summary,description,category_id,permissions,parameters,returns,version,revision,enabled,builtin,created_at,updated_at)`；变更审计表 `central_tool_audit` |
| 部署形态 | **不是独立进程**，是 platform server 的 HTTP 路由模块（`/admin/...`）。因此 M1 不是"新建 Python 服务搬 33 个函数"，而是"给已有台账加一个 MCP 出口"——工作量比 v1 估计的小 |
| tool-gate 落点与职责 | 引擎侧 `scripts/tool-gate.mjs`（13KB）。职责是 action → 工具依赖闸门（`requires`/`enhances`/`when`）+ 调用流水（`output/runtime/tool-usage.jsonl`）+ 状态读取（`config/tool-runtime-state.json`）。**明确声明"不是安全边界"** |
| 状态同步链路 | `central-tools.ts: syncRuntimeState()` 在启停时写 `tool-runtime-state.json`，`tool-gate.mjs` 执行前读。文件缺失 = 全部启用（刻意设计，避免可用性押在一次写盘上） |
| 白名单机制 | `agent/tasks.py: TASK_CONTRACTS.tools`（每任务精确到函数名）+ `tool-gate.mjs: CALLABLE_STAGE_TOOL_IDS`（10 个）。MCP 子集装配直接复用，不新建 |

**剩余待办（M1 开工前完成）：**

| 项 | 产出 |
|---|---|
| 33 工具的副作用与幂等性 | 逐条标注"只读 / 有副作用 / 幂等 / 非幂等"，落 `tool-inventory.md`。MCP 工具描述必填此项（§3.3） |
| `exec/*` 与 central-tools 的边界 | 明确哪些工具是"包装了 `aitestharness_tools` 的薄壳"，避免 M1 后同一能力出现两份 MCP 工具 |
| MCP 化取舍 | 标记"不适合暴露为 MCP tool"的条目（纯内部函数、仅后台使用的管理类操作）及原因 |
| 适配器工具白名单 | playwright-mcp / mobile-mcp 的工具子集（8-12 个/任务），补进执行路径唯一清单 |

验收：`tool-inventory.md` 落仓库，33 条逐条与代码对齐，副作用列无空缺；MCP 化取舍有明确结论。

### 6.3 新增批次（v2 重排）

| 批次 | 目标 | 文件面/要点 | 验收（量化） | 依赖 | 回滚 |
|---|---|---|---|---|---|
| **M0 前置核实** | 见 §6.2 | 只读盘查 + 清单文档 | 33 工具全部对齐代码，边界清晰 | — | 无风险（只读） |
| **M1 工具协议 MCP 化** | 给既有台账加 MCP 出口（**不是把 33 个函数搬去新服务**）；子集装配复用 `TASK_CONTRACTS.tools`；tool-gate 职责不动 | ① TS 侧：`@modelcontextprotocol/sdk` 在 server 进程内暴露 33 工具（同进程复用，零 HTTP 包装）② Python 侧：`aitestharness_tools` 的工具用 FastMCP ③ 两套 tool name 命名空间统一 | ① Inspector 调用全部工具通过 ② 每个任务可见工具数 ≤12 ③ 现有授权/审计/`syncRuntimeState` 不回归 ④ 硬依赖停用仍能拦住对应 action | M0 | 保留原 HTTP 调用通道开关，可切回 |
| **M1.5 任务/run 实体（v2.2 新增）** | 补 `qa_tasks` / `qa_runs`，把 env 与 `sut_version` 贯通到 run 与 plan | ① 两张新表 + 迁移（现有 session 回填为 task，`session_id` 降为执行载体）② `qa_runs.env` / `sut_version` / `parent_run_id` ③ 报告头带 env 与版本 ④ `qa_tasks.scope_json`（documents / modules / clauses） | ① 一个任务多 run 可查、可比较 ② 同一项目两环境结果可区分 ③ 报告能回答"哪个环境、哪个版本" ④ 76 张既有表无破坏性变更 | M0 | 新表可独立回滚；不改既有表主键 |
| **M2a Web 探索主路径（v2.3 拆分，不依赖 computer-use）** | `probe/base.py` 接口 + `PlaywrightProbe`；①静态解析 + ②结构巡检打通；`explore/pipeline.py` 编排 + `source` 标记 | 复用 `explore/explorer.py` + `exec/snapshot.py`（判定层不动）；取原料层为全新增量（§3.5.2） | ①静态解析产出路由/控件清单 ≤10s、0 token ②对同一 Web 项目完成"探索→maps→测试点草稿" ③每页均有 `source` 标记 ④判定层单测零浏览器依赖 | M1 | `PlaywrightProbe` 可替换为纯 HTTP 实现；不影响判定层 |
| **M2b 视觉兜底接 computer-use（v2.3 新增）** | ③ 视觉探索接入 Midscene；`screenshot`/降级为结构化锚点 | `MiniProgramProbe` 之外的第三取法；`BudgetGuard` 硬预算 | ①对 canvas/图片按钮类页面可补出可用锚点 ②补出的锚点**全部为结构化形式**（无坐标进剧本）③视觉调用 ≤ 硬预算 | M2a | 关闭后 M2a 主路径不受影响 |
| **M2.5 最小剧本回归验证（v2 新增，卡点）** | 手写 3 条剧本，证明"零模型重放能稳定通过" | `operation_script` 最小形态 + 剧本运行 driver；**每次 run 写 `qa_runs` 并落环境基线（G1）** | **3 条剧本连跑 5 次全过**，且重放阶段 VLM 调用数 = 0；5 条 run 记录均可查、可对比 | M2a + M1.5 | 剧本可删，不影响主链 |
| **M3 App 探索接入** | mobile-mcp + Android 模拟器；设备容量受四池约束 | 机器/设备挂载 + mobile-mcp 常驻 | ①模拟器上完成探索全流程 ②单设备串行可稳定重复 ③并发不超过 §11.7 池容量 | M2 | 断开设备即回滚 |
| **M4 操作剧本（固化）** | 剧本重放运行器；固化质量准入线；失败三分归因 | 复用 `hybrid` 约束 + `heal_level`；`operation_script` **作附件制品**（§6.4） | ①剧本可入库/可重放 ②结构化断言占比 ≥70% 准入生效 ③三分归因可演示 ④L3 必须人工确认才更新 | M2.5 | 剧本与 IR 解耦，删制品不影响 IR |
| **M5 小程序 driver** | `miniprogram-automator` 自包（作为 driver，不是 MCP 适配器嵌套） | 新增 driver 实现 | 微信开发者工具中完成一条用例执行 | M4 | driver 开关关闭 |
| **M6 skill 瘦身** | 三类分离：退役/迁移/保留 | 每类出清单；编排类知识逐条迁入剧本/检查单 | ①保留-迁移-退役清单逐条对应 ②探索装配改为消费知识包 ③「结果未知不重放」纪律保留 | M4 | git 可回溯，不物理删除 |
| **M7 桌面客户端（二期）** | UI-TARS 自部署接入 | driver 抽象层加实现 + **GPU 硬件评估** | 桌面程序探索演示 | M4 + 硬件 | driver 开关关闭 |

> 冲突边界：M0/M1 与批次 2/4/5 文件面零交集；M2a-M4 涉及 `explore/`、`exec/`、新增 `probe/`，需与批次 3 的暂停确认同步；u2/u3 表结构在 M4 落定时一并收敛（参考 `db-table-audit-20261116.md` B 档）。

### 6.4 IR 变更策略：`operation_script` 不侵入 schema

`aitestharness-ir` 已有 114 个用例通过，是硬资产。**降低契约变更半径**：

- IR 计划里**只新增一个引用字段**：`script_id`（软引用，缺失时回落到原有步骤执行）；
- 剧本本体作为**独立附件制品**存储（含 NL 步骤、锚点、断言、录制元信息、版本）；
- 断言仍用既有 `assert_type` / `assert_level` 表达，**不新增枚举**；
- irval 只补"`script_id` 存在时校验引用完整性"，不校验剧本内部结构；
- 剧本版本与 IR 版本解耦：剧本可独立演进，IR 只认 id。

### 6.5 与 v1 批次编号对照

| v2 | v1 | 变化 |
|---|---|---|
| M0 | — | 新增前置核实 |
| M1 | M1 | 改为"给台账加 MCP 出口"（非新建服务）；复用 `TASK_CONTRACTS.tools` 做子集；tool-gate 职责更正为依赖闸门、不降级 |
| M1.5 | — | v2.2 新增：任务/run 实体（G7/G2/G8），M2.5 的前置载体 |
| M2a | M2 | v2.3 拆分：三层递进 + 取原料适配器（`probe/`），**不依赖 computer-use 即可交付** |
| M2b | M2 的③部分 | v2.3 新增：视觉兜底单独成批，脱离一期关键路径（§3.5） |
| M2.5 | — | 新增最小剧本卡点 |
| M3 | M3 | 设备容量受四池约束 |
| M4 | M4 | 增加准入线、三分归因、L3 人工确认 |
| M5 | M5 | 表述改为 driver（非适配器嵌套） |
| M6 | M6 | 改为三类分离 |
| M7 | M7 | 增加硬件评估 |

---

## 七、风险与对策（v2 重写）

| 风险 | v1 对策 | v2 对策（修正后） |
|---|---|---|
| computer-use 误操作（不可逆） | tool-gate 敏感操作确认 + 高危白名单 | **主防线移到环境层**：数据快照可回滚 + 支付 mock + 无生产权限；动作层沿用只读默认。注意：tool-gate 是依赖完整性闸门、不是敏感操作闸门，不能承担此责（§3.2.5） |
| 锚点漂移（UI 改版后剧本失效） | 失败自动重新探索修复并入库 | **改为**：L1/L2 自愈（换指纹/延等待）自动但不改剧本；L3 重新探索必须出 diff 报告经人工确认（§5.6）。理由：静默更新基准会让"该失败的变成通过" |
| 模型成本（逐步视觉推理） | 回归以剧本重放为主（不烧模型） | **矛盾已消除**：明确重放层零模型；给出成本算式与判据（重放出现 VLM 调用即质量缺陷）（§3.4） |
| MCP 安全 | stdio 日志走 stderr；HTTP 绑 127.0.0.1 + Origin + Bearer | 保留，另补：**工具数量爆炸**——以 `TASK_CONTRACTS.tools` 为唯一来源做子集装配（8-12/任务）+ 工具描述必填副作用与幂等性（§3.3） |
| 真机/模拟器环境维护 | 设备矩阵作为机器扩展 | 设备容量仍受 §11.7 四池约束（设备 1~2、小程序 1~2），一期不做真机池；矩阵只解决"挂载与切换"，不解决"并发扩容"（§2.3） |
| 引擎升级 breaking change | 引擎/适配器走 MCP 抽象层 | 修正：走 **driver 抽象**（不是 MCP 适配层嵌套）；换引擎只改 driver 实现（§3.2.1） |
| **探索成本失控（v2 新增）** | — | 三层递进 + `BudgetGuard` 硬预算（超限拒绝而非建议）+ 视觉层仅兜底（§3.2.2） |
| **回归失去可比性（v2 新增）** | — | 三分归因 + 断言失败永不自愈 + L3 人工确认 + `inconclusive` 与 `fail` 严格分开（§5.6） |
| **UI-TARS 硬件成本（v2 新增）** | — | 二期启动前单独出 GPU/显存评估，不默认可部署（M7） |

---

## 八、里程碑（量化判据）

| 期次 | 范围 | 交付判据（演示 → 量化） |
|---|---|---|
| **一期（1-2 周）** | M0 + M1 + M1.5 + M2a + M2.5 + M3（**M2b 视觉兜底不在期内**） | ① `tool-inventory.md` 33 条与代码对齐、副作用无空缺 ② 静态解析 ≤10s / 0 token 产出页面清单 ③ 一个 Web 项目完成「建档→探索→测试点→用例→证据报告」 ④ **3 条剧本连跑 5 次全过且零 VLM 调用** ⑤ 一个 App 完成探索全流程 ⑥ 每任务可见工具 ≤12 ⑦ **`qa_tasks` / `qa_runs` 落库：一个任务多 run 可查，run 带 env 与 `sut_version`**（§10.2 G2/G7/G8） ⑧ 探索产出的每页均带 `source` 标记，判定层单测零浏览器依赖（§3.5） |
| **二期（3-4 周）** | M4 + M5 + M6 | ① 回归任务基于剧本零模型重放 ② 结构化断言占比 ≥70% 准入生效 ③ 三分归因可演示，L3 必须人工确认 ④ 小程序用例可执行 ⑤ skill 三类清单逐条对应 |
| **三期** | M7 桌面客户端（云真机/规模化见 §九，明确不做） | ① GPU 硬件评估通过 ② 桌面客户端探索演示 ③ 若要重议云真机，先补设备调度/健康/回收的独立方案 |

---

## 九、明确不做（v2 新增）

v1 用"三期按需"含糊带过，容易被理解成承诺。以下明确排除，附重议条件：

| 不做 | 原因 | 何时重议 |
|---|---|---|
| iOS 真机自动化 | 依赖 Apple 工具链 + macOS 构建机，收益/成本比低 | 出现 iOS 专属需求且客户愿意提供 macOS 机器 |
| 云真机池 / 大规模并发 | §11.7 已定设备 1~2 池；并发扩容是另一套工程（设备调度、健康、回收） | 单日回归任务数 > 设备容量 × 8 小时 |
| 支付 / 短信 / 邮件的真实验证 | 不可逆且涉合规 | 不重议，永远走 mock |
| 性能 / 压测 | 与功能回归是不同工具链，computer-use 不适用 | 单独立项 |
| 兼容性矩阵（多机型 × 多版本） | 成本随组合数指数上升 | 明确商业需求后按机型白名单做 |
| 安全渗透 / 漏洞扫描 | 与本平台定位无关 | 不重议 |
| 线上巡检 / 灰度验证 | 本平台限定测试环境，无生产权限 | 不重议（与 §3.2.5 环境层防线冲突） |
| 自研视觉 agent 模型 | v1 前提 2 已定"接现成引擎" | 现成方案连续 3 个月无法满足核心场景 |

---

## 十、全流程缺口与重构建议（v2.1 新增，v2.2 按两层重写）

> 本章回答的是另一个问题：不是"执行引擎怎么建"，而是**整条流程还有哪些环节是空的、哪些是重复实现**。
> 所有判断以**代码现状**为准，不以文档为准。
>
> **v2.2 修正**：v2.1 把流程写成一条直线（建档→探索→设计→执行→缺陷→报告），把**项目层一次性资产**与**任务层每轮流**混为一谈，因此漏掉了任务主线的三个前置环节，也把 3 条缺口判反了。现按 §5.0 的两层划分重写：**项目层**（项目 → 环境 → 建档 → 地图/知识/规则 → 长期复用）与**任务层**（新建任务 → 需求 → 测试点 → 用例 → 计划 → 执行 → 缺陷 → 报告 → 回流）。

### 10.0 先纠正前提：`gap-inventory-20261116.md` 已部分过期

那份差距清单把「环境不是一等实体」（B1）和「建档第一屏缺失」（A1）列为待做，但代码里已经有了：

| 清单说缺 | 代码实际有 |
|---|---|
| 环境不是一等实体 | `project_environments`：`base_url` / `is_default` / `status` 四态（`unregistered`·`probing`·`registered`·`failed`）/ `pages_total` / `apis_total` / `login_captcha` / `maps_path` / `steps_json`（五步进度） |
| 探索资产无处沉淀 | `qa_environment_knowledge`（module/flow/wall/interface 四层，按 env 分片）、`qa_exploration_hypotheses` + `qa_hypothesis_verdicts` |
| 建档没入口 | `project_environments.steps_json` 已承载五步进度，属"已实现未全暴露"（属 gap-inventory 的"工具建了但点不到"一类），不是"没有" |

清单 11-16 写，两天就漂。**这本身是流程缺口：差距清单没有防腐机制，而排期是按它排的。** 对策见 §10.5。

因此本章**不重复** gap-inventory 已列的 13 项，只写它没覆盖的两类：**运行时/治理面缺什么**（§10.2）、**代码层该重构什么**（§10.3）。

### 10.1 全流程落地状态（按两层分别核，v2.2 重写）

> v2.1 把两层压成了一条直线，导致"项目层资产"和"任务层每轮流"混在一张表里，判断自然就错。以下按 §5.0 的两层划分逐项核。

**项目层（建一次，长期复用）**

| 环节 | 代码现状 | 判定 |
|---|---|---|
| 项目 / 环境实体 | `projects` + `project_environments`（键 `(project_id, env)`，`status` 四态） | 已落地 |
| 建档 onboard | `runtime_cli onboard.bootstrap`（零 LLM，`BOOTSTRAP_TIMEOUT_MS` 120s）；产物 `maps/<env>/`；`steps_json` 五步进度；失败只写 `failed + last_error` | 已落地 |
| 项目地图 | `maps_path` 指向文件 + 摘要列（`pages_total` / `pages_registered` / `apis_total` / `api_modules`）；**无版本号、无 content hash** | 已落地，**无版本**（G9） |
| 探索 | `explore/explorer.py` 四阶段 + `BudgetGuard`，静态解析为默认入口 | 已落地，待按 §5.3 接三层 |
| 环境知识 | `qa_environment_knowledge`（module/flow/wall/interface 四层，带 `round` 与 `source_session_id`，可回溯到现场） | 已落地 |
| 项目规则 | `qa_knowledge_candidates`（候选，永不直接成规则）→ 人工确认 → `qa_project_rules` + `qa_rule_versions`（不可变、可退役） | 已落地，链路完整 |
| 项目资料 | `qa_documents` / `qa_document_revisions`（项目级，任务 pin 时被引用） | 已落地 |
| 资产退场治理 | 有健康度 / `quarantine` / `maps_staleness` 14 天提示，**无定时治理任务** | **缺**（G6） |

**任务层（每次按任务需求新建）**

| 环节 | 代码现状 | 判定 |
|---|---|---|
| **测试任务实体** | **没有**。UI 路由 `/qa/project/tasks/:sessionId`，`TaskIndex = { session, runs }`——**任务就是一个会话**，`title` 由模型自动生成 | **缺**（G7） |
| 任务上下文 pin | `qa_task_context_snapshots`（append-only：`documents_json` / `rules_json` / `capabilities_json`） | 已落地（pin 的是输入，不是任务对象） |
| ① 需求分析 | `plan/phases.py` `requirement`：`requires: []`，`produces: requirements{lineage, items}`，`confirm: True` | 已落地 |
| ② 测试点分析 | `testpoint`：`requires: [requirements]`，`produces: testpoints{lineage, items, matrix}`，矩阵程序算 | 已落地；**测试点无跨批次稳定身份**（G4） |
| ③ 用例设计 | `case`：`requires: [testpoints]`，断言必须回指测试点 | 已落地 |
| ④ 计划固化 | `plan`：`requires: [cases, maps]`（**跨层咬合点**），五闸全过才入库 | 已落地 |
| ⑤ 执行 | `exec/`（hybrid driver、自愈分级、`LocResolver`、`DeviceQueue`、`snapshot` 取原料/判定分离）+ `irval` 114 通过用例 | 已落地；**run 非实体**（G2）、**env 未落库**（G8） |
| ⑥ 缺陷分析 | `qa_defects` / `qa_defect_occurrences` / `qa_defect_events` / `qa_retests` | 已落地（提单侧） |
| ⑦ 报告 | `qa_case_results` / `qa_report_indexes`（不可变 revision + sha256） | 已落地 |

**跨层与回流**

| 环节 | 代码现状 | 判定 |
|---|---|---|
| 环境基线 / 数据重置 | 无。`baseline` 一词已被"快照 diff"（`defect/evidence.py`）与"耗时基线"（`selector.suspicious_signals(baseline_ms)`）占用，**与数据基线无关**；`allow_seed` 是逐条造数授权，造数 ≠ 可恢复 | **缺**（G1） |
| 被测版本 | 无 `sut_version`；`build_id` 是知识构建的，不是 SUT 的 | **缺**（G3） |
| 缺陷 → 测试点回流 | `qa_defects.related_cases_json` 只到 case；测试点 `(batch_id, point_key)` 每批次重建 | **缺**（G4） |
| 人工介入度量 | `scripts/confirm-gate.mjs`（11KB，三层抽样）在跑，但无事件表 | **缺**（G5） |
| run 作为实体 | 76 张表里没有 `qa_runs`；`run_id` 是散落在 `qa_case_results` / `qa_report_indexes` / `output/runs/<run_id>/` 的字符串 | **缺**（G2） |
| 环境贯通 | 只有 3 张表带 `env`（`project_environments` / `qa_environment_knowledge` / `qa_exploration_hypotheses`）；而 `project-environment-service.ts` 注释明确写着"**run 的 env、一 plan 多 variant 全部以 (project, env) 为键**" | **意图与实现不一致**（G8） |

### 10.2 真缺的 9 项（v2.2：按层补齐后从 6 项增至 9 项）

| # | 层 | 缺口 | 代码级证据 | 为什么阻断流程 | 最小补法 | 归属 |
|---|---|---|---|---|---|---|
| **G1** | 跨层 | 环境基线 / 数据重置 | 全模块搜不到 reset/restore；`baseline` 语义已被快照 diff 与耗时基线占用；`allow_seed` 只管造数 | §3.2.5 把"可回滚"当安全主防线、M2.5 要求"3 条剧本连跑 5 次全过"——**两条都以基线为前提，前提现在为空**。没有基线，第二次回归与第一次不可比，flaky 无法与脏数据区分 | 环境级 `env_snapshot`（DB dump + 文件快照 + mock 状态指纹）；新增 `exec/baseline.py` 只做**校验与 diff（纯函数）**，恢复动作交环境层；命名避开既有 `baseline` 免撞车 | 一期 M2.5 前 |
| **G2** | 任务层 | run 不是实体 | 无 `qa_runs` 表；run 只是 `qa_case_results` / `qa_report_indexes` 的 `run_id` 字符串 + `output/runs/<run_id>/` 目录 | **一个任务本来就会跑很多次 run（回归/重跑）**，但每次 run 的司机/起止/统计/父子关系无处存：查不了"上周所有回归"、做不了趋势、换机重装即丢。M2.5 的"连跑 5 次"没有记录载体 | `qa_runs(run_id, project_id, env, task_id, plan_rev, sut_version, driver, trigger, started_at, finished_at, status, stats_json, parent_run_id)`；大产物仍留文件系统，DB 只存索引 | 一期 M2.5 前 |
| **G3** | 任务层 | 被测版本未建模 | 无 `sut_version`；`build_id` 属知识构建 | 结论无法回答"这条用例相对哪个被测版本通过"；**flaky / 环境问题 / 被测真变了**三者分不开，而这正是回归价值的全部 | `qa_runs.sut_version`（+ 任务级默认值）；报告头强制带出；缺失时结论标 `inconclusive`（不猜，沿用 IR 既有 verdict） | 一期 |
| **G4** | 任务层 → 项目层 | 测试点没有跨批次稳定身份 | `qa_test_points` 主键 `(batch_id, point_key)`，`UNIQUE(batch_id, point_key)`；batch 是 `qa_design_batches(session_id, run_id, revision)`，每 run 重建；`qa_defects` 只挂 `related_cases_json` | **两个症状同一病根**：① 缺陷只到 case 粒度，回流不到测试点，同一个 bug 下轮还漏；② 任务 A 与任务 B 对同一模块的覆盖无法合并，"项目级覆盖率"根本不存在 | 加跨批次稳定身份 `point_uid = hash(module + feature + 规范化description)`；`qa_defects` 加 `point_uid`；归因后跑 `coverage.gaps` + 维度矩阵，把漏测假设写进 `qa_exploration_hypotheses`（`statement`/`why_unknown`/`expectation` 字段已齐，天生落点） | 二期 |
| **G5** | 任务层 | 人工介入成本无度量 | `confirm-gate.mjs` 有三层抽样算法，但无事件表、无口径 | 任务层有 **3 个 confirm 卡点**（requirement / testpoint / case，`CONFIRM_GATES`）——"三层做了算法，人还是只能全审"，不度量就不知道卡点是否合理，也证明不了已修好 | `confirm_events(task_id, gate, who, when, target, sampled, hit, duration_ms)`；报告出"人工成本"栏 | 二期 |
| **G6** | 项目层 | 资产退场没有岗位 | 有 `ElementLibrary` 健康度、`quarantine`、`maps_staleness`，无定时任务 | 项目层资产（地图/知识/规则/剧本）只进不出，逐轮腐烂；`assets/library.py` 保证"改要留 reason"，保证不了"该退的会退" | 定时治理任务 + "待治理清单"（剧本 30 天未跑 / 指纹连续失败 / maps 过期 / 规则 6 个月未命中）；治理动作仍走 `apply(change, actor, reason)` | 三期 |
| **G7** | 任务层 | **测试任务不是实体**（v2.2 新增） | UI 路由 `/qa/project/tasks/:sessionId`，`TaskIndex = { session: {sessionId,title,agentId}, runs }`；无 `qa_tasks` 表；`sessions.title` 注释写明"auto-generated by the model after the first exchange" | 任务层是用户的主干，却**没有对象**：① 任务属性（用哪个 env、目标版本、需求范围、负责人、状态）无处落，只能塞进 title 文本；② "项目视图"只能靠 session 列表 + run 目录拼；③ `qa_task_context_snapshots` 是"启动时 pin"，不是任务对象，文档改了任务不知道自己过期 | 新增 `qa_tasks(task_id, project_id, env, title, scope_json{documents, modules, clauses}, sut_version, status, owner, created_at, closed_at, session_id)`；session 降为任务的执行载体（1:N）；用现有 session 回填迁移 | 一期（与 G2 同批） |
| **G8** | 层间 | 环境没贯通到任务层（v2.2 新增） | 只有 3 张表带 `env`；而 `project-environment-service.ts:4-5` 明确写着"**run 的 env、一 plan 多 variant 全部以 (project, env) 为键**"；`qa_design_batches` / `qa_case_results` / `qa_report_indexes` 均无 `env` | 一个项目两个环境（test / staging）跑同一批用例，结果**混在一起无法区分**；报告回答不了"这条是哪个环境过的"；service 注释承诺的"一 plan 多 variant"没有落点 | `qa_runs.env`（随 G2 一起加）；报告头带 env；plan 若要多环境，用 `(plan_id, env)` 关联而非复制一份 plan | 一期（字段级，随 G2） |
| **G9** | 项目层 | 项目地图没有版本（v2.2 新增） | `plan` 阶段 `requires: ["cases","maps"]`，但 maps 只有 `maps_path` + 摘要列 + `probed_at`，**无 revision / content_hash**；`qa_environment_knowledge` 的 `round` 只是"第几轮" | ① 无法回答"这条用例基于哪版地图设计"；② 地图更新后无法批量判定哪些 plan stale（`invalidate` 需要上游版本可比）；③ `maps_staleness` 只能按天数提示，识别不出"地图内容已变但天数没到" | `maps/<env>/index.json` 加 `{built_at, content_hash, probe_version}` 并回写 `project_environments.maps_hash`；plan 固化时记录 `maps_hash`；不一致即 stale | 二期 |

### 10.3 该重构的 5 项（按"收益 ÷ 风险"排）

| # | 现状 | 风险 | 建议 | 归属 |
|---|---|---|---|---|
| **R1** | **Python / Node 同构双写**：`exec/api_engine.py`（244 行）↔ `scripts/api-engine.mjs`（20.7KB）同一规则两次实现 | **已在漂**。同一类问题还有更硬的证据：`central-tools.ts` 里 **14 处** description 指向 `qa/scripts/xxx.mjs`，但 **`qa/` 目录不存在**（实际都在 `scripts/`）。按台账描述找实现，找不到 | 定真源：Python 管规则/契约/判定，Node 只管 IO 与编排，用"规则快照 JSON"交接；**禁止双写**。这与 §3.3 批评的"清单抄一份必然漂"同源，只是规模大得多 | 二期前 |
| **R2** | 编排层碎片化：`scripts/` 共 316 个文件（**272 个 `.mjs`**），各自解析参数、各自写证据 | MCP 化只是给这 272 个碎片贴 33 个标签，没解决复用与可测性 | 收敛为"声明式 pipeline + 少量可组合 stage"，脚本降为库函数。**这是 MCP 化的前置**，顺序反了会返工 | M1 前置（做子集，不铺全量） |
| **R3** | 台账描述与实现脱钩（证据同 R1） | MCP 化后 agent **照 description 选工具**，描述错了就是选错工具，且错得很自信 | `central_tools` 加 `impl_path` 字段 + CI 校验文件存在；顺手修掉 14 处漂移。**半天工作量** | M0 内完成 |
| **R4** | "agent 能干什么"四处各说一遍：`skills/`(14) + `TASK_CONTRACTS`(5 类) + `central_tools`(33) + `tool-gate` 绑定 | 改一处漏三处。§六的 M6 只瘦 skill，**没治根因** | `TASK_CONTRACTS.tools` 作唯一能力声明；skill 只留"判据/知识"，工具授权从契约派生；`tool-gate` 绑定由契约生成而非手写 | M6 扩展 |
| **R5** | 前端绕过工具层（A6 已知：`project-knowledge-page.tsx` 不走 `extract`/`incremental`），同类可能不止一处 | 同一规则前端一份、工具一份，慢慢长出第二套真源 | 复用 `assets/binding.py` 的 `binding_audit` 思路：前端写操作 ↔ 是否存在对应工具，做成**机器对账**而非人工排查 | 二期 |

### 10.4 优先级：如果只做三件（v2.2 按两层重排）

1. **G7 + G2（任务实体 + run 实体）**——两层流程没有承载对象，后面所有记录都挂不上：没有任务，就没有"这个任务用哪个环境、测哪个版本、覆盖哪些条款"；没有 run，就没有"这次和上次怎么比"。
2. **G1 + G3（环境基线 + 被测版本）**——让回归结论有意义。缺这两项，"连跑 5 次全过"只能算口头结论，M4 的剧本固化也没有可比基准。
3. **G8 + G9（env 贯通 + 地图版本）**——两个字段级改动，不做则"一个项目两个环境"和"地图变了哪些用例失效"都无从回答。

**排期插入点（对 §6.3 批次的增量，不改动既有批次编号）：**

| 插入位置 | 内容 | 理由 |
|---|---|---|
| M0 内追加 | R3：`impl_path` 字段 + CI 校验 + 修 14 处漂移 | 与 M0"33 条与代码对齐"是同一件事，合并做零额外成本 |
| M2.5 之前 | G7 + G2 + G8（`qa_tasks` / `qa_runs` / env 字段） | M2.5 判据的**载体**；三张表一次迁移，分开做要迁三次 |
| M2.5 之前（紧随） | G1 + G3（基线 + 被测版本） | "连跑 5 次全过"的可比性前提 |
| M4 之后 | G4（测试点稳定身份 + 回流）+ G5（人工成本度量） | 需要先有稳定剧本与 run 记录 |
| 二期 | G9（地图版本 + `maps_hash` 落 plan） | 与 `invalidate` / `maps_staleness` 一起做才有意义 |
| M6 扩展 | R4（能力声明单一真源） | M6 本来就要动 skill 与授权，顺手治根因 |
| 三期 | G6（资产治理定时任务） | 资产量足够大之后才有治理收益 |

### 10.5 一条元建议：把"文档声称 vs 代码现状"的对账放进 CI

`gap-inventory` 两天过期，说明这个成本天天在付——只是付在"读旧文档做错排期"上。可执行的机器对账清单（都不需要人工判断）：

| 校验 | 失败即说明 |
|---|---|
| `central_tools.impl_path` 指向的文件必须存在 | 台账描述已脱钩（当前 14 处必失败） |
| 描述中出现的路径/脚本名，在仓库内可解析 | 文档与实现漂移 |
| `TASK_CONTRACTS.tools` 的每个工具名 ⊆ MCP server 实际暴露集合 | 能力声明与实际不一致 |
| `skills/` 引用的工具名 ⊆ `TASK_CONTRACTS.tools` | skill 私自扩权 |
| gap-inventory 每条"缺"必须带 `evidence_path`，路径不存在或已被实现则告警 | 差距清单过期（本次即属此类） |
| `PHASES[i].requires` 中每个产物 kind 都有产出方（`maps` 由 onboard/explore 共出，属白名单例外） | 阶段契约被改坏：某阶段依赖了没人产出的东西 |
| 凡带 `run_id` 的 `qa_*` 表，其 `run_id` 必须能在 `qa_runs` 找到 | run 悬空（当前因表不存在，100% 悬空） |

这比写第十份盘点文档划算。**M0 里加"差距清单重核"动作**，作为一次性清账 + 后续 CI 常态化。

### 10.6 与本文其他章节的关系

| 本章项 | 支撑哪条既有结论 |
|---|---|
| G7 | §5.0 / §5.4 任务层主线——任务层是用户主干，但没有任务对象，主线无处挂 |
| G2 / G3 | §5.6 三分归因（环境/定位/真实缺陷）——**没有 run 记录与版本，归因只能靠猜** |
| G8 | §5.4 的 `plan requires maps` 与 `project-environment-service.ts` 的 `(project, env)` 键——注释承诺了，表里没有 |
| G9 | §5.4 plan 前置 maps + §5.3 探索产出地图增量——地图无版本，`invalidate` 判不了 stale |
| G4 | §5.8 结果闭环与回流——当前只有"规则"一条通道是通的，漏测与覆盖率合并不通 |
| G1 | §3.2.5"安全主防线在环境层（可回滚）"——**没有 G1，该防线只是文字** |
| R2 / R3 | §3.3 工具描述是一等公民、§6.2 M0 核实 |
| R4 | §5.7 工具子集装配——子集从哪来，应由 `TASK_CONTRACTS` 派生，不是第二份清单 |

---

## 附：与既有文档的关系

- 执行层/协议层/skill 层以**本方案（v2）为准**（覆盖 v3 方案对应章节及 v1 全文）；
- v1 保留为决策记录，其中与本文冲突处以本文为准（涉及 v1 的 §1.1 前提 1、§3.2、§3.3、§5.3、§5.4、§七、M1/M4/M6 表述）；
- 意图层与数据模型以《AITestHarness-IR契约规范-v1》为准；
- **执行层既有实现以代码为准确认**：`aitestharness-tools/aitestharness_tools/{exec,explore,regression,irval}/*`（见 §2.2），Codex 落地前必读；
- 平台建设脉络与差距见《gap-inventory-20261116.md》《codex-onboarding-20261116.md》；**该清单已部分过期**（B1/A1 等项已有代码），以 §10.0 与以代码为准的 §10.1 为最新口径；
- 全流程缺口与代码级重构债见**本章 §十**（v2.1 新增）；
- 数据库收敛参考《db-table-audit-20261116.md》。

## 附：v2 修订记录

| 版本 | 日期 | 变更 | 触发原因 |
|---|---|---|---|
| v1 | 2026-11-18 | 初版：direction 确认、资产盘点、目标架构、选型、批次重排 | 研发组长确认方向调整 |
| v2 | 2026-11-18 | R1-R8 八项修订；新增 M0/M2.5/§3.4/§4.4/§5.6/§九。另含 **3 处事实更正**：① 33 工具落点为 `central-tools.ts`（SQLite，非独立服务）② `tool-gate.mjs` 是依赖完整性闸门、非敏感操作闸门 ③ 任务级工具白名单已存在于 `TASK_CONTRACTS.tools`，不新建机制 | 方案评审：v1 存在 3 阻断 + 4 坑 + 1 资产缺口；落地前核对代码发现 3 处事实误读 |
| v2.1 | 2026-11-18 | 新增 **§十 全流程缺口与重构建议**：6 项运行时/治理缺口（G1-G6）+ 5 项重构（R1-R5）+ 排期插入点 + 文档对账进 CI；纠正 `gap-inventory-20261116.md` 已过期部分（B1/A1 等已有代码）；附 §10.6 与既有章节的支撑关系 | 用户追问"整体流程还缺什么、哪里该重构"；按代码复核后发现差距清单已漂移 |
| v2.2 | 2026-11-18 | **按两层结构重写流程相关章节**：新增 §5.0（项目层/任务层总览 + `plan/phases.py` 九阶段归属表）、新增 §5.4 测试任务主线（需求→测试点→用例→计划）、§5.8 补"回流"通道，§5.5–§5.9 顺延重编号并同步全部交叉引用；§十 由 6 项缺口扩为 **9 项**（新增 G7 测试任务不是实体、G8 环境未贯通、G9 项目地图无版本），10.1 拆为项目层/任务层/跨层三张表；§10.4 优先级与 §八 一期判据同步；新增 2 条 CI 对账规则 | 用户指出"我原本设计的流程是新建项目→探索建地图，之后每次按任务需求建测试任务，从需求分析到测试报告"，核对后发现 v2/v2.1 把项目层资产与任务层每轮流压成一条直线，漏了任务主线前三段 |
| v2.3 | 2026-11-18 | 新增 **§3.5 computer-use 的引入边界与取原料层**：四象限正交矩阵（视觉+MCP 不成立的原因）、`probe/` 适配器接口、三层取法表 + `source` 标记、computer-use 三个落点与"产出必须降级为结构化锚点"硬约束、MCP 只接异常路径（默认流水线零模型）；§5.3 改为"默认不启 agent"；M2 拆为 **M2a / M2b**，M2b 移出一期；新增 R9 | 用户追问"computer-use 和 MCP 怎么实现、建档探索要不要用"；核对发现全包无浏览器驱动依赖、取原料层实为空 |
