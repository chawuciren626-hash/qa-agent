---
name: api-test-execution
version: 2026.11.22.1
description: 用受控 HTTP worker 执行已设计的接口场景，逐请求保存断言证据，处理依赖顺序、凭据引用、写授权、取消与部分结果；不启动浏览器，不手写请求或结论。
sections:
  criteria: ["产物格式（强制）", "操作顺序", "判定规则", "自检清单", "不要做"]
  knowledge: ["场景检查维度", "认证与写授权"]
  steps: ["输入", "输出", "三个不可逆点"]
---

# 接口执行

## 输入

| 来源 | 用途 | 缺了怎么办 |
|---|---|---|
| 派发单 | run_id、接口范围、目标环境、授权边界 | 缺范围就不启动，交回队长 |
| `design/test_cases.json` | 要执行的用例（`execution_layer=api` 或带 `api_scenario`） | 没有接口用例 → 说明无接口轨，不自行设计 |
| 接口契约（OpenAPI / Swagger） | 核对方法、路径、状态码、字段、内容类型 | 没有就写明"无机器可读契约，只核设计预期" |
| `inputs/` 归档原文 | 引用出处，逐字可核 | 引用对不上原文，`prepare` 直接失败 |
| 本次用户原话 | 判断有没有测试授权、有没有写操作授权 | 原话里带"不要执行 / 只生成"，不能启动 |

只支持 Swagger 2.0 / OpenAPI 3.0。3.1 明确拒绝，遇到就报不可支持，不降级硬猜。

## 输出

| 文件 | 谁写 | 说明 |
|---|---|---|
| `execution/api/test_results.json` | 执行器 | 逐请求回执与断言结论，缺陷和报告的唯一来源 |
| `execution/api/task.json` | 执行器 | 任务结论（completed / partial） |
| `execution/api/contract.json` | 执行器 | 契约摘要与限制说明 |
| `execution/api/scenario-draft.json` | **你** | 仅当用户给的是没有 `api_scenario` 的老用例，才需要适配 |
| 一句话交接 | 你 | 通过 / 失败 / 未完成、未测范围、缺项 |

## 产物格式（强制）

字段的完整语义与 worker 行为见 `references/protocol.md`；本节只列必须照做的部分。

### 场景对象

| 字段 | 必填 | 取值 |
|---|---|---|
| `scenario_id` | 是 | `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`，本计划内唯一 |
| `case_id` | 是 | 设计里的真实编号，不自造 |
| `title` | 否 | 缺省取用例标题 |
| `expected` | 是 | **与设计原文完全相等**，一个标点都不改 |
| `source_refs` | 是 | `[{source_path, quote}]`，至少一条 |
| `depends_on` | 否 | 依赖的场景 ID，变量只在依赖链内可见 |
| `resources` | 否 | 共享可变资源键，混跑 UI 时必须在派发里声明过 |
| `steps` | 是 | 1–30 步 |

### 步骤对象

| 字段 | 必填 | 说明 |
|---|---|---|
| `request_id` | 是 | 本 dispatch 内唯一；同一请求重读结果沿用原编号 |
| `method` | 是 | GET / HEAD / OPTIONS / POST / PUT / PATCH / DELETE |
| `url` | 是 | 完整地址，只能来自资料里出现过的地址 |
| `query` / `path_params` / `headers` | 否 | 键值对；不塞凭据 |
| `json` / `form` | 否 | 请求体，二选一 |
| `auth` | 否 | 见下节 |
| `assertions` | 是 | 1–100 条，发出前定稿 |
| `extract` | 否 | `[{name, path}]`，后续用 `${name}` 引用 |
| `side_effect` | 否 | 声明这一步有副作用 |
| `cleanup_of` | 否 | 指向被清理的 request_id |

### 断言类型

| type | 参数 | 判什么 |
|---|---|---|
| `status` | `value` | HTTP 状态码，写具体值 |
| `content_type` | `value` | 具体媒体类型，不带参数和通配符；忽略大小写与 charset |
| `equals` | `path` + `value` | 字段严格相等 |
| `exists` | `path` | 字段存在 |
| `type` | `path` + `value` | 字段类型 |
| `schema` | `path` + `value` | 严格 JSON Schema |
| `range` | `path` + `min` / `max` | 数值区间 |
| `length` | `path` + `min` / `max` | 长度区间 |
| `contains` | `path` + `value` | 包含 |

`path` 用点分隔字段路径。Schema 不支持的关键字直接报错，不静默删规则。
`application/problem+json` 与 `application/json` 严格区分，缺失或非法判失败。

### 硬约束（不满足直接失败）

1. `source_path` 只能是本 run 的 `inputs/`、`analysis/`、`design/` 文件，或恰好 `execution/api/scenario-draft.json`。
2. `quote` 必须是该文件里**逐字存在**的片段；`scope` 的 `quote` 还必须包含 `scope.url`。
3. 每条断言在 `prepare` 前定稿；`prepare` 之后计划不可变。
4. 适配草稿的每条场景必须带 `case_source{source_path, case_id}`，`source_path` 不能是自己，
   且 `expected` 必须与原用例**完全相等**（不是包含、不是近似）。
5. 写请求必须有 `write_authorization`；它的 `quote` 要等于本次用户原话整段（不是截取片段），
   且原话里针对该方法的禁止性条款会让授权失效。
6. 场景 ≤ 100，步骤 ≤ 30，并发 ≤ 4，`timeout_ms` ≤ 60000，`max_response_bytes` ≤ 1 MiB。
7. 本阶段唯一可手写的运行目录文件是 `execution/api/scenario-draft.json`；
   其余 `execution/api/**` 都是受控证据，写它会被直接拒绝。

### 最小示例

```json
{
  "version": 1,
  "scope": [{"url":"http://localhost:3000/api","source_path":"inputs/request.txt","quote":"请测试 http://localhost:3000/api"}],
  "concurrency": 2,
  "timeout_ms": 15000,
  "scenarios": [{
    "scenario_id":"orders-query", "case_id":"API-001", "title":"查询订单",
    "expected":"返回200，业务码为0",
    "source_refs":[{"source_path":"inputs/contract.txt","quote":"业务码为0"}],
    "depends_on":[], "resources":[],
    "steps":[{"request_id":"orders-get-1","method":"GET","url":"http://localhost:3000/api/orders",
      "query":{"page":1},
      "assertions":[{"type":"status","value":200},{"type":"equals","path":"code","value":0}]}]
  }]
}
```

## 认证与写授权

- 认证写成 `auth:{type:"bearer|basic|api_key|cookie", ref:"qa-secret://..."}`；
  `api_key` 追加 `name` 与 `in:"header|query"`。Basic 的引用可以是完整 Basic 值或 `username:password`。
- **缺凭据时写 `credential_key`（如 `api-token`）替代 `ref`**，worker 会进入等待人工状态；
  用户给了安全引用后，在原任务上传入凭据继续，**不重派、不重启、不重放已经发出的请求**。
- 登录接口本身可以作为普通授权请求执行，用 `extract` 取 token，再通过加密引用关联后续请求。
- 已发出的 401 不会自动重试。
- 写请求：`write_authorization{source_path, quote}` 的 `quote` 必须是用户原话整段；
  "测一下"不构成写授权，也不扩展成生产支付、通知、权限变更或批量删除。
- 清理只针对本次可证明归属且已授权的资源，默认不清理；清理本身也是写操作。

## 操作顺序

1. 契约到手先看（可选）：解析契约，确认方法、路径、状态码、字段有来源。
2. 适配场景：一次写完，自检全部通过再往下。
3. `prepare` **一次**。它会固化计划、核验引用、校验用例是否可执行。
4. `start` **一次**。它立刻返回，代表已发出，不代表测完。
5. `status` 轮询看进度，不重启、不改计划。
6. 终结后 `collect`，拿逐请求回执与两个结果文件。
7. `validate_artifacts(stage=api_execution)`，回真实状态。

## 三个不可逆点

这三条踩了就整轮报废，且报错文案不直观：

1. **`prepare` 之后计划不可变。** 改一个字符都会报"计划不可变"。
   所以场景必须在 `prepare` 前定稿；发现写错了，只能作为一次显式修订重来，不能靠再 prepare 覆盖。
2. **`start` 只启动一次。** 状态不是"已准备"时再 `start` 是空操作，返回 `replayed:false`，
   什么都不会重发。看到这个字段就该去 `status`，不是换参数重试。
3. **`task.json` 不能手写。** 它是受控证据，`write_file` 会被拒。
   需要补充限制说明就写在交接里，或让执行器版本承担。

## 判定规则

| 情况 | 结论 |
|---|---|
| 该请求全部断言通过 | 该请求通过 |
| 任一断言失败 | 该请求失败，保留原预期 |
| 请求没发出 / 发出无回执 | 未完成（blocked） |
| 写请求已发出但结果未知 | blocked + `result_unknown=true`，**不能写成失败或成功** |
| 只有 HTTP 状态断言 | 只证明状态，不证明业务 |
| 等待凭据 | 任务保持未完成，交付说清在等什么 |
| 用户要求取消 | 请求取消后**等 worker 结束再收结果**；取消不代表已发生的写入被清理 |

- 部分结果可交付，标 partial；未执行、未知写、取消后的限制都要写出来。
- worker 丢失时只从已落盘回执恢复，已发出无结论的写请求标未知，不重启重放。
- 提前出报告：冻结当前回执做时点快照，把模板交回队长，不自行写报告、不宣告接口阶段完成。
- 请求不自动重试、不跟随重定向（重定向按未完成证据保留，防止凭据跨域），TLS 校验开启。
- 响应体不公开落盘，只留类型、大小、哈希和断言结论；提取值加密存储。

## 端点只认已确认的锚点

请求目标与断言只引用接口契约或系统地图里**已人工确认**的接口（verified），
并记录引用的编号与版本。判定规则：

| 情况 | 处理 |
|---|---|
| 有 verified 锚点 | 正常设计场景 |
| 只有候选锚点、没人工确认 | 受影响用例记 blocked，列进缺项清单 |
| 完全没有锚点，只有页面路径 | 不按路径猜端点，记 blocked 并说明缺接口契约 |
| 断言资产缺失 | 同 blocked，不自己造一套断言标准 |

- 不把候选当已确认，不把 blocked 写成通过，不为了凑用例编造路由或 operation ID。
- 缺项清单写清：`case_id`、缺哪个锚点或资产、缺了会挡住哪一步。

## 场景检查维度
设计够不够，按这张表看。不是每个接口都要全跑，按需求适用。

| 维度 | 看什么 |
|---|---|
| 方法与路径 | 契约允许的方法、路径参数、内容类型；不猜接口 |
| 认证与授权 | 无凭据 / 失效凭据 / 已认证但权限不足，三种分开；401 与 403 的预期取自契约 |
| 对象隔离 | 身份 A 访问身份 B 的资源，看允许与拒绝规则、有没有泄漏 |
| 参数 | 必填缺失、null、空串、0、false、类型错误、边界；只存一份数据，别用重复字面量 |
| 业务拒绝 | 拒绝要看资源未变化；报错不代表没有写入 |
| 分页过滤排序 | 稳定排序、重复与漏项、末页空页；先建已知小数据集，不假定生产数据量 |
| Schema | 必填、类型、可空、扩展字段；不为通过放宽 `additionalProperties` |
| 幂等 | 重复请求后的资源状态与副作用次数（重复记录、通知、计费） |
| 异步一致性 | 只按已定义的状态和时间预算观察，不用无限轮询或固定睡眠掩盖失败 |

链路类用例要标明每一步消费的真实对象 ID 与前置状态。创建后回查、变更后查询、
拒绝后检查原状态是三个不同验证目标，能证明的结论也不同：只有最后一个 HTTP 状态通过，
不足以说明链路通。

## 自检清单

- [ ] 每条场景的 `case_id` 与 `expected` 能在设计文件里逐字对上
- [ ] 每条断言都能指回契约条款或用例原文，没有一条是事后补的
- [ ] 写请求有完整原话授权，没有把"测一下"当授权
- [ ] `source_path` 与 `quote` 都在允许范围内且逐字存在
- [ ] 一个场景一个业务检查目标，没有把三条规则塞进一条
- [ ] 未完成、未知、失败分开统计，数字能对上回执条数
- [ ] `task.json` 没有被手写

## 不要做

- 不用浏览器、不用 curl 或任何脚本代替执行器，不安装依赖。
- 不根据响应反改预期、不追补历史通过记录、不重放已发出请求。
- 不手写 `execution/api/**` 下的结果与证据，不伪造回执。
- 不设计用例、不造测试点、不判缺陷、不写报告。
- 不把接口通过说成功能通过；性能与安全测试不在本阶段范围。
