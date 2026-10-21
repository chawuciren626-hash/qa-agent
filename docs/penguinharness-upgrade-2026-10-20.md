# PenguinHarness 0.2.16 升级记录

准备日期：2026-10-20；正式升级完成：2026-10-21。原宿主：0.2.13；已安装：[官方 v0.2.16](https://github.com/Prism-Shadow/penguin-harness/releases/tag/v0.2.16)。

## 安装来源与备份

使用官方 Windows x64 桌面安装包 `penguin-desktop-win32-x64.exe`，已验证 Authenticode 签名有效，SHA256 与发布页 `SHA256SUMS.desktop` 一致：

```text
b3ae02d2c39ec5b1a5bd5611ee6407c8f1d90e72d03a43191062b87872d45769
```

本机安装位置：`D:\Program Files\PenguinHarness`。工程位置：`E:\Codex\AITestWorker`。

升级前备份：`E:\QAArchives\AITestWorker\penguin-upgrade-20261020-0.2.13-to-0.2.16`，包含原安装目录、`~/.penguin/data`、`%APPDATA%/PenguinHarness`。备份含本机私有配置，仅保留在本地归档，不纳入 Git。

## 兼容适配

- 统一安装器与桌面品牌安装器保留 0.2.13 支持，并加入已检查的 0.2.16。仍要求锚点唯一、原件哈希匹配、应用退出后修改，不放宽到任意版本。
- 新版前端有独立补丁配方，保留 AITestHarness 首页、任务/项目侧栏、资料库、定时任务、测试总控入口、交付卡片、人工操作卡片及执行详情折叠；原生 Workbench 入口继续保留。
- 文件接口已改为宿主统一路由注册，测试交付接口在会话路由中注册，继续校验会话访问权限、桌面来源、交付路径和文件类型。
- 子 Agent 的 hook 在新上下文装配阶段加载。只给子 Agent 安装 `qa-stage-boundary` 的 pre-tool hook，保留新版执行范围约束及超时选项；不向子 Agent 注入 stop、user-prompt 或 spawner。
- 适配新版编译符号及桌面 shell，保留原应用存储身份、原数据目录和任务栏分组。
- 本工程没有调用已移除的 `/workflows` 路由或旧 Agent SDK `ask/run` 接口，无需迁移这些调用。上游会在访问旧工作流时执行原生 Workbench 迁移。

## 验证

1. 隔离安装、脚本语法、重复安装、回退及重新安装通过。
2. `verify-penguin-host.mjs` 从实际新版 `server.js` 提取并执行 hook 与交付路由，验证子 Agent hook 隔离、执行约束、超时、关闭父 hook 时的子边界以及文件接口权限。
3. 新建任务合成验证通过，创建请求仍指向 `test_agent`。真实新版 React 组件的父/子上下文、流式文本、执行详情折叠、桌面/手机布局验证通过。
4. 人工操作继续/等待、重复点击防重、交付卡片、证据 JSON/目录、HTML/PDF 预览、浏览器原生打开拒绝、打开超时及文件缺失反馈通过。预览使用合成会话及只读历史交付物，没有调用模型或重跑业务。
5. core 回归：622 项，618 通过、3 失败、1 跳过。三个失败在升级前 HEAD 脚本的隔离复跑中全部复现：`directory-context` 的旧工程复核预期、`runtime-reliability` 的旧纠错次数策略预期、`skill-resources` 的旧指令文本断言。本次不改动这些业务规则，也不把全套回归报告为通过。
6. 静态及运行时预检为 `ready`，发布资源清单有效，七个业务 Agent 同步检查为 `in_sync`。
7. 额外启动的 browser 全组未完成：两个 worker 恢复测试在 Windows 进程身份检查处得到 `unknown`，而非预期 `same`。正式安装授权取消后停止了该扩展回归及其专属测试进程，保留日志；未将它标为通过，也未将原因归结为宿主升级。进程身份检查模块本次没有修改，进一步排查留待后续。

工程结果保存在 `output/engineering-tests/`，界面证据在 `output/playwright/`。新版实际模型全流程、真实站点重新登录及各文档默认应用打开不属于本次验证结论。

## 维护检查

```powershell
node scripts/install-penguin-runtime.mjs 'D:/Program Files/PenguinHarness/resources/app' --check
node scripts/install-desktop-branding.mjs 'D:/Program Files/PenguinHarness/resources/app' --check
node scripts/verify-penguin-host.mjs 'D:/Program Files/PenguinHarness/resources/app'
node scripts/sync-penguin-agents.mjs
```

之后再次更新宿主时，先备份并回退原版本补丁，将旧安装记录和原件备份移出新版安装目录，检查并适配目标版本后重新安装。不能把旧 `qa-runtime-install.json` 或 `.qa-runtime-original` 带入不同版本。

`--restore` 只移除本工程补丁，不降级宿主，也不恢复数据。需要回到 0.2.13 时，先正常退出应用、保存升级后新增数据，再恢复完整旧程序及必要的数据备份；不要直接覆盖升级后产生的新会话。

## 本机部署

**2026-10-21 正式宿主已升级至 0.2.16，并已启动。** 用户允许 Windows UAC 后，官方安装程序返回 0，实际安装目录的版本确认为 0.2.16。

已安装新版测试补丁和桌面品牌；统一安装器与品牌检查均为 `installed / changed=false`，七个业务 Agent 为 `in_sync`。实际安装目录的 hook/交付接口专项验证及主程序、服务端语法检查通过。保留 AITestHarness 快捷方式，官方安装器重建的同目标重复快捷方式已归档。

启动后首页、新版前端和交付模块均返回 200，前端确认包含测试工作台及交付卡片补丁。原生桌面日志确认历史会话的人工操作接口持续返回 200。独立 Bearer API 探针返回 401，未计为通过；上述历史会话验证以原生客户端日志为依据，没有修改认证机制。启动检查结果保存在 `scratchpad/penguin-0.2.16/installed-smoke.json`。本次未调用模型或重新执行业务测试，完整回归限制见上文。

原备份的 2,711 个文件全部通过 SHA256 校验，继续保留。重试前的数据、桌面配置、旧补丁记录及重复快捷方式归档在 `E:\QAArchives\AITestWorker\penguin-upgrade-20261021-retry`。

历史：2026-10-20 首次安装因管理员授权取消返回 1223，当时已恢复 0.2.13 的测试补丁和品牌；该阻塞已在本次用户授权后解除。
