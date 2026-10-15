# 真实 Agent 验收记录

时间：2026-10-14 13:36 至 14:07（北京时间）。结论：**整体未通过**。

## 方法和边界

通过已安装的 PenguinHarness 原生会话及任务接口，使用现有 tokendance / step-3.7-flash 模型。没有以工程测试夹具、Codex 手写专业产物或伪造执行记录替代 Agent 交付。测试对象为本地虚构文档草稿页面，两个独立 scope，不涉及真实业务数据。

原三场景按上轮相同范围复验；另外补充独立报告任务，以验收操作者真实浏览器只读观察为输入，明确禁止声称创建功能已执行。该补充只验证报告能力，不算完整流程恢复。

本轮未改代理、证书、模型凭据或安装文件，未重启 PenguinHarness，未修复业务工程代码，未提交 GitHub。仅新增验收辅助脚本、取证和本文档。

## 场景结果

| 场景 | 真实会话 | 结果 |
| --- | --- | --- |
| 文字直接生成用例 | session-2026-10-14-13-36-17-7f13ffac | 阶段 completed，Excel 与 JSON 实际 15 条；回复和任务摘要错误地称 12 条。约 6 分 15 秒完成。 |
| URL 只读探索及报告 | session-2026-10-14-13-36-09-528e3748 | 未通过。没有选择 execution；用例角色直接 curl，拼错 API 后误报环境异常。用例返修、报告未闭环，约 15 分钟后由验收操作者停止循环。 |
| 完整测试流程 | session-2026-10-14-13-36-12-da23f57d | 分析、6 条测试点及 6 条用例完成；执行准备失败，实际创建、缺陷分析和 Word/PDF 未完成。约 25 分钟仍未进入产品执行。 |
| 独立报告补验 | session-2026-10-14-14-00-42-9c35875a | 未通过。报告文件先写错目录，export_report 缺文件触发全局 stopped；仅有 Markdown/JSON 草稿，无 Word/PDF。约 3 分 20 秒返回失败说明。 |

每个会话均只有一个 run，未观察到本轮另建 run 绕过失败。但真实后台通知的任务身份识别仍有静态风险，见下文。

## 已确认问题

### P1 自动推进和职责路由不可靠

- 完整流程总控在 13:39:36 仅登记 test_points 派发，没有对应 run_subagent 调用，却回复测试点正在后台处理。验收操作者补充一次同范围继续指令后，13:42:35 才真正启动。不能算零介入自动推进。
- URL 任务只选择 test_cases/report；总控直接 explore_url 被拒绝后，仍让用例角色探索产品。该角色请求 `/api/final-url-20261014/items`，而实际页面使用 `/api/healthy/items`。错误地址返回 404，被描述为环境异常和种子记录不存在。
- 验收操作者的真实浏览器及 GET 核验确认页面显示 Sample document / 120 / draft，正确 API 返回 200。错误应归为智能体执行问题，不能作为产品缺陷。
- URL 返修混用生命周期 diagnose_test_cases 与独立任务契约，出现要求前序测试点、related_test_point 的矛盾，并把工程 Schema 选择交给用户。应统一按保存的任务模式解析契约。

### P1 自行增加的假设阻断执行及确认归档崩溃

- 分析/设计把已明确提供的 UI URL 解释为“可能是健康检查接口”，并加入待确认的自动刷新假设。执行准备首次只选出人工用例；后续检查因 `Assumption: Confirmation evidence required` 连续失败。
- 起始请求已经授权本地限定操作，13:50 仍重复索取同范围批准。验收操作者代确认并澄清 UI 入口后，确认没有正确落入执行数据。
- prepare_execution_plan 连续 3 次失败；子 Agent 随后手写执行计划，validate_execution_prepare 又失败。不能用手写确认依据替代受控计划和真实授权。
- 最终 apply_analysis_feedback 产生 `Cannot read properties of undefined (reading 'push')`。自动模式 manifest 未提供 confirmations 数组，而 `scripts/analysis-revision.mjs:66` 直接 push；此前已写出反馈文件及修订快照，仍须处理失败时的部分写入问题，不能只补一行初始化后忽略一致性。

### P1 报告缺文件仍导致全局停止

- 独立报告子 Agent 把初始文件写到会话根目录的 report，而不是 run/report。
- 14:02:40 的 export_report 在读取 run/report/report-task.json 时 ENOENT，被归为 runner_error 并停止整个控制器；没有启动产品测试。
- 后来纠正文件位置仍不能继续导出。上一轮只修复 URL 来源路径分类，尚未覆盖导出输入和其他非执行入口。需要统一可纠正输入边界，而不是取消未知执行/安全失败保护。

### P2 最终回复不完全依据实际产物

- 独立用例 JSON 和 Excel 有 15 条，回复及 task summary 为 12 条，说明最终数量仍由模型复述而非真实数据确定。
- 独立报告最终链接指向不存在的 `report/test_report_reportable-results.json`，却标为 Markdown 报告。真实草稿是 `report/test_report.md`。
- JSON 仍以代码路径显示，没有可点击链接；最终回复仍包含过多 Schema、校验及前序台账说明。
- 被中断/失败的 URL 和独立报告任务会话已 idle，但部分 manifest 阶段仍为 in_progress。应核对任务结束后的真实状态同步，不直接改历史记录冒充完成。

### 后续必须覆盖的身份边界

真实后台子任务完成通知在原轨迹中是 role=user，同时带 `sender: harness` 和 `[background_task_done]`。当前 requestTurnKey 排除了两种内部文字前缀，却未排除 sender=harness，存在把后台完成当成新用户任务边界的风险。本轮未观察到因此创建第二个 run；下一轮应以原生 sender 字段补回归，而不是声称已复现重复创建。

## 文件交互验收

| 检查 | 结果 |
| --- | --- |
| 桌面 Excel 卡片点击 | 通过。在真实会话点击，WPS 打开本轮文件，显示 15 条、中文正常；有截图。 |
| XMind 卡片触发及客户端打开 | 卡片触发客户端有日志；首次退出未完成视觉确认。确认进程退出后通过同一打开入口补开，看到完整脑图、分支及中文，无损坏提示。不能把首次退出认定为文件损坏。 |
| XMind ZIP/JSON | CRC 检查通过，content.json/metadata.json/manifest.json 可解析。 |
| Word/PDF | 未生成，未验收；没有用历史文件或手工导出替代。 |
| 下载接口 | 200，Excel SHA256 与交付文件一致：fffb5467bef18e5f391d70a731a69af9d8bed1d2dabbd51eca32fcbf154f1cc5。 |
| 浏览器下载保存 | download.saveAs 返回 canceled，尚未定位原因。 |
| 桌面下载按钮 | 点击未见保存完成，Windows 默认 Downloads 未发现对应文件；未确认其他自定义保存位置，不宣称下载通过。 |
| 网页布局 | 1440 宽桌面及 390 宽手机已截图；手机 document scrollWidth=390。 |

## 人工介入记录

用户本轮没有补操作。验收操作者在同一完整流程会话代做两次推进：一次纠正“仅登记未启动”，一次重申原执行授权及 UI 入口。均未扩大范围。这两次介入是体验缺陷证据，不算系统自主完成。

对 URL 和完整流程发起过停止请求以结束工程循环。14:06:52 最终核验四个父会话及九个实际子会话全部 idle。历史失败、停止及半成品状态保留，没有手工改为 completed。

两个 scope 最终都只有原始种子记录；未观察到创建操作写入。验收浏览器已关闭，本轮启动的 4317 测试服务已停止，文档应用保留供查看，未保存改动。

## 证据位置

统一目录：`E:\QAArchives\AITestWorker\real-agent-final-20261014`。

- sessions.json：原始输入、会话和工作区。
- 四份 *-snapshot.json：真实父/子消息快照。
- final-audit.json：最终运行阶段、全部会话状态、文件哈希及测试数据状态。
- ui-verification.json、actual-url-target.png：正确页面/API 的只读核验及下载结果。
- cases-native-result.png、cases-native-after-open.png、cases-opened-wps.png：真实 Excel 卡片及 WPS。
- xmind-native-click.png、xmind-verified.png：链接触发及脑图显示。

各场景 run 和动作凭据仍位于对应 E:\QAWorkspaces 会话目录。报告任务的 ENOENT 与生命周期反馈崩溃有独立 action-audit 凭据。

## 下一轮修复顺序

1. 优先修复确定的运行错误：自动模式确认归档空数组/部分写入，报告导出缺文件的输入分类，以及真实 harness 通知身份边界。保持原失败证据，不要求用户技术解锁。
2. 收敛总控派发：明确 URL 观察需要 execution；派发登记和实际子调用一致；无真实子任务时不能回复“后台运行”。统一 task/lifecycle 契约，减少反复读源码和无关目录扫描。
3. 打通自然语言授权和执行准备：已明确的环境事实不制造待确认假设；确认只影响必要字段，禁止修改已确认产物或手写凭据绕过失败。
4. 最终交付从真实产物生成数量与链接，检查链接存在性，精简回复；定位下载取消。再做真实全流程和 Word/PDF 打开验收。

本轮验收失败说明此前工程回归通过不足以证明真实模型使用可用，不应先继续打包发布。
