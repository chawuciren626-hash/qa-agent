# 阶段 × Agent × LLM × 工具 × Skill × 插件 全链路梳理

> 依据：方案 v3 §5.3（确定性边界）、§10.1~§10.7（阶段工具清单）、§10.9（模型降级）、§11（四类自动化）、§15（探索器）、§16（报告审阅）、§17.3（Agent 权限收窄）、§17.4（待接线 Skill）、§24.6（能力包分发）。
> 工具名对应 `aitestharness-tools/` 里的实际实现文件。

---

## 阅读说明：先分清五个概念

现在工程里这五个词经常混着说，混起来就没人能说清"到底谁在干什么"。先钉死：

| 概念 | 是什么 | 谁维护 | 是否含 LLM | 分发通道 |
|---|---|---|---|---|
| **Agent** | 一个有独立交付物、独立确认点、独立失效条件的**角色**。它是"岗位"，不是"能力" | 服务端下发（提示词 + skill 绑定） | 用 LLM | 能力包 |
| **Skill** | 一个 agent 干这活时用的**知识包 / 方法包**（如测试设计方法、资产管理办法） | 服务端下发 | **不含 LLM**，是文本+规则 | 能力包 |
| **插件 / Adapter / Driver** | 连到**外部世界**的连接器（浏览器、HTTP、Appium、Jira、打码平台、OCR） | 装在客户端 | 不含 LLM，但可能要独立进程 | **整包**（代码）或 ③档依赖下载 |
| **工具（Tool）** | 一个**确定性函数**：吃结构化输入、吐结构化输出、可单测 | 随客户端发布 | **零 LLM** | **整包**（代码，不可热更） |
| **LLM 调用** | 一次模型请求。**只有 Agent 会发起**，工具永远不会发起 | 用户自己配的模型 | 全是 LLM | — |

一句话：**Agent 是岗位，Skill 是岗位手册，插件是接口，工具是手，LLM 是脑。**

---

## 零、全链路总表（一张表看完七阶段）

| # | 阶段 | 主 Agent | 谁在做 | LLM 位置 | 用到的主要工具 | 绑定 Skill | 用到的插件 |
|---|---|---|---|---|---|---|---|
| 0 | 项目建档 | `default_agent`（入口） | **几乎全程序** | 无 | `onboard.bootstrap` | — | HTTP（local） |
| 0' | 环境探索 | `default_agent` + 探索子流程 | 程序为主，少量 LLM | 2 处（判页面类型、补测试点） | `explore.explorer`、`onboard`、`exec.login` | `test-asset-management` | **Playwright** |
| 1 | 需求分析 | `requirement_analysis_agent` | 程序切条款，LLM 抽取 | 1 处 | `requirement.parsers`、`testability`、`acceptance`、`knowledge.extract` | `test-design-methods` | 无（文档本地解析） |
| 2 | 测试点分析 | `test_point_agent` | **程序算矩阵，LLM 填空** | 1 处 | `testpoint.matrix`、`testpoint.coverage` | `test-design-methods` | 无 |
| 3 | 用例生成 | `test_case_agent` | 程序搭骨架，LLM 补步骤 | 2 处 | `case.builder`、`plan.gates` | `test-design-methods`、`test-asset-management` | 无 |
| 4 | 执行 | `automation_execution_agent` / `api_automation_agent` / `android_test_agent` / `miniprogram_test_agent` | **全程序（重放零 LLM）** | 0 处（未固化路径除外） | `exec.api_engine`、`wait_assert`、`infra`、`api_ext`、`login`、`debug`、`hybrid`、`pools`、`native_mini` | `test-asset-management` | **Playwright / HTTP / Appium / 微信开发者工具 / 打码平台 / OCR** |
| 5 | 缺陷分析 | `defect_analysis_agent` | 程序取证+去重，LLM 归因 | 1 处 | `defect.evidence`、`defect.tools` | `test-asset-management` | **Jira / 禅道** |
| 6 | 报告 | `test_report_agent` | 程序出数字，LLM 审阅 | 1 处 | `report.reviewer` | — | 无 |
| 横 | 回归调度 | `test_agent`（状态机，不是 LLM 决策） | **全程序** | 0 处 | `regression.selector`、`regression.impact`、`plan.gates` | **`test-selection`** | 无 |
| 横 | 编排派发 | `test_agent` | **状态机 + 规则表** | 0 处 | 阶段状态机（现有） | — | 无 |

**全流程 LLM 调用点共 6 处**（探索 2 + 需求 1 + 测试点 1 + 用例 2 + 归因 1 + 报告 1 = 8 次量级，其中用例阶段 2 次）。方案 §10.7 的原话是"真正重度用 LLM 的只有四处"：**探索、用例步骤补全、失败归因、报告风险洞察**。

---

## 1. 阶段 0：项目建档（新增，用户旅程第一步）

### 发生了什么

用户填项目名 + 贴 URL + 上传资料。**全程零 LLM，10 秒级。**

| 步骤 | 执行者 | 具体动作 | 工具函数 |
|---|---|---|---|
| 可达性 | 程序 | DNS/TCP/HTTP 三次探测 | `probe_site` |
| 抓骨架 | 程序 | 首页 + 最多 12 个 JS bundle（单文件 2MB / 总量 8MB 硬上限） | `probe_site` |
| 编码嗅探 | 程序 | charset 声明 → UTF-8 严格 → GB18030 | `_decode` |
| 提路由 | 程序 | 4 类来源：`path:` 数组、`component:` 映射、`router.push/replace`、`navigateTo` | `extract_routes` |
| 归一化 | 程序 | `/order/123` → `/order/:id`（数字且长度≥4 才参数化，`v2` 保留） | `normalize_route` |
| 登录探测 | 程序 | 找 `input[type=password]` + 相邻 input；验证码从 `img src` / `class` 提线索 | `probe_login` |
| 接口探测 | 程序 | 6 个常见 OpenAPI 地址 | `probe_openapi` |
| 危险文案 | 程序 | 扫"删除/批量/支付/发消息"等文案 | `scan_risky_actions` |
| 知识抽取 | 程序 | md/docx → 条款（**无原文位置即丢弃**）→ 按 type+statement 去重 | `split_clauses` / `build_knowledge` |
| 出报告 | 程序 | 路由 N / 接口 M / 登录方式 / 未建档 K 页 / `next_steps` | `render_report_markdown` |

| 维度 | 结论 |
|---|---|
| **Agent 参与** | 仅作为入口承接点击，不产生任何 LLM 调用 |
| **LLM 参与** | **无** |
| **Skill** | 无 |
| **插件** | 只有本地 HTTP 客户端（requests） |
| **产物** | `maps/{env}/pages.json`、`apis.json`、`login.json` + `knowledge/*.json` + 建档报告 |

> **这一阶段是"用户端第一次感知到差别"的地方**：给个地址 10 秒出一份清单，而不是看着 AI 在屏幕上点。

---

## 2. 阶段 0'：环境探索（只有 URL + 账号的入口）

方案 §15.2 四阶段，**每个阶段有硬预算**。

### ① 环境建档 —— 零 LLM
直接复用阶段 0 的 `bootstrap()`。不重复。

### ② 结构巡检 —— 广度优先，每页 LLM ≤2 次

| 谁 | 做什么 |
|---|---|
| **程序**（`explore.explorer`） | 打开页面 → 结构化 DOM 快照 → **规则提取控件清单（零 LLM）** → 记录多指纹 → 记录触达接口 |
| **LLM**（第 1 次） | 判页面类型：列表 / 表单 / 详情 / 仪表盘（**给枚举让它选，不让它描述**） |
| **LLM**（第 2 次） | 判页面主要业务意图（一句话，用于生成测试点标题） |

硬预算：**≤50 页**，超出进"待探索队列"。

### ③ 功能试触 —— 有限深度，LLM 消耗最高区

只在首页 / 一级导航 / 用户指定入口做：表单填 3 字段提交 1 次、列表查询 1 次、导航跳转、空值/非法值提交 1 次。

| 谁 | 做什么 |
|---|---|
| **程序** | 填表、点击、观察前端校验，全部走确定性动作 |
| **LLM** | **不参与具体操作**。只在失败时判"这是前端校验生效（正常）还是没生效（缺陷）" |
| **插件** | **Playwright**（有头模式，用户能看见） |

硬预算：**≤10 页、每页 ≤5 次动作**。达到就停，不靠模型自觉。

危险动作白名单：删除/批量改/支付/发消息默认禁止，需用户显式放行（`scan_risky_actions` 提供候选清单）。

### ④ 固化沉淀 —— LLM 价值最高处，但只补缺口

| 产物 | 谁产 | 工具 |
|---|---|---|
| 应用地图 | 程序 | `knowledge.maps.build_maps` |
| 元素库（多指纹） | 程序 | `explorer.extract_controls` |
| 登录片段 `login.yaml` | 程序 | `exec.login`（策略链 + 会话固化） |
| 首版测试点 | **程序出矩阵，LLM 补缺口** | `testpoint.matrix` |
| 首批可固化轨迹 | 程序过五闸 | `plan.gates.compile_gates` |
| 待探索队列 | 程序 | `explorer` 预算守卫 |
| 探索度报告 | 程序 | "巡检 38/52 页 · 试触 8/10 页 · 未探索 14 项" |

| 维度 | 结论 |
|---|---|
| **Agent** | `default_agent` 承接，探索子流程内嵌（不单设 agent，避免"探索 agent 自己决定要不要探索"） |
| **LLM 总调用** | 每轮探索约 **2 次/页 × 50 页 + 少量**，上限由程序卡死 |
| **Skill** | `test-asset-management`（元素库写入规范） |
| **插件** | **Playwright**（必需）；验证码时接**打码平台 / OCR**（可选） |

---

## 3. 阶段 1：需求分析

### 程序先干，LLM 后干（顺序不能反）

```
docx/md ──[parse_markdown/parse_docx]──> 章节树 + 条款列表（带 {file, paragraph_index}）
                                              │
                    ┌─────────────────────────┘
                    ▼
        ┌── 程序：条款切分 + 去重 + 丢弃无位置项
        │
        └── LLM（Advisor 需求项抽取器）：逐条抽 需求项 IR
                    │  输入：单条条款（不是整篇 PRD！）
                    │  强制：必须回填原文位置，填不出就丢弃
                    ▼
        ┌── 程序：模块标签推断（module_of()，跳过 api/v1 噪声段）
        ├── 程序：可测性检查 T1~T4
        └── 程序：验收标准可观察性 E1/E2/E3/W1
```

| 维度 | 结论 |
|---|---|
| **Agent** | `requirement_analysis_agent` |
| **权限收窄**（§17.3） | ① 输入只能是**解析后的条款**，**不许直读整份 PRD 自由总结**；② 输出逐条挂原文位置；③ 必须打模块标签 |
| **LLM 做的** | 隐含约束识别（"单笔不超过 5 万"这类没写在验收标准里的）、可测性判断（这句话到底能不能测） |
| **LLM 不做的** | 切条款、去重、定位原文、打模块标签——全是程序 |
| **工具** | `requirement.parsers`（md/docx/OpenAPI/Figma）、`requirement.testability`（T1~T4）、`requirement.acceptance`（E1~W1）、`knowledge.extract`（条款化/去重/缺口） |
| **Skill** | `test-design-methods`（判可测性的方法依据） |
| **插件** | 无。文档在本机解析，OpenAPI 走本地 HTTP |
| **产物** | 需求项 IR（每条带 `source`）、可测性问题清单、知识缺口清单 |
| **确认卡点** | ①"需求理解对不对" —— 人在这里停下来签字 |
| **零 LLM 可能** | 有 OpenAPI 时，接口类需求**完全零 LLM** |

**弱模型降级**（§10.9.2）：`extract 3 / structured 3 / long_ctx 4` → 弱档走"条款切分后逐条人工确认"；**没有确定性兜底**（自然语言就是自然语言），所以这一环最该保证"人工可完成"。

---

## 4. 阶段 2：测试点分析

### 矩阵由程序算，LLM 只补空格子

```
需求项 IR ──[build_matrix]──> 待覆盖矩阵（需求项 × 8 维度）
                                    │
                    KNOWLEDGE_MAP（18 控件类型 × 维度）
                                    │
                              [matrix_gaps] ──> 缺口清单（空格子）
                                                     │
                                          LLM 只对这些格子生成测试点
                                                     ▼
                                        [assign_verify_mode] 强制分配验证方式
                                                     ▼
                                        [coverage] V-33 双向对账找漏
```

| 维度 | 结论 |
|---|---|
| **Agent** | `test_point_agent` |
| **权限收窄** | **覆盖矩阵由程序算，agent 只补空格子**；必须过"矩阵无空缺"校验；必须完成验证方式分配 |
| **LLM 做的** | 只对缺口格子生成测试点（数量可控、可度量） |
| **LLM 不做的** | 算矩阵、算覆盖率、分配验证方式、对账——全程序 |
| **工具** | `testpoint.matrix`（`KNOWLEDGE_MAP` / `build_matrix` / `matrix_gaps` / `assign_verify_mode` / `search_checklist`）、`testpoint.coverage`（V-33） |
| **Skill** | `test-design-methods` —— **它的可确定部分（维度矩阵、checklist、边界值字典）已经下沉成 `KNOWLEDGE_MAP`**，agent 只在缺口处判断。这就是 §5.5 说的"重叠的解法是下沉，不是合并" |
| **插件** | 无 |
| **产物** | 测试点 IR + 覆盖矩阵 |
| **确认卡点** | ②"测试点全不全" —— 第二个独立评审动作 |
| **额外闸** | 验证方式分配审计：接口可验却被分到 UI 的比例 >30% 报警（`hybrid.allocation_audit`） |

**弱模型降级**：`reasoning 2 / structured 3` → 弱档直接由 `KNOWLEDGE_MAP` 产出测试点 + 人工按缺口清单勾选。**这一阶段天然有确定性兜底**，是全链路最不依赖模型的一环。

---

## 5. 阶段 3：用例生成

### 一句话纪律：**步骤让 LLM 补，断言必须从测试点来**

```
测试点 IR ──[build_case_skeleton]──> 骨架（步骤占位 + 断言占位，占位回指测试点 ID）
                                          │
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
      LLM：步骤补全               程序：DataFactory            程序：断言占位保留
   （只补"怎么走"，动作+定位意图）    （边界六组 + 数据集 ID）      （禁止 LLM 写断言！）
              │                           │                          │
              └───────────────────────────┴──────────────────────────┘
                                          ▼
                      [check_case_budget] N+1 硬限 → [reconcile_enumeration] 双向对账
                                          ▼
                      [compile_gates] 五道闸 → 计划入库（闸 5 pending）
```

| 维度 | 结论 |
|---|---|
| **Agent** | `test_case_agent` |
| **权限收窄** | ① **断言必须来自测试点预期，不许看页面反推**；② 必须过条数预算；③ 必须过枚举对账 |
| **LLM 做的（2 处）** | ① 步骤意图描述（"打开订单列表 → 输入单号 → 点查询"）；② 断言的**语义表述**（把测试点预期翻译成 matcher 表达） |
| **LLM 不做的** | 搭骨架、造数据、算条数、对账、过闸——全程序 |
| **工具** | `case.builder`（骨架/DataFactory/预算/对账）、`plan.gates`（`extract_touched` + `compile_gates` 五闸） |
| **Skill** | `test-design-methods`（边界值字典已下沉到 DataFactory）、`test-asset-management`（定位器引用元素库，不现场编 selector） |
| **插件** | 无 |
| **产物** | 用例 IR → 执行计划 DSL |
| **确认卡点** | ③用例评审（第三条独立失效条件） |
| **五道闸具体是什么** | 闸 1 元素库命中 / 闸 2 matcher 白名单（引用 `irval/enums.py` 唯一来源）/ 闸 3 断言来自测试点 / 闸 4 无空步骤 / 闸 5 重放已验（N=3 回填） |

**为什么断言不能让 LLM 写**：断言若是看着页面"觉得对"写出来的，这条用例通过与否就完全没意义——这正是通用 agent 做测试的根本缺陷。

**弱模型降级**：`structured 3 / extract 2` → `assisted` 模式：程序给枚举候选（动作类型 / 等待类型 / 定位策略白名单），LLM 只做"选择或填空"；再弱就人工填骨架。

---

## 6. 阶段 4：执行（重放零 LLM）

### 谁在执行

| 被测类型 | Agent | 插件 / Driver | 工具 |
|---|---|---|---|
| 接口 | `api_automation_agent` | HTTP worker（requests / 工程 HTTP 层） | `exec.api_engine`、`exec.api_ext`、`exec.wait_assert` |
| Web UI | `automation_execution_agent` | **Playwright**（有头/无头同进程不同参数） | `exec.wait_assert`、`exec.infra`、`exec.login`、`exec.debug`、`exec.hybrid`、`exec.pools`、`exec.native_mini`(LocResolver) |
| App | `android_test_agent` | **Appium / ADB**（M2） | `exec.native_mini`、`exec.pools` |
| 小程序 | `miniprogram_test_agent` | **微信开发者工具**（M2） | `exec.native_mini`、`exec.pools` |

### 执行过程中的 LLM：0 次

| 环节 | 谁做 | LLM |
|---|---|---|
| 步骤重放 | `api_engine.run_plan` / Playwright 执行器 | **0** |
| 定位 | `LocResolver` 多指纹降级（testid → aria → css → text → xpath） | **0** |
| 等待 | `wait_assert` 8 类封闭枚举（禁 driver 专有写法、禁 sleep） | **0** |
| 断言判定 | `wait_assert` observe（采集事实不影响 verdict）/ decide（决定 verdict） | **0** |
| 自愈 | `infra`：L1 换指纹 / L2 延长等待（限一次）/ **L3 跳过步骤禁止** | **0** |
| 登录 | `login` 策略链（万能码 → 打码平台 → OCR → 人工），**≤1 次重试防锁号** | **0** |
| 结论 | 五档 pass / fail / flaky / skipped / inconclusive | **0** |
| 版本戳 | `version.runtime_stamp()` 写 `engine_version` / `schema_version` / `capability_versions` | **0** |

> **唯一例外**：M1 可降级为"计划驱动 + 受控探索"，那时探索段按阶段 0' 的预算规则算 LLM。

### 人工接管的三种模式（§12.7）

| 模式 | 触发 | 谁做 |
|---|---|---|
| **阻塞式** | 验证码、短信、扫码 | 引擎暂停 → 人操作 → 点继续 → **状态重对齐三步**（重抓 DOM / 刷新 touched / 校验前置条件） |
| **断点式** | 调试、排查 | 人在 `debug.DebugController` 设断点单步 |
| **修正式** | 人工走完某段异常路径 | 人操作一段，`debug.TakeoverSession` 记录并可编译为片段 |

接管的 LLM 参与：**0**。这是"人只完成引擎做不到的那一小段，然后交回"。

### 执行阶段的其他工具

| 工具 | 干什么 |
|---|---|
| `exec.pools` | 四池调度：接口 20~50 / Web=CPU 核数 / 设备 1~2 / 小程序 1~2；混合用例进主 driver 池 |
| `exec.hybrid` | 混合 driver 四约束：主 driver 声明 / ≤2 段不切回 / `context_flow` 显式 / 结论按最弱一环 |
| `exec.debug` | 断点、单步、状态查看、接管会话 |
| `exec.api_ext` | 响应契约校验、异步轮询、变量提取（`$.a.b`→ctx）、DB 断言 |
| `defect.evidence` | 失败即组装取证包七分区 + 与上次成功 diff（**归因下沉到执行末端**，上下文还热） |

---

## 7. 阶段 5：缺陷分析

| 环节 | 谁做 | LLM |
|---|---|---|
| 取证包组装（context/visual/dom/network/console/trace/history 七分区） | 程序 `defect.evidence` | 0 |
| 缺陷去重（指纹 = 失败断言 + 目标元素 + 异常签名 + 环境键） | 程序 `defect.tools` | 0 |
| 偶发 bug 识别（verdict 不稳 + actual 多样 → 上报真实偶发缺陷，**不许自动改脚本**） | 程序 `defect.tools` | 0 |
| 缺陷单渲染（内置 / Jira / 禅道模板） | 程序 `defect.tools` | 0 |
| **根因归类 + 置信度** | **LLM（Advisor 归因器）** | **1 处** |

| 维度 | 结论 |
|---|---|
| **Agent** | `defect_analysis_agent`，**保留**（有真判断成分：五分类 + 置信度） |
| **权限收窄** | **取证包必须由程序组装**，agent 不许自己"找证据" |
| **LLM 做的** | 五分类归因（产品 bug / 脚本问题 / 环境问题 / 数据问题 / 偶发）+ 置信度；低置信转人工 |
| **插件** | **Jira / 禅道**连接器（渲染好的单推过去） |
| **降级** | `reasoning 3 / structured 2` → 按 §14.3 可疑信号规则表做**确定性归因**，人工复核。**有兜底** |

---

## 8. 阶段 6：报告（审阅者，不是写手）

| 环节 | 谁做 | LLM |
|---|---|---|
| `extract_facts`：通过率、flaky 率、一致性、耗时——**全部来自 exec IR** | 程序 | 0 |
| `RiskLedger`：风险台账状态机 new→tracking→mitigated | 程序 | 0 |
| 报告模板渲染 | 程序 | 0 |
| **风险洞察 + 监控建议** | **LLM** | **1 处** |

| 维度 | 结论 |
|---|---|
| **Agent** | `test_report_agent`，**定位从"写报告"改为"审报告"** |
| **四条硬约束**（§16.2） | ① **数字只读**（agent 不许改写任何数字）；② 洞察必须挂引用；③ **允许空输出**；④ facts / insights 分段 |
| **LLM 做的** | 看一眼 facts，说"这个 flaky 率集中在订单模块，建议查一下那块的异步轮询" |
| **LLM 不做的** | 算任何数字、渲染任何表格 |
| **Skill** | 无（提示词 `REVIEWER_PROMPT` 走能力包下发档） |
| **降级** | 只出 facts + 台账机械汇总，**洞察留空**。§16 已明确允许空输出 |

---

## 9. 横向：编排派发与回归调度

### 编排派发：从"LLM 判断"改为"状态机 + 规则表"

| 现在 | 改造后 |
|---|---|
| `test_agent` 用 LLM 决定下一步派给谁、能不能跳过 | **状态机 + 规则表**，agent **不能决定跳过阶段** |
| 阶段间传文本 | 阶段间**传 IR + 硬校验**，不合格即阻塞 |
| LLM 调用 | **0 次** |

### 回归调度：三个问题，全程序回答

| 问题 | 工具 |
|---|---|
| 这次该跑哪些？ | `regression.impact`（五触发源：显式 / 需求变更 / 代码变更 / 片段依赖 / 历史相似，**每条给理由**） |
| 跑哪一档？ | `regression.selector`（smoke / core / full 三闸） |
| 结果信不信？ | `regression.selector.judge_samples`（N 次样本 → 五档；**版本不同判 inconclusive 不算 flaky**）+ 准入结论合成 |
| 该不该进隔离区？ | `quarantine_check` |

**Skill**：`test-selection` —— **这就是 §17.4 说的"已定义但从未接线的 Skill"**。改造后由 `regression.selector` + `impact` 提供执行体，skill 只保留"按风险/预算选"的策略描述。

---

## 10. 四处真正用 LLM 的地方（方案 §10.7 的原话）

| # | 位置 | 为什么不可形式化 | 兜底 |
|---|---|---|---|
| 1 | **探索（新场景）** | 面对没见过的系统，只能"看一眼判断" | 预算硬限，超了就停，产探索度报告 |
| 2 | **用例步骤补全** | "怎么走"是意图描述，无法穷举 | `assisted`：给枚举让模型选；`manual`：骨架给人填 |
| 3 | **失败归因** | 根因判断需要跨证据推理 | **规则表确定性归因**（§14.3 可疑信号） |
| 4 | **报告风险洞察** | 洞察就是"想到别人没想到的" | **允许空输出**，facts 照样给 |

**其余全部零 LLM**。反过来看这张表更直观：**七阶段里，有五个阶段的程序占比 >80%**。

---

## 11. Skill 清单与接线状态

| Skill | 谁用 | 现在 | 改造后 |
|---|---|---|---|
| `test-design-methods` | 需求 / 测试点 / 用例三个 agent | 被三个 agent 各自解释（**重叠的根因**） | **可确定部分下沉为程序资产**（`KNOWLEDGE_MAP`、DataFactory 边界字典、checklist 检索），三处共享同一份规则；skill 只剩方法论述 |
| `test-asset-management` | 用例 / 执行 / 缺陷 / 探索 | **未绑定任何 Agent** | **M1 第 1 步接上**，落到 `elements/`（多指纹、环境变体、失效历史） |
| `test-selection` | 回归调度 | **未绑定任何 Agent** | **M1 第 2 步接上**，落到 `regression.selector` + `impact` |
| 其余 12 个 Skill | 各 agent | 保留 | 保留，但按"能不能形式化"逐步把可确定部分下沉 |

> 关键判断：**职责重叠的根因不是角色划分重复，是规则散在提示词里被各自解释。** 所以解法是下沉，不是合并 agent。

---

## 12. 插件 / Adapter 清单

| 插件 | 用在哪一阶段 | 谁在用 | 分发方式 |
|---|---|---|---|
| **Playwright**（内核） | 探索 / Web 执行 / 接管 | `automation_execution_agent` | ③档依赖下载（首次使用时拉，落本地缓存，带兼容性声明） |
| **HTTP worker** | 接口执行 | `api_automation_agent` | 内置（整包） |
| **Appium / ADB** | App 执行（M2） | `android_test_agent` | ③档依赖下载 |
| **微信开发者工具桥** | 小程序执行（M2） | `miniprogram_test_agent` | ③档依赖下载 |
| **打码平台** | 登录（验证码） | `exec.login` 策略链 | 客户自己配，凭据存本机 |
| **OCR** | 登录（iframe/canvas 降级） | `exec.login` | ③档依赖下载 |
| **Jira / 禅道** | 缺陷单推送 | `defect_analysis_agent` | 内置连接器（整包）或客户自配 |
| **Figma**（原型解析） | 需求分析（M2） | `requirement.parsers` | 无（导出文件本地解析） |

**插件为什么和工具分开**：插件连外部世界，可能崩、可能超时、可能要独立进程；工具是纯函数，可单测。混在一起会把"外部服务挂了"和"逻辑写错了"混成一种故障。

---

## 13. 权限收窄总表（改造的核心动作）

方案 §17.3 的原话：**"主要矛盾不是 agent 数量，是 agent 的权限。"**

| 收什么 | 对谁 | 怎么收 |
|---|---|---|
| **输入来源** | 全部 agent | 只能吃上游 IR，**不许自由读原始材料自行总结** |
| **输出格式** | 全部 agent | 必须过 schema 硬校验，不合格即**阻塞**（不是告警） |
| **决策权** | `test_agent` | 阶段派发交给状态机，**不能决定跳过阶段** |
| **自由空间** | 测试点 / 用例 / 执行 | 能形式化的一律下沉为程序（矩阵、checklist、边界字典、定位策略） |
| **断言来源** | `test_case_agent` | **必须回指测试点**，不许看页面反推 |
| **取证材料** | `defect_analysis_agent` | 取证包由程序组装，agent 不许自己找 |
| **数字** | `test_report_agent` | **只读**，一个数字都不许改 |
| **版本字段** | 全部 agent | 列入 `irval/ownership.py::EXEC_FACT`，agent 提交时被**剥离** |

最后一条特别说明：**agent 不能写 `engine_version`**。否则它可以自己声称"跑的是新版本"，把版本漂移洗成 pass，flaky 归因直接失效。

---

## 14. 降级矩阵（模型弱的时候谁顶上）

方案 §10.9 的核心：**不按模型强弱做两套流程，把同一件事拆成 auto / assisted / manual 三档，产物契约完全相同。**

| 阶段 | 任务 | 声明档 S | 实测 B | 实测 N（不可用） |
|---|---|---|---|---|
| 需求 | 需求项抽取 | auto | assisted（强约束枚举） | **manual**：条款逐条人工确认 |
| 测试点 | 缺口补齐 | auto | assisted | **程序出映射 + 人工勾选** |
| 用例 | 步骤补全 | auto | assisted（只选不生成） | manual（填骨架） |
| 归因 | 根因分类 | auto | **规则表确定性归因** + 人工复核 | 同左 |
| 报告 | 风险洞察 | auto | facts + 机械汇总 | **洞察留空**（允许） |
| 探索 | 页面类型判断 | auto | 关键词规则兜底 | 只做结构巡检，不做试触 |

**只降不升**：实测只能证明"比声明更差"，不能证明更好；无样本按 N 处理。

**降级必须说出来**（§10.9.5）：

> "本次需求抽取为**人工模式**：当前模型在该任务能力得分 1/4（缺 extract、long_ctx）。原因：近 20 次调用 schema 非法率 35%。建议换用在线模型或按骨架手填。"

不写这句话的后果：用户以为"AI 分析了"，实际拿到半成品，最后结论是"这工具不准"——**真相是模型不够，跟工具无关**。

---

## 15. 每个阶段一张速查卡

### 卡 1 · 建档
`Agent:` default（仅入口） · `LLM:` 0 · `工具:` onboard.bootstrap · `Skill:` — · `插件:` HTTP · `耗时:` 10 秒 · `闸:` bundle 限流

### 卡 2 · 探索
`Agent:` default（探索子流程） · `LLM:` ≈2 次/页，≤50 页 · `工具:` explorer / maps / login / matrix / gates · `Skill:` test-asset-management · `插件:` **Playwright** · `耗时:` ≤10 分钟 · `闸:` 预算硬限 + 危险动作白名单

### 卡 3 · 需求分析
`Agent:` requirement_analysis_agent · `LLM:` 1 处（逐条抽取） · `工具:` parsers / testability / acceptance / extract · `Skill:` test-design-methods · `插件:` — · `闸:` 无原文位置即丢弃 + 可测性 T1~T4 + 确认卡点①

### 卡 4 · 测试点
`Agent:` test_point_agent · `LLM:` 1 处（只补缺口） · `工具:` matrix / coverage · `Skill:` test-design-methods（已下沉） · `插件:` — · `闸:` 矩阵无空缺 + 验证方式分配审计 + 确认卡点②

### 卡 5 · 用例
`Agent:` test_case_agent · `LLM:` 2 处（步骤 / 断言表述） · `工具:` builder / gates · `Skill:` test-design-methods + test-asset-management · `插件:` — · `闸:` N+1 预算 + 枚举对账 + **五闸** + 确认卡点③

### 卡 6 · 执行
`Agent:` 四个执行 agent · `LLM:` **0** · `工具:` api_engine / wait_assert / infra / login / debug / hybrid / pools / native_mini · `Skill:` test-asset-management · `插件:` **Playwright / HTTP / Appium / 小程序桥** · `闸:` 五档结论 + N=3 + 版本冻结 + 自愈红线

### 卡 7 · 缺陷
`Agent:` defect_analysis_agent · `LLM:` 1 处（归因+置信度） · `工具:` evidence / tools · `Skill:` test-asset-management · `插件:` **Jira / 禅道** · `闸:` 取证由程序组装 + 指纹去重 + 偶发 bug 识别

### 卡 8 · 报告
`Agent:` test_report_agent · `LLM:` 1 处（洞察） · `工具:` reviewer · `Skill:` — · `插件:` — · `闸:` 数字只读 + 洞察挂引用 + 允许空输出

### 卡 9 · 回归调度
`Agent:` test_agent（状态机） · `LLM:` **0** · `工具:` selector / impact · `Skill:` **test-selection** · `插件:` — · `闸:` 三档选集 + 准入结论 + 隔离区纪律

---

## 16. 一句话总结每个角色

| 角色 | 一句话 |
|---|---|
| `default_agent` | 入口和向导，不产生判断 |
| `test_agent` | 调度员，照规则表派活，无权跳步 |
| `requirement_analysis_agent` | 把条款翻译成可测的需求项，翻不出位置就不算翻 |
| `test_point_agent` | 只在程序画好的格子里填内容，画格子的事它不干 |
| `test_case_agent` | 补"怎么走"，但"什么算对"必须照抄测试点 |
| 四个执行 agent | 扳机，扣下去就按计划跑，没有思考时间 |
| `defect_analysis_agent` | 法医，证据由程序摆好，它只写死因和把握几成 |
| `test_report_agent` | 审稿人，数字一个字不能改，只能说看法 |
