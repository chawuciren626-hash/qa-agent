# 批次 2（环境与建档）· 服务端交接，2026-11-17

> 执行方：WorkBuddy。分支 `workbuddy/batch2-env-onboarding`，基线 `origin/main` `e05361a`。
> 本批只交付**服务端 + 执行入口 + 原型**；前端改动等原型确认后再动（见 §6）。

## 1. 完成度

| 项 | 状态 |
|---|---|
| B1 环境一等实体（表 / 状态机 / 默认环境） | ✅ 已完成 |
| A1 建档入口的服务端侧（创建即登记环境、地址校验） | ✅ 已完成 |
| 建档执行入口（`runtime_cli onboard.bootstrap`） | ✅ 已完成 |
| A1 前端（新建弹窗地址行、工作台环境条、环境页） | ⛔ 未动，等原型确认 |
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

**为什么不挂到 `stage-tool-runtime.mjs` / `tool-gate.mjs`**：那两个是"run 内、有 active stage"的通道，`runStageTool` 会校验 `manifest.stages[stage] === 'in_progress'`。建档发生在任何 run 之前，挂上去要么伪造一个 stage，要么让入口永远 409。因此本批没有改动批次 1 的工具通道文件面，也未动 `STAGE_TOOLS` 的断言。若 Codex 认为必须统一入口，建议另立一个"run 外工具通道"，而不是复用阶段工具。

## 5. 回归结果（2026-11-17 本机 Windows）

| 命令 | 结果 |
|---|---|
| `npm run ci:tools` | ALL PASS（含新增 `test_onboard_runtime_cli`） |
| `cd aitestharness-ir && python -m pytest tests -q` | 114 passed |
| `cd platform/packages/server && npx tsc --noEmit -p .` | 0 错误 |
| `cd platform/packages/web && npx tsc --noEmit -p .` | 0 错误 |
| `npx vitest run test/project-environments.test.ts` | 6 passed |
| `npx vitest run test/managed-projects.test.ts test/project-rename.test.ts` | 9 passed / 1 skipped（原有 runIf 跳过） |

新增用例覆盖：环境登记与"未建档≠0"、地址与环境名校验、失败不冒充成功、成功摘要落库、地址变更清空旧摘要、非成员 404。

## 6. 待产品确认（阻塞前端）

1. **环境地址在新建弹窗里选填还是必填**。原型按"选填，填了就创建后立即建档"做，好处是兼容"先建项目后连环境"的老习惯。
2. 环境页入口位置：项目内左侧导航新增一级「环境」，还是并进项目资料。

原型：`prototype/batch2-onboarding-prototype.html`（6 屏，含失败态）。

## 7. 环境坑（本次踩到，建议记入手册 §6）

1. **`requirements-ci.txt` 缺运行依赖**：原清单只有文档/图像几个包，缺 `pytest`、`pyyaml`、`requests`、`beautifulsoup4`。后果不是报"缺依赖"，而是 `probe_login` 静默降级到正则路径，`test_bootstrap_1010` 断言 `username_field == "u"` 失败，看起来像代码 bug。已在本批补齐前四个（后四个重包本机未装齐，不影响两个门禁）。
2. **`src/ifaces.json` 是 gitignore 的生成物**。给模块类加 `@Use()` 依赖后，本地那份会变陈旧，启动报 `ModuleBootError: ... run gen:ifaces`，`npx vitest` 全挂。修法：`cd platform/packages/server && npm run gen:ifaces`。拉代码后若遇到该报错，先跑它。
3. pip 装 `lxml/pillow/reportlab` 在本机极慢（单条命令超 5 分钟被杀），不是网络不通——PyPI 可达。装依赖请用后台任务，别同步等。

## 8. 未做（明确留空，不当已完成）

- 前端全部改动。
- 真实环境的建档 run 回执（需要授权地址 + 该地址从服务端可达）。
- maps 落盘目录仍是扁平文件名 `maps-<env>.yaml`（Python `write_bundle` 现状）。设计文档写的是 `maps/{env}/`；本批把目录定在 `<projectDir>/maps/<env>/`，文件名未改。要不要改成 `maps/<env>/pages.json|apis.json`，等批次 3 来源条款化时一并定，避免两次改落盘格式。
