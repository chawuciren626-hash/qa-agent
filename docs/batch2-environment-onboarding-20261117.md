# 批次 2（环境与建档）· 服务端交接，2026-11-17

> 执行方：WorkBuddy。分支 `workbuddy/batch2-env-onboarding`，基线 `origin/main` `e05361a`。
> 本批只交付**服务端 + 执行入口 + 原型**；前端改动等原型确认后再动（见 §6）。

## 1. 完成度

| 项 | 状态 |
|---|---|
| B1 环境一等实体（表 / 状态机 / 默认环境） | ✅ 已完成 |
| A1 建档入口的服务端侧（创建即登记环境、地址校验） | ✅ 已完成 |
| 建档执行入口（`runtime_cli onboard.bootstrap`） | ✅ 已完成 |
| 建档五步进度流式（`spawn` + `@@step` + `steps_json`） | ✅ 已完成（§4.1） |
| A1 前端：新建弹窗地址行、环境列、建档抽屉、项目环境页、工作台环境条、详情侧栏环境段 | ✅ 已完成 |
| 真实 gatewayadmin 场景跑一次建档 | ⏸ 待有授权地址与可达网络后执行 |

## 2. 数据模型

`project_environments`（PK `(project_id, env)`），随 `openDatabase` 的 `SCHEMA_SQL` 幂等创建，老库自动补表，无迁移分支（与仓库既有约定一致）。

关键字段与取舍：

- `base_url` 在环境上，**不写** `.project_config.toml`——那里的 `base_url` 是模型供应商端点，混用会污染模型配置语义（`project-config-service.ts` 头注释已明确该文件的语义）。
- `status ∈ unregistered | probing | registered | failed`。`probing` 既表示"正在跑"，也让进程崩溃后的残留可辨认。
- `pages_total / pages_registered / apis_total` **可为 NULL**：NULL = 从没跑过，0 = 跑过且确实 0 个。UI 上这是"未建档"与"0 个页面"的区别。
- `is_default`：默认环境全局唯一，写入时先把同项目其它环境降级。
- 地址变更会清空旧摘要（否则旧站点的 12 个页面会描述新地址）。

## 3. 接口

前缀 `/api/projects/:projectId/environments`（读需项目访问权，写需 owner）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 环境列表 + `defaultEnv` |
| POST | `/` | 建/改环境 `{env?, baseUrl, isDefault?}` |
| GET | `/:env` | 单个环境 |
| POST | `/:env/bootstrap` | 触发建档，立刻 202，前端轮询 status |
| POST | `/:env/bootstrap/wait` | 同步等建档结束（CLI/测试用） |

创建项目时可选带 `environment: {env?, baseUrl}`：先校验地址再建项目，校验失败 400 且不留半创建；环境写入失败回滚整个项目。`/api/projects/managed` 的项目视图新增 `environment` 字段（无环境为 `null`）。

地址校验：只放行 `http(s)`；拒绝 URL 内嵌账号口令；拒绝 `169.254.169.254`、`metadata.google.internal` 等云元数据端点。内网/回环地址**放行**（测试环境大量是 localhost），完整的站点白名单属于批次 4 的执行策略，不在这里做。

## 4. 建档执行入口

`aitestharness_tools/runtime_cli.py` 新增 `onboard.bootstrap` 分支：

- 入参 `{project, env, target_url, openapi_url?, out?}`
- 给 `out` 才落 `maps-<env>.yaml` + `bootstrap-report-<env>.md`；不给就只回结构
- 失败（首页不可达等）返回 `ok=false`，**不落盘**，`paths=null`

服务端 `project-environment-service.ts` 以子进程调用它（cwd=`AITEST_ENGINE_ROOT`，注入 PYTHONPATH，超时 120s），结果写回同一行。

### 4.1 五步进度怎么来的（`steps_json`）

Python 每到一个真实边界就往 **stderr** 写一行 `@@step {"index":1,"status":"running"}`，stdout 始终只保留一个纯 JSON 信封（混进日志会让调用方解析失败）。

- 服务端用 **`spawn` 而不是 `execFile`**：`execFile` 要等进程结束才拿到 buffer，五步进度会退化成"结束瞬间五条一起到"，抽屉里就只剩假动画。`spawn` 逐行读 stderr，按 `\r?\n` 切（一行可能被拆包，半个 JSON 不解析也不丢）。
- 每收到一个事件就合并进 `project_environments.steps_json`（固定五行，按 index 合并），**不动 `revision`**：进度是过程量，不是配置版本；前端本来就按 `status` 轮询整行。
- 未知 index 的事件直接丢弃（不凭空多一行）；坏 JSON 行丢弃（进度可丢，不值得让整次建档失败）；写库失败也吞掉，不中断建档。
- 收尾 `finalizeSteps`：把"结束那一刻还挂在 running 的步骤"落定成 done/failed（失败时把 `last_error` 写进这步的 detail），避免进程死在半路留下永远转的圈。
- 失败不写 0 页：`pages_total` 仍是 NULL，UI 显示「—」。

联调实测（`http://127.0.0.1:1/` 拒绝连接）：`steps[0] = failed / 3053ms / "ConnectionError: ... 由于目标计算机积极拒绝"`，其余四步 idle，环境 `status=failed`。

**为什么不挂到 `stage-tool-runtime.mjs` / `tool-gate.mjs`**：那两个是"run 内、有 active stage"的通道，`runStageTool` 会校验 `manifest.stages[stage] === 'in_progress'`。建档发生在任何 run 之前，挂上去要么伪造一个 stage，要么让入口永远 409。因此本批没有改动批次 1 的工具通道文件面，也未动 `STAGE_TOOLS` 的断言。若 Codex 认为必须统一入口，建议另立一个"run 外工具通道"，而不是复用阶段工具。

## 5. 回归结果（2026-11-17 本机 Windows）

| 命令 | 结果 |
|---|---|
| `npm run ci:tools` | ALL PASS（含新增 `test_onboard_runtime_cli`） |
| `cd aitestharness-ir && python -m pytest tests -q` | 114 passed |
| `cd platform/packages/server && npx tsc --noEmit -p .` | 0 错误（顺带修掉 `environment-knowledge.test.ts` 一处先前就存在的 `verdicts[0]` 越界断言） |
| `cd platform/packages/web && npx tsc --noEmit -p .` | 0 错误 |
| `npx vitest run test/project-environments.test.ts test/environment-knowledge.test.ts` | 9 + 7 passed |
| `npx vitest run test/bootstrap-steps.test.ts` | 4 passed |
| `npx vitest run test/project-environments-page.test.ts` | 4 passed（失败原文照抄 / 未探索空态 / 判定追加 / 造数默认关） |
| `npx vitest run test/project-management-page.test.ts test/qa-project-pagination.test.ts` | 15 + 8 passed |
| `npx vitest run test/managed-projects.test.ts test/project-rename.test.ts test/project-environments.test.ts test/environment-knowledge.test.ts` | 26 passed / 1 skipped（跳过的是原有 `runIf(AITEST_ENGINE_ROOT)` 用例） |

新增用例覆盖：环境登记与"未建档≠0"、地址与环境名校验、失败不冒充成功、成功摘要落库、地址变更清空旧摘要、非成员 404；以及探索资产的层覆盖、key 去重、假设默认关造数、判定 append 不覆盖、按状态计数、环境不存在 404；老项目（建档功能上线前建的、没有环境）读出来 `environment` 为 `null`、环境接口回空列表 + `defaultEnv=null` 而不是 404。

## 6. 产品决策（2026-11-17 已确认）

1. **环境地址选填**：填了创建后立即建档，留空则先建项目、之后在环境页补。兼容"先建项目后连环境"的老习惯，历史项目也能惰性补建（详情侧栏显示"未建档"而不是 0）。
2. **项目内左侧导航新增一级「项目环境」**（不是并进项目资料）。该页不在「项目视图」的 tab 之下——那排 tab（任务与节点/项目用例/缺陷清单/测试报告）只属于项目视图。
3. **多环境 v1 只做"默认环境 + 添加环境"**，不做环境切换器。
4. **建档完成后不自动跑探索**：探索会开有头浏览器占机器，给按钮由人触发；触发后系统代建会话。

原型：`prototype/batch2-onboarding-v2.html`（11 屏）。

## 6.2 前端落地（路由 / 组件 / 谁调谁）

| 位置 | 文件 | 职责 |
|---|---|---|
| 列表行「环境」列 | `project-management/environment-cell.tsx` | 四态 chip；NULL 显示「—」；未建档点击 = 立刻建档 + 开抽屉 |
| 建档抽屉 | `project-management/bootstrap-drawer.tsx` | 三态（建档中/已建档/失败）共用一个容器；只在 `probing` 时 1.2s 轮询；失败原因照抄程序原文 |
| 五步展示 | `project-management/bootstrap-steps.tsx` | 抽屉与环境页共用；没有任何按时间推进的逻辑 |
| 项目环境页 | `project-management/project-environments-page.tsx`，路由 `/qa/project/environments` | 左环境列表 + 右档案（探索资产四层 / 未知与假设）；「补充场景」开假设弹窗 |
| 左侧导航 | `penguin/ui/workspace-ui.mjs` | 项目视图下面加一级「项目环境」（路径挂在 `/qa/project` 前缀下以复用 `projects` 模块权限） |
| 工作台环境条 | `features/qa/project-view.tsx` + `workspace-layout.css` | 只读摘要 + 跳转；建档/探索不在这里发起 |
| 详情侧栏环境段 | `project-management/project-detail-panel.tsx` | 默认环境状态/地址/建档结果；「打开项目环境」先按同一套校验进入项目再切路由 |

接口层（`project-management/api.ts`）新增 `getEnvironmentKnowledge` / `listHypotheses` / `createHypothesis`；`EnvironmentView` 增加 `steps: BootstrapStep[]`。

诚实边界的落地：环境页在 `lastRound === 0` 时显示「这个环境还没探索过」并解释建档不回答流程问题，**不把空地图画成 0 个模块**；假设区写清「假设不进探索资产，判定是追加的」；造数开关默认关并写明它会真写被测系统。

## 6.1 三层职责（别再混）

| 层 | 回答什么 | 形态 | 有 run | 有会话 |
|---|---|---|---|---|
| 建档 `onboard.bootstrap` | 有哪些地址 | requests+bs4，零 LLM，不开浏览器 | 无 | **无** |
| 探索 `breadth`/`depth` | 地址怎么走通、前置条件 | 开浏览器跑几分钟 | 有 | **有，人工触发后系统代建** |
| 测试任务 | 这次验什么 | 六阶段 | 有 | 有（用户建） |

硬依据：`readTaskRuns(workspace, sessionId)`——全仓 run 必挂 session；QA 路由全是 `/:sessionId/*`。所以探索不建会话就没有 run/Trace/界面过程，这不是产品偏好是结构约束。建档没有 run，因此不建会话。

## 7. 环境坑（本次踩到，建议记入手册 §6）

1. **`requirements-ci.txt` 缺运行依赖**：原清单只有文档/图像几个包，缺 `pytest`、`pyyaml`、`requests`、`beautifulsoup4`。后果不是报"缺依赖"，而是 `probe_login` 静默降级到正则路径，`test_bootstrap_1010` 断言 `username_field == "u"` 失败，看起来像代码 bug。已在本批补齐前四个（后四个重包本机未装齐，不影响两个门禁）。
2. **`src/ifaces.json` 是 gitignore 的生成物**。给模块类加 `@Use()` 依赖后，本地那份会变陈旧，启动报 `ModuleBootError: ... run gen:ifaces`，`npx vitest` 全挂。修法：`cd platform/packages/server && npm run gen:ifaces`。拉代码后若遇到该报错，先跑它。
3. pip 装 `lxml/pillow/reportlab` 在本机极慢（单条命令超 5 分钟被杀），不是网络不通——PyPI 可达。装依赖请用后台任务，别同步等。

## 8. 未做（明确留空，不当已完成）

- 真实环境的建档 run 回执（需要授权地址 + 该地址从服务端可达）。本批只用「端口拒绝连接」验证了 spawn→`@@step`→`steps_json`→UI 这条链，没验过真实站点抓 12 个 bundle 时的耗时分布。
- maps 落盘目录仍是扁平文件名 `maps-<env>.yaml`（Python `write_bundle` 现状）。设计文档写的是 `maps/{env}/`；本批把目录定在 `<projectDir>/maps/<env>/`，文件名未改。要不要改成 `maps/<env>/pages.json|apis.json`，等批次 3 来源条款化时一并定，避免两次改落盘格式。
- `kb/<env>/` 目录本身（modules.yaml / flows / walls 的落盘）未做：本批只落了 DB 索引与接口，文件由探索 Agent 回传后再写，属批次 4 的产物。
- 环境档案页的「派发探索」入口：本批只有入口文案与空态说明，真正的派发（建会话 + 发 `breadth` 指令）在批次 3。页面上不放假按钮，只写"派发入口在批次 3 接通"。

## 9. 探索资产与假设闭环（本批新增，Codex 请重点复核第 2 条）

三张表跟着 `project_environments` 走，不跟 `qa_` 主区（那里是项目级、人产出物）：

| 表 | 性质 | 关键约定 |
|---|---|---|
| `qa_environment_knowledge` | 程序写，每轮**覆盖** | PK 带 env；不再出现的条目被删（它已不成立） |
| `qa_exploration_hypotheses` | 人提，待验证 | `allow_seed` 默认 0；statement 须可判定 |
| `qa_hypothesis_verdicts` | append-only | 假设表 status 只是最新快照 |

三个判断需要复核：

1. **为什么知识按环境分而不是按项目**：预发常比生产少几个模块。若合成一张项目级图，下游生成用例时会拿预发的模块去生产环境跑。技能文档里"项目库是唯一事实来源"是通用流程口径，本工程有环境实体，唯一性的最小单元是环境。

2. **为什么假设不写进 knowledge、也不走 `qa_knowledge_candidates`**：候选→规则那条是**业务规则**（退款必须原路退回），确认后约束断言；这里是**探索假设**（退款前需有已支付订单，请去验），确认后补的是链路前置条件。两者语义不同、生命周期不同（规则长期有效，假设一轮即判）。混用会让规则库塞满一次性的探索结论。

3. **为什么 verdict 要 append**：被推翻的结论决定断言放哪。用例里钉住了这个：退款超额是提交时才校验，断言放输入框会误报。只存最新 status，这个信息永久丢失。

接口：`GET/PUT /:env/knowledge[/:layer]`、`GET/POST /:env/hypotheses`、`POST /:env/hypotheses/:id/verdicts`。`GET knowledge` 一次返回四层 + 假设计数，避免首屏"地图有了、计数还是 0"的错帧。

留给下一批的接口空缺：探索任务派发（建会话 + 发 breadth 指令）、kb 文件落盘、探索产物写入 knowledge 的调用点（应由探索 Agent 回传后调 `PUT /:layer`，不由前端调）。
