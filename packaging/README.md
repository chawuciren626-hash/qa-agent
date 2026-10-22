# Windows 安装候选

目标为 Windows x64。当前产物是内部预览。preview.3 增加首次模型配置与示例任务引导，保留 preview.2 的同宿主版本事务升级与失败恢复。现有环境的三用例 Excel 任务已完成并核验；新安装环境的真实模型任务、干净机器验收仍待完成，不应当作为正式版本发布。宿主固定为 PenguinHarness 0.2.16，后续通过适配验证后再升级。详见首次使用验收（本地历史记录，不随源码分发）。

## 普通用户的预期使用方式

打开安装包，选择空的、当前用户可写的安装目录，安装后从 AITestHarness Preview 快捷方式启动。首次启动自动创建七个测试角色。首页“开始使用”依次提供“配置模型”“验证连接”“填写示例任务”。在模型库配置自己的模型服务与凭据；验证会产生一次可能计费的小型请求，填写示例不会自动发送。安装包不含维护者配置、历史会话或模型额度。

程序目录包含 `AITestHarness.exe`、`app/engine`、`runtime/penguin`、`runtime/tools`，用户数据位于 `data`，任务目录位于 `workspaces`。与原有 PenguinHarness 的数据和桌面身份隔离。不要直接移动已初始化目录。preview.2 可对完整的 preview.1 安装目录覆盖升级，也支持同版本重装；已卸载后只剩数据的目录需要迁移/恢复工具，当前不能直接覆盖。

升级前退出应用，运行新安装包并选择原安装目录。安装器校验包内哈希、宿主版本、数据版本和运行进程，保存旧程序后替换并执行安装初始化。此批只支持宿主 0.2.16 不变、数据版本 1 不变的应用更新；跨宿主版本和降级会拒绝。

安装失败会恢复旧程序。安装器异常退出后，重新运行新安装包会先恢复未完成事务，再尝试安装。升级锁存在时新版启动器拒绝启动；不要手工删除锁或只复制一部分备份。已提交的升级不会因恢复操作被回滚。配置、会话与工作空间原地保留，不从旧数据副本覆盖，因此新增数据不会因安装失败被抹去。

旧程序、失败候选和事务记录保留在 `.product-upgrade/<事务编号>`，目前不自动清理，可能每次占用约 1.5 GB，并包含本地业务配置。卸载也保留这些恢复材料及用户数据。安装过程另需临时解包、候选和备份空间，应预留数 GB 空间。业务已启动后的版本回退、跨版本数据库恢复不在此批范围。

本轮发布目标为 [v0.1.0-preview.4](https://github.com/chawuciren626-hash/qa-agent/releases/tag/v0.1.0-preview.4)，包含首次引导完成状态修复。仓库当前为私有，Release 仅授权用户可访问。源码提交和 Actions 候选构建不会自动发布安装包。

## 维护者构建

推荐提交到自己的仓库后，在 Actions 手动执行 **Windows installation candidate**。工作流生成安装包、SHA256、文件清单和已安装工具冒烟结果，作为 Actions artifact；不会自动发布 Releases。构建所需 Node/Python 属于维护环境，用户安装时不需要这些开发工具。

工作流现已接入隔离宿主兼容检查和发行候选整理。主 artifact 内含 `RELEASE-NOTES.md`、`acceptance.json` 和固定发行文件；待验收项保留 pending。维护命令、验收记录格式及本机 preview.2 → preview.3 升级实测见发行维护记录（本地历史记录，不随源码分发）。本机可审核候选位于 `dist/release-preview.3/`，尚未上传。

本机完整构建过程见 `.github/workflows/windows-release.yml`：

1. 安装项目及 `packaging/tools` 的锁定依赖。
2. `fetch-runtime.ps1` 下载并校验 `runtime-sources.json` 中的宿主、Python 和 NSIS。
3. `prepare-windows.mjs` 解包官方宿主、复制发布白名单、安装生产依赖和浏览器、内嵌 Python 文档依赖，生成启动器与文件哈希清单。所有参数均显式指定，输出必须为新目录。
4. `verify-payload.mjs` 校验清单、链接及私有状态文件。
5. NSIS 编译必须使用 `/INPUTCHARSET UTF8`，并设置 `NSISDIR`、`/DSTAGE=...`、`/DOUTPUT=...`。
6. 实际安装后运行 `smoke-installed.mjs <安装根目录> <新的证据目录>`，它从 PATH 移除开发运行时，调用安装内的导出器和浏览器，不调用模型。

静默安装示例（PowerShell）：

```powershell
$target = [IO.Path]::GetFullPath('C:\QAInstallTests\测试应用')
$process = Start-Process -FilePath '.\AITestHarness-0.1.0-preview.3-win-x64.exe' -ArgumentList "/S /D=$target" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0 -or !(Test-Path "$target\AITestHarness.exe")) { throw 'Installation failed' }
```

NSIS 的 `/D=` 必须使用 Windows 反斜杠路径，作为最后一个参数，不单独给路径加引号。除了退出码，还必须验证实际目标文件；错误格式可能退回默认目录。

退出应用后可运行 `Uninstall.exe`。自动化等待卸载时使用 `/S _?=<安装根目录>`；这会让卸载器原地执行，可能保留卸载器自身。安装器遇到不属于本产品的非空目录、不兼容版本、运行中的目标或初始化失败，应返回非零退出码。不要把“已恢复旧程序”的安装失败当成升级成功。

## 发布前必须补齐

- 跨宿主版本的数据迁移与完整回退；已运行新版之后的回退及备份清理界面。
- 无预装宿主和开发工具的干净 Windows 验收。
- 新用户模型配置与最小单阶段、六阶段实际工作流验收。
- 通用历史数据迁移工具的完整验收；本机迁移工具已完成一次实际验证，不代表支持所有机器或跨宿主版本。
- 远端 Actions 实跑、最终候选摘要核对及 Releases 下载说明。
- 自有安装器当前未签名；后续签名使用发布者证书，上游签名不能替代。

`distribution_ready:false` 是当前真实状态，不应仅为发布而改为 true。
