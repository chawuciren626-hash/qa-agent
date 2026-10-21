# 首次使用引导与最小任务验收

## 本轮交付

首次使用首页增加“开始使用”卡片：展示七个测试角色就绪情况，读取总控实际使用的模型，提供“配置模型 → 验证连接 → 填写示例任务”。配置入口使用宿主模型库，不另建密钥存储。点击验证才发起小型模型请求；示例仅填入输入框，由用户发送。验证结果不等于所有专业角色或全流程已通过。

模型验证只提交已保存的 provider/modelId 引用，隐藏服务商原始错误。模型配置在验证期间变化会使结果失效；项目或用户切换会清空页面验证状态。角色未就绪时禁用验证与示例按钮。

版本提升至 `0.1.0-preview.3`，宿主仍为 `0.2.16`，数据版本仍为 1。preview.2 不含本轮引导。GitHub Actions 构建工作流已加入引导及客户端资源身份回归，远端工作流尚未运行。

## 用户完成的真实最小任务

用户确认已在 AITestHarness 完成“登录页必填校验测试用例设计”，本轮只读核验既有交付，没有重新调用模型或续跑此前暂停的验收会话。

- 会话：`session-2026-10-21-14-01-22-a6ba9ff5`。
- 运行：`run-9570c596-c560-4444-9781-6a04ff111504`，状态 completed，用例阶段 completed，执行阶段 skipped。
- JSON 与 Excel 主表均有 3 条用例：用户名为空、密码为空、两项均填写。
- Excel 可解析，含“测试用例”“问题清单”“预期依据”三个工作表，6193 字节。
- SHA256：`f95ba2426356a03b6c53867b0bcbe55f1d6a35fe7ce9eb3074d60017df720bc9`。
- 证据：`output/onboarding-acceptance-20261021/user-completed-artifact.json`。

这证明现有环境的最小用例设计与 Excel 交付成功；不替代新安装环境的模型任务验收、干净 Windows 验收或六阶段业务回归。本轮没有重做原生 Excel 打开或下载交互。

## 工程与浏览器验证

安装、事务升级、引导、资源身份及运行时安装五组定向回归共 38/38 通过。记录：`output/engineering-tests/2026-10-21T06-52-07-936Z-34480f16-561e-450c-b23d-807bf8aca9d7`。不代表整个历史 core 测试集无失败。

浏览器合成接口验证：角色未就绪禁用、连接成功与失败、示例仅填写、配置模型跳转、无模型不请求验证、配置读取失败隐藏原始错误、收起与 390px 页面布局。最终手机截图：`output/playwright/onboarding-final-mobile.png`。合成接口不作为真实模型成功证据。

## 安装包本机验证

- 安装包：`dist/AITestHarness-0.1.0-preview.3-win-x64.exe`，617141620 字节。
- SHA256：`8bc1e5a6931aec9aaf9d2fddf0270075f1ea38dac2029eed988b95515d2ef5b4`。
- 全新构建目录 `scratchpad/product-build-005`，4752 项载荷校验通过，未包含用户状态。清单与校验文件保存为 `dist/preview.3-product-payload.json`、`dist/preview.3-SHA256SUMS.txt`。
- NSIS 实际安装至独立中文/空格路径成功；通过 `AITestHarness.exe` 首次启动，七角色初始化完成，doctor 12 项与鉴权服务均 ready。
- CLI `product-entry start` 在首次角色初始化前会报告 agents 未就绪；本轮保留该结果 `dist/preview.3-start-result.json`。普通用户使用桌面入口启动后正常初始化，最终结果见 doctor/service 文件。
- 移除开发工具 PATH 后，包内浏览器及 XMind、Excel、Word/PDF、HTML 导出检查通过。
- 浏览器访问实际安装服务，确认引导展示 7/7 角色、示例填入不发送、模型库跳转正常。截图：`output/playwright/preview3-installed-guide.png`。此鉴权浏览器的宿主终端接口返回 401，未影响已验收页面；不据此声明终端功能通过。
- 本轮安装验证未复制现有模型凭据、未发送模型请求。安装后源文件哈希与工程引导一致。证据：`dist/preview.3-bootstrap-result.json`。
- 测试实例已退出并卸载；程序目录移除，data/workspaces 哨兵完整保留，现有工作环境未迁移。
- 汇总证据：`dist/preview.3-fresh-install-result.json`、`dist/preview.3-doctor-result.json`、`dist/preview.3-service-result.json`、`dist/preview.3-installed-tools-result.json`、`dist/preview.3-uninstall-result.json`。

## 待完成验收

干净 Windows 测试机暂不可用，按用户决定保留验收项；新安装模型任务、跨宿主版本迁移与回退、签名及 GitHub Release 仍待完成。安装清单继续标记 `distribution_ready:false`。现有用户数据与凭据未复制进安装包。本轮不替代 preview.2 的升级/故障恢复实测，也未重复开展 preview.2 到 preview.3 的真实安装覆盖验证。
