# AITestHarness 软件测试智能体

AITestHarness 基于 PenguinHarness 运行底座，提供软件测试总控及七个专业智能体，按需完成需求分析、测试点、测试用例、Web/接口自动化执行、缺陷分析和测试报告。按提供的功能需求或接口资料分别建立测试链路，也可以独立生成设计产物。

现有发行版本为 **0.1.0-preview.4（Windows x64 预览版）**，内置 PenguinHarness **0.2.16**。源码包含后续接口自动化、分流交付和会话导航优化，不代表现有安装包已包含这些改动。发行验收范围以对应 Release 的 `acceptance.json` 为准。

## 下载安装

前往 [GitHub Releases](https://github.com/chawuciren626-hash/qa-agent/releases/tag/v0.1.0-preview.4)，下载 `AITestHarness-0.1.0-preview.4-win-x64.exe`。这是预览版，请从带有 Pre-release 标记的版本页下载，不依赖 GitHub 的 latest 链接。

仓库目前为私有仓库，下载需要登录有访问权限的 GitHub 账号。

1. 运行安装包，选择当前用户可写的目录，例如 `E:\AITestHarness\installed`。
2. 从安装生成的 **AITestHarness Preview** 快捷方式或安装目录中的 `AITestHarness.exe` 启动。
3. 首次使用在“模型库”配置自己的模型服务和凭据，验证连接，然后填写示例或自己的测试任务。
4. 成功发起测试会话后，首次使用引导不再显示；已有测试任务的用户自动跳过。

**不需要另外安装 PenguinHarness、Node.js、Python 或浏览器。** 安装包内置这些运行组件，但不提供模型账号或额度。连接验证会调用一次小型模型请求，可能产生费用；填写示例不会自动发送。

安装器当前未签名。可用 Release 中的 `SHA256SUMS.txt` 核对下载文件：

```powershell
Get-FileHash .\AITestHarness-0.1.0-preview.4-win-x64.exe -Algorithm SHA256
```

新机器上的完整用户验收仍待完成，Windows 构建/安装冒烟测试不等于干净机器真实模型任务验收。

## 日常使用

- 输入需求、上传 Word，或提供已授权测试环境的 URL 和目标。
- 默认由总控按需派发专业智能体；只有明确要求“跑全流程”才执行完整生命周期。
- 工作空间留空使用应用默认任务目录；也可选择外部工作目录。不要选择源码目录作为任务工作空间。
- 各阶段交付模块命名的需求分析 Markdown、功能/接口测试点 XMind、测试用例 Excel，以及对应类型 HTML 测试报告；新报告暂不生成 Word/PDF。
- 会话支持刻度导航、悬停摘要、定位跳转和本地书签。
- 必要的登录、验证码或业务确认由用户完成；内部校验和工程步骤由应用处理。

示例：“根据附件写测试用例，交付 Excel，不执行测试。”或“测试这个测试环境登录页的输入校验，输出实际结果和报告。”

应用不默认授权删除、支付、真实通知等有副作用操作。功能覆盖及限制见 [使用指南](docs/user-guide.md)。

## 目录结构

安装目录由用户选择，以下路径均相对于该目录：

| 目录或文件 | 内容 |
| --- | --- |
| `AITestHarness.exe` | 应用启动入口 |
| `app/engine` | 部署的测试业务引擎和角色配置 |
| `runtime/penguin` | 固定版本的 PenguinHarness 宿主 |
| `runtime/tools` | Node.js、Python 和浏览器 |
| `data/penguin` | 模型配置、原生会话和宿主数据 |
| `data/qa` | 业务索引和保护数据 |
| `data/desktop-profile` | 桌面配置与登录状态 |
| `workspaces` | 默认任务工作区、测试证据和交付物 |

开发源码与已安装程序分开。本项目维护者当前使用 `E:\AITestHarness\source` 作为 Git 仓库，`E:\AITestHarness\installed` 作为安装目录，`releases`、`backups` 保存制品和本机备份；新用户无需使用相同盘符。

开发入口见 [技术文档导航](docs/index.md)。日常优化验证后受控同步本地运行副本，提交和安装包构建按维护者明确请求进行。

源码、公开角色、适配代码和构建配置提交 Git；运行数据、凭据、工作区、备份和二进制安装包不提交源码仓库。修改源码后需要重新构建或受控部署，安装副本不会自动同步。

## 应用和宿主如何更新

维护者跟踪 PenguinHarness 官方 Release，在隔离环境完成兼容适配与回归，然后更新 `packaging/runtime-sources.json` 中的宿主版本、下载地址和 SHA256，构建并发布新版 AITestHarness。

用户通过 **AITestHarness Release** 更新整个应用，获得已验证的内置宿主；不要运行上游安装器覆盖应用管理的宿主目录。当前没有完成应用自动检测、下载和安装的闭环，需手动下载新版安装包。

升级前退出应用，运行新安装包并选择原安装目录。现阶段仅支持宿主 0.2.16、数据版本 1 不变的应用升级，跨宿主版本升级及降级会拒绝。事务失败恢复、保留数据卸载和空间要求见 [安装包说明](packaging/README.md)。不要直接移动已初始化的安装目录。

## 开发与构建

源码克隆用于开发；普通用户使用安装包。维护环境推荐 Node.js 24.14.0 和 Python 3.12。开发测试依赖及准备步骤见 [工程测试与 CI](docs/engineering-tests-and-ci.md)。

```powershell
npm ci
npm run check:static
npm run release:check
npm run test:list
npm test
```

Windows 构建流程为 GitHub Actions 的 **Windows installation candidate**，固定下载并校验上游运行组件，按发布白名单打包，执行安装工具冒烟与恢复测试。Actions 生成候选制品，不会自动发布 Release。完整构建命令见 [packaging/README.md](packaging/README.md)。

目前仍有待验收项：干净 Windows、新安装环境的真实模型任务、六阶段发行验收及跨宿主升级恢复。已有本机历史任务成功记录不能替代新安装包验收；`distribution_ready:false` 保留真实状态。

## 文档与第三方组件

- [接口自动化协议](docs/api-execution.md)
- [使用指南](docs/user-guide.md)
- [安装与发行维护](packaging/README.md)
- [凭据与数据保护](docs/credential-security.md)
- [文档导航](docs/index.md)

PenguinHarness 由 Prism Shadow 开发，使用 Apache-2.0 许可证。AITestHarness 是基于该底座的测试应用，并非 PenguinHarness 官方发行版。发行包保留上游及运行依赖的许可证和声明，见 [第三方组件声明](packaging/THIRD-PARTY-NOTICES.txt)。
