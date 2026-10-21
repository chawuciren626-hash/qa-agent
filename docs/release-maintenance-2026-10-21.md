# 发行准备与宿主兼容验证

本轮只准备本地发行候选和维护流程，未提交 Git、推送、创建标签、创建 GitHub Release 或启用定时检查。应用二进制继续使用已验收的 `0.1.0-preview.3`；本轮修改属于维护脚本、验证器和工作流，没有重打或替换该安装包。

## 已验证的宿主基线

2026-10-21 官方稳定版接口返回最新版本 `0.2.16`，当前没有新版可进行跨宿主实测。来源：<https://github.com/Prism-Shadow/penguin-harness/releases>。

新增 `scripts/host-compatibility-review.mjs`，以官方制品建立的未使用构建目录为输入，在另一个全新目录复制 `resources/app`，再执行精确版本补丁、幂等检查及真实服务端代码专项验证。输入和输出不能重叠，拒绝链接和已识别的宿主私有状态；使用显式逐文件复制，避免 Node 24 在中文目标路径上的 cpSync 问题。

本机验证通过：

- 副本与输入初始哈希相同；原始输入在验证前后保持不变。
- 补丁安装后检查为 installed，重复检查无变化。
- 子 Agent pre-tool hook 边界、hook 禁用语义、超时/隔离参数、会话鉴权、桌面专属文档打开及路径/扩展名限制检查通过。
- 未启动该副本的桌面或服务，未读取现有用户数据、调用模型或修改原安装。
- 报告：`scratchpad/host-review-20261021-01/host-review.json`。

未知宿主版本只生成 compatibility_review_required 报告并返回非零退出码，不复制、打补丁或放宽兼容清单。技术检查通过也保留业务回归、跨宿主数据迁移与干净机器验收待办。

维护者用法（Node 24，输出目录必须不存在）：

```powershell
node scripts/host-compatibility-review.mjs '<候选>/runtime/penguin/resources/app' '<新的隔离检查目录>'
```

发现新版后的步骤为：核对官方制品来源/摘要 → 新建隔离候选 → 开发并审查精确版本适配 → 更新相应契约校验 → 运行隔离检查 → 业务回归和数据迁移/回退验收 → 构建新应用候选。不能仅把版本加入 supported 就宣称兼容，也不能直接更新当前用户使用的 runtime。

## preview.2 → preview.3 的真实安装演练

使用两个现有 NSIS 安装包，在独立中文/空格目录安装 preview.2，再覆盖安装 preview.3；宿主均为 0.2.16。

- 15 个配置和合成用户数据/工作区文件哈希保持不变。
- 实际安装目录中的载荷清单与 preview.3 构建清单一致。
- 在完整载荷 setup 完成后注入故障，旧程序恢复，18 个程序/清单/配置/用户状态文件哈希保持不变。
- 卸载移除程序目录，合成数据和工作区哨兵保留。
- 证据：`output/release-acceptance-20261021/result.json`、`rollback-retry/result.json`。

初次故障演练误用目标目录里的 Node，被“运行时必须在安装目标外”保护拒绝，未进入更新事务。改用外部 Node 后复验通过，原失败目录保留。本轮使用合成文件，不声称覆盖真实历史会话续接、真实凭据迁移或跨宿主数据升级。

## 可审核的发行候选

新增 `scripts/prepare-release-candidate.mjs`：先验证未使用载荷的完整文件哈希，再检查安装器名称、PE 标识和摘要，要求验收记录绑定相同的产品版本、宿主版本、安装器 SHA256 和载荷清单 SHA256。安装器与载荷的关联由实际安装后清单比较记录确认，不把文件名或 PE 标识本身当作安装包内容证明。

候选目录只包含固定清单：安装器、`SHA256SUMS.txt`、`product-payload.json`、`acceptance.json`、`RELEASE-NOTES.md`、`THIRD-PARTY-NOTICES.txt`。许可证完整文件已包含在安装包内。验收记录只导出白名单检查 ID 和状态，不复制原始日志、任意备注、凭据或本机路径。缺失检查保持 pending，即使所有检查通过，也仍要求维护者审核，不自动发布或将 distribution_ready 改为 true。

本机产物：`dist/release-preview.3/`。

安装包 SHA256：`8bc1e5a6931aec9aaf9d2fddf0270075f1ea38dac2029eed988b95515d2ef5b4`，617141620 字节。

维护者用法：

```powershell
node scripts/prepare-release-candidate.mjs '<未使用构建目录>' '<安装器.exe>' '<验收记录.json>' '<新的候选输出目录>'
```

验收输入格式为 `version: 1`，包含 `product_version`、`host_version`、`installer_sha256`、`payload_manifest_sha256` 和 `checks: [{id, status}]`。状态只允许 passed/failed/pending；检查 ID 见脚本的 `releaseChecks`。验收输入是维护者对实际证据的记录，不是可自行证明真实性的数字签名。不得复用别的安装包或历史环境的通过记录。

`scripts/product-payload-check.mjs` 现为构建校验和候选准备共用实现：拒绝哈希不匹配、未列入清单的文件、路径越界/链接、已使用的数据目录和已识别私有状态文件。此文件级检查不等于通用秘密内容扫描。

## GitHub 工作流

`.github/workflows/windows-release.yml` 已加入维护工具合同测试、隔离宿主验证和候选目录生成。主 artifact 仅上传发行候选固定目录；工具冒烟与宿主验证结果另存维护 artifact。权限仍为 contents:read，没有发布操作。

CI 只将实际执行的检查记为 passed。桌面首次启动、界面、旧到新版本升级、真实模型和干净机器检查仍保留 pending；同版本重装不能替代旧到新版本升级验证。GitHub runner 有开发工具，不作为干净 Windows 机器。

本机完成 19/19 项维护及安装定向测试，覆盖版本/摘要不匹配、缺失/重复状态、私有备注过滤、载荷篡改/越界/私有状态、未知宿主拒绝、中文复制与链接拒绝。记录：`output/engineering-tests/2026-10-21T07-14-15-549Z-83b75cdf-5a1a-4736-9a37-da2ad4cc8c28`。工作流 YAML 与全部 8 段 PowerShell 均解析通过；远端 Actions 尚未运行。

## 当前发布待办

本机候选的 9 项检查已通过，3 项仍待完成：新安装环境配置模型后的最小任务、新安装环境六阶段流程、干净 Windows。用户已在既有 AITestHarness 完成的最小任务结论保留，不重复执行，也不挪用为新安装验收证据。

安装器未签名，正式公开发行前仍需明确签名方案和完成上述验收。跨宿主迁移及数据回退尚未支持，当前安装器继续拒绝跨宿主覆盖升级。仓库提交后，还需在 GitHub 运行实际构建、审核产物，再按发布授权上传 Releases；仅提交源码不会出现可下载安装的 Release。
