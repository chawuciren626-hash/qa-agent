# 工程与宿主整合、逐步自主化可行性研究

> 路线已修订：用户明确长期保留 PenguinHarness 底座，持续跟随上游做兼容更新。后续以[产品整合计划](product-integration-plan-2026-10-21.md)为准。本文保留此前技术调研与方案比较；其中替换执行内核的建议不再是实施目标。

日期：2026-10-21。范围：当前 AITestWorker 源码与 PenguinHarness v0.2.16 官方源码、许可证、更新文档。结论来自源码与文档核查，尚未构建独立发行版或验证替代引擎原型。本次不迁移正式数据、不调整正在运行的宿主、不改更新配置。

## 结论

可行。推荐走“统一产品发行 → 收拢宿主适配接口 → 自有界面与业务服务 → 按需替换执行内核”的路线。

三个目标应分开验收：

1. **一个目录、一个启动入口**：可以较早实现，但内部仍要分开程序、数据和工作区。
2. **能够持续吸收上游升级**：通过锁定版本、兼容测试、自己的发行流程实现；不能承诺任意官方版本可直接覆盖而无需适配。
3. **逐步成为自己的产品**：先掌握安装、界面、业务状态与更新，再决定是否替换内核。产品自主不要求立刻重写模型循环、上下文压缩等通用能力。

不建议长期依赖修改压缩后的 JavaScript；也不建议第一步就把上游源码混入现有 scripts 目录并大面积改名。

## 已核实的条件

### 上游允许二次开发，且具备分层结构

- v0.2.16 的 LICENSE 为 Apache-2.0，允许按其条款修改和再分发。发行时须携带许可证、保留适用声明、标注修改，并按要求处理 NOTICE；许可证不授予上游商标权。使用自己的品牌可行，但不能把保留的上游代码宣称为完全原创。
- 上游另有 THIRD-PARTY-NOTICES.md。运行时、字体、Git 等分发物各自保留许可证；新发行包须按实际包含内容整理第三方声明，不能只复制一个 Apache 许可证就视为完成。
- 源码分为 core、server、web、desktop、cli、hmr。Web 通过 HTTP/SSE 访问 Server；Electron 桌面壳承载本地服务及窗口；core 提供 Agent 执行引擎。
- 上游源码及 npm 安装要求 Node >=24，使用 pnpm；本工程 package.json 当前声明 Node >=20.11。整合构建必须明确宿主与测试工具的运行时，不能直接沿用现有最低要求声称满足上游。
- `@prismshadow/penguin-core/plugin` 定义 `modules` 和 `replaces`：可新增模块，也可按名称替换宿主模块。接口结构在启动前检查，缺失依赖会导致启动拒绝。它提供渐进替换的基础，不是未来版本永不变化的兼容承诺。
- `@prismshadow/penguin-server/plugin` 已暴露 Sessions、AgentService、Http、WebShell 等类型接口；HTTP 插槽提供带认证策略的路由组，WebShell 提供页面等贡献点。这些是迁出补丁的候选入口，尚未证明现有所有定制都能直接迁入。

### 当前工程已有独立业务能力，也有深度耦合

| 部分 | 当前情况 | 自主化工作 |
| --- | --- | --- |
| 测试领域 | 角色、Skills、Schema、阶段规则、执行证据和交付校验在本工程 | 保留，逐步形成独立业务模块 |
| 执行与文档 | Playwright 执行器、Excel/XMind、Word/PDF 生成逻辑已在本工程 | 独立打包 Node/Python/浏览器依赖，验证干净机器安装 |
| 客户端 | 已有 workspace-ui、delivery-ui；仍嵌入宿主前端组件及请求环境 | 先抽离接口依赖，再形成自己的前端入口 |
| 宿主补丁 | 安装器修改 server.js、前端 bundle；品牌安装器修改桌面部分 | 优先改为插件或源码级小范围适配，减少编译符号依赖 |
| Agent 派发与恢复 | 依赖 run_subagent/input_subagent、父子会话、hook 和宿主中断语义 | 建立运行时适配层，保留幂等与恢复语义 |
| 运行证据 | stage-evidence 等直接读取宿主 trace 和消息字段 | 用适配器转换为业务事件；保持原始证据来源与标识映射 |
| 会话及模型 | 聊天历史、模型配置、认证、流式消息仍主要由宿主承担 | 中期复用，后期逐项替换；历史会话单独迁移 |
| 安装与升级 | 当前依靠官方安装包，再安装本工程补丁 | 建立自有版本组合、启动器和升级事务 |

本次 0.2.13 → 0.2.16 已需要适配前端符号、文件路由与子 Agent hook 装配位置，证明“仅把目录合并”不会消除升级成本。

## 单目录方案

建议先以一个用户可写的产品根目录统一管理，例如下列**目标结构**，并非本次已创建：

```text
E:\AITestHarness\
  AITestHarness.exe          自有启动入口，后续形成安装器
  app\
    engine\                 测试业务引擎，第一阶段保持稳定真实路径
    ui\                     自有界面资源
    adapters\penguin\       宿主相关代码的集中边界
  runtimes\
    penguin\0.2.16\         经过验证的宿主运行时
    node\                   工具运行时（是否与宿主共用须验证）
    python\                 报告运行时
    browsers\               Playwright 所需浏览器
  data\
    penguin\                宿主数据
    desktop-profile\        Electron 状态与浏览器配置
    qa\                     工程应用数据及索引
  workspaces\               新任务与交付物
  updates\                  下载、暂存、兼容清单和升级日志
```

备份至少有一份保留在产品根目录之外，避免卸载或目录损坏连带丢失。选择外部项目的用户仍可把工作区放在外部；“一个目录”指默认安装与管理体验。

具体限制：

- 上游支持 `PENGUIN_HOME` 指定数据根；本工程已有 `QA_APP_DATA_ROOT`、`PENGUIN_AGENT_ROOT` 和角色同步 `--target-root`。可以由统一启动器计算并传入路径。
- `PENGUIN_HOME` **不负责迁移 Electron userData**。桌面日志、Cookie/浏览器状态、端口文件等跟随 app identity/userData；完全收进一个目录需要桌面层支持，且须在 Electron 读取路径之前设置。源码核查尚未发现可直接满足全部目录迁移的统一便携开关。
- `application-data.mjs` 明确要求应用数据与 engine 不相互包含。放在同一父目录下的不同子目录满足设计方向，不应删除隔离检查来实现整合。
- 当前路径检查拒绝链接重定向，运行清单还记录绝对 engine_root、session_root。不能用 current 目录链接或直接切换业务引擎版本路径，假设旧运行会自动继续。第一阶段保持 engine 的稳定真实路径；后续先引入逻辑安装标识与受控路径迁移，再做完全按版本切换。
- 搬迁需要处理 hook 的 project.json、工作区绑定、运行清单和历史文件链接。推荐先复制到新位置并校验，完成切换后保留旧位置；旧会话是否续跑与新会话能否工作是两个验收项。
- 同一份宿主数据不得被新旧实例同时写入。SQLite 及其日志应在正常退出后备份，不能把运行中随意复制数据库视为一致快照。
- 单目录不等于跨电脑免安装：Windows 凭据、浏览器登录、原生依赖及系统默认打开程序仍须单独验证。

源码组织与产品安装目录可以不同。建议源码维护自有 packages/apps 与固定上游来源；产品目录只放构建结果及运行依赖。不要把开发仓库、node_modules、用户会话和交付证据全部塞入同一个 Git 版本控制范围。

## 后续如何跟随 PenguinHarness 更新

整合产品应有**一个负责最终更新的组件**。上游发布新版本是输入，由自己的发行流程决定何时进入产品。

建议锁定一个兼容组合：自有产品版本、PenguinHarness tag/commit、适配器版本、补丁或插件版本、数据格式版本、运行时版本及文件摘要。产品版本独立于上游版本。

升级流程：

1. 发现上游新版本，读取变更记录、接口变更及数据迁移要求。
2. 在暂存目录取得官方制品或从固定 tag 构建，核验来源与摘要。
3. 应用适配并跑契约测试：会话/流式、派发与中断恢复、权限、人工操作、文件交付、历史读取。
4. 使用与正式数据隔离的样本副本测试迁移；测试环境关闭计划任务、外部连接及真实执行副作用。
5. 等活跃任务结束或受控暂停，关闭应用，备份一致的数据与旧程序，再切换。
6. 启动健康检查失败则执行已验证的回退策略，成功才标记升级完成。

数据与程序回退必须分开：新版写过数据库或改变历史格式后，回退程序不一定兼容新数据。必要时恢复升级前快照，并另外保存升级后产生的数据，不能直接覆盖掉新增会话。

上游桌面 electron-updater 指向官方 GitHub/镜像，安装元数据使用上游 appId 和签名发布者。自有产品需要自己的 appId、发布源、安装/卸载身份及签名方案，避免升级回官方完整应用。当前官方更新器不会自行下载，但用户触发更新仍会替换文件。

`PENGUIN_UPDATE_CHECK=off` 文档只承诺关闭版本检查；不能把它视为禁用了所有手动升级、热更新和远程更新入口。自有发行版还须审查并统一管理这些路径。上游另有 hmr 版本存储/切换机制，完整二次发行不能只改一个下载地址。

在尚未完成独立打包前，可继续沿用本次“官方升级 → 精确适配 → 校验”流程；进入自有发行后则由产品更新器分发经过验证的组合。

## 渐进替代路线与验收门槛

### 第一阶段：统一发行和路径管理

产出：统一启动配置、目录清单、安装/卸载责任划分、复制迁移与回退工具、依赖清单。

通过条件：在隔离目录启动一套产品；新建任务、已有交付读取、角色同步通过；不依赖原工程的绝对路径；正式旧数据保持可用；卸载程序保留用户数据。不要在首次目录迁移中同时替换执行内核。

### 第二阶段：先收拢宿主边界，再减少编译补丁

定义自有 `AgentRuntimeAdapter` 概念接口，至少涵盖：会话创建与输入、事件流、派发子任务、取消/续接、工具权限、人工操作、交付物索引、证据读取及能力发现。名称是建议，不是现有实现。

让业务代码依赖该接口，由 Penguin 适配器翻译实际 API、trace、会话 ID 和 hook。业务 run_id 与宿主 session_id 分开关联，避免宿主 ID 格式扩散为永久数据约束。

候选替换顺序：角色/Skills 插件化 → 交付与人工操作 HTTP 路由 → 页面/工作台入口 → 子任务与工具边界。每迁出一类补丁，才删除对应补丁配方。

上游 Workbench 适合先做测试工作台，但不能单凭 Workbench 存在就认定它能够替代整个客户端、所有原生打开功能和子 Agent hook。

通过条件：可枚举剩余宿主依赖；业务层不再直接解析宿主 trace；父子任务中断后不重复派发；权限与文件边界测试通过。对于无法用公开扩展点实现的能力，保留小范围源码适配，并记录对应上游提交。

### 第三阶段：自己的界面、业务服务与桌面壳

以现有 workspace-ui/delivery-ui 为起点做独立界面，脱离宿主内部 React 符号。由自己的服务掌管测试项目、运行状态、交付和历史检索，Penguin 作为后台运行时。

聊天记录仍可先由 Penguin 保存，通过适配器读取；测试状态与交付事实由自己的数据模型掌管，避免两个系统互相改写同一份事实。

通过条件：用户只启动 AITestHarness；在源码中升级 Penguin 不要求改业务界面；安装、更新、异常提示、文件打开均由自己的产品负责。

### 第四阶段：按价值选择是否替换运行内核

先替换产品特有的编排、恢复和工具执行接口；模型调用、上下文管理等可继续复用 core，或者以后实现另一个适配器。

真正完全替代需要承担模型协议、流式事件、工具循环、上下文压缩、会话恢复、并发与取消、子任务生命周期、认证和权限、凭据及成本统计等能力。仅把总控提示词搬走不等于替代引擎。

验证新内核时使用隔离样本和事件回放；不能让两个内核同时操作同一个真实业务站点。先做一个角色的完整交付，再验证中断恢复和多阶段链路。历史会话初期可只读保留，续跑迁移单独验收。

当已经不依赖上游某个模块时，其后续更新可以不再吸收。完全自主后的目标是选择性吸收上游改进，而不是永远合并整个上游发行版。

## 方案比较与建议

| 方案 | 短期成本 | 上游升级影响 | 与目标的匹配 |
| --- | --- | --- | --- |
| 只合并文件夹、继续编译补丁 | 最低 | 原有耦合全部存在 | 只能作为过渡 |
| 上游插件/适配器 + 自有发行和界面 | 中等 | 主要集中在适配边界，可逐版验证 | 推荐主线 |
| 维护上游源码分支并大量修改 | 初期可快速接管，长期合并成本高 | 每次合并需处理冲突和行为差异 | 仅在扩展点不足处局部采用 |
| 立即全部重写 | 最高 | 后续无整包升级依赖，但自担全部维护 | 当前不推荐 |

建议下一项是一个有明确退出条件的隔离原型：**固定 0.2.16，验证统一根目录启动，并把一个交付只读接口从编译补丁迁到服务端插件**。同时验证会话权限和插件不兼容时的失败处理。通过后再实施正式迁移；若插件能力不足，选择局部源码适配，而不是放宽安全检查。

本次未给固定工期：独立打包、原生依赖和插件覆盖范围尚未做构建验证。第一阶段范围明确，可优先推进；完全替代引擎属于后续产品工程，应按每阶段实测结果估算。

## 核查依据

本地代码：`scripts/application-data.mjs`、`scripts/directory-context.mjs`、`scripts/sync-penguin-agents.mjs`、`scripts/install-penguin-runtime.mjs`、`scripts/penguin-reliability-patches.mjs`、`scripts/stage-evidence.mjs`、`scripts/command-runtime.mjs`、`penguin/ui/`、`config/release-resources.json`。当前发布清单仍明确为源码资源白名单，不是可执行安装包。

官方资料均固定到 v0.2.16，避免 main 后续变化混淆本次结论：

- [许可证](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/LICENSE)与[第三方声明](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/THIRD-PARTY-NOTICES.md)。
- [架构说明](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/docs/content/architecture.zh.md)。
- [插件契约及模块替换](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/core/src/plugin/index.ts)与[服务端插件接口](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/server/src/plugin/index.ts)。
- [页面扩展插槽](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/server/src/http/routes/contributions.ts)与[HTTP 路由插槽](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/server/src/http/app.ts)。
- [桌面身份与数据目录](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/desktop/src/app-identity.ts)、[服务配置](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/server/src/config.ts)。
- [更新文档](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/docs/content/updates.zh.md)、[桌面打包配置](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/desktop/electron-builder.yml)、[热更新机制](https://github.com/Prism-Shadow/penguin-harness/blob/v0.2.16/packages/hmr/README.md)。
- [0.2.16 发布与迁移说明](https://github.com/Prism-Shadow/penguin-harness/releases/tag/v0.2.16)，包含 Workflow/Workbench 路由和 Agent SDK 调用变更，说明公开接口也需要逐版验证。

研究用上游文件副本保存在本机 `scratchpad/integration-research/`，未纳入发行资源。本轮仅新增此研究报告。
