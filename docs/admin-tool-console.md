# 工具管理（管理台 `/tools`）

> 面向：维护平台后台的工程师、以及要往这里加工具的 Agent 开发者。
> 对应方案：§17.4（能力登记）、§10（权限收窄）、§25（评审落地项可见性）。

## 1. 这个页面解决什么问题

改造前，平台后台有 Agent 管理、技能管理、插件管理，**没有工具**。于是「哪条纪律已经上线、它属于哪个阶段、被哪些 Agent 用到、现在是开还是关」这四个问题，只能靠翻代码和文档回答。

这带来两个具体后果：

- **演示时答不上来**。被问「你这个校验器在哪生效」，只能现场找文件；
- **纪律会悄悄失效**。某个工具被停用或改了参数，没有任何一处能看出来，直到某次回归大面积失败。

所以工具模块不是「再加一个 CRUD 页面」，它是**能力清单的唯一登记处**：一个工具 = 一个可被 Agent 调用的能力单元，登记它的参数契约、读写权限、归属阶段、引用关系与启停状态。

## 2. 数据模型

独立成表，**不进 `public_resources`**。理由：工具是运行期能力的登记与开关，没有 draft/publish 语义；塞进资源体系会逼着 `KINDS`、依赖解析、bundle 校验都接受一种缺两条腿的资源。

| 表 | 作用 |
|---|---|
| `central_tools` | 工具本体：名称、显示名、摘要、说明、阶段、权限、参数契约、返回结构、版本、revision、启停、内置标记 |
| `central_tool_categories` | 阶段分类，与技能管理同一套 id（`common/req/design/case/web/api/app/mini/report/defect`） |
| `central_tool_agents` | 工具 ↔ Agent 引用关系 |
| `central_tool_audit` | 每次变更一条记录（create / update / touch / enable / disable / delete） |

字段取舍：

- `version` 只在**Agent 读得到的东西**变了时 +1（说明、参数、返回、阶段、权限）。改显示名或摘要不动版本——否则版本列全是噪声；
- `revision` 用于并发保护，PUT 带旧 revision 会被 409 拒掉；
- `builtin=1` 的工具**不可删除，只可停用**。删掉等于把方案里的那条纪律从后台抹掉，「停用」才是它的真实语义。

## 3. 接口

前缀 `/api/control/tools`（管理台走 `/api/control/tools/admin/*`，运行期走 `/catalog`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin` | 列表 + 分类（需管理员） |
| GET | `/admin/:id` | 单条详情 |
| GET | `/admin/:id/audit` | 最近 50 条变更 |
| POST | `/admin` | 新建 |
| PUT | `/admin/:id` | 更新（带 `revision`，契约变更才提版本） |
| POST | `/admin/:id/toggle` | 启停 |
| DELETE | `/admin/:id` | 删除（内置拒；仍被引用拒） |
| GET | `/catalog` | **运行期消费口**：只返回已启用工具，非管理员可读；`enforced` 说明状态是否已同步到引擎 |
| GET | `/admin/usage` | 运行期调用次数聚合（按工具、按 action） |
| POST/PUT/DELETE | `/categories[/:id]` | 分类维护（内置阶段不可删） |

`/catalog` 与 `/admin` 的差别不只是权限：`/catalog` 不带审计、不带 revision，只给 Agent 装配时真正需要的字段。运行期读管理接口是权限设计上的常见破口，这里从接口层就分开。

## 4. 引用关系的两条规则

1. **只接受真实存在的 Agent**（`store.list(true)` 里的 `payload.agentId`），防止拼错 id 造出一条假引用；
2. **但允许保留该工具当前已有的引用**。内置工具的内置引用（如 `test_agent`）在设计上先于资源导入存在；若不允许保留，管理员一打开编辑器保存就会把它们清空。

对应地，前端候选列表取「中央已导入 Agent ∪ 工具当前已引用」，空环境下也能看到并取消内置引用，而不是显示「暂无可用 Agent」却顶着一个「引用 5」。

## 5. 首批内置工具

7 条可用 + 2 条规划中（规划中的按停用入库，不伪装成可用）：

| 名称 | 阶段 | 权限 | 状态 | 代码里的载体 |
|---|---|---|---|---|
| `irval.check` | 通用 | read | 可用 | `diagnose_analysis` / `diagnose_test_points` / `diagnose_test_cases` / `validate_artifacts` |
| `plan.phases` | 通用 | read | 可用 | `orchestration-state.mjs`、`stage-handoff.mjs`、`artifact-scope.mjs` |
| `agent.contract` | 通用 | read | 可用 | `structured-actions.mjs` 的 `dispatch` / `handoff` / `complete` |
| `assets.library` | Web 自动化 | write | 可用 | `test-asset-catalog.mjs`、`register-test-asset.mjs`、`validate-test-assets.mjs` |
| `dom.snapshot` | Web 自动化 | read | 可用 | `browser-task.mjs` 的 `snapshot` 操作 |
| `regression.select` | 测试报告 | read | 可用 | `select-test-cases.mjs` + `config/test-selection-policy.json`（仅 Profile 规则选择，无五源与未测清单） |
| `expected.provenance` | 用例生成 | read | 可用 | `expected-source.mjs`（R1~R5）、`execution-verdict.mjs`（把上限接到执行结论） |
| `knowledge.incremental` | 需求分析 | write | 规划中（停用） | 无。仓库里没有任何 NFKC 指纹 diff 实现 |
| `requirement.completeness` | 需求分析 | read | 规划中（停用） | 无。对应方案 §25.4 的 V-33 反向对账 |

「规划中」的两条在后台里能让人看见路线，灰着则说明它还没生效。判断标准只有一条：**仓库里能不能指出具体文件**。指不出来的，就是规划中。

## 6. 运行面：停用会真的拦住

后台的启停**已经接线**，不是纯台账。链路见 [`tool-runtime-integration.md`](tool-runtime-integration.md)：

```
启停按钮 → config/tool-runtime-state.json → scripts/tool-gate.mjs → executeAction 闸门
```

- **硬依赖**停用 → 依赖它的 action 直接 `rejected`，回执写明是哪条工具；
- **软依赖**停用 → 照常执行，回执带 `tool_degraded`；
- 每条调用回写 `output/runtime/tool-usage.jsonl`，后台按工具聚合展示。

需要 `AITEST_ENGINE_ROOT` 指向能跑 `project-action.mjs` 的目录。没配时后台会显示警示条，明说「此时不会拦住 Agent 的调用」——不静默失效。

## 7. 边界（别把它当万能件）

- **它不是 Agent 的内置工具编辑器**。`read_file`、`exec_command` 那类内置函数仍在 `penguin-core` 的 `tools-form.tsx` 里管，这里是「纪律型能力」的登记处；
- **它不校验参数契约的语义**。只做 JSON 对象合法性检查。参数是否覆盖了工具真实入参，需要 code review；
- **审计只保留变更轨迹，不做差异回放**。要回放参数契约的历史版本，需要另建版本表（当前 `version` 只是计数，不存旧体）；
- **绑定关系是代码，不是配置**。改 action→工具绑定要改 `scripts/tool-gate.mjs`，不在后台里改——它决定「停用会发生什么」，不该让人随手改；
- **没有绑定的工具停用等于没影响**。`assets.library`、`knowledge.incremental`、`requirement.completeness` 目前不在任何 action 的路径上，详情页会明写「停用后不会拦住任何调用」。

## 8. 还差的一步

**软依赖的降级没有进最终报告**。`tool_degraded` 只写进 action 回执，报告生成处还没消费它。要让报告上出现「本次回归的选集口径未生效」，得在 `build-report-metrics` / `export_report` 里读这个字段。
