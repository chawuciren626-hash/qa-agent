# AITestHarness 产物契约规范（IR Contract Spec v1）

> 配套文档：《AITestHarness 测试平台架构重构方案 v3》第 6 章。  
> 本文件是**字段级定稿**，开发实现以本文件为准。v1 定稿后，字段增删必须走附录 A 的变更流程。  
> 覆盖面：1 个公共头 + 6 份核心 IR + 2 份附属契约 + **38 条校验规则** + 端到端示例。  
> 状态：**v1 已定稿**（2026-11-13）。第 10 章 7 项待确认问题已全部拍板，决策记录见第 10 章。

---

## 0. 使用说明

### 0.1 三类读者怎么用

| 角色          | 读什么                   | 用来干什么                      |
| ----------- | --------------------- | -------------------------- |
| 产品/架构       | 第 1、2.1、7 章           | 确认契约能支撑既定机制；审计字段是否膨胀       |
| 后端开发        | 全部，重点是第 3~5、6 章       | 直接实现 schema 与校验器           |
| Agent/提示词开发 | 第 3 章各节的"谁写"列 + 第 6 章 | 明确 agent 只能填哪些字段，哪些字段由程序回填 |

### 0.2 三条使用铁律

1. **字段分权**：每个字段标注 `writer`（`program` / `agent` / `human`）。**agent 不得写 `program` 字段**，校验器直接丢弃越权写入。
2. **必填分级**：字段按 `draft` / `approved` 两态标必填。`draft` 允许缺，**`approved` 缺一个就阻塞**，不允许"先跑起来再说"。
3. **枚举封闭**：所有枚举值在 2.5 节集中定义，**新增枚举值等于契约变更**，必须走流程。禁止运行时自造值（如 `verdict: "基本通过"`）。

---

## 1. 设计原则

### 1.1 每个字段必须有一个"消费者"

字段不是描述性的，是**机制性的**。任何字段必须能回答："哪个机制会读它？不填会导致什么功能失效？"

第 7 章给出字段-机制映射表，作为防膨胀审计依据。**没有消费者的字段一律删除**——这是本规范最重要的一条纪律，也是防止产物 schema 演化成"什么都能装的大口袋"的唯一手段。

### 1.2 机读优先于可读

同一信息有两种表达时，选机器可判定的那种：

| 错误                        | 正确                                                                                            | 原因                   |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `expected: "页面应显示优惠金额为0"` | `expected: [{statement: "页面显示 0 元", observable: "coupon_amount", matcher: equals, value: 0}]` | 前者只能靠 LLM 判断，后者可程序判定 |
| `status: "差不多完成了"`        | `status: done`（枚举）                                                                            | 自由文本无法参与流程判断         |
| `passed: "看起来没问题"`        | `verdict: pass` + `assertions[].result`                                                       | 结论必须有可追溯依据           |

**判断标准**：这个字段的值，能否写出一个返回布尔值的比较函数？不能，就不是机读字段，应降级为 `note`。

### 1.3 结构化可嵌套，语义不可推测

允许 `business_rules[].expression` 这种"半结构化"字段（可解析的表达式字符串），但**不允许**让下游去"理解一段话再推断"。比如计划里不能写"登录后随便点几下"，必须写具体步骤。

### 1.4 向前兼容优先于完美

新增字段必须是**可选**且**有默认行为**。删除字段必须经过一个大版本周期（标 `deprecated`，仍解析但不使用）。

---

## 2. 通用规范

### 2.1 ID 命名

```
<TYPE>-<序号>[@<version>]
```

| 类型   | 前缀     | 示例                | 说明                           |
| ---- | ------ | ----------------- | ---------------------------- |
| 需求项  | `REQ`  | `REQ-0045`        | 项目内全局唯一                      |
| 测试点  | `TP`   | `TP-0045-02`      | `TP-<需求序号>-<两位序号>`，天然体现血缘    |
| 用例   | `CASE` | `CASE-00123`      | 全局自增                         |
| 执行计划 | `PLAN` | `PLAN-00123`      | 与用例同号（一条用例一份主计划），变体加后缀 `-v2` |
| 执行记录 | `EXEC` | `EXEC-8821`       | 运行池全局自增                      |
| 缺陷   | `DEF`  | `DEF-0031`        | 全局自增                         |
| 报告   | `RPT`  | `RPT-20261113-01` | 按日期                          |
| 风险   | `RISK` | `RISK-0007`       | 全局自增                         |
| 片段   | `FRAG` | `FRAG-login`      | 语义命名，版本另计                    |
| 取证包  | `EV`   | `EV-8821`         | 与 `EXEC` 同号                  |

**引用语法**：`<id>@<version>` 表示"精确到版本"，`<id>` 表示"跟随最新 approved 版本"。**跨产物引用必须写精确版本**（如 `derived_from: ["REQ-0045@3"]`），只有"要跟随升级"的场景才省略版本。

**变更禁止换 ID**：需求项内容变更走升版（`REQ-0045@2 → @3`），**不许新建 ID**。这条与现有工程"写结果未知不换 ID 重放"同源——ID 换了，血缘、回归映射、缺陷关联全部断链。

### 2.2 公共头（8 份产物强制，12 个字段）

```yaml
# ===== 公共头 =====
schema_version: "1.0"          # 契约版本，program 写
type: requirement              # program 写，见 2.5 枚举
id: REQ-0045                   # program 写
version: 3                     # program 写（语义变更才 +1，见 2.3）
status: approved               # program 写；迁移只能由状态机触发
project: proj-internal-crm     # program 写
module: order                  # agent 写（首次），human 可改；影响分析用
derived_from: ["REQ-0044@1"]   # program 写（禁止 agent 声明）
content_hash: "sha256:9f2a..." # program 写（语义指纹，见 2.3）
labels: [exploratory]          # agent/human 写，自由标签，不影响流程判定
created_at: 2026-11-13T17:00+08:00   # program 写
created_by: agent:requirement_analysis_agent   # program 写
updated_at: 2026-11-13T17:30+08:00   # program 写
approved_by: ["human:lisi"]    # human 写；approved 态必备
notes: ""                      # 任何人可写，纯备注，不参与判定
```

| 字段               | 类型         | 必填（draft/approved） | writer      | 消费者              | 缺失后果              |
| ---------------- | ---------- | ------------------ | ----------- | ---------------- | ----------------- |
| `schema_version` | string     | ✓/✓                | program     | 解析器              | 无法判断兼容性           |
| `type`           | enum       | ✓/✓                | program     | 全部               | 无法路由              |
| `id`             | string     | ✓/✓                | program     | 全部               | 无法引用              |
| `version`        | int        | ✓/✓                | program     | 增量重算、取证对比        | 无法判断新旧            |
| `status`         | enum       | ✓/✓                | program     | 编排器、选集           | 无法判断可用性           |
| `project`        | string     | ✓/✓                | program     | 资产库、权限           | 无法隔离              |
| `module`         | string     | ✓/✓                | agent       | 影响分析（代码变更→模块→用例） | 影响分析退化到人工         |
| `derived_from`   | `id@ver[]` | ✓/✓                | **program** | 血缘、增量重算、回归选集     | 变更传播失效，只能全量重算     |
| `content_hash`   | string     | ✓/✓                | program     | 表述变更检测           | 每次文档小改都全量重算       |
| `labels`         | string[]   | -/-                | agent/human | 选集、报表分组          | 无                 |
| `created_at`     | ISO8601    | ✓/✓                | program     | 报表、审计            | 无                 |
| `created_by`     | `actor`    | ✓/✓                | program     | 审计、归因            | 无法区分人/机产出         |
| `updated_at`     | ISO8601    | ✓/✓                | program     | 增量同步             | 无法做增量             |
| `approved_by`    | `actor[]`  | -/✓                | **human**   | 准入、选集            | **未确认的产物可能进入回归集** |
| `notes`          | string     | -/-                | any         | 人读               | 无                 |

**`actor` 格式**：`program:<module>` / `agent:<agent_name>` / `human:<username>`。禁止自由文本。

### 2.3 版本与语义指纹

```
version: 3              # 语义变更才 +1
content_hash: sha256:…  # 语义指纹：去格式噪音后的正文 hash
```

**判定规则（程序自动执行，不询问 LLM）**：

| 变更                 | version | content_hash | 是否触发下游重算     |
| ------------------ | ------- | ------------ | ------------ |
| 业务规则/字段/预期发生变化     | +1      | 变            | **是**（求血缘闭包） |
| 措辞改写、章节重排、错别字、格式调整 | 不变      | **不变**       | 否            |
| 排版导致的文本移动          | 不变      | 不变           | 否            |

**语义指纹算法（定稿）**：

```
1. 取产物"语义正文"字段（各 IR 在 3.x 中显式列出语义正文字段清单）
2. 规范化：去除全半角差异、连续空白折叠、去标点、统一数字格式、去 HTML/Markdown 标记
3. 按语义正文字段清单的顺序拼接
4. sha256
```

**为什么不能直接用文档 hash**：真实项目里 PRD 每天有人改格式，用文档 hash 会导致每次小改都全量重算，团队一个月内就会绕过这套机制。

**为什么不能让 LLM 判断"是不是语义变更"**：判断不稳定且不可解释。指纹不一致时**一律按语义变更处理**（保守），由人在 diff 里确认无实质变化后手动标注 `no_semantic_change: true`（该标注写审计日志）。

### 2.4 状态机（所有产物统一）

```
draft ──提交评审──> reviewing ──人工确认──> approved ──失效──> deprecated ──> archived
  ↑                    │                                      
  └──────打回──────────┘                                      
```

| 迁移                      | 触发者               | 前置校验                       |
| ----------------------- | ----------------- | -------------------------- |
| `draft → reviewing`     | program（提交动作）     | schema 校验全通过               |
| `reviewing → approved`  | **human**（必须显式确认） | 语义校验全通过 + `approved_by` 非空 |
| `reviewing → draft`     | human             | 无（打回必须填 `reject_reason`）   |
| `approved → deprecated` | program 或 human   | 下游产物必须一并标记（血缘闭包）           |
| `deprecated → archived` | program           | 无引用                        |

**硬规则**：

- **`approved` 态产物不可原地修改**，修改必须产生新版本（`version+1`），旧版本保留可查；
- **`draft` 态产物不得进入回归集、不得被执行引擎消费**；
- 状态只能由状态机迁移，agent 无权直接写 `status`。

### 2.5 全局枚举字典（封闭，新增需走契约变更）

```yaml
type:            [requirement, test_point, case, plan, exec, defect, report, risk]
status:          [draft, reviewing, approved, deprecated, archived]
actor_prefix:    [program, agent, human]

# 需求
requirement.kind:        [functional, constraint, non_functional, compliance]
source_type:             [prd, openapi, figma, ticket, reverse_engineering, manual]
priority:                [P0, P1, P2, P3]

# 测试点
dimension:               [functional, boundary, exception, permission, compatibility,
                          performance, security, data_consistency, usability]
driver_kind:             [web, api, native, miniprogram, db]
control_type:            [input_text, input_number, input_date, select, radio, checkbox,
                          button, link, table, upload, rich_text, iframe, canvas, map]

# 执行
verdict:                 [pass, fail, flaky, skipped, inconclusive]
step_status:             [pass, fail, skipped, blocked]
inconclusive_kind:       [env_unreachable, precondition_unmet, session_failed,
                          data_unavailable, resource_timeout]
wait_type:               [element_visible, element_enabled, element_stable, network_idle,
                          request_done, text_changed, url_matches, attribute_equals]
assert_level:            [decide, observe]

# 预期判定（10.1 决议：封闭白名单，禁止自由脚本）
matcher:                 [equals, not_equals, contains, not_contains, gt, gte, lt, lte,
                          between, in_set, regex, abs_diff, null, not_null]
matcher_fn_whitelist:    [abs_diff, round, len]        # 仅 matcher 表达式中可用
assert_type:             [url_matches, url_contains, visible, hidden, text_visible,
                          text_equals, value_equals, attribute_equals, count_equals,
                          status_code, json_path, db_row, schema_match, semantic]
action_type:             [goto, click, fill, select, hover, scroll, upload, download,
                          press, wait, extract, request, db_query, navigate, switch_context]

# 缺陷
defect_category:         [product_bug, script_issue, env_issue, data_issue, flaky, unknown]
severity:                [S1, S2, S3, S4]
lifecycle:               [open, confirmed, fixed, verified, closed, wontfix]
dedup_decision:          [new, merged, linked]

# 风险
risk_status:             [new, tracking, mitigated, accepted, escalated, closed]

# 自愈
heal_level:              [L1, L2, L3]
```

**禁止**：在产物中出现"其它/未知/差不多/基本通过"等自由文本枚举值。无法归类时用 `unknown`，并在 `notes` 说明。

### 2.6 值类型约定

| 类型   | 约定                                                | 示例                                   |
| ---- | ------------------------------------------------- | ------------------------------------ |
| 时间   | ISO8601 带时区，秒级                                    | `2026-11-13T17:04:00+08:00`          |
| 金额   | 字符串十进制 + 币种，**不用 float**                          | `{amount: "99.99", currency: "CNY"}` |
| 引用   | `${namespace.key}`，namespace ∈ `data`/`ctx`/`env` | `${data.username}`                   |
| 产物引用 | `id@version`                                      | `CASE-00123@2`                       |
| 数据引用 | `data://<dict>.<key>@<version>`                   | `data://order.boundary@1`            |
| 证据引用 | `evidence://<exec_id>/<step_id>`                  | `evidence://EXEC-8821/s3`            |
| 凭证   | **永不落盘到产物**，只写引用                                  | `${cred://internal-qa/user01}`       |

---

## 3. 六份核心 IR

### 3.1 `requirement` 需求项

**语义正文字段（参与 content_hash）**：`title`、`statement`、`business_rules[].statement`、`business_rules[].expression`、`business_rules[].boundary`、`data_constraints`、`acceptance`、`preconditions`

```yaml
# ---- 公共头（略）----
title: 订单满减规则
statement: 用户下单金额满 100 元减 10 元，不与其他优惠叠加。
kind: functional
priority: P0

source_ref:                        # 溯源（缺此项不许 approved）
  source_type: prd
  doc: prd-order-v3.docx
  doc_version: "v3.1"
  locator: {page: 12, para: 3, anchor: "#order-discount"}
  quote: "满100元减10元，不与其他优惠叠加"   # 原文摘录，程序可回原文校验

business_rules:                    # 测试点矩阵与数据工厂的机械输入
  - id: BR-01
    statement: 满 100 元减 10 元
    inputs: [order_amount]
    expression: "order_amount >= 100 ? discount = 10 : discount = 0"
    boundary: ["99.99", "100", "100.01"]
  - id: BR-02
    statement: 不与其他优惠叠加
    inputs: [order_amount, coupon_amount]
    expression: "coupon_applied ? discount = 0 : discount = 10"
    boundary: []

data_constraints:                  # 喂数据工厂
  - field: order_amount
    type: "decimal(10,2)"
    range: ["0.01", "999999.99"]   # 10.7 决议：一律字符串十进制，禁止 YAML 浮点
    format: "两位小数"
    nullable: false

acceptance:                        # 断言的唯一合法来源（上游）
  - id: AC-01
    statement: 满 100 的订单实付 = 订单总额 - 10
    observable: order.pay_amount
  - id: AC-02
    statement: 满 100 且使用优惠券时，优惠金额 = 0
    observable: order.discount_amount

preconditions:
  - 用户已登录且实名认证

clarifications:                    # 未答复 → 该需求项不可 approved
  - {id: Q1, question: "叠加优惠券时满减是否失效？", status: answered,
     answer: "失效", answered_by: "human:product_wang"}

testability:
  score: high
  issues: []

supersedes: REQ-0045@2
change_note: "满减门槛由 100 调整为 200（客户 2026-11-12 需求变更）"
no_semantic_change: false
```


| 字段 | 类型 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|---|
| `source_ref` | object | ✓/✓ | program（解析） | 溯源校验、评审、变更追溯 |
| `business_rules[].expression` | string | -/✓ | agent | 数据工厂、断言生成、测试点矩阵 |
| `business_rules[].boundary` | string[] | -/✓ | agent | 数据工厂（边界值） |
| `acceptance[].observable` | string | -/✓ | agent | 断言生成（可观测对象） |
| `clarifications` | object[] | ✓/✓ | agent/human | 阻塞判定（有 open 项则不可 approved） |
| `testability.score` | enum-ish | -/✓ | agent | 需求评审优先级 |

**三条硬规则**：
1. `source_ref.quote` 必须能在原文定位到（程序校验），**定位失败即视为编造**，不许 approved；
2. `clarifications` 存在 `status: open` 的项 → 状态锁在 `reviewing`，**不许 approved**（这是"禁止 agent 脑补"的机械保障）；
3. 每个 `business_rule` 必须至少被一个测试点覆盖（跨产物校验 V-21）。

### 3.2 `test_point` 测试点

**语义正文字段**：`title`、`scenario`、`expected`、`dimension`、`verification`

```yaml
# ---- 公共头（略）----
requirement: REQ-0045@3
dimension: boundary
matrix:                            # 矩阵坐标，去重与缺口统计用
  cell: "REQ-0045/boundary"
  axis: {requirement: REQ-0045, dimension: boundary}

title: 满减门槛边界值
scenario: 订单金额分别为 99.99 / 100.00 / 100.01 时的优惠计算
control_type: input_number

expected:                          # 断言的直接来源
  - id: E-01
    statement: 99.99 元订单不享受满减
    observable: order.discount_amount
    matcher: equals
    value: "0"
  - id: E-02
    statement: 100.00 元订单减免 10 元
    observable: order.discount_amount
    matcher: equals
    value: "10"
  - id: E-03
    statement: 100.01 元订单减免 10 元
    observable: order.discount_amount
    matcher: equals
    value: "10"

verification:                       # 验证方式分配（强制，防 UI 泛滥）
  primary: api
  secondary: [db]
  rationale: 金额计算属业务逻辑，UI 层只能看到展示值，无法判定计算正确性
  api_verifiable_but_ui: false      # 程序统计用（V-06 计算 30% 阈值）

priority: P1
knowledge_ref: ["KB-numeric-boundary@2"]   # 知识库命中，可追溯覆盖率来源
coverage_generated_by: matrix       # matrix | advisor | human
derived_from: ["REQ-0045@3"]
```

| 字段 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|
| `expected[].matcher` | -/✓ | agent | 断言生成；**仅允许 2.5 节白名单值**，越界即打回（V-35） |
| `expected[].matcher_args` | 条件✓ | agent | matcher 为 `between` / `abs_diff` / `regex` 时的参数（见 10.1） |
| `matrix.cell` | ✓/✓ | program | 去重、覆盖缺口计算、覆盖率报表 |
| `expected[].observable` | -/✓ | agent | **断言生成**（没有 observable 的预期无法机判） |
| `verification.primary` | ✓/✓ | program（规则表） | 验证方式分配校验、调度分池 |
| `verification.rationale` | -/✓ | agent | 人工评审；异常分配的解释 |
| `knowledge_ref` | -/- | program | 知识库覆盖率统计 |
| `coverage_generated_by` | ✓/✓ | program | **衡量 LLM 占比**：advisor 占比过高说明知识库不足 |

**为什么必须有 `observable`**：这是本契约最关键的设计之一。`expected` 若只写"页面显示 0 元"，断言只能靠 LLM 看图判断；写了 `observable: order.discount_amount` + `matcher` + `value`，就能程序判定。**没有 observable 的预期 = 不可判定 = 不许生成 decide 级断言。**

### 3.3 `case` 用例

**语义正文字段**：`title`、`preconditions`、`steps[].intent`、`assertions`

```yaml
# ---- 公共头（略）----
test_point: TP-0045-02@1
title: 满减边界 - 订单金额 99.99 不享受满减
primary_driver: api

preconditions:
  - {type: account, ref: "cred://internal-qa/vip01"}
  - {type: fragment, ref: "FRAG-login@2"}
  - {type: data, ref: "data://ds-order-boundary@1"}

dataset: "data://ds-order-boundary@1"

steps:                              # 概要级；可执行细节在 plan
  - {id: s1, intent: 以 99.99 元创建订单, driver: api}
  - {id: s2, intent: 查询订单优惠金额, driver: api}

assertions:                         # ★ 断言来源强制可追溯
  - id: a1
    source: "TP-0045-02@1#E-01"     # 必须指向 test_point.expected[].id
    level: decide
    statement: 优惠金额为 0
  - id: a2
    source: "TP-0045-02@1#E-01"
    level: observe
    statement: 订单状态为已创建

budget:
  max_steps: 8
  max_duration_ms: 30000

teardown:
  - {action: request, intent: 删除测试订单}

tags: [regression, api, boundary]
derived_from: ["TP-0045-02@1"]
```

| 字段 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|
| `test_point` | ✓/✓ | program | 血缘、覆盖率 |
| `primary_driver` | ✓/✓ | program（取自 test_point.verification） | 调度分池、断言类型合法性 |
| `assertions[].source` | -/✓ | program（校验），agent（生成时填） | **断言来源闸**（V-07）；防 LLM 编断言 |
| `assertions[].level` | -/✓ | agent + 规则覆写 | 判定性/观察性分流、错误通过率统计 |
| `budget` | ✓/✓ | program（默认值 + 规则） | 防失控（V-08） |
| `dataset` | -/- | program | 数据隔离、多环境复用 |

**三条硬规则**：
1. **每条 `decide` 断言必须有 `source`**，且 source 必须指向真实存在的 `test_point.expected[].id`（跨产物校验 V-07）；
2. **至少一条 `decide` 断言**，否则不许 approved（V-08，对应"无断言不算通过"）；
3. 步骤数超过 `budget.max_steps` 直接打回（对应 Hifox 的"用例条数预算"经验）。

### 3.4 `plan` 执行计划

**语义正文字段**：`steps`（含 locators / wait / assert）、`environment`、`fragments`

完整步骤骨架见 v3 文档 7.3，此处只列 IR 必备字段与编译元数据：

```yaml
# ---- 公共头（略）----
case_ref: CASE-00123@1
primary_driver: web

compiled_from:                      # 编译溯源
  explore_run: explore-20261113-1420
  compiler_version: "1.0.3"
  compiled_at: 2026-11-13T15:20:00+08:00
  compiled_by: program:compiler

gates:                              # ★ 五道闸结果，缺一不可 approved
  locator_unique:      {pass: true, checked: 6, failures: []}
  assertion_decidable: {pass: true, checked: 4, failures: []}
  data_no_hardcode:    {pass: true, findings: []}
  traceable:           {pass: true, orphans: []}
  replay_verified:     {pass: true, exec_ref: EXEC-8820, attempts: 3, identical: true}

touched:                            # ★ 影响分析主数据源，重放时自动刷新
  pages: [/login, /order/create]
  apis: ["POST /api/auth/login", "POST /api/order", "GET /api/coupon/calc"]
                                    # 10.2 决议：只记 method + path，不记入参签名
                                    # 入参取证在 evidence 包，长期资产不留（脱敏 + 索引成本）

fragments: ["FRAG-login@2"]

environment:
  target: internal-qa
  variant: chrome-1280

context_flow: []                    # 混合 driver 时必填（见 v3 11.5）
steps: [...]                        # 见 v3 7.3
teardown: [...]
```

| 字段 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|
| `gates` | -/✓ | program | 入库闸（V-09）；审计"这个计划凭什么可信" |
| `gates.replay_verified.exec_ref` | -/✓ | program | **防伪造**：指向真实执行记录，可反查 |
| `touched` | ✓/✓ | program | 影响分析、回归选集、资产刷新 |
| `fragments` | -/- | program | 片段变更 → 用例失效传播 |
| `context_flow` | 混合时✓ | program | 跨 driver 数据传递（V-13） |

**硬规则**：`gates` 五项全 `pass` 才允许 `status: approved`；任何一项 `pass: false` 的计划**只能停在 `draft`**，不允许"先跑着看"。

### 3.5 `exec` 执行结果

**语义正文字段**：无（纯事实记录，不参与版本演进，每次执行产生新记录）

```yaml
# ---- 公共头（略；status 恒为 approved，version 恒为 1）----
plan_ref: PLAN-00123@1
case_ref: CASE-00123@1
suite_ref: SUITE-core-20261113@1 | null

attempt: 1                          # 第几次执行（仅事实，不参与通过判定）
verdict: fail                       # pass|fail|flaky|skipped|inconclusive
verdict_reason: "断言 a1 失败：期望 0，实际 10"
inconclusive_kind: null             # verdict=inconclusive 时必填

steps:
  - {id: s1, status: pass, driver: web, duration_ms: 210, locator_hit: null}
  - {id: s2, status: pass, driver: web, duration_ms: 130, locator_hit: 3}
  - {id: s3, status: fail, driver: api, duration_ms: 88,
     failed_assert: a1, evidence_ref: "evidence://EXEC-8821/s3"}

assertions:                         # 断言级明细（错误通过率统计依赖它）
  - {id: a1, level: decide, result: fail, expected: "0", actual: "10"}
  - {id: a2, level: observe, result: pass}

evidence_ref: "evidence://EXEC-8821"
self_heal:
  - {level: L2, step: s2, action: extend_wait, from_ms: 500, to_ms: 1500}

touched:                            # 实际刷新值（可能与 plan 不同）
  pages: [/login, /order/create]
  apis: ["POST /api/order"]

metrics:
  duration_ms: 1820
  llm_calls: 0                      # ★ 重放零 LLM 的可验证证据
  llm_tokens: 0
  cpu_ms: 940

environment:
  target: internal-qa
  variant: chrome-1280
  engine_version: "0.9.1"

consistency:                        # ★ N=3 一致性（入库门槛）
                                    # 10.3 决议：内嵌于 exec，不设独立 CGROUP 产物
                                    # 理由：N=3 是"这条计划可不可信"的属性，不是独立实体
  group: CG-00123-20261113          # 同组多次执行共享 group，由程序生成
  runs: 3
  identical: true
  divergent_runs: []
  baseline_exec: EXEC-8821          # 取第一次执行作为基线，其余与之逐断言比对
  diff_detail: []                   # 不一致时列出 {assert_id, per_run_results}

started_at: 2026-11-13T16:40:12+08:00
finished_at: 2026-11-13T16:40:14+08:00
```

| 字段 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|
| `verdict` | ✓/✓ | program（断言引擎） | 报表、准入结论、flaky 检测 |
| `inconclusive_kind` | 条件✓ | program | **准入结论单独统计**；区分环境问题与质量问题 |
| `assertions[].expected/actual` | -/✓ | program | 错误通过率、断言有效性分析 |
| `self_heal` | -/- | program | 资产健康度扣分、flaky 前兆 |
| `metrics.llm_calls/tokens` | ✓/✓ | program | **证明"重放零 LLM"**；成本趋势 |
| `consistency` | -/✓ | program | 入库门槛（V-16）；flaky 判定 |
| `consistency.baseline_exec` | -/✓ | program | 一致性比对锚点；失败时回答"和哪一次不一致" |
| `consistency.diff_detail` | 条件✓ | program | `identical=false` 时必填，直接支撑 flaky 归因（不用 LLM 猜） |

**两条硬规则**：
1. `verdict: pass` 的前提是**所有 `decide` 断言都 pass**（V-14）；`observe` 失败不改变 verdict，但必须记录；
2. **`attempt > 1` 不影响 verdict 计算**：重试只用于判断环境抖动，绝不允许"第二次通过就算通过"（对应"禁用含重试的通过率"）。

### 3.6 `defect` 缺陷

**语义正文字段**：`title`、`description`、`attribution.category`

```yaml
# ---- 公共头（略）----
title: 满减门槛在 100.01 元时未生效
description: 订单金额 100.01 元时优惠金额为 0，预期 10。

found_by:
  exec_ref: EXEC-8821@1
  case_ref: CASE-00123@1
  step: s3
  found_at: 2026-11-13T16:40:14+08:00

fingerprint: "sha256:7b1c..."       # failed_assert + target + error_signature
dedup:
  decision: new                     # new|merged|linked
  similar: [{defect: DEF-0012, similarity: 0.91}]
  merged_into: null

attribution:
  category: product_bug             # product_bug|script_issue|env_issue|data_issue|flaky|unknown
  confidence: 0.86
  evidence: ["evidence://EXEC-8821"]
  by: agent:defect_analysis_agent
  rationale: 接口返回 discount=0，但同类金额 100.00 返回 10，判定为边界条件未处理

severity: S2
affected:
  module: order
  requirements: ["REQ-0045@3"]
  cases: ["CASE-00123@1"]

lifecycle: confirmed
verification:                       # ★ fixed → closed 的必过关卡
  fixed_claim: {ref: "commit:abc1234", at: 2026-11-14T10:00:00+08:00, by: "human:dev_li"}
  verify_exec: {ref: EXEC-8901@1, verdict: pass, at: 2026-11-14T15:00:00+08:00}

external: {system: jira, key: "CRM-1234"}
reopen_history: []
```

| 字段 | 必填(d/a) | writer | 消费者 |
|---|---|---|---|
| `fingerprint` | ✓/✓ | program | **去重主键**（防重复提单） |
| `dedup` | -/✓ | program | 去重决策可审计 |
| `attribution.category` | -/✓ | agent | 误报率统计、团队 triage |
| `attribution.confidence` | -/✓ | agent | 低置信转人工阈值 |
| `verification.verify_exec` | -/✓ | program | **`closed` 前置条件**（V-17） |
| `lifecycle` | ✓/✓ | program（状态机） | 缺陷趋势、报告 |

**硬规则**：`lifecycle: closed` 必须存在 `verification.verify_exec` 且 `verdict: pass`（V-17）。这是现有工程"fixed 只是修复声明，关闭必须绑独立复测"不变量的结构化落点。



---

## 4. 两份附属契约

### 4.1 `report` 报告（数字由程序算，LLM 只写 insights）

```yaml
# ---- 公共头（略）----
# 10.4 决议：报告走状态机 draft → reviewing → approved
#   draft      ：程序聚合完成、insights 未审 → 只能内部查看，不得对外发出
#   reviewing  ：已提交质量负责人
#   approved   ：必须带 approved_by（human），此时准入结论才具备对外效力
period: {from: 2026-11-13T00:00:00+08:00, to: 2026-11-23T23:59:59+08:00}
suite_refs: ["SUITE-core-20261113@1"]

admission:                          # 准入结论（程序算）
  requirement_coverage: {value: 1.00, detail: "6/6 需求项有执行用例"}
  impact_coverage:      {value: 0.955, detail: "168/176 受影响用例已执行"}
  asset_health:         {value: 0.92, detail: "168 中 13 条 flaky/跳过"}
  verdict: conditional              # pass | conditional | no_conclusion
  reasons: ["影响覆盖度 95.5% 未达 100%，未测 8 条见 excluded"]

execution:                          # 事实统计（程序算）
  total: 176
  pass: 151
  fail: 12
  flaky: 9
  skipped: 4
  inconclusive: 0                   # ★ 必须单列
  first_run_pass_rate: 0.858        # ★ 不含重试

defects: {new: 6, reproduced: 3, closed: 4, by_severity: {S1: 0, S2: 2, S3: 4, S4: 0}}

facts: [...]                        # 程序生成，只读
insights:                           # LLM 生成，每条必须挂引用
  - id: INS-01
    risk: 优惠模块失败率上升 12%，但失败中 60% 为 inconclusive
    evidence: ["metric:module_failure_rate.order@RPT-20261106", "exec:EXEC-8890", "exec:EXEC-8902"]
    suggestion: 先排查测试环境依赖服务，再判定质量下降
    confidence: 0.78
    by: agent:test_report_agent
  - id: INS-02
    risk: 覆盖率 100% 但 58% 用例仅 observe 级断言，存在错误通过风险
    evidence: ["metric:assert_level_distribution@RPT-20261113"]
    suggestion: 对 order 模块补充 decide 级断言
    confidence: 0.9

risks_opened: ["RISK-0007", "RISK-0008"]
```

**校验规则**：
- `facts` 中每个数字必须能在指标包里找到同值，**不一致直接丢弃该条**（V-18）；
- `insights[].evidence` 不得为空（V-19）；
- 允许 `insights: []`，并统计空输出率。

### 4.2 `risk` 风险台账

```yaml
# ---- 公共头（略）----
phenomenon: order 模块 inconclusive 比例连续 3 轮上升
evidence: ["RPT-20261106", "RPT-20261113"]
severity: medium
owner: "human:qa_zhang"
status: tracking                    # new|tracking|mitigated|accepted|escalated|closed
first_seen: RPT-20261106@1
last_seen: RPT-20261113@1
occurrences: 3
status_history:
  - {from: new, to: tracking, at: ..., by: "human:qa_zhang", note: "已联系运维排查依赖服务"}
resolution: null
```

**校验规则**：同一 `phenomenon` 的 `content_hash` 相似度 > 0.9 时**必须合并**，不允许重复开风险（V-26）；`status: closed` 必须有 `resolution`。

---

## 5. 校验规则清单（38 条，可直接实现为校验器）

> **可执行验收**：《AITestHarness校验器测试用例集-v1.md》给出 M1 范围内 24 条规则的 fixture（97 个用例，35 正 / 62 反）与错误码表。**规则实现是否合格，以该用例集全绿为准**，不以代码 review 为准。

**分层**：`S` = schema 层（类型/枚举/必填，静态）；`M` = 语义层（跨字段逻辑，单产物内）；`X` = 跨产物层（需查库）。

| # | 层 | 规则 | 失败处置 | 实现要点 |
|---|---|---|---|---|
| V-01 | S | 公共头 14 字段齐全 | 拒绝解析 | schema 校验器 |
| V-02 | S | 所有枚举值必须在 2.5 字典内 | 拒绝入库 | 枚举白名单 |
| V-03 | S | `id` 格式符合前缀规范且项目内唯一 | 拒绝入库 | 前缀正则 + 唯一索引 |
| V-04 | S | 时间为 ISO8601 带时区；金额为字符串十进制 | 拒绝入库 | 正则 + 类型检查 |
| V-05 | S | 产物中不得出现凭证明文 | **拒绝入库并告警** | 正则（密码/token/密钥模式）+ 敏感词字典 |
| V-06 | S | `status=approved` 时全部 approved 必填字段齐全 | 状态迁移阻塞 | 按 IR 类型查必填表 |
| V-07 | S | `actor` 格式必须为 `program:`/`agent:`/`human:` 前缀 | 拒绝解析 | 正则 |
| V-08 | S | 引用语法合法（`${ns.key}` / `id@ver` / `data://` / `evidence://` / `cred://`） | 拒绝入库 | 引用解析器 |
| V-09 | M | `approved_by` 必须非空且**至少一个 human actor** | 不许 approved | 状态机前置 |
| V-10 | M | `requirement.clarifications` 存在 `open` 项时不许 approved | 状态锁在 reviewing | 状态机前置 |
| V-11 | M | `requirement.source_ref.quote` 非空；`business_rules` 至少一条 | 不许 approved | 语义校验 |
| V-12 | M | `test_point.verification.primary` 必填，且必须在 `driver_kind` 内 | 拒绝入库 | 枚举校验 |
| V-13 | M | 分配为 `ui` 的测试点必须有 `verification.rationale` | 打回补写 | 条件必填 |
| V-14 | M | 要生成 `decide` 断言的 `expected` 必须有 `observable + matcher + value` | 不许生成断言 | 逐条检查预期 |
| V-15 | M | `case.assertions` 至少一条 `level=decide` | 不许 approved | 对应"无断言不算通过" |
| V-16 | M | `case.steps` 数量 ≤ `budget.max_steps` | 打回拆分 | 计数 |
| V-17 | M | `plan.gates` 五项全 `pass: true` | 只许停在 draft | 五闸结果检查 |
| V-18 | M | `plan` 的每个 `wait.type` 必须在封闭枚举内；**禁止 `sleep`/固定 timeout** | 拒绝入库 | 枚举 + 关键字扫描 |
| V-19 | M | `plan` 定位不得使用坐标或绝对路径（`/html/body/div[2]…`） | 拒绝入库 | 正则 + 指纹类型检查 |
| V-20 | M | `exec.verdict=pass` 要求所有 `decide` 断言 `result=pass` | verdict 强制改 fail | 断言汇总 |
| V-21 | M | `exec.verdict=inconclusive` 时 `inconclusive_kind` 必填 | 拒绝入库 | 条件必填 |
| V-22 | M | `defect.lifecycle=closed` 必须有 `verification.verify_exec.verdict=pass` | 不许 closed | 状态机前置 |
| V-23 | M | `report.facts` 每个数字必须能在指标包找到同值 | **丢弃该条并告警** | 数值反查 |
| V-24 | M | `report.insights[].evidence` 非空，且引用必须可解析 | 丢弃该条洞察 | 引用校验 |
| V-25 | M | 混合 driver 计划必须有 `context_flow`，且 driver 段数 ≤2、不折返 | 拒绝入库 | 步骤 driver 序列扫描 |
| V-26 | M | `risk.status=closed` 必须有 `resolution`；同现象相似度>0.9 必须合并 | 拒绝 closed / 强制合并 | 相似度检索 |
| V-27 | X | `derived_from` 引用的产物必须存在且版本有效 | 拒绝入库 | 查库 |
| V-28 | X | `source_ref.quote` 必须能在原文定位 | **视为编造，不许 approved** | 原文检索（精确 + 模糊兜底） |
| V-29 | X | 每个 `business_rule` 至少被一个 `test_point` 覆盖 | approved 阻塞，列缺口 | 反向索引 |
| V-30 | X | `case.assertions[].source` 必须指向存在的 `test_point.expected[].id` | 拒绝入库 | 跨产物引用检查 |
| V-31 | X | `plan.case_ref`、`plan.gates.replay_verified.exec_ref`、`exec.plan_ref`、`defect.found_by.exec_ref` 必须存在 | 拒绝入库 | 引用完整性 |
| V-32 | X | `suite` 每条用例必须有 `reason`；`consistency.identical=false` 的 plan 不得入选 | 拒绝生成该 suite | 选集器内置 |
| V-33 | X | 覆盖率双向对账：需求项 ↔ 测试点 ↔ 用例 两个方向 diff 必须为空 | 阻塞准入结论 | 集合运算，零 LLM |
| V-34 | X | 上游升版时，血缘闭包内所有下游必须被标记 `needs_recompute` | 阻塞新版本 approved | 图遍历 |
| V-35 | M | `expected[].matcher` ∈ 2.5 节白名单；`matcher_args` 与类型匹配（10.1 #1） | 不许生成断言 | 白名单比对 |
| V-36 | M | `report` 对外导出必须 `status=approved` 且 `approved_by` 含 human（10.1 #4） | 拒绝导出 | 状态机前置 |
| V-37 | M | 同一 `case_ref` 只允许一份 `plan`，环境差异入 `variants/`（10.1 #6） | 拒绝入库 | 索引唯一性检查 |
| V-38 | S | 数值型 `range` / `value` / `boundary` 必须为字符串十进制，检测到 float 报错（10.1 #7） | schema 拒绝 | YAML 加载时类型断言 |

**实现优先级建议**：

| 批次 | 规则 | 理由 |
|---|---|---|
| M1 必做 | V-01~V-08、V-15~V-21、V-27、V-30、V-31、**V-37、V-38** | schema + 执行链路完整性，直接支撑"重放可复现"；V-37/V-38 属落地即生效的硬约束 |
| M1 应做 | V-05、V-14、**V-35**、V-33 | 防凭证泄露、防不可判定断言（含 matcher 越界）、覆盖率对账 |
| M2 做 | V-09~V-13、V-28、V-29、V-34、**V-36** | 依赖需求分析链路、原文库与报告状态机 |
| M3 做 | V-22~V-26、V-32 | 依赖缺陷库、报告、回归集 |

---

## 6. 跨产物约束（四条核心机制）

### 6.1 断言来源链（防 LLM 编断言）

```
requirement.acceptance[].observable
      ↓ 生成
test_point.expected[] {observable, matcher, value}
      ↓ 引用
case.assertions[].source = "TP-xxxx#E-xx"
      ↓ 编译
plan.steps[].assert
      ↓ 执行
exec.assertions[] {expected, actual, result}
```

**任何一环缺失，链条就断，断言失效**。校验器 V-30 检查第三环，V-14 检查第二环的可判定性。

> 这是整套契约里最重要的一条链：它保证"用例通过"这件事有据可查，而不是模型看完页面觉得"应该没问题"。**通用 agent 做测试的根本缺陷就在这里——它的断言没有上游。**

### 6.2 血缘完整性

六张边，全部由程序维护：

| 边 | 写入时机 | 用途 |
|---|---|---|
| `requirement → test_point` | 测试点生成时 | 变更传播、覆盖率 |
| `test_point → case` | 用例生成时（`test_point` 字段） | 变更传播、选集 |
| `case → plan` | 编译时（`plan.case_ref`） | 执行追溯、回归 |
| `plan → exec` | 每次执行（`exec.plan_ref`） | 历史对比、flaky |
| `exec → defect` | 提缺陷时（`defect.found_by`） | 缺陷复测、召回率 |
| `plan → touched` | 编译 + 每次重放刷新 | **影响分析** |

**无父产物的产物 = 孤儿**，V-27 拦截。孤儿产物的唯一合法来源是 `source_type: reverse_engineering`（探索逆向需求），此时 `derived_from` 指向探索运行 ID。

### 6.3 覆盖率对账（零 LLM，双向）

```
正向：requirement.business_rules → 是否有 test_point 覆盖？
反向：test_point → 其 requirement 是否真的包含这个业务点？
```

程序算集合差，两个方向都必须为空。**不允许用 LLM 判断"覆盖够不够"**——那正是"覆盖率看起来 100% 但实际漏了"的来源。

### 6.4 选集可解释

`suite` 中每条用例必须带 `reason`，且 `reason` 只能取以下可计算来源：

```yaml
reason:
  - {type: requirement_change, ref: "REQ-0045@3"}
  - {type: touched_api, ref: "POST /api/order"}
  - {type: fragment_change, ref: "FRAG-login@1→2"}
  - {type: module_change, ref: "order-service"}
  - {type: manual, ref: "human:zhang"}
  - {type: historical_similar, ref: "CASE-00456", score: 0.82}
```

**禁止** `reason: "AI 认为相关"`。不可解释的选集在测试团队里没有信任基础。

---

## 7. 字段-机制映射（防膨胀审计）

反向审计用：每个字段必须被至少一个机制消费。**下表外的字段视为待删**。

| 机制 | 依赖字段 |
|---|---|
| **溯源与审计** | `source_ref.*`、`created_by`、`approved_by`、`status_history` |
| **变更传播（增量重算）** | `version`、`content_hash`、`derived_from`、`no_semantic_change` |
| **断言合法性** | `acceptance[].observable`、`expected[].observable/matcher/value`、`assertions[].source` |
| **测试点完备性** | `matrix.cell`、`dimension`、`coverage_generated_by`、`knowledge_ref` |
| **验证方式治理** | `verification.primary/secondary/rationale`、`api_verifiable_but_ui` |
| **防失控** | `budget.max_steps`、`budget.max_duration_ms`、探索预算（运行参数） |
| **可复现门槛** | `gates.*`、`consistency.group/runs/identical/baseline_exec/diff_detail`、`metrics.llm_calls` |
| **影响分析与选集** | `touched.pages/apis`、`module`、`fragments`、`reason[]`、`variants/*` |
| **断言可判定性** | `expected[].matcher`（白名单）、`matcher_args`、`verification.primary` |
| **归因与去重** | `fingerprint`、`dedup.*`、`attribution.*`、`evidence_ref` |
| **准入结论** | `verdict`、`inconclusive_kind`、`assertions[].level`、`first_run_pass_rate` |
| **缺陷闭环** | `lifecycle`、`verification.verify_exec`、`reopen_history` |
| **报告可信** | `facts`（数字来源）、`insights[].evidence` |
| **风险收敛** | `risk.status`、`occurrences`、`status_history` |

**审计方法**：新增字段时，必须在 PR 中写明"消费它的机制 + 不填的后果"，否则拒绝合入。这条规则本身比任何字段设计都重要——**它是防止 schema 在半年后变成"谁都能往里塞东西"的唯一机制**。

---

## 8. 版本演进与兼容

### 8.1 两种版本号，别混

| 版本号 | 含义 | 谁改 |
|---|---|---|
| `schema_version` | **契约本身**的版本（本文件） | 架构师，走附录 A 流程 |
| 产物 `version` | **单条产物内容**的版本 | 程序，语义变更自动 +1 |

### 8.2 契约变更规则

| 变更类型 | 允许 | 处置 |
|---|---|---|
| 新增**可选**字段 | ✓ | `schema_version` 次版本 +1（1.0 → 1.1）；旧产物无需迁移 |
| 新增**必填**字段 | ✗（除非大版本） | 需提供迁移脚本 + 默认值方案 |
| 新增枚举值 | 需评审 | 次版本 +1；**旧校验器必须能容忍未识别值并降级为 `unknown`** |
| 删除字段 | ✗（当前大版本内） | 先标 `deprecated` 一个大版本，仍解析不使用 |
| 修改字段语义 | ✗ | 必须新建字段 + 并行一段时间 |

### 8.3 兼容性底线

**校验器必须宽容读取、严格写入**：读到未知字段忽略并记录 warning，写入时只输出本规范定义的字段。

理由：多方并行交付（WorkBuddy / codex / Trae / Qoder）是当前现实，严格拒绝未知字段会导致任何一方升级就全网阻塞。

---

## 9. 端到端示例：一条需求走完全链路（含变更增量）

### 9.1 初次生成

```
REQ-0045@1  「满100减10」
   │  (矩阵 + 知识库 → 生成 3 个测试点)
   ├─ TP-0045-01  functional   正常满减          verification: api
   ├─ TP-0045-02  boundary     门槛边界          verification: api (+db)
   └─ TP-0045-03  exception    不满足门槛        verification: api
        │  (每个测试点 → 用例)
        ├─ CASE-00123  ← TP-0045-02  assertions: a1(source=E-01), a2(source=E-02)
        │     └─ PLAN-00123  gates 全 pass, touched: [POST /api/order, GET /api/coupon/calc]
        │           └─ EXEC-8821  verdict=pass, llm_calls=0, consistency.identical=true
        ├─ CASE-00124
        └─ CASE-00125
```


**此时覆盖矩阵**：3 个格子已填，`coverage_generated_by: matrix`（3/3 由矩阵生成，LLM 未介入）。

### 9.2 需求变更（门槛 100 → 200）

```
REQ-0045@2  语义正文变化 → content_hash 变 → version 2

【程序执行，零 LLM】
1. 求血缘闭包：
   REQ-0045@2 → TP-0045-01/02/03 → CASE-00123/124/125 → PLAN-* → EXEC 历史
2. 标记 needs_recompute：
   TP-0045-02（boundary 涉及 100/200 边界，必重算）
   TP-0045-01（functional 涉及满减金额，必重算）
   TP-0045-03（exception 门槛值 99.99 需改 199.99，必重算）
   → 三条全中。若只有 TP-0045-02 涉及，则只重算这一条。
3. 输出增量任务：3 个测试点 + 3 条用例 + 3 份计划
```

**关键点**：重算的是"这一支"，不是全项目。若这个项目有 500 条用例，只有 3 条被触及。

### 9.3 增量重算与人工审 diff

```diff
# TP-0045-02@1 → @2
  expected:
    - {id: E-01, statement: 99.99 元订单不享受满减, value: "0"}
-   - {id: E-02, statement: 100.00 元订单减免 10 元, value: "10"}
-   - {id: E-03, statement: 100.01 元订单减免 10 元, value: "10"}
+   - {id: E-02, statement: 199.99 元订单减免 0 元, value: "0"}
+   - {id: E-03, statement: 200.00 元订单减免 10 元, value: "10"}
+   - {id: E-04, statement: 200.01 元订单减免 10 元, value: "10"}
  derived_from: ["REQ-0045@2"]
```

**注意**：`E-01` 保留不变（99.99 仍然不该享受满减），**只有真正变化的部分产生 diff**。这就是"人工只审 diff"能成立的原因。

### 9.4 表述变更（不触发重算）

```
REQ-0045@2 → @3  （仅 PRD 章节重排 + 措辞调整）
content_hash: 不变 → version 不升 → 不产生任何重算任务
```

若正文确实改了但不影响语义（把"满100元"写成"订单满一百元"），指纹会变 → 触发重算。此时人工在 diff 中确认无实质变化后标 `no_semantic_change: true`，程序回滚该次重算任务并写审计日志。

### 9.5 断言链在变更中的表现

```
CASE-00123@1  assertions[0].source = "TP-0045-02@1#E-02"
   ↓ 测试点升版后 E-02 语义变化
V-30 校验：source 指向 "TP-0045-02@1#E-02" 仍合法（版本固定）
但 V-34 校验：TP 已升版，CASE 必须标记 needs_recompute
   ↓
CASE-00123@2  assertions[0].source = "TP-0045-02@2#E-03"   ← 重新指向新的正确预期
```

**设计取舍**：`source` 引用**精确版本**而非"跟随最新"，是为了让"旧用例仍在引用旧预期"变成**可见的错误**，而不是悄悄跟着变。悄悄跟随会导致"用例自动通过但预期已错"——那是最危险的错误通过。

---

## 10. 决议表（2026-11-13 定稿）

> 本章原标题为"待确认项"。**7 项已于 2026-11-13 全部拍板**，以下为决策记录；括号内为实现落点，已同步写入前文各节与第 6 章校验表。
> 定稿后如需变更，走附录 A 流程。

### 10.1 决议一览

| # | 问题 | 决议 | 落点 |
|---|---|---|---|
| 1 | `expected.matcher` 是否支持表达式 | **支持，但仅限白名单函数**（`abs_diff` / `round` / `len`），禁止自由脚本 | 2.5 节 `matcher` / `matcher_fn_whitelist`；V-35 |
| 2 | `touched.apis` 是否记录入参签名 | **不记录**。长期资产只留 method + path；入参取证放 evidence 包 | 3.4 节 `touched` 注释 |
| 3 | `exec.consistency` 内嵌还是独立产物 | **内嵌**。补 `baseline_exec` + `diff_detail` | 3.5 节 `consistency` |
| 4 | `report` 是否走状态机 | **要**。`draft → reviewing → approved`，对外效力绑定 human 确认 | 4.1 节头注释；V-36 |
| 5 | 探索是否需要独立 IR | **需要，但作为 `plan` 的变体**（`type: explore_session`），M2 实施 | 见 10.5 |
| 6 | 多环境是一份 plan 多 variant 还是多份 plan | **一份 plan + variant 文件**。禁止多份 plan | 见 10.6；V-37 |
| 7 | `data_constraints.range` 类型 | **字符串十进制**，禁止 YAML 浮点；解析时按 `type` 转换 | 3.1 节示例；V-38 |

### 10.2 逐项说明（含被否决方案的理由）

**#1 matcher 白名单**

```yaml
# 允许
matcher: abs_diff
matcher_args: {tolerance: "0.01"}     # 金额容差

matcher: between
matcher_args: {min: "100.00", max: "200.00"}

matcher: regex
matcher_args: {pattern: "^[A-Z]{2}\\d{6}$"}
```

```yaml
# 禁止——会让校验器无法静态判定
matcher: "abs(actual - expected) < 0.01"
```

被否决方案：开放表达式（含 `eval`）。理由不是安全，而是**可判定性**——表达式一旦自由，校验器无法在编译期判断"这条断言是否有意义"，等于把判定权重新交回给运行时。

**#2 入参与取证分离**

| 诉求 | 落点 | 生命周期 |
|---|---|---|
| 影响分析需要知道"碰了哪些接口" | `touched.apis`（method + path） | 长期资产，参与索引 |
| 缺陷定位需要知道"这次请求带了什么" | `evidence://<exec>/<step>` 内的请求明细 | 按保留期清理 |

被否决方案：`touched` 记录入参。理由：入参会随时间无界膨胀，且涉及 PII/凭证脱敏的持续义务；而它对影响分析没有增量价值（入参变化必然体现在断言或数据引用上）。

**#3 consistency 内嵌**

补两个字段，让"不一致"可归因而不用 LLM 猜：

- `baseline_exec`：取第一次执行作基线，其余与之逐断言比对；
- `diff_detail`：`identical=false` 时必填，直接给出 `{assert_id, per_run_results}`。

被否决方案：独立 `CGROUP` 产物。理由：N=3 不是独立业务实体，拆出去后所有查询都要 join，"这条计划可信吗"变成一个三段查询。

**#4 报告状态机**

| 状态 | 谁能推进 | 含义 |
|---|---|---|
| `draft` | program | 数字已算、insights 未审；**不得对外发出** |
| `reviewing` | program / human | 已提交确认 |
| `approved` | **human** | 准入结论具备对外效力 |

理由：报告如果可无人确认就发出，第 13 章的准入结论（可上线 / 有条件 / 不给结论）就成了系统自说自话，管理层不会认。

**#5 探索作为 plan 变体**

```yaml
type: explore_session                # plan 的子类型
explore:
  budget: {max_pages: 50, max_touch_pages: 10, max_actions_per_page: 5}
  coverage: {inspected: 38, total: 52, queue_remaining: 14}
  danger_policy: read_only           # read_only | allow_submit_whitelist
```

理由：探索产物与 plan 共享 `touched` / `steps` / `evidence` 结构，复用一个 schema 即可；独立 IR 会造成两套步骤模型，M2 再改成本更高。

**#6 一 plan 多 variant（本表影响最大的一项）**

```
plan/CASE-00123.yaml               ← 唯一血缘实体
variants/
  internal-qa.chrome-1280.yaml     ← 覆盖 locators / data 引用 / base_url
  staging.chrome-1440.yaml
  prod-readonly.api.yaml
```

被否决方案：多份 plan。后果是**一条用例在三个环境变成三条血缘分支**：一次需求变更要重算三次、三次人工确认、flaky 率三倍统计样本，而它们本质上是同一件事。

**#7 range 用字符串十进制**

```yaml
range: ["0.01", "999999.99"]     # 正确
range: [0.01, 999999.99]         # 禁止（YAML 解析为 float）
```

理由：`0.1 + 0.2 != 0.3` 在金额断言上直接造成误报，而误报是这套体系最不能容忍的损耗——它会训练团队忽略失败。

### 10.3 配套新增校验规则

| 编号 | 级别 | 校验 | 失败处置 |
|---|---|---|---|
| V-35 | M | `expected[].matcher` ∈ 2.5 节白名单；`matcher_args` 与 matcher 类型匹配 | 不许生成断言 |
| V-36 | M | `report` 对外发出（`exported=true`）必须 `status=approved` 且 `approved_by` 含 human | 拒绝导出 |
| V-37 | M | 同一 `case_ref` 只允许一份 `plan`，环境差异必须落在 `variants/` | 拒绝入库 |
| V-38 | S | 数值型 `range` / `value` / `boundary` 一律为字符串十进制；检测到 float 即报错 | schema 拒绝 |

### 10.4 仍属开放（不阻塞 v1 实施）

| # | 项 | 现状 | 何时定 |
|---|---|---|---|
| O-1 | `matcher: semantic`（语义断言）的输出格式 | 目前只约定"输入结构化摘要 + 输出带模型标记" | M2 |
| O-2 | evidence 包保留期与脱敏策略 | 未定 | M1 落地前 |
| O-3 | 探索 `type: explore_session` 的完整字段 | 仅有骨架 | M2 |

---

## 附录 A：契约变更流程

```
1. 提出：写明「新增/修改什么字段 + 消费它的机制 + 不填的后果」
2. 审计：对照第 7 章，确认该字段有明确消费者（无消费者一律拒绝）
3. 影响面：列出受影响的 IR、校验器、agent 提示词、已有产物迁移方案
4. 评审：架构 + 至少一名开发 + 一名测试
5. 落地：schema_version 升版 + 校验器同步 + 迁移脚本（如需要）
6. 回归：用第 9 章的端到端样例跑一遍全链路，验证不断链
```

**在第 2 步被拒绝是常态，这是设计意图。**

## 附录 B：与 v3 方案的对应关系

| 本规范章节 | 对应 v3 章节 | 说明 |
|---|---|---|
| 2.2 公共头 | 6.1 | 血缘头的字段级落实 |
| 2.3 语义指纹 | 6.3 | 指纹算法定稿（去噪 + 字段清单） |
| 3.1 requirement | 10.2 | 需求分析阶段的产物 |
| 3.2 test_point | 10.3、11.6 | 含验证方式分配的字段落点 |
| 3.3 case | 10.4、7.3 | 断言来源链的中间环节 |
| 3.4 plan | 7、8 | 五道闸结果的结构化 |
| 3.5 exec | 12、14 | 五档结论、N=3、零 LLM 证据 |
| 3.6 defect | 10.5、14.6 | 生命周期与复测绑定 |
| 4.1 report | 16 | 审报告的四条约束 |
| 4.2 risk | 16.3 | 风险台账 |
| 第 5 章 | 17.2 | "防不可复现"约束的清单化 |
| 第 6 章 | 6.2、13 | 血缘、覆盖率对账、选集可解释 |

---

> **文档结束。** v1 定稿后，字段变更按附录 A 流程执行；新增字段若无明确消费者，一律拒绝合入。
