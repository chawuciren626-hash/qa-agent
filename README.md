# AITestHarness

AITestHarness 是基于 [PenguinHarness](https://github.com/Prism-Shadow/penguin-harness) 的软件测试智能体应用。用户在项目中提交需求或测试目标，由总控协调需求分析、测试点、用例设计、测试执行、缺陷分析和测试报告等专业智能体。项目视图集中查看任务进度、阶段结果、用例、缺陷与报告。

> **当前处于开发和预览阶段。** `main` 是当前活跃开发分支（2026-11-15 已按 B1~B12 重构批次全量重置）；`develop` 为历史分支，不再同步更新。源码中出现的功能不代表已进入公开安装包，也不代表已通过真实业务验收。

## 近期落地（2026-11-15，B1~B12 重构批次）

- **IR 契约 v1.1**：阶段产物结构契约升级，新增 `expected[].source/state` 与 `exec.verdict_cap`（预期溯源与判定上限）；配套 irval 校验器 114 条用例全通过。
- **质量防线**：数据生命周期审计（UNDECLARED_DATASET / PERSISTENT_MUTATED 等 5 类违规码）、确认卡点三层（内容指纹 diff → 确定性抽样 → 风险分级强制）落地。
- **一致性验收**：M1 同源一致性达到 `ready_pending_manual`（3 次真实执行 + duration 落地验证；剩余人工比对项见 `docs/m1-consistency-acceptance.md`）。
- **后台注册表**：管理员端工具注册表扩至 **33 条**（含 `login.captcha_chain` 登录与验证码策略链），全部启用。
- **测试基线**：仓库 CI 1149 条用例 0 失败（11 条平台限制 skip，均注明缺失条件）；irval 冒烟 242 条全绿。

## 当前能力

- **项目与任务**：按项目管理任务和资料；任务详情显示各阶段进度、结果及产物。项目资料供任务理解业务使用，任务可以查看不同运行记录。
- **逐阶段审核**：阶段产出后由用户确认，再进入下一阶段；有疑问可补充信息并要求重新分析。执行前还须确认测试范围和授权。独立的分析、用例或报告任务不强制跑完整流程。
- **测试设计与执行**：需求分析、测试点和用例可生成结构化数据及 Markdown、XMind、Excel 等产物；Web 与接口测试执行记录实际结果和证据。Android、小程序等执行能力仍需按具体环境验证。
- **结果与报告**：项目视图提供用例、缺陷和报告列表；任务详情可预览阶段文档及部分结构化产物。报告结论、统计、未测范围和风险由已登记事实约束，不把缺少证据的结果当成通过。
- **配置与管理**：用户在“设置 → 模型配置”维护模型渠道和连接，配置供其项目使用；管理员视图管理用户、角色、菜单、智能体、发布资源和权限。个人技能、项目知识及质量追踪正在完善。

系统会保留运行记录和历史产物。项目级缺陷状态与单次运行的缺陷产物目前是两套记录，统计范围不能混用；历史数据的自动对账仍待建设。

## 版本与安装（截至 2026-11-15）

| 状态 | 当前依据 | 说明 |
| --- | --- | --- |
| 开发源码 | `main` 分支（活跃）、`platform/upstream-source.json` | 集成的 PenguinHarness 源码版本为 **0.2.17**；`develop` 为历史分支。 |
| 维护者本机运行版 | `installation.json` 与 `aitest-source-runtime.json` | 统一目录安装，运行清单为 `mode: source`、上游 **0.2.17**。它是本机受控同步结果，不是发行安装包。 |
| 发行安装候选 | Actions artifact `windows-installation-candidate` | 由 `main`（`eb633c4`）经 **Windows installation candidate** 工作流构建（run [43670404119](https://github.com/chawuciren626-hash/qa-agent/actions/runs/43670404119)）。旧的 v0.1.0-preview.4 Release 已删除，正式 Release 尚未发布。 |

安装候选包内置运行所需宿主和工具，但不包含模型账号、额度或维护者的项目数据。下载后请以 artifact 内的 RELEASE-NOTES、SHA256 与文件清单为准，不能用本页的开发能力清单推断安装包功能。`distribution_ready` 当前仍为 `false`：干净 Windows 验收、真实模型任务全流程验收等事项未完成，不应作为正式版本发布。

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
- [IR 契约规范 v1.1](docs/AITestHarness-IR契约规范-v1.md)（含缺省语义与 V-39/V-40 规则）
- [架构重构方案 v3 与批次执行记录](docs/AITestHarness测试平台架构重构方案-v3.md)、[重构批次清单](docs/refactor-batches-v3.md)
- [数据生命周期审计](docs/data-lifecycle.md)、[确认卡点](docs/confirm-gate.md)、[golden set 管理](docs/golden-set.md)
- [M1 一致性验收](docs/m1-consistency-acceptance.md)
- [工程测试与 CI](docs/engineering-tests-and-ci.md)
- [安装包构建与恢复](packaging/README.md)
- [凭据与数据保护](docs/credential-security.md)

PenguinHarness 由 Prism Shadow 开发，采用 Apache-2.0 许可证。AITestHarness 是基于该底座开发的测试应用，并非 PenguinHarness 官方发行版；第三方组件声明见[许可证清单](packaging/THIRD-PARTY-NOTICES.txt)。
