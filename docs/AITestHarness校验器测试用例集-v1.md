# AITestHarness 校验器测试用例集（V-Suite v1）

> 配套文档：《AITestHarness-IR契约规范-v1.md》第 5 章（38 条校验规则）。  
> 本文件把规则从"纸面规范"变成**可执行的验收依据**：每条规则给出至少 1 个正例（应通过）+ 1 个反例（应拦截），反例必须标注**期望的错误码**。  
> 覆盖面：**M1 必做 20 条 + M1 应做 4 条 = 24 条规则**，落地为 **13 条规则的完整用例（97 个）** + 11 条规则的最小用例模板（1 正 1 反）。M2/M3 规则给出模板，待实现时补齐。

---

## 0. 怎么用这份文件

### 0.1 三类读者

| 角色    | 用途                                                |
| ----- | ------------------------------------------------- |
| 开发    | 每个用例就是一条单元测试；`expected.code` 是断言值，必须与实现输出的错误码逐字一致 |
| 测试    | 用它验收"校验器是否真的拦得住"，而不是看代码 review                    |
| 产品/架构 | 看 0.4 的"拦截率看板"口径，这是向领导证明"这套体系不是靠模型自觉"的证据          |

### 0.2 执行约定

```bash
# 每个用例 = 一个 YAML fixture + 一条期望
vb run --suite V-Suite-v1 --case V01-N01 --fixture fixtures/V01-N01.yaml
# 期望输出（JSON）
{"case": "V01-N01", "rule": "V-01", "result": "rejected", "code": "HEADER_MISSING_FIELD",
 "field": "approved_by", "layer": "S"}
```

**判定标准**：`result` 与 `code` 必须同时匹配。**只匹配 `result` 不算通过**——否则所有规则都返回 `REJECTED` 也能"全绿"，那正是我们要防的"假通过"。

### 0.3 Fixture 组织

```
fixtures/
  _base/                        # 合法基线，所有反例从这里派生
    requirement.valid.yaml
    test_point.valid.yaml
    case.valid.yaml
    plan.valid.yaml
    exec.valid.yaml
    defect.valid.yaml
    report.valid.yaml
    risk.valid.yaml
  V01-N01.yaml                  # 命名：<规则号>-<N正常|A异常><序号>
  ...
```

**反例写法要求**：只改一处。如果一个反例改了三个字段，就无法证明是哪条规则拦住的——这是测试用例设计的基本纪律，也是最容易被偷懒破坏的地方。

### 0.4 拦截率看板（M1 验收口径）

| 指标        | 定义                                     | M1 目标                    |
| --------- | -------------------------------------- | ------------------------ |
| 规则覆盖率     | 已实现规则数 / M1 应实现规则数（24）                 | 100%                     |
| 用例覆盖率     | 通过的用例数 / **97**                        | 100%                     |
| **反例拦截率** | 反例中被正确拦下且错误码匹配的比例（62 个反例）              | **100%**（有一例不拦就是漏洞）      |
| 正例误杀率     | 正例被误拦的比例（35 个正例）                       | **0%**（误杀比漏拦更伤，会让团队绕过校验） |
| 越权写入拦截率   | agent 写 `program` 字段被拒的比例（8 个 PERM 反例） | 100%                     |

> 这五个数字就是"平台自身可信度"的度量，和第 14 章 flaky 治理是同一套哲学：**先证明自己不会乱来，再谈测得对不对。**

---

## 1. 基线 Fixture（所有正例的母本）

### 1.1 `_base/requirement.valid.yaml`

```yaml
schema_version: "1.0"
type: requirement
id: REQ-0045
version: 3
status: approved
project: proj-internal-crm
module: order
derived_from: ["REQ-0044@1"]
content_hash: "sha256:9f2a1b3c"
labels: []
created_at: 2026-11-13T17:00:00+08:00
created_by: agent:requirement_analysis_agent
updated_at: 2026-11-13T17:30:00+08:00
approved_by: ["human:lisi"]
notes: ""
title: 订单满减规则
source_ref:
  doc: prd/order-v3.docx
  page: 12
  para: "3.2 满减规则"
  quote: 订单金额满 100 元减 10 元
business_rules:
  - id: BR-01
    statement: 满 100 元减 10 元
    inputs: [order_amount]
    expression: "order_amount >= 100 ? discount = 10 : discount = 0"
    boundary: ["99.99", "100", "100.01"]
data_constraints:
  - field: order_amount
    type: "decimal(10,2)"
    range: ["0.01", "999999.99"]
    format: "两位小数"
    nullable: false
acceptance:
  - id: AC-01
    statement: 满 100 的订单实付 = 订单总额 - 10
    observable: order.pay_amount
clarifications: []
testability: {score: high, issues: []}
supersedes: REQ-0045@2
change_note: "满减门槛由 100 调整为 200"
no_semantic_change: false
```

### 1.2 `_base/plan.valid.yaml`（截取关键段，完整版见契约 3.4 + v3 7.3）

```yaml
schema_version: "1.0"
type: plan
id: PLAN-00123
version: 1
status: approved
project: proj-internal-crm
module: order
derived_from: ["CASE-00123@1"]
content_hash: "sha256:5d8e0f1a"
labels: []
created_at: 2026-11-13T15:20:00+08:00
created_by: program:compiler
updated_at: 2026-11-13T15:20:00+08:00
approved_by: ["human:lisi"]
notes: ""
case_ref: CASE-00123@1
primary_driver: web
compiled_from:
  explore_run: explore-20261113-1420
  compiler_version: "1.0.3"
  compiled_at: 2026-11-13T15:20:00+08:00
  compiled_by: program:compiler
gates:
  locator_unique:      {pass: true, checked: 6, failures: []}
  assertion_decidable: {pass: true, checked: 4, failures: []}
  data_no_hardcode:    {pass: true, findings: []}
  traceable:           {pass: true, orphans: []}
  replay_verified:     {pass: true, exec_ref: EXEC-8820@1, attempts: 3, identical: true}
touched:
  pages: [/login, /order/create]
  apis: ["POST /api/auth/login", "POST /api/order"]
fragments: ["FRAG-login@2"]
environment: {target: internal-qa, variant: chrome-1280}
context_flow: []
steps:
  - id: s1
    intent: 打开登录页
    action: goto
    target: {url: /login}
    assert: [{type: url_contains, value: /login, level: decide}]
  - id: s2
    intent: 填写账号
    action: fill
    target:
      locators:
        - {testid: login-username}
        - {role: textbox, name: 用户名}
    value: ${data.username}
    assert: [{type: value_equals, expected: ${data.username}, level: observe}]
  - id: s3
    intent: 点击登录
    action: click
    target:
      locators:
        - {testid: login-submit}
        - {role: button, name: 登录}
    wait:
      - {type: network_idle, idle_ms: 500}
      - {type: element_stable, target: {testid: login-form}}
    assert: [{type: text_visible, value: 密码错误, level: decide}]
teardown:
  - {action: reset_session}
```

### 1.3 `_base/exec.valid.yaml`

```yaml
schema_version: "1.0"
type: exec
id: EXEC-8821
version: 1
status: approved
project: proj-internal-crm
module: order
derived_from: ["PLAN-00123@1"]
content_hash: "sha256:aa11bb22"
labels: []
created_at: 2026-11-13T16:40:12+08:00
created_by: program:engine
updated_at: 2026-11-13T16:40:14+08:00
approved_by: []
notes: ""
plan_ref: PLAN-00123@1
case_ref: CASE-00123@1
suite_ref: null
attempt: 1
verdict: fail
verdict_reason: "断言 a1 失败：期望 0，实际 10"
inconclusive_kind: null
steps:
  - {id: s1, status: pass, driver: web, duration_ms: 210, locator_hit: null}
  - {id: s2, status: pass, driver: web, duration_ms: 130, locator_hit: 2}
  - {id: s3, status: fail, driver: web, duration_ms: 88, failed_assert: a1, evidence_ref: "evidence://EXEC-8821/s3"}
assertions:
  - {id: a1, level: decide, result: fail, expected: "0", actual: "10"}
  - {id: a2, level: observe, result: pass}
evidence_ref: "evidence://EXEC-8821"
self_heal: []
touched: {pages: [/login, /order/create], apis: ["POST /api/order"]}
metrics: {duration_ms: 1820, llm_calls: 0, llm_tokens: 0, cpu_ms: 940}
environment: {target: internal-qa, variant: chrome-1280, engine_version: "0.9.1"}
consistency:
  group: CG-00123-20261113
  runs: 3
  identical: true
  divergent_runs: []
  baseline_exec: EXEC-8821
  diff_detail: []
started_at: 2026-11-13T16:40:12+08:00
finished_at: 2026-11-13T16:40:14+08:00
```

### 1.4 错误码总表（实现必须逐字输出）

| 层          | 前缀        | 示例                                                                         |
| ---------- | --------- | -------------------------------------------------------------------------- |
| `S` schema | `SCHEMA_` | `SCHEMA_HEADER_MISSING`、`SCHEMA_ENUM_INVALID`、`SCHEMA_FLOAT_NUMBER`        |
| `M` 语义     | `SEM_`    | `SEM_NO_DECIDE_ASSERT`、`SEM_SLEEP_FORBIDDEN`、`SEM_MATCHER_NOT_WHITELISTED` |
| `X` 跨产物    | `XREF_`   | `XREF_MISSING_TARGET`、`XREF_ASSERT_SOURCE_INVALID`                         |
| 越权         | `PERM_`   | `PERM_AGENT_WROTE_PROGRAM_FIELD`                                           |

**错误码必须正交**：一个用例只应触发一个错误码。如果实现同时报 3 个码，说明规则边界没划清，需要回头调规则而不是改用例。

---

## 2. S 层（schema，静态校验）

### 2.1 V-01 公共头字段齐全

> 规则：8 份产物必须含公共头全部必填字段；`approved` 态额外要求 `approved_by`。

| 用例      | 变异                                     | 期望                                                           |
| ------- | -------------------------------------- | ------------------------------------------------------------ |
| V01-N01 | 用 `_base/plan.valid.yaml` 原样           | `accepted`                                                   |
| V01-A01 | 删除 `derived_from`                      | `rejected` / `SCHEMA_HEADER_MISSING` / `field: derived_from` |
| V01-A02 | 删除 `content_hash`                      | `rejected` / `SCHEMA_HEADER_MISSING` / `field: content_hash` |
| V01-A03 | `status: approved` 但 `approved_by: []` | `rejected` / `SCHEMA_APPROVED_NEEDS_APPROVER`                |

```yaml
# V01-A01（只删一行，其余同 _base/plan.valid.yaml）
derived_from: "REMOVED"
```

**陷阱**：实现容易把 `derived_from: []`（空数组）当"缺失"。**空数组是合法值**（探索产物没有上游），缺失才是错误。V01-N02 专门覆盖这条。

| 用例      | 变异                       | 期望         |
| ------- | ------------------------ | ---------- |
| V01-N02 | `derived_from: []`（探索产物） | `accepted` |

### 2.2 V-02 枚举值封闭

> 规则：所有枚举值必须在 2.5 字典内，禁止自造值。

| 用例      | 变异                            | 期望                                                                                                            |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| V02-N01 | `verdict: inconclusive`（枚举内）  | `accepted`                                                                                                    |
| V02-A01 | `verdict: "基本通过"`             | `rejected` / `SCHEMA_ENUM_INVALID` / `field: verdict` / `allowed: [pass, fail, flaky, skipped, inconclusive]` |
| V02-A02 | `wait.type: sleep`            | `rejected` / `SCHEMA_ENUM_INVALID` / `field: steps[2].wait[0].type`                                           |
| V02-A03 | `wait.type: "waitForTimeout"` | `rejected` / `SCHEMA_ENUM_INVALID`                                                                            |

**这一条为什么重要**：V02-A01 就是"LLM 自造结论"的典型——模型看到大部分步骤过了、有个小问题，会写"基本通过"。**这一条拦不住，第 14 章的五档结论就形同虚设。**

### 2.3 V-03 ID 格式与唯一性

| 用例      | 变异                                    | 期望                                      |
| ------- | ------------------------------------- | --------------------------------------- |
| V03-N01 | `id: TP-0045-02`                      | `accepted`                              |
| V03-A01 | `id: TESTPOINT-0045-02`（前缀非法）         | `rejected` / `SCHEMA_ID_PREFIX_INVALID` |
| V03-A02 | `id: CASE-123`（位数不足 5 位）              | `rejected` / `SCHEMA_ID_FORMAT_INVALID` |
| V03-A03 | 库内已存在 `CASE-00123@1`，再导入相同 id+version | `rejected` / `SCHEMA_ID_DUPLICATE`      |
| V03-N02 | `CASE-00123@2`（同 id 新版本）              | `accepted`                              |

**关键边界**：`CASE-00123@1` 与 `CASE-00123@2` 是**同一实体**，不是重复；`CASE-00123@1` 重复导入才是重复。实现若按 id 去重会误杀版本（V03-N02 就是为这条设的）。

### 2.4 V-04 时间与金额类型

| 用例      | 变异                                      | 期望                                              |
| ------- | --------------------------------------- | ----------------------------------------------- |
| V04-N01 | `created_at: 2026-11-13T17:00:00+08:00` | `accepted`                                      |
| V04-A01 | `created_at: 2026-11-13 17:00`（无时区）     | `rejected` / `SCHEMA_TIME_NO_TIMEZONE`          |
| V04-A02 | `created_at: 2026/11/13`                | `rejected` / `SCHEMA_TIME_FORMAT_INVALID`       |
| V04-A03 | `value: 0`（数值型，应为字符串 `"0"`）             | `rejected` / `SCHEMA_NUMBER_NOT_STRING_DECIMAL` |

### 2.5 V-05 凭证明文（M1 应做）

> 规则：产物中不得出现密码/token/密钥明文，只允许 `cred://` 引用。

| 用例      | 变异                                                    | 期望                                                        |
| ------- | ----------------------------------------------------- | --------------------------------------------------------- |
| V05-N01 | `password: ${cred://internal-qa/user01}`              | `accepted`                                                |
| V05-A01 | `password: "Abc@123456"`                              | `rejected` / `SEM_CREDENTIAL_PLAINTEXT` / `action: alert` |
| V05-A02 | `Authorization: "Bearer eyJhbGciOiJIUzI1..."`（JWT 模式） | `rejected` / `SEM_CREDENTIAL_PLAINTEXT`                   |
| V05-A03 | `notes: "阿里云 AccessKey LTAI5tXXXXXX"`                 | `rejected` / `SEM_CREDENTIAL_PLAINTEXT`                   |

**为什么放在 notes 也要拦**：这是最常见的泄漏路径——开发为了"方便排查"把密钥写进备注，然后随产物一起入库、进 Git。

**误判风险提示**：`password` 字段名本身不能作为判据（否则 `password: ${cred://...}` 会被误杀）。判据是**值形态**：长度 ≥ 6 的连续非引用字符串 + 含特殊字符，或匹配已知密钥前缀（`eyJ`、`LTAI`、`sk-`、`ghp_`）。

### 2.6 V-06 approved 必填齐全

| 用例      | 变异                                     | 期望                                                            |
| ------- | -------------------------------------- | ------------------------------------------------------------- |
| V06-N01 | plan 全必填齐全，`status: approved`          | `accepted`                                                    |
| V06-A01 | plan `status: approved` 但 `gates` 整段缺失 | `rejected` / `SCHEMA_APPROVED_FIELD_MISSING` / `field: gates` |
| V06-N02 | plan `status: draft` 且 `gates` 缺失      | `accepted`（draft 允许缺）                                         |

**这条给出了"渐进式填写"的合法空间**：draft 可以先只有骨架，approved 必须完整。**没有这个分层，编译中途的产物根本存不下来。**

### 2.7 V-07 actor 格式

| 用例      | 变异                                  | 期望                                         |
| ------- | ----------------------------------- | ------------------------------------------ |
| V07-N01 | `created_by: agent:test_case_agent` | `accepted`                                 |
| V07-A01 | `created_by: "张三"`                  | `rejected` / `SCHEMA_ACTOR_FORMAT_INVALID` |
| V07-A02 | `created_by: "AI"`                  | `rejected` / `SCHEMA_ACTOR_FORMAT_INVALID` |

### 2.8 V-08 引用语法

| 用例      | 变异                                                  | 期望                                          |
| ------- | --------------------------------------------------- | ------------------------------------------- |
| V08-N01 | `source: "TP-0045-02@1#E-01"`                       | `accepted`                                  |
| V08-N02 | `value: ${data.username}`、`evidence://EXEC-8821/s3` | `accepted`                                  |
| V08-A01 | `value: "${username}"`（无 namespace）                 | `rejected` / `SCHEMA_REF_NAMESPACE_INVALID` |
| V08-A02 | `source: "TP-0045-02#E-01"`（断言来源缺版本）                | `rejected` / `SCHEMA_REF_VERSION_REQUIRED`  |


**V08-A02 是刻意设计**：断言来源必须精确到测试点版本（见契约 9.3），省略版本会让"测试点升版后用例自动跟随"——那会造成"自动通过但预期已错"。

---

## 3. M 层（语义，单产物内）

### 3.1 V-14 可判定断言（M1 应做）

> 规则：要生成 `decide` 断言的 `expected` 必须有 `observable + matcher + value`。

| 用例 | 变异 | 期望 |
|---|---|---|
| V14-N01 | `expected: {observable: order.discount_amount, matcher: equals, value: "0"}` | `accepted` |
| V14-A01 | `expected: {statement: 页面应显示优惠金额为0}`（无 observable） | `rejected` / `SEM_EXPECTATION_NOT_DECIDABLE` |
| V14-A02 | 有 observable 但无 `matcher` | `rejected` / `SEM_EXPECTATION_NOT_DECIDABLE` / `missing: matcher` |

**这是整个契约最关键的一条**。它拦的正是通用 agent 的通病："页面应显示优惠金额为0"这种预期，只能靠模型看图判断，而模型判断不可复现。

### 3.2 V-15 至少一条 decide 断言

| 用例 | 变异 | 期望 |
|---|---|---|
| V15-N01 | 含 1 条 `level: decide` | `accepted` |
| V15-A01 | 全部 `level: observe` | `rejected` / `SEM_NO_DECIDE_ASSERT` |
| V15-A02 | `assertions: []` | `rejected` / `SEM_NO_DECIDE_ASSERT` |

**对应"无断言不算通过"**：一条只观察不断言的用例，跑出来永远是 pass，等于没测。

### 3.3 V-16 步骤数预算

| 用例 | 变异 | 期望 |
|---|---|---|
| V16-N01 | 5 步，`budget.max_steps: 8` | `accepted` |
| V16-A01 | 9 步，`budget.max_steps: 8` | `rejected` / `SEM_STEP_BUDGET_EXCEEDED` / `action: split_case` |
| V16-N02 | 9 步，`budget.max_steps: 12`（人工显式放宽） | `accepted` |

**预算的作用不是"限制"，是"提醒拆分"**：超过阈值通常意味着这条用例测了太多事，失败时也难归因。

### 3.4 V-17 五闸全绿

| 用例 | 变异 | 期望 |
|---|---|---|
| V17-N01 | 五项全 `pass: true` | `accepted` |
| V17-A01 | `locator_unique.pass: false` | `rejected` / `SEM_GATE_NOT_PASSED` / `gate: locator_unique` |
| V17-A02 | 五项全绿但 `replay_verified.exec_ref: null` | `rejected` / `SEM_GATE_EVIDENCE_MISSING` |

**V17-A02 是防伪造**：闸可以是"人工标的 pass"，但没有真实执行记录的 pass 不算数。**这条绑死了"编译正确"和"真的跑通"。**

### 3.5 V-18 等待必须类型化（禁 sleep）

| 用例 | 变异 | 期望 |
|---|---|---|
| V18-N01 | `wait: [{type: network_idle, idle_ms: 500}]` | `accepted` |
| V18-A01 | `wait: [{type: sleep, ms: 3000}]` | `rejected` / `SEM_SLEEP_FORBIDDEN` |
| V18-A02 | `wait: [{type: network_idle, idle_ms: 3000}]`（idle_ms > 2000） | `rejected` / `SEM_WAIT_TOO_LONG` / `action: warn_or_reject` |

**V18-A02 的阈值是 2000ms**：不是因为 3 秒不行，而是"固定等待 3 秒"说明同步策略没学对。允许过是给它留个口子，但必须告警——**这类等待是 flaky 的头号来源**（见 v3 14.3 根因①）。

### 3.6 V-19 禁坐标与绝对路径

| 用例 | 变异 | 期望 |
|---|---|---|
| V19-N01 | `locators: [{testid: login-submit}, {role: button, name: 登录}]` | `accepted` |
| V19-A01 | `locators: [{css: "/html/body/div[2]/div[1]/button[3]"}]` | `rejected` / `SEM_ABSOLUTE_PATH_FORBIDDEN` |
| V19-A02 | `locators: [{xpath: "//*[@id='app']/div[4]/form/button"}]`（含索引段） | `rejected` / `SEM_ABSOLUTE_PATH_FORBIDDEN` |
| V19-A03 | `locators: [{coord: {x: 320, y: 480}}]` | `rejected` / `SEM_COORDINATE_FORBIDDEN` |
| V19-N02 | `locators: [{xpath: "//button[normalize-space()='登录']"}]`（无索引段、语义谓词） | `accepted` |

**V19-N02 是必要的宽松**：`//button[text()='登录']` 这类语义 xpath 是稳定的，不该一刀切禁 xpath。判据是"是否依赖层级索引"，不是"是否用 xpath"。

### 3.7 V-20 verdict 与断言一致性

> 规则：`verdict=pass` 要求所有 `decide` 断言 `result=pass`。

| 用例 | 变异 | 期望 |
|---|---|---|
| V20-N01 | 2 条 decide 全 pass，`verdict: pass` | `accepted` |
| V20-A01 | 1 条 decide `result: fail`，`verdict: pass` | `rejected` / `SEM_VERDICT_CONTRADICTS_ASSERT` / `action: force_fail` |
| V20-N02 | `decide` 全 pass，但有 `observe` 断言 fail，`verdict: pass` | `accepted`（observe 不参与判定） |
| V20-N03 | decide 全 pass，`verdict: flaky`（N=3 不一致） | `accepted`（flaky 是更高优先级的结论） |

**V20-A01 的处置是"强制改 fail"而不是"拒绝"**：这是唯一一条**修正而非拒绝**的规则。理由是这个错误极可能来自程序 bug（断言引擎漏汇总），拒绝入库等于丢掉一次真实的执行事实；改判 + 告警既保留事实，又防止它污染结论。

### 3.8 V-21 inconclusive 必须有原因

| 用例 | 变异 | 期望 |
|---|---|---|
| V21-N01 | `verdict: inconclusive`, `inconclusive_kind: env_unreachable` | `accepted` |
| V21-A01 | `verdict: inconclusive`, `inconclusive_kind: null` | `rejected` / `SEM_INCONCLUSIVE_NO_KIND` |
| V21-N02 | `verdict: fail`, `inconclusive_kind: null` | `accepted`（非 inconclusive 时该字段应为空） |
| V21-A02 | `verdict: pass`, `inconclusive_kind: env_unreachable` | `rejected` / `SEM_KIND_ON_PASS` |

**V21-A02 很少被想到但很重要**：pass 带 inconclusive_kind 说明状态机写串了，这种脏数据会让"环境问题统计"虚高，进而掩盖真实质量下降。

### 3.9 V-35 matcher 白名单（M1 应做）

| 用例 | 变异 | 期望 |
|---|---|---|
| V35-N01 | `matcher: abs_diff, matcher_args: {tolerance: "0.01"}` | `accepted` |
| V35-N02 | `matcher: between, matcher_args: {min: "100.00", max: "200.00"}` | `accepted` |
| V35-A01 | `matcher: "abs(actual - expected) < 0.01"` | `rejected` / `SEM_MATCHER_NOT_WHITELISTED` |
| V35-A02 | `matcher: between` 但 `matcher_args` 缺失 | `rejected` / `SEM_MATCHER_ARGS_MISSING` |
| V35-A03 | `matcher: abs_diff, matcher_args: {tolerance: 0.01}`（数值非字符串） | `rejected` / `SCHEMA_NUMBER_NOT_STRING_DECIMAL` |
| V35-A04 | `matcher: regex, matcher_args: {pattern: "(a+)+$"}`（灾难性回溯模式） | `rejected` / `SEM_REGEX_UNSAFE` |

**V35-A04 补充说明**：正则白名单之外还要做正则安全校验（嵌套量词、无上限重复）。一个 `(a+)+$` 能让整个 worker 挂死，比断言错误难查得多。

### 3.10 V-37 一 case 一 plan

| 用例 | 变异 | 期望 |
|---|---|---|
| V37-N01 | 库内 `CASE-00123` 只有 `PLAN-00123` | `accepted` |
| V37-A01 | 库内已有 `PLAN-00123`（case_ref: CASE-00123），再入库 `PLAN-00124`（同 case_ref） | `rejected` / `SEM_MULTIPLE_PLANS_PER_CASE` / `action: use_variant` |
| V37-N02 | 同 case 的 `variants/internal-qa.chrome-1280.yaml` | `accepted`（variant 不算 plan） |

**这条是 10.1 #6 决议的落地保障**。没有它，"一份 plan + 多 variant"只是口头约定，第一个赶工的人就会新建一份 plan。

---

## 4. X 层（跨产物）

### 4.1 V-27 derived_from 必须存在

| 用例 | 变异 | 期望 |
|---|---|---|
| V27-N01 | `derived_from: ["REQ-0045@3"]`，库内存在 | `accepted` |
| V27-A01 | `derived_from: ["REQ-0099@1"]`，库内不存在 | `rejected` / `XREF_MISSING_TARGET` |
| V27-A02 | `derived_from: ["REQ-0045@9"]`，版本不存在 | `rejected` / `XREF_VERSION_NOT_FOUND` |
| V27-A03 | `derived_from: ["REQ-0045"]`（缺版本） | `rejected` / `SCHEMA_REF_VERSION_REQUIRED` |

### 4.2 V-30 断言来源可追溯

| 用例 | 变异 | 期望 |
|---|---|---|
| V30-N01 | `source: "TP-0045-02@1#E-01"`，测试点存在且含 E-01 | `accepted` |
| V30-A01 | `source: "TP-0045-02@1#E-99"`（expected id 不存在） | `rejected` / `XREF_ASSERT_SOURCE_INVALID` |
| V30-A02 | `source: "TP-0045-02@1"`（缺 `#E-xx`） | `rejected` / `SCHEMA_REF_VERSION_REQUIRED` |
| V30-A03 | `source: "TP-0099-01@1#E-01"`（测试点不存在） | `rejected` / `XREF_MISSING_TARGET` |
| V30-A04 | `assertions[0].source: null`（agent 没填来源） | `rejected` / `XREF_ASSERT_SOURCE_INVALID` |

**这一组是"防 LLM 编断言"的核心关卡**。V30-A04 尤其常见：模型倾向于直接写出断言内容而不给出处，必须硬拦。

### 4.3 V-31 引用完整性

| 用例 | 变异 | 期望 |
|---|---|---|
| V31-N01 | plan/exec/defect 的所有 ref 都指向存在对象 | `accepted` |
| V31-A01 | `plan.case_ref: CASE-0099@1` 不存在 | `rejected` / `XREF_MISSING_TARGET` / `field: case_ref` |
| V31-A02 | `gates.replay_verified.exec_ref: EXEC-9999@1` 不存在 | `rejected` / `XREF_GATE_EVIDENCE_NOT_FOUND` |
| V31-A03 | `exec.plan_ref: PLAN-0099@1` 不存在 | `rejected` / `XREF_MISSING_TARGET` / `field: plan_ref` |
| V31-A04 | `defect.found_by.exec_ref: EXEC-9999@1` 不存在 | `rejected` / `XREF_MISSING_TARGET` / `field: found_by.exec_ref` |

**V31-A02 是整套"防假通过"的最后一环**：计划可以宣称"重放验证通过"，但那个 exec 记录必须真实存在。**没有这条，五闸的 replay_verified 可以凭空写 true。**

---

## 5. S 层补充：V-38 数值类型

| 用例 | 变异 | 期望 |
|---|---|---|
| V38-N01 | `range: ["0.01", "999999.99"]` | `accepted` |
| V38-A01 | `range: [0.01, 999999.99]`（YAML float） | `rejected` / `SCHEMA_FLOAT_NUMBER` |
| V38-A02 | `value: 0`（`expected[].value` 为 int） | `rejected` / `SCHEMA_NUMBER_NOT_STRING_DECIMAL` |
| V38-A03 | `boundary: [0.1, 0.2]` | `rejected` / `SCHEMA_FLOAT_NUMBER` |

**实现提示**：YAML 1.1/1.2 对数字的解析不同，必须在加载阶段用自定义构造函数（PyYAML 的 `FloatConstructor` 覆写）**在解析时就捕获原始 token**，而不是"先解析成 float 再检查类型"——后者已经丢失原始字面量，`"0.10"` 和 `0.1` 无法区分。

---

## 6. 越权写入专项（PERM 组，10 个用例）

> 这一组不属于 38 条规则中的某一条，但它是"字段分权"铁律（契约 0.2）的验证，**M1 必须过**。

| 用例 | agent 尝试写 | 期望 |
|---|---|---|
| PERM-A01 | `derived_from` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A02 | `content_hash` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A03 | `status: approved` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A04 | `version` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A05 | `id` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A06 | `approved_by` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A07 | `gates.locator_unique.pass: true`（伪造闸） | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-A08 | `verdict: pass` | `rejected` / `PERM_AGENT_WROTE_PROGRAM_FIELD` |
| PERM-N01 | `module`、`labels`、`notes`（agent 合法字段） | `accepted` |
| PERM-N02 | agent 写入 `expected[].matcher` | `accepted`（agent 合法字段） |

**PERM-A07 是这组里最关键的**：如果 agent 能写 `gates`，那五闸就形同虚设——它大可以自己标"全部 pass"。**闸的写入权必须在编译器进程，不能在被约束方手里。** 这跟"裁判不能由运动员兼任"是同一件事。

**实现要点**：不能靠"比对写入前后 diff 然后回滚"（有竞态），必须在**反序列化阶段**就按 `writer` 声明做字段剥离——agent 产出的 JSON 里出现 `program` 字段，直接丢弃并告警，不进对象。

---

## 7. 未覆盖部分（M2/M3 待补）

| 规则 | 依赖 | 补用例时要注意 |
|---|---|---|
| V-09~V-13 | 需求分析链路 | V-10 需构造 `clarifications.status: open` 的状态锁场景 |
| V-22 | 缺陷库 | 需构造"fixed 声明存在但 verify_exec 未 pass"的用例 |
| V-23、V-24 | 报告指标包 | 数字反查需要 mock 指标包，注意浮点比较 |
| V-25 | 混合 driver | 需覆盖"3 段 driver"与"折返"两个反例 |
| V-26 | 风险台账 | 相似度阈值 0.9 需给出临界样例（0.89 / 0.90 / 0.91） |
| V-28、V-29 | 原文库 | 需构造"quote 可定位"与"quote 编造"对照 |
| V-32、V-33 | 回归集 | V-33 双向对账要各构造一个方向的缺口 |
| V-34 | 血缘图 | 需 3 层血缘的图遍历样例 |
| V-36 | 报告状态机 | 覆盖"draft 导出被拒"与"approved 无 human 被拒" |

---

## 8. M1 验收清单（可直接作为交付标准）

```
□ 24 条 M1 规则全部实现，错误码与本文档逐字一致
□ 13 条完整用例规则（97 个用例，含 PERM 组 10 个）全部通过
□ 11 条最小模板规则各补到 ≥3 个用例（1 正 + 2 反，反例要覆盖边界而非同类重复）
□ 反例拦截率 100%，正例误杀率 0%
□ 每个错误码都能输出 field / action，而不是只有 REJECTED
□ V-20 实现为"改判 + 告警"，不是"拒绝入库"
□ V-38 在 YAML 加载阶段捕获，不是解析后检查
□ PERM 组在反序列化阶段剥离，不是写后回滚
□ 校验器有独立的 CLI（vb run），可脱离平台单测
```

**最后一条容易被忽略**：校验器如果不能脱离平台单独跑，它就永远只能"跟着流程跑一遍看看"，无法做回归测试。**一个不可单测的校验器，一个月后就会有人为了赶进度把它注释掉。**

---

## 附录：用例编号速查

| 规则 | 正例 | 反例 | 合计 |
|---|---|---|---|
| V-01 | 2 | 3 | 5 |
| V-02 | 1 | 3 | 4 |
| V-03 | 2 | 3 | 5 |
| V-04 | 1 | 3 | 4 |
| V-05 | 1 | 3 | 4 |
| V-06 | 2 | 1 | 3 |
| V-07 | 1 | 2 | 3 |
| V-08 | 2 | 2 | 4 |
| V-14 | 1 | 2 | 3 |
| V-15 | 1 | 2 | 3 |
| V-16 | 2 | 1 | 3 |
| V-17 | 1 | 2 | 3 |
| V-18 | 1 | 2 | 3 |
| V-19 | 2 | 3 | 5 |
| V-20 | 3 | 1 | 4 |
| V-21 | 2 | 2 | 4 |
| V-27 | 1 | 3 | 4 |
| V-30 | 1 | 4 | 5 |
| V-31 | 1 | 4 | 5 |
| V-35 | 2 | 4 | 6 |
| V-37 | 2 | 1 | 3 |
| V-38 | 1 | 3 | 4 |
| PERM | 2 | 8 | 10 |
| **合计** | **35** | **62** | **97** |

> **口径说明**：正文初稿按"每条规则至少 1 正 1 反"估算为 62 个用例，展开细化后实为 **97 个（35 正 / 62 反）**。13 条 M1 规则、共 23 组表；**以本表为准**，0.4 节的 62 指"最少用例数"，M1 实际验收按 **97** 执行。
>
> 反例（62）多于正例（35）是有意的：**正例证明没误杀，反例证明真拦得住**。而"漏拦"的代价远大于"多写几个反例"——漏一次就是一次假通过进到客户那里。
