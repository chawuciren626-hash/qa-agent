# 产品整合实施记录

日期：2026-10-21。状态：内部安装预览，`distribution_ready:false`。保留 PenguinHarness 作为上游宿主，不替换其执行内核。用户确认当前没有干净 Windows 测试机，本轮先完成本机验证，干净机器验收保留。

## 已实现

| 项目 | 实现 |
| --- | --- |
| 路径与入口 | 安装配置 schema；统一/既有布局解析、边界与链接检查；CLI 诊断、状态、启动、升级检测和迁移预检；自有 Windows 启动器 |
| 兼容策略 | 固定 Windows x64 PenguinHarness 0.2.16；未知版本要求兼容审核；官方更新只读检测，不自动安装 |
| 桌面与数据隔离 | 独立桌面身份、profile、宿主数据、业务数据和工作空间；关闭此产品实例的上游自动更新入口，避免绕过适配流程 |
| 首次运行 | 原生宿主 API 创建七个角色，初始化记录与冲突保护，同步 Skills/hooks 和角色工具接口；不发送模型请求 |
| 打包 | 官方固定来源和哈希、生产资源白名单、Node 24.14.0、Python 3.12.10 及文档依赖、Playwright Chromium；逐文件清单与第三方声明 |
| 安装卸载 | 用户权限安装、快捷方式、安装位置初始化；拒绝非空覆盖；卸载检查自身运行进程并保留用户数据 |
| CI | 手动 Windows 安装候选构建工作流，安装内工具检查及卸载保留数据检查；生成 artifact，不自动发布 Releases |

## 本机证据

- 产品合同测试最新 14/14 通过：`output/engineering-tests/2026-10-21T03-12-46-188Z-09b0c6d9-e23f-464b-9d4a-9c27df87361a`。
- 较早产品/数据/安装组合 23/23 通过：`output/engineering-tests/2026-10-21T03-00-24-069Z-3ed0f643-57e7-4534-938a-a6e1a1450076`。这些有重叠，不相加统计。
- 清洁构建目录清单 4,751 文件，通过哈希与私有状态文件检查；源码发布白名单 244 项检查通过。
- 复制安装验证目录 `E:\QAInstallTests\测试应用 20261021-1`：中文/空格路径、自有启动器、七角色初始化、全部 doctor 检查、localhost 鉴权状态及首页验证通过，与原宿主共存。截图 `output/playwright/product-installation-home.png`。
- 首版真实 NSIS 安装：默认 `%LOCALAPPDATA%\Programs\AITestHarness`，安装退出 0，快捷方式/卸载登记创建，首次启动与 doctor/status 均通过。
- 初次静默安装传入正斜杠 `/D=E:/...` 未应用目标目录，实际安装到默认目录；后续命令与 CI 改用 Windows 绝对路径，并强制检查目标文件，不能只相信退出码。
- 首次内置工具检查发现嵌入式 Python 的 `._pth` 不包含业务 helpers，Excel 导出失败。已在构建流程加入相对路径 `../../../app/engine/scripts`，不依赖开发机器路径。
- 修复后的已安装目录，移除开发环境 PATH：XMind、Excel、Word、PDF、HTML 和内置无头浏览器全部通过。证据 `E:\QAInstallTests\runtime-evidence-02\result.json`。仅合成导出验证，PDF检查文件结构标记，未据此宣称版式或真实业务验收通过。
- 运行中的卸载前置检查拒绝移除；关闭本次合成测试实例后实际卸载退出 0，程序目录移除、数据和工作空间哨兵均保留。原有 `D:\Program Files\PenguinHarness` 未关闭或迁移。
- 最终候选重新从 NSIS 安装到 `E:\QAInstallTests\正式安装 中文 20261021`，退出 0、指定路径正确，无手工修补。内置工具冒烟全部通过；首次桌面启动后 doctor 的 12 个顶层检查及鉴权服务状态均 ready。非空目录重复安装返回 2，运行中真实卸载返回 2，程序未被移除。
- 最终候选的测试实例停止并重启后，服务再次 ready，七角色初始化记录哈希未变。随后卸载退出 0，app/runtime 移除，data/workspaces 哨兵内容保留。机器可读结果为 `dist/local-installation-acceptance.json`。该验证不涉及真实任务中断恢复。

## 本轮候选制品

- 本机：`dist/AITestHarness-0.1.0-preview.1-win-x64.exe`，617,134,158 字节，未签名内部预览。
- SHA256：`912ba072598ac48bcd2c74bedc6a9708127c08d7504dc44088a14499085c7ed1`。
- `dist/SHA256SUMS.txt`、`dist/product-payload.json`、`dist/installed-tools-result.json`；本机 doctor/service 证据也保存在 dist，其中包含本机路径，不是公开发布资源。
- 最终构建目录 `scratchpad/product-build-003`。候选包含构建时白名单快照，不保证等同于之后仍在并行编辑的工作区文件。

## 当前边界与下一批

1. 本轮不将原有用户数据搬入产品目录；迁移工具目前只提供只读预检。
2. 首版安装预览只接受空目录。后续 preview.2 已实现同宿主版本覆盖升级事务和失败恢复，验证进度见[升级实施记录](product-upgrade-progress-2026-10-21.md)。跨宿主迁移及已投入使用后的数据回退仍需补齐。
3. preview.3 已补齐首次使用引导、宿主模型库入口和连接验证；现有环境三用例 Excel 已核验，详见[首次使用验收](product-onboarding-progress-2026-10-21.md)。新安装环境的真实模型任务及六阶段业务验收仍待完成。
4. 本机隔离目录及移除开发环境 PATH 的测试不是干净机器验收。用户确认暂无测试机，保留此项。
5. 兼容层先收拢路径、版本、安装和初始化；业务服务接口和插件化替换还需后续迭代。异常退出留下初始化锁的恢复能力仍需完善。
6. Windows Actions 尚未在远端执行。安装器未签名，尚无 GitHub Releases；源码、制品均未提交或推送。
7. 原先 core 基线 622 项中 618 通过、3 失败、1 跳过，失败已在升级前复现；没有宣称本轮完整回归全绿。

构建和候选使用说明见 [packaging/README.md](../packaging/README.md)。最终“第三方下载安装即可使用”仍按原计划的完整验收矩阵执行，不能用内部预览替代。
