# 本机拉取、合并、验证与部署流程

> 2026-11-24 客户端约定更新：远程客户端按 `remote-client-deployment-20261124.md` 和 `deploy-remote-client.mjs` 执行，取消本机业务服务自启。下文旧本机 Server/Web 同步流程仅供对应历史运行方式与恢复参考。

适用日期：2026-11-21。适用对象：AITestHarness 本机源码和已安装运行副本的日常更新。本文依据当前脚本及最近三轮部署记录整理；执行时以目标提交中的脚本、安装配置和实际状态为准。

## 1. 流程与完成标准

标准流程：确认目标提交 → 获取远端与本地状态 → 明确合并范围 → 固定源码 → 相关测试与完整构建 → 核对产物 → 正常退出客户端 → 安全暂停后台 → 备份 → 按变更范围同步 → 必要时迁移 → 恢复服务 → 安装环境验收 → 记录版本和恢复路径。

“代码已提交”“代码已推送”“源码已合并”“构建完成”“安装副本已更新”“真实场景验收通过”是六种不同状态，汇报时分别说明。只有安装副本更新、服务恢复和部署后检查完成，才能报告“已部署”。没有执行真实探索或模型调用时，只报告相应自动化测试通过。

日常更新直接同步本机运行副本。仅在用户明确要求时新增 Git 提交、推送远端或生成安装包/Release；构建部署请求本身不自动包含这些动作。

## 2. 目录与数据边界

| 用途 | 当前本机位置 | 操作原则 |
| --- | --- | --- |
| 主源码仓库 | E:/AItestHarness | 与 ZCode 共用，构建期间可能继续变化 |
| 本机安装目录 | E:/AITestHarness/installed | 以 installation.json 解析实际布局 |
| 应用程序 | runtime/penguin/resources/app | server/main/migrate-db、web-dist 及完整性清单 |
| 引擎 | app/engine | 通过引擎同步脚本和发布白名单管理 |
| 数据与会话 | data/、workspaces/ | 保留用户数据，不用源码目录覆盖 |
| 部署证据 | 源码目录 output/release/<本轮名称>/ | 构建日志、校验结果、备份路径、部署记录；不提交 Git |
| 本机备份 | 当前为 E:/AITestHarness/backups/ | 记录本轮脚本实际返回的绝对路径 |

以上绝对路径只描述本机运维环境，不能写死在通用运行时代码中。PenguinHarness 宿主继续保留，不用上游安装器覆盖受管理宿主。

账号、密钥、Token、模型凭据、数据库、工作区、真实任务产物、宿主二进制和备份不进入源码提交。任务列表数据只来自平台同步和用户创建；部署不能生成演示任务。产品标准资源初始化与任务初始化是两件事，标准资源运维另见 deployment-operations-initialization.md。

## 3. 确认版本、拉取与合并

先确定用户指的是哪个提交，截图或交接文档只用于定位，最终用 Git 对象确认完整 SHA、父提交、文件差异和测试范围。

PowerShell 示例（Git 命令失败时立即停止后续步骤，不整段无条件执行）：

~~~powershell
$SourceRoot = 'E:/AItestHarness'
Set-Location -LiteralPath $SourceRoot
git status --short
git branch --show-current
git remote -v
git log -6 --oneline
git fetch origin
git log --oneline --left-right HEAD...origin/main
git show --stat <目标提交>
git diff --name-status <当前部署提交> <目标提交>
~~~

远端地址输出前应注意脱敏；不记录含凭据的 URL。fetch 失败就如实记录，不能声称已完成远端同步。

按实际情况选择：

| 状态 | 处理方式 |
| --- | --- |
| 目标已在本地 main，例如 ZCode 已提交 | 直接固定目标 SHA 构建，无须制造一次重复合并 |
| 本地落后远端且工作区适合更新 | 使用 git merge --ff-only origin/main，完成后重新核对 HEAD |
| 目标在另一分支 | 审阅差异及提交关系，在隔离分支完成必要 merge 或 cherry-pick，解决冲突后重测 |
| 本地与远端分叉 | 先查清两侧提交；不能用强推或 reset --hard 消除分叉 |
| 主仓库有未提交或并发修改 | 保留原工作区，使用固定提交的隔离构建目录；不自动 stash、覆盖或清理他人工作 |

合并顺序服从依赖关系。冲突解决后需要重新检查接口、类型、运行配置及数据库迁移，不以“Git 合并成功”代替验证。只有用户要求提交/推送时才执行对应动作，推送完成后核对远端 SHA。

**近期实际情况：** dc71084 和 0cd0c6a 都已由 ZCode 提交到本地 main，本轮工作是审阅并构建部署固定版本；并没有每轮都执行远端拉取和分支合并，也没有替用户新增提交或推送。更早的远端推送是另一次获得明确授权的操作。

## 4. 固定源码，避免混入并发修改

构建前记录目标 SHA、工作区差异和源码来源。优先使用以目标提交为基线的干净隔离 checkout/worktree；工作树由应用管理时使用相应工作树能力创建和登记。

如果复用旧隔离工作树，需要补齐旧基线到目标提交的全部差异，逐文件核对目标提交内容。Git HEAD 仍可能显示旧基线，因此记录应写“基线 + 目标文件覆盖”，不能声称 HEAD 就是目标版本。更推荐后续直接使用目标提交建立干净工作树。

主仓库的“构建前干净”不能保证“构建期间没变化”。dc71084 部署曾发现 ZCode 在打包期间继续改探索模块，部署前一致性检查因此停止，随后验证服务端产物并用固定提交重建前端。

两种校验路径：

- 干净工作树：构建前后核对 HEAD 和 tracked diff，确认输入没有变化。
- 隔离快照：保存来源提交和输入文件哈希；必要时用 sourcemap 的 sourcesContent 与目标 Git blob 核对。近期部署核对了 495 个 server/src 文件，这只证明所核对的文件，不覆盖依赖、环境和所有构建输入；依赖锁文件、构建工具和配置也须单独记录。

Windows 上 C: 工作树连接 E: 的 node_modules/UI 资源，曾导致 CSS 字体路径出现跨盘错误。可将 web/ui 源码快照放在同一磁盘，采用仅用于构建的准确 UI 导出别名，并检查 CSS 所有 url() 资源。不能只看 Vite 退出码。

依赖版本以锁文件为准，不临时升级。复用 node_modules junction 的隔离目录不直接运行可能重装依赖的 pnpm 命令；确认依赖匹配后使用 Node 调用已安装构建工具。需要安装新依赖时，在适合的干净目录按锁文件安装。

## 5. 测试与构建顺序

先按变更选择有意义的回归，再完整构建受影响的产物。新增依赖注入字段时，先生成接口清单，再运行测试，避免 stale manifest 报错。

以下命令分别在注明的包目录执行，任一步非零退出都中止发布：

~~~powershell
# platform/packages/server
node ../../scripts/gen-ifaces.mjs --project tsconfig.json --out src/ifaces.json
node node_modules/vitest/vitest.mjs run test/project-exploration.test.ts test/exploration-knowledge-sync-render.test.ts test/exploration-knowledge-analysis.test.ts test/project-environments.test.ts test/qa-platform-tasks.test.ts
node node_modules/tsup/dist/cli-default.js

# platform/packages/desktop，服务端构建成功后执行
node node_modules/tsup/dist/cli-default.js
node scripts/build-assets.mjs

# platform/packages/web，或同盘固定源码快照中的 web 包
node node_modules/vitest/vitest.mjs run test/platform-tasks-page.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/vite/bin/vite.js build
~~~

部分服务端测试需要 AITEST_ENGINE_ROOT 指向本轮源码根；完整服务端构建近期使用 NODE_OPTIONS=--max-old-space-size=4096。这些是本轮进程环境，不应改变用户全局设置。

服务端完整构建包含 DTS，耗时较长；出现“ESM Build success”时仍要等 DTS 和整个进程结束。desktop 打包读取 server/dist，因此不能反过来或并行构建这两个阶段。desktop-assets 还会准备插件和原生依赖等资源；哪些需要部署，按发布范围检查。

构建日志单独保存，检查进程退出码。PowerShell 对原生命令 stderr 的处理可能产生误判，近期使用 Node spawnSync 将 stdout/stderr 写入日志并核对 status。

## 6. 部署前检查与冻结产物

进入维护前完成：

1. 确认源版本及包含的修复，核对 server.js、main.js、migrate-db.js 和 web-dist/index.html 存在。
2. 保存 SHA256、源码证明、测试结果和构建日志。产物冻结后不再被另一轮构建覆盖。
3. 检查新功能标识和已删除逻辑；字符串检查仅作辅助，实际行为依赖回归测试。
4. 检查 index.html 的 JS/CSS 引用及 CSS url() 对应文件，排除跨盘路径和残留旧资源。
5. 确认部署脚本读取的是本轮构建目录。脚本按自身所在源码根查找产物，不能在另一目录运行后误以为会部署指定源码。
6. 确认客户端/后台状态，选择安全维护窗口。构建阶段后台保持运行，尽量缩短暂停时间。

旧 web-dist 应整体替换，不把新 dist 合并到旧目录；否则旧 CSS/JS 会残留。备份或重命名时使用同盘目标，跨盘 rename 会报 EXDEV。文件变更前核对目标绝对路径，避免误操作。

## 7. 安全暂停、备份与数据基线

从托盘正常退出客户端。关闭窗口可能只会隐藏，必须查看 desktopCount；不直接启动 runtime/penguin/PenguinHarness.exe 绕过受管理启动器，正常入口是安装目录 AITestHarness.exe。

~~~powershell
# 在本轮固定源码目录执行
node scripts/local-service.mjs status E:/AITestHarness/installed/installation.json
node scripts/local-service.mjs pause E:/AITestHarness/installed/installation.json
~~~

只有官方 pause 成功、服务完全退出并产生维护标记，才替换程序。客户端仍连接、后台任务不允许停止或现状清单校验失败时，停止部署，保留当前程序；不强制杀进程或伪造维护标记。

暂停后备份数据库及本轮可能改动的配置，保存任务和资料基线。SQLite 优先使用官方 backup API，或确认数据库所有写入者都已退出后进行完整冷备；不在运行中仅复制 web.db 而遗漏 WAL。

基线至少包含：用户任务、非演示同步任务，以及项目资料的状态、修订号和内容哈希。备份位置和文件校验结果写进本轮记录。若更新涉及其他数据，也扩大保留检查范围。

程序部署脚本会备份程序和清单，但这不等于已经备份数据库、配置、工作区或所有引擎文件，需分别确认。

## 8. 按变更范围同步安装副本

| 变更类型 | 执行动作 |
| --- | --- |
| 已受支持的 server/web/desktop main 更新 | deploy-project-management-local.mjs |
| 引擎 Python/脚本/Skill 或发布资源变化 | 额外执行 deploy-engine-files.mjs |
| 已配置角色提示词/Agent 指令变化 | 按实际账户目录预览并应用 sync-penguin-agents.mjs |
| 数据库 schema 变化 | 备份后运行目标版本 migrate-db，并核对迁移账本 |
| 插件、原生模块、宿主或部署脚本不覆盖的产物变化 | 使用该版本相应完整部署流程；不能仅靠上述局部脚本宣称更新完成 |

~~~powershell
# 引擎有变化时，先同步引擎；无变化无需执行
node scripts/deploy-engine-files.mjs E:/AITestHarness/installed

# 同步应用构建产物
node scripts/deploy-project-management-local.mjs E:/AITestHarness/installed

# 仅需同步角色指令时；先预览，再按实际账户/Agent根目录应用
node scripts/sync-penguin-agents.mjs --target-root=<实际目标目录>
node scripts/sync-penguin-agents.mjs --apply --target-root=<实际目标目录>

# schema 有变化时；dataRoot 必须从安装配置解析
node E:/AITestHarness/installed/runtime/penguin/resources/app/dist/migrate-db.js <dataRoot> [dbPath]

# 全部同步和必要迁移成功后恢复
node scripts/local-service.mjs resume E:/AITestHarness/installed/installation.json
node scripts/local-service.mjs status E:/AITestHarness/installed/installation.json
~~~

应用同步脚本当前只覆盖 dist/server.js、dist/migrate-db.js、dist/main.js 和 web-dist，并更新 aitest-source-runtime.json；它不自动同步引擎、全部 desktop dist、全部插件或执行数据库迁移。引擎同步脚本按发布策略补充/更新 engine_files，报告旧清单中不再受策略管理的项，本轮不会直接删掉这些旧项。

单个部署脚本在自身复制/校验失败时会尝试回滚，但跨脚本步骤并非一个总事务。多步骤中途失败时，先确认已安装的各部分版本是否兼容，再恢复或回滚；不能无条件在 finally 中启动一个半更新环境。

## 9. 安装环境验收

恢复后依次检查：

1. 服务 ready=true、error=null；端口从当前锁文件/服务状态读取，不写死旧端口。
2. checkSourceRuntime 校验应用和引擎清单；运行中的 server.js 哈希与冻结构建一致。
3. 使用正确鉴权调用受影响接口；本机 api-token 仅用于本机运维，禁止输出或写入文档。
4. HTTP 实际返回首页 JS/CSS/字体，验证新前端代码已加载，不能只看磁盘文件存在。
5. 数据库 integrity_check=ok、foreign_key_check 无错误；任务及资料与维护前基线对比。
6. 保留账号服务配置，验证登录相关变更时客户端允许所有角色登录，后台仅管理员登录；不能重新启用本机自动 admin 模式。
7. 按修复点补充场景验收，例如空列表多次读取不写演示任务、无项目模型时账号回退、归档快照跳过及取消归档恢复。

最近任务列表验收为三个项目各请求两轮，均 HTTP 200；这只是该轮已知项目数，不是以后固定常量。真实任务变化可能来自用户操作或同步，应结合维护时间和审计判断，不能把合法业务变化当部署误删。

自动化用例通过、安装接口正常，不等于已经执行真实模型请求或真实站点探索。未执行的验收明确标注。历史轮次错误摘要不因程序更新自动改写，归档状态也不由部署擅自取消。

## 10. 失败处理与恢复

- 测试或构建失败：保持现有应用运行，修复后只重跑必要检查，再继续部署。
- pause 被拒绝：保持服务原状态，说明客户端或任务阻塞原因，等待安全窗口。
- 单脚本部署失败：确认脚本回滚结果和完整性校验，不能只看到“已回滚”字样就结束。
- 恢复后验收失败：安全暂停，按本轮备份恢复相互匹配的程序/引擎/清单；数据库是否恢复要根据迁移兼容性和维护后新增业务数据决定，不能随意用旧库覆盖新数据。
- 数据库迁移失败：保持维护状态，保留日志和现场，使用已验证备份恢复，或修复后继续迁移；未经确认不能启动不兼容版本。

应用备份一般包含 server.js、main.js、migrate-db.js（原先存在时）、web-dist 和完整性清单；引擎备份由引擎同步脚本另存。引擎与应用都更新时，按同步的逆序恢复，并使用对应阶段的清单，避免把新引擎与旧 engine_files 哈希混合。

恢复完成必须重新校验清单、恢复服务并重复相关安装验收。不要手工篡改哈希来掩盖文件不一致。若无法恢复，报告服务当前是否暂停、失败步骤及明确恢复入口。

## 11. 每轮应交付的记录

记录放在 output/release/<本轮名称>/，至少包含：

- 目标完整 SHA、实际构建输入和当前部署版本；是否执行拉取、合并、提交、推送，分别说明。
- 本轮包含/排除的变更，依赖和配置变化。
- 测试数量、构建结果、日志路径及验证边界。
- 产物 SHA256、程序/引擎/数据备份的真实绝对路径。
- pause、同步、迁移、resume 的结果。
- 安装接口、静态资源、数据保留和完整性验收。
- 未完成验收及失败时的恢复方式。

面向用户的完成说明采用“提交版本 + 部署位置 + 已生效行为 + 验证结果 + 未覆盖验收 + 记录链接”。不把源码检查包装成安装验收。

## 12. 最近三轮的可追溯实例

| 部署内容 | 目标版本 | 记录位置 |
| --- | --- | --- |
| 探索后 LLM 项目知识文档 | 5cefd69（文档 64dcd86） | output/release/exploration-knowledge-20261121/deployment-record.md |
| 平台任务账号模型回退及移除演示种子 | dc71084 | output/release/account-model-fallback-dc71084/deployment-record.md |
| 探索快照归档跳过与恢复 | 0cd0c6a | output/release/snapshot-archive-0cd0c6a/deployment-record.md |

这些轮次完成的是本机安装版更新，不应据此声称虚拟机或其他服务器也已更新。跨环境部署需分别确认目标、服务配置、备份、发布与验收；2026-11-24 虚拟机切换记录见 deployment-single-instance-20261124.md。
## 当前客户端部署入口（2026-11-24）

远程业务客户端按 `remote-client-deployment-20261124.md` 执行。使用 `deploy-remote-client.mjs` 进行检查、备份、受保护暂停和主进程/启动脚本同步，取消本机业务服务自启；不使用旧流程把 Server/Web 和业务库再部署为一套客户端实例。本文保留旧运行方式供历史恢复参考。服务端仍通过统一实例部署流程维护。
