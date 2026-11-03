# AITestHarness

AITestHarness 是基于 [PenguinHarness](https://github.com/Prism-Shadow/penguin-harness) 的软件测试智能体应用。用户在项目中提交需求或测试目标，由总控协调需求分析、测试点、用例设计、测试执行、缺陷分析和测试报告等专业智能体。项目视图集中查看任务进度、阶段结果、用例、缺陷与报告。

> **当前处于开发和预览阶段。** 本仓库的 `develop` 源码、本机受控同步的运行版、GitHub Release 安装包是三个不同状态。源码中出现的功能不代表已进入公开安装包，也不代表已通过真实业务验收。

## 当前能力

- **项目与任务**：按项目管理任务和资料；任务详情显示各阶段进度、结果及产物。项目资料供任务理解业务使用，任务可以查看不同运行记录。
- **逐阶段审核**：阶段产出后由用户确认，再进入下一阶段；有疑问可补充信息并要求重新分析。执行前还须确认测试范围和授权。独立的分析、用例或报告任务不强制跑完整流程。
- **测试设计与执行**：需求分析、测试点和用例可生成结构化数据及 Markdown、XMind、Excel 等产物；Web 与接口测试执行记录实际结果和证据。Android、小程序等执行能力仍需按具体环境验证。
- **结果与报告**：项目视图提供用例、缺陷和报告列表；任务详情可预览阶段文档及部分结构化产物。报告结论、统计、未测范围和风险由已登记事实约束，不把缺少证据的结果当成通过。
- **配置与管理**：用户在“设置 → 模型配置”维护模型渠道和连接，配置供其项目使用；管理员视图管理用户、角色、菜单、智能体、发布资源和权限。个人技能、项目知识及质量追踪正在完善。

系统会保留运行记录和历史产物。项目级缺陷状态与单次运行的缺陷产物目前是两套记录，统计范围不能混用；历史数据的自动对账仍待建设。

## 版本与安装（截至 2026-11-03）

| 状态 | 当前依据 | 说明 |
| --- | --- | --- |
| 开发源码 | `develop` 分支、`platform/upstream-source.json` | 集成的 PenguinHarness 源码版本为 **0.2.17**；开发中的功能需分别测试和部署。 |
| 维护者本机运行版 | `installation.json` 与 `aitest-source-runtime.json` | 统一目录安装，运行清单为 `mode: source`、上游 **0.2.17**。它是本机受控同步结果，不是发行安装包。 |
| 发行打包配置 | `packaging/runtime-sources.json` | **0.1.0-preview.4 / PenguinHarness 0.2.16**。当前源码更新尚未重新制作并验收新的 Release 安装包。 |

已有 Windows x64 预览版可从 [v0.1.0-preview.4 Release](https://github.com/chawuciren626-hash/qa-agent/releases/tag/v0.1.0-preview.4) 获取；仓库为私有时需要相应访问权限。预览包内置运行所需宿主和工具，但不包含模型账号、额度或维护者的项目数据。下载后请以该 Release 的说明、校验文件和验收记录为准，不能用本页的开发能力清单推断预览包功能。

安装器尚未签名。安装或升级前退出应用；升级须遵循[安装与恢复说明](packaging/README.md)，不要用上游 PenguinHarness 安装器覆盖本产品管理的宿主目录，也不要直接移动已初始化的安装目录。

## 在当前开发版中使用

1. 登录后进入**项目视图**，选择或创建项目，并维护必要的项目资料。
2. 在**设置 → 模型配置**添加模型服务，填写自己的凭据并测试连接。模型调用可能产生供应商费用。
3. 在项目中创建测试任务，提供文字、附件或已获授权的测试环境地址，说明希望分析、设计、执行还是运行完整流程。
4. 在**任务进度**进入详情，查看阶段结果和产物；确认无问题后继续，有问题则补充要求并重新分析。实际执行只针对已确认的目标和范围。

例如：“根据附件编写测试用例并交付 Excel，暂不执行”；或“对指定测试环境的登录页做输入校验，记录失败证据并生成报告”。验证码、多因素认证和业务规则确认等仍可能需要人工参与。删除、支付、真实通知等有副作用操作不会因提供一个 URL 就自动获得授权。

## 已知边界

- 自动化执行的敏感环境变量已收窄，但**完整运行沙箱尚未通过 Windows 实机验收**。WSL2 自动化适配仍处于源码试点，当前执行器没有接入该路径；设置页出现沙箱选项不等于 Playwright 已被隔离。
- 本机合成测试、类型检查和服务诊断不能代替新安装环境的真实模型任务验收。干净 Windows、完整阶段流程、移动端执行及跨宿主升级恢复仍需验证。
- 报告和列表只应反映已登记、已校验的执行事实。任务中断、未执行或证据不足时，应保留对应状态与限制。

## 开发与验证

仓库根目录是测试业务引擎、角色、技能和安装工程；`platform/` 是 PenguinHarness 宿主及本产品的服务端、网页和桌面适配。源码与安装目录相互独立，修改源码不会自动更新运行版。

维护环境建议 Node.js 24、pnpm 11 和 Python 3.12。依赖准备及完整测试矩阵见[工程测试与 CI](docs/engineering-tests-and-ci.md)。常用检查：

```powershell
npm ci
npm run check:static
npm run release:check
npm test
cd platform
pnpm install --frozen-lockfile
pnpm --filter @prismshadow/penguin-server typecheck
pnpm --filter @prismshadow/penguin-web typecheck
```

本地源码改动经验证后可按部署脚本备份、校验并同步运行副本；提交 Git、制作安装包和发布 Release 是不同操作。运行数据、模型凭据、工作区、桌面状态、备份及安装二进制不纳入源码仓库。

## 文档

- [技术文档导航](docs/index.md)
- [阶段与产物契约](docs/artifact-contracts.md)
- [工程测试与 CI](docs/engineering-tests-and-ci.md)
- [安装包构建与恢复](packaging/README.md)
- [凭据与数据保护](docs/credential-security.md)

PenguinHarness 由 Prism Shadow 开发，采用 Apache-2.0 许可证。AITestHarness 是基于该底座开发的测试应用，并非 PenguinHarness 官方发行版；第三方组件声明见[许可证清单](packaging/THIRD-PARTY-NOTICES.txt)。
