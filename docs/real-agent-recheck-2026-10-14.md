# 真实Agent复验与文件打开检查

日期：2026-10-14。结论：独立用例生成与Excel文件打开通过；URL探索、完整流程及桌面一键打开验收未全部通过。

## 验收方式

通过本机已安装PenguinHarness的原生会话接口创建真实test_agent任务，模型为tokendance / step-3.7-flash。三个场景使用上一轮相同需求，仅替换本地夹具scope隔离数据。没有手工代写测试产物，没有修改代理、证书、模型或用户凭据。模型正常响应，本轮未出现上一轮的TLS证书错误或451拒绝。

| 场景 | 会话 | 结果 |
| --- | --- | --- |
| 文本直接写用例并交付Excel | session-2026-10-14-11-12-07-7d2f4173 | completed，12条用例，Excel和JSON已生成，总控返回文件链接 |
| URL只读探索、用例和报告 | session-2026-10-14-11-12-50-834251a7 | 路径输入错误被误分类为运行故障并stopped，没有实际浏览器探索或正式报告 |
| 显式完整流程 | session-2026-10-14-11-12-53-98c041ac | 分析结构校验通过，交接被错误恢复判定拦截；总控另建run继续，验收方终止，未交付XMind/Word/PDF |

## 文件与交互

实际Excel：E:\QAWorkspaces\2026-10-14-11-12-07-7d2f4173\output\runs\run-5a08ba7d-d0af-4dcc-8fc5-e6c7d533f35e\design\test_cases.xlsx。

- 工作簿可解析，包含“测试用例”和“问题清单”，12条数据，11列标准表头。
- 调用工程原有文档启动器打开该文件，WPS窗口标题为test_cases.xlsx，定向窗口截图可见实际表格，无损坏提示或明显乱码；这不是从PenguinHarness桌面链接点击打开的证明。
- 通过真实安装版网页、真实会话及原生本机API身份访问，看到Excel链接和文件卡片，执行详情默认折叠；没有以合成消息替代。
- 实际点击Excel链接得到403及“本机打开仅支持桌面应用”提示。这是普通浏览器身份的预期保护，未绕过桌面权限检查。
- 浏览器点击下载触发下载事件，但自动化保存返回canceled；同一下载接口带合法身份独立读取为200，SHA256与Agent正式交付一致：36f4cc1372df2e38609949fa59e918e706015889d27c83c7c100a3a7f1826c4d。下载自动化未闭环，不能据此宣称用户下载功能通过或判定产品下载接口故障。
- 总控给出的JSON Markdown链接在界面中显示为普通文字，非可点击链接；主要Excel交付链接可点击。
- Windows桌面自动化遇到窗口几何及前台激活失败，未能可靠完成PenguinHarness桌面内链接点击。已停止不可靠的键鼠尝试，不要求用户补技术解锁。
- 本轮未生成XMind、Word或PDF，无法进行这些格式的最终打开检查；历史文件不能替代本轮交付。

Excel阶段completed只证明本次流程与文件交付，不等于用例语义质量完全合格或产品测试通过。用例仍有自行生成追溯ID等质量问题，未在本轮修改原产物。

## 剩余工程阻断

### 1. URL来源路径错误仍会全局停止

执行子Agent首次漏source_path，收到可纠正输入提示；随后把工作区相对路径交给要求运行目录相对路径的入口，readRunFile尝试读取运行目录下的output，抛出ENOENT。这个尚未启动浏览器的输入错误没有转换成CommandUsageError，导致全局stopped。不是上一轮无扩展名规则再次拒绝。

应统一路径契约：派发直接给出可用source_path；入口读取前核对路径形式与存在性，将确定的输入错误分类为可修正，不放宽来源或越界保护。子Agent随后仍手写了失败JSON且位置不在run内，说明仅靠提示词禁止补造受控执行文件还不充分。

### 2. 校验动作别名未解除已纠正的只读Shell探测失败

原分析子会话session-2026-10-14-11-14-02-b60d8c37在POSIX shell中执行Get-ChildItem失败，后来实际完成validate_analysis，script为validate-artifacts.mjs、任务键为`:validate_analysis:`。child-command-policy.mjs只用`:validate_artifacts:<stage>`匹配已验证校验回执，因此pendingShellProbes未清除，handoff和返修预检反复报“Shell inspection failures were not followed by verified artifact validation”。

应按受控脚本、动作与持久回执验证统一识别合法校验别名，仍要求同run、同派发、真实成功及确认结束；不能笼统忽略历史错误。另有shell profile的which/locale告警，未在本轮改动启动环境。

### 3. 总控绕过失败另建run

原run-cb261b3f-d709-4136-bdd6-46b82d182cf3分析失败后，总控自行创建run-cb931f4d-0951-4749-bcac-3ae72ed8b152并重新派发分析。这不符合本次验收的有限纠错与保留失败流程要求。已终止本轮任务，保留两份记录，不能把新run日后成功算作原流程顺畅通过。

应让失败返回提供明确的结束或安全恢复动作，并覆盖同一用户任务下的自动重建行为，避免仅增加提示词或向用户索要更多确认。实现时不能阻碍用户确实发起的新独立任务。

## 下一步

优先修复来源路径输入分类、校验别名恢复识别和失败后任务边界。之后再复验URL及完整流程，并在可可靠控制的桌面窗口完成Excel/XMind/Word/PDF点击打开。无需用户补材料或手工修改状态。

## 证据与清理

证据目录：E:\QAArchives\AITestWorker\real-agent-recheck-20261014。包含sessions.json、会话快照、真实网页截图、web-check.json及wps-workbook.png。验收脚本自身的导入路径/定位/下载错误单独记录，不混同为Agent运行结果。

三个本轮会话均已通过原生接口停止并核实idle；验收测试服务和自动化浏览器已关闭，WPS中的工作簿保留打开，未保存修改。没有更改旧失败状态，没有修改生产业务逻辑，没有提交GitHub。
