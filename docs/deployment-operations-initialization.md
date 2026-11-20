# 部署、运维与标准数据初始化

适用版本：main，标准数据基线 `2026.11.16.1`。维护日期：2026-11-20（main 合并验证；基线标识保持不变以兼容已有记录）。

## 1. 部署交付原则

部署完成必须同时具备程序、数据库结构、标准数据、资源关联和运行配置。后台页面通过服务读取数据库；页面能打开或接口返回 200，不代表部署完成。

标准定义随源码维护，部署时写入中央服务对应表。中央数据库是管理和授权的运行期依据。用户不需要首次使用向导来补齐产品自身的数据。首次使用的“开始使用”、角色就绪统计、示例任务、引导专用连接检查及浏览器完成标记已移除；正常模型配置、连接测试、任务场景和输入框保留。

初始化命令：`scripts/initialize-standard-data.mjs`。必须在中央服务所在机器、当前部署源码目录中运行，使用与应用一致的 Node.js 24 和构建产物。不要在 develop 的数据目录上运行 main 初始化。

## 2. 标准数据与存储位置

| 模块 | 标准来源 | 运行期存储与要求 |
| --- | --- | --- |
| Agent 管理 | `penguin/agents.json`、对应角色指令、`penguin/command-runtime.md` | `public_resources` 中 11 个 Agent，`public_resource_versions` 保存发布快照，依赖版本和哈希写入 `public_resource_version_dependencies` / `public_resource_version_pins` |
| 技能管理 | `skills/` 中 15 个维护目录 | `public_resources` 中完整 ZIP 资源；包含 SKILL.md 及脚本、参考材料、模板等；`central_skill_versions` 保存版本标签，分类写入 `central_skill_categories` / `central_skill_assignments` |
| 插件管理 | `platform/plugins/*/package.json` 中随版本交付的插件；4 个受信适配器 | `public_resources` 中记录插件名、版本、来源；分类写入 `public_plugin_categories` / `public_plugin_category_assignments`。登记插件不等于给所有 Agent 全局启用插件 |
| 模型配置 | 服务端 `model-catalog/seed.ts` | `central_model_config` 加密保存渠道、模型目录、默认选择与折扣配置；模型条数随锁定版本变化，不在部署脚本另抄目录 |
| 工具管理 | `central-tools.ts` 的标准工具定义 | `central_tools`、`central_tool_categories`、`central_tool_agents`；未实现工具保持停用，不把规划项标记为可执行 |
| Agent 分类 | 中央服务内置阶段定义 | `public_agent_groups` / `public_agent_group_assignments` |
| 菜单与权限 | `AdminSystemStore` 内置菜单和现有身份系统 | 11 个管理菜单落入 `public_admin_menus`，普通角色菜单落入 `public_role_menus`；内置管理员/普通用户身份仍由 `users.is_admin` 决定，不另建冲突的身份体系 |
| 管理员助手 | 现有项目创建服务 | 创建 `admin_agent_catalog` 项目及 `default_agent`；项目表和项目目录由项目服务一起维护，模型配置来自中央模型目录 |
| 初始化记录 | 本次标准定义 | `standard_data_baselines` 记录资源逻辑标识、数据库 ID、初始内容哈希、基线版本和创建时间；写入动作进入管理审计表 |

公共通用 Agent 标识为 `general_agent`；管理员助手项目中的入口标识为 `default_agent`。两者用途不同。

模型密钥、登录密码、授权 Token、业务测试凭据、用户任务、会话、工作区、记忆及历史报告均不属于标准数据。初始化不复制旧部署的这些内容，不生成假任务或假测试结果。

## 3. 首次部署步骤

以下变量由部署配置提供。示例为 Linux shell；`SOURCE_ROOT` 是本次版本源码，`CENTRAL_HOME` 是本次中央服务的数据根目录，`CENTRAL_ORIGIN` 是其本机应用地址（默认使用 `http://localhost:端口`；`127.0.0.1` 可能被宿主保留为预览域，API 会拒绝访问）。

```sh
cd "$SOURCE_ROOT"
# 按项目锁文件安装依赖并完成 core、server、cli、web 构建。
# 首次启动中央服务，完成数据库建表和管理员账号配置；随后正常停止该中央服务。
node scripts/initialize-standard-data.mjs seed "$CENTRAL_HOME"
# 启动同一数据目录的中央服务，再执行：
node scripts/initialize-standard-data.mjs complete "$CENTRAL_HOME" "$CENTRAL_ORIGIN"
node scripts/initialize-standard-data.mjs check "$CENTRAL_HOME" "$CENTRAL_ORIGIN"
```

三个阶段必须纳入部署流水线，并检查退出码。任一步失败都不能报告“部署完成”。

1. **seed：离线标准数据入库。** 数据库必须由中央服务正常创建。检测到锁文件对应进程仍存活时拒绝运行。按技能、插件、Agent 的顺序创建和发布资源，建立依赖版本，初始化模型目录、菜单及分类。资源发布、依赖、模型和菜单处于同一 SQLite 事务中，失败回滚。辅助服务建表和工具基础登记使用现有服务初始化逻辑，可能早于资源事务完成；失败后可修正原因再执行，不需要删库。
2. **complete：在线完成助手项目。** 使用中央数据目录内的本机 `api-token` 调用正常项目创建接口，存在则保留；随后检查助手入口、模型目录、工具和标准资源。只接受本机回环地址，拒绝把本机凭据发给远程服务；不打印凭据。
3. **check：复核。** 检查标准资源及发布状态、助手项目和入口、模型目录、工具目录；输出资源数量。此阶段不创建项目。正常服务读取模型时会同步助手运行配置，所以它不是严格的文件系统只读操作。

中央启动需要 `AITEST_ACCOUNT_CENTER=1`。客户端使用 `AITEST_ACCOUNT_CENTER_ORIGIN` 指向中央服务，按部署已有账号绑定方式配置。`AITEST_ENGINE_ROOT` 必须指向本次部署的引擎，不能指到 develop；工具运行状态依赖这一配置。

模型目录入库只说明配置项存在。管理员还需在模型配置中设置真实可用的渠道凭据或本地服务地址，选择默认模型并执行正常连接测试。中央助手使用中央配置；用户项目的模型权限和凭据遵循既有账号/项目配置机制，不会因为初始化自动获得中央密钥。

## 4. 重复执行、升级与管理员修改

- 资源按稳定逻辑标识识别：Agent ID、技能名、插件来源加插件名；重复执行不重复创建、不增加发布版本。
- 已有资源的名称、内容、授权范围、未发布编辑和版本保留。已有模型目录（包括管理员主动清空的目录）、默认模型、密钥、菜单开关、工具启停及工具关联保留。
- 标准资源已撤回、删除或存在重复标识时停止并报错，交由管理员核对。初始化不会悄悄恢复被停用的能力。
- 基线版本升级可以补缺失资源；它不自动覆盖已存在的旧定义。标准指令或插件版本变更需要单独审阅和发布，不能用初始化命令充当强制升级工具。
- `preserved` 表示已有记录保留，不表示其内容与新版源码完全一致。验收中应结合管理审计和发布版本判断是否需要升级。

## 5. 上线前验收

```sh
cd "$SOURCE_ROOT"
node --test tests/deployment/standard-data.test.mjs
node scripts/initialize-standard-data.mjs check "$CENTRAL_HOME" "$CENTRAL_ORIGIN"
```

工程测试覆盖：空库完整发布及依赖、稳定资源打包、重复执行不改变资源/模型、管理员修改保留、依赖缺失回滚、撤回资源不自动恢复。它们使用独立内存数据库，不使用真实任务数据。

环境验收应记录：

1. 后台各模块有实际数据库记录，Agent 11 个、技能 15 个，插件包含本版本内置库及 4 个受信适配器；模型、工具数量与当前构建定义一致。
2. 管理员助手能进入 `admin_agent_catalog/default_agent`，模型列表来自中央配置；模型连通性单独测试。
3. 使用普通用户身份验证资源授权及任务入口，不以管理员能看到资源替代普通用户验收。
4. 用户新建任务页面不再出现“开始使用”指引；任务场景、工作区选择、输入框可用。
5. 重启服务后数据仍存在；再次初始化不产生重复记录和版本。
6. 有凭据及授权的情况下执行一项真实任务并检查产物；缺少凭据时明确记录“标准数据验收通过，真实模型调用未验收”，不能将其写成端到端通过。

## 6. 备份与恢复

升级前检查运行中、压缩中及等待处理的任务和调度，安排维护窗口；正常停止本次实例，不通过强杀中断用户任务。数据库、`central-model-config.key`、项目目录、运行配置和应用构建必须成套备份到源码目录之外，并限制访问权限。

在线备份 SQLite 必须使用 SQLite backup API；直接复制数据库文件应在服务停止后进行，保留相关 WAL 文件。不可只备份数据库而遗漏加密密钥。

恢复时停止失败版本，保存失败现场，然后将备份中的数据库、密钥、项目目录、配置和对应构建一起恢复。核对路径及端口后启动，再执行 `check`。不要把 main 数据恢复到 develop，或用 develop 的构建直接打开 main 数据库。

## 7. 故障定位

| 现象 | 检查与处理 |
| --- | --- |
| 后台全空 | 核对访问的是中央端口、数据根目录及数据库；检查部署是否执行 seed/complete，而不是要求用户补建标准记录 |
| 助手缺项目 | 执行 complete，检查项目创建接口与目录权限；不要直接手工插项目表 |
| 模型列表为空 | 确认 `central_model_config` 是否已存在但被管理员清空；初始化会保留它，需管理员通过模型设置处理 |
| 有模型但调用失败 | 在正常模型设置中检查凭据、地址、额度与默认选择；不重跑初始化覆盖配置 |
| 标准资源未发布或已删除 | 查看审计和历史版本，确认管理员意图；不要删库重建 |
| 技能有名称但资源不可用 | 检查发布归档完整性及 Agent 依赖版本，不能只放 SKILL.md 文本 |
| 工具状态未生效 | 检查本次实例的 `AITEST_ENGINE_ROOT` 与 `config/tool-runtime-state.json`，确认没有指向其他部署 |

部署记录应保存源码版本、未提交改动清单/校验值、构建结果、备份位置、seed/complete/check 输出和实际验收范围；不得包含明文凭据。
