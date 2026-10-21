# 本机统一目录迁移

## 当前主路径

统一根目录为 `E:\AITestHarness`。

| 项目 | 新位置 |
| --- | --- |
| Git 工程源码 | `E:\AITestHarness\source` |
| 应用启动程序 | `E:\AITestHarness\installed\AITestHarness.exe` |
| 部署业务引擎 | `E:\AITestHarness\installed\app\engine` |
| 宿主程序 | `E:\AITestHarness\installed\runtime\penguin` |
| 工具运行时 | `E:\AITestHarness\installed\runtime\tools` |
| 宿主模型配置和会话 | `E:\AITestHarness\installed\data\penguin` |
| QA 索引与保护数据 | `E:\AITestHarness\installed\data\qa` |
| 桌面状态 | `E:\AITestHarness\installed\data\desktop-profile` |
| 工作区与交付物 | `E:\AITestHarness\installed\workspaces` |
| 发行候选 | `E:\AITestHarness\releases\preview.3` |
| 迁移备份与记录 | `E:\AITestHarness\backups\migration-20261021` |

桌面新入口为 **AITestHarness（统一目录）**。公共桌面的旧 AITestHarness 图标因 Windows 写权限不足未修改，仍指向 `D:\Program Files\PenguinHarness`；当前使用新入口。用户桌面重复的 Preview 快捷方式已保留到备份目录。开始菜单的 AITestHarness Preview 指向新安装。

## 实施与保留

安装采用已验证的 preview.3 安装包，内置宿主 0.2.16。本机迁移没有修改安装包或公开发行候选，不会将迁入的模型配置打包分发。

源码复制包含 .git、未提交/未跟踪源码和现有本机业务配置；575 个 Git 管理/待提交文件在复制后与原仓库逐一校验一致，HEAD 保持 `42478b873627e4f6a166f43bbd3c77cc627885e3`。随后新增的迁移工具、测试及文档只写入新主仓库。原 scratchpad、dist、浏览器测试缓存和 nul 临时文件留在旧目录；当前发行候选另复制至 releases。没有提交、推送或创建新 Git 分支。

在宿主停止后，将宿主数据、QA 数据、桌面状态及工作区先复制到原始备份，再复制到目标，并逐文件校验，共 12345 个文件。期间发现长路径复制/校验问题，已以 Windows 扩展路径修复并从只读校验点继续；未删除原数据。新安装在迁移期间曾被打开，但其中没有任务；关闭后将其初始化数据另行保留。迁移时暂时移开目标 installation.json，使未完成的目标无法启动。

路径更新仅针对明确的运行元数据：

- 259 个原生 sessions 与对应 trace_sessions 的 workspace 字段。
- 98 个 .qa-session.json、对应索引和生成的命令转发文件。
- 运行 manifest 的 directory_context。
- 393 个 trace 文件的 session_meta.workspace / agent_state；历史消息、工具输入输出和系统提示正文不替换。
- 工作区记忆的 .workspace 标记与其基于路径计算的目录名。
- Python 探测缓存改用包内运行时；8 个受管理角色 hook 指向新的部署引擎。

模型配置、凭据、用户全局沙箱设置均保留。现有七个业务角色通过明确迁移记录认领，首次启动完成初始化检查，没有重新创建一套历史角色。test-assets、test-env、test-environments 本机配置复制到部署引擎配置目录并保留原始备份；这些本机配置不加入发布白名单。

## 验证结果

- 378 个原有会话保留。
- 9485 个不需要路径变更的工作区文件哈希不变，包括交付与证据；393 个 trace 文件的历史正文保持不变。
- 2 个宿主凭据/连接文件字节不变；31 张数据库表除明确迁移的路径与失效缓存字段之外一致。
- 父会话及专业子会话的目录上下文读取通过，新的 engine_root 指向 installed/app/engine。
- 应用启动后角色初始化 complete；启动前 12 项 doctor 检查 ready，鉴权 API 可用。
- 最近会话 `session-2026-10-21-14-01-22-a6ba9ff5` 可打开，历史消息、交付卡片和 Excel 下载可用。通过原生授权的浏览器会话实际点击下载，文件为 6193 字节，SHA256 为 `f95ba2426356a03b6c53867b0bcbe55f1d6a35fe7ce9eb3074d60017df720bc9`，与迁移前一致。
- 新建一个不调用模型的空会话，确认默认工作区为新的 installed/workspaces，随后通过原生 API 删除该诊断会话；没有重跑用户最小任务或六阶段任务。
- 迁移工程测试通过：外层 1 项合同测试执行内部 2 项 Python 测试，涵盖路径前缀边界、超过 260 字符的路径、凭据/交付保留、历史消息保留、索引缓存与重复迁移拒绝。报告：`output/engineering-tests/2026-10-21T08-19-09-970Z-8127a79a-f5fc-4a5b-99b8-b9e9c7a91803`。前两次测试暴露短路径别名和测试 SQLite 连接清理问题，修正记录保留。

接口和复制证据保存在备份目录的 journal.json、source-copy-check.json、data-verification.json、api-validation.json、new-session-validation.json、doctor-before-start.json。界面截图为 `output/playwright/unified-history.png`。初次浏览器验证只使用 API Bearer，普通下载未通过；改用宿主 `/api/remote/session` 提供的原生浏览器授权后实际下载通过，没有绕过鉴权。

最终联合回归 13 项中 12 项通过，包括迁移和工作区适配测试；工程审查用例预期 ready、实际 stopped。使用相同 Node 24 在旧仓库复验也出现同一失败，属迁移前既有问题，本轮未扩大范围修复。新报告：`output/engineering-tests/2026-10-21T08-34-39-997Z-8cedcb8d-fdef-4921-ae85-17ee2d07a033`；旧仓库对照报告：`E:\Codex\AITestWorker\output\engineering-tests\2026-10-21T08-37-42-953Z-d40dcdf7-9e8a-43e1-aae2-c66fcfcdfc30`。

启动后复查：鉴权服务 ready，12 项安装检查 ready，桌面新快捷方式目标正确，复制的安装包 SHA256 与原 preview.3 一致。收尾记录为备份目录中的 migration-result.json。此结果不代表公开发行验收完成。

## 迁移边界与恢复

102 个早期会话在迁移前已引用不存在的 `E:\Codex\测试智能体` 及其子目录。保留这些会话的历史消息，没有虚构工作区、替换为不对应的文件或宣称已修复。用户明确选择的外部桌面工作区保持原位置。迁移后未实际让模型续跑所有历史任务；路径上下文通过不等于所有中断任务已复验。

旧工程、官方宿主、.penguin 数据和 E:\QAWorkspaces 均保留，没有卸载或删除。需要回退时先停止新应用，再启动旧宿主；原始数据仍在旧位置。**新应用开始产生新数据后，不要用旧备份直接覆盖新数据**，应先备份并另做差异迁移。不要同时运行新旧实例作为同一项目的日常工作入口。

## 后续开发

在 Codex/编辑器中打开 `E:\AITestHarness\source`。Git 提交在这里进行；installed、backups、releases 位于仓库外，凭据和产物不进入 Git。源码修改后需要明确构建或受控部署，当前安装副本不会自动同步修改；不要直接运行源码中的角色同步命令覆盖安装角色，否则会把 hook 指回源码目录。

更新宿主仍按“调整版本锁定/兼容层 → 隔离回归 → 构建应用 → 验收安装包 → 发布新应用”进行。本次目录迁移不解除干净 Windows、新安装模型任务、六阶段发行验收等既有待办，也不代表已支持跨宿主版本的数据升级。
