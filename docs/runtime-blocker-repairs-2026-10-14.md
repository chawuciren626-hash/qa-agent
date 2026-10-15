# 真实验收问题修复：第一批运行阻断

日期：2026-10-14。

## 最新复验补修：命令路径和派发合同

本批最终六组工程回归 124/124 通过、无跳过；角色安装复查 in_sync。真实模型复验仍未通过，详见下文失败记录，不以工程结果替代。

真实复验 url13 的 execution 和 test_cases 已交接，但报告导出多次使用未加引号的 Windows 反斜杠路径。PenguinHarness 实际通过 Bash 执行，路径被去掉反斜杠，读取请求失败并消耗 unbound 请求纠错次数。该轮未交付 Word/PDF，不计通过；历史运行及错误回执保留。

- 独立派发的长合同存入单独文本，原生派发 JSON 引用合同，避免单行 JSON 被文件读取截断。仍绑定真实 dispatch 和子调用，不以文件存在替代子 Agent 完成。
- 独立任务给出精确的请求文件写入路径和正斜杠相对命令；生命周期与公共指令均不再假设 Windows 使用 PowerShell。缺请求回执返回实际收到的路径和安全写法，不猜测或重建损坏路径。
- 成功的只读目录/搜索不再要求额外交付审批；失败检查仍须保留证据并核验恢复。新增相对运行目录 find，拒绝 shell 命令替换、rg 外部预处理器和修改型 find。
- 总控说明明确 browser_task/explore_url 由执行子 Agent 调用，总控负责派发与交接。

本批四组隔离工程回归首轮 109/109 通过、无跳过；扩大回归随后暴露浏览器连接文件竞态，已补原子发布与 Windows 有界替换重试，不能用首轮通过数覆盖后续结果。真实 url14 因执行子Agent仅输出思考并耗尽长度而停止；取消父会话未自动停止子会话，验收操作者已单独停止并确认均 idle。模型保持 tokendance / step-3.7-flash，未改代理、证书或网络设置。最终合并测试、仍需修复的取消传播及真实交付待验项见[本轮复验记录](real-agent-path-recheck-2026-10-14.md)。

本批对应 `real-agent-final-acceptance-2026-10-14.md` 中确定的运行错误。历史失败会话、产物和状态不回填、不解锁；工程回归不代替真实 Agent 验收。

## 已修改

1. 自动模式需求修订：允许合法的 manifest 没有 confirmations 数组。先复制、校验并构建下一状态，再写归档和反馈；不提前修改调用者的 manifest。记录修订 prepared / committed / failed 状态；manifest 提交失败时恢复原分析 Markdown，保留失败证据，不把残留反馈文件视为已应用或已授权。
2. 独立任务导出：先校验当前派发归属及状态，再检查草稿。缺文件、无效 JSON、草稿契约不完整返回可纠正输入，指出当前运行目录及任务文件，沿用既有有限纠错机制。纠正后可以重试，不因首次草稿错误直接全局 stopped。越界文件、错误派发归属及未知错误不改成可恢复成功。
3. 会话身份：sender=harness 的后台通知不再改变 create_run 的用户任务绑定，也不能作为 apply_analysis_feedback 的用户原文。真正的新用户请求仍独立绑定运行。

## 验证

新增工程回归覆盖：无 confirmations 的自动模式、后台通知后复用原运行、后台通知不能提供用户确认、无效修订账本不产生写入、提交故障恢复原文件且可重试、独立报告缺草稿或 JSON 损坏后修复并导出、目录重定向与外来派发仍被拒绝。

测试通过 `scripts/run-engineering-tests.mjs` 在临时工程副本中运行，不向真实会话写入夹具、不执行产品测试。首轮 75 项中 73 项通过，2 项为新增测试夹具问题：Windows 文件符号链接权限及在活动阶段切换测试确认模式；已改为目录 junction 负向测试、从建计划时直接选择自动模式。

最终扩大回归：structured-actions、independent-task、controller-command-session、stage-evidence 共 **106/106 通过，无跳过**。其中独立报告修正草稿后的 Word/PDF 导出通过，但属于工程夹具验证，不代表真实 Agent 已完成报告任务。资源清单检查返回 allowlist_valid，165 个条目；exe_ready=false，不宣称可以发布。

回归日志保存在 Windows 临时目录 `qa-repair-runtime-20261014-v2.log`；原失败轮为 `qa-repair-runtime-20261014.log`。

未修改代理、TLS、模型配置；未改安装包、重启应用或提交仓库。已安装总控 hook 的工程根仍为 `E:\Codex\AITestWorker`。

## 后续顺序

1. 派发登记后没有实际启动子 Agent、URL 探索职责路由，以及独立任务误用生命周期诊断。
2. 用户原始授权和真实澄清传递到执行准备；避免 Agent 自行添加假设、重复索取同范围批准。
3. 交付摘要数量、实际存在的文件链接及下载完成状态。
4. 重新运行真实 Agent 场景，并检查 Excel、XMind、Word、PDF 实际交付和打开。

这些后续项尚未因本批修复而宣称完成。原验收整体未通过的结论保持不变。

## 第二批：派发和任务路由

已完成工程修改，真实 Agent 复验仍待执行：

1. dispatch 响应明确标记 `child_started=false` 和下一步 `run_subagent`。停止钩子现在可发现“登记成功但没有原生子调用”的派发，用同一 delegation 最多提醒两次；一旦存在已发起、已失败或结果未知的真实调用，不会重复启动。提醒不创建新 run、不重复 dispatch、不修改阶段状态、不授予执行权限。
2. 独立任务即使误调用 `diagnose_analysis`、`diagnose_test_points` 或 `diagnose_test_cases`，入口也会根据 manifest 的 task 模式转到独立任务草稿检查，不再要求生命周期台账、前序测试点或 related_test_point。专业角色指令仍优先使用 `diagnose_task`。
3. plan_run 新增 task-only 的 `source_mode`：默认 `provided_materials`；用户明确要求访问、探索或测试实际产品后再生成交付物时使用 `live_product`。系统先选择 execution 获取受控观察，再把观察作为数据依赖交给测试用例、报告等角色；不会补造 analysis/test_points 等生命周期阶段，也不会新增用户确认。文档中仅出现 URL 不等于允许访问。
4. 非执行角色明确不得用 curl、自编 HTTP 或浏览器猜测产品状态，也不得根据页面路径猜 API 后把 404 归为环境故障。实际观察由 automation_execution_agent 产生。

第二批定向工程回归 99/99 通过，扩大回归 120/120 通过。test_agent、test_point_agent、test_case_agent 三份指令已同步到 PenguinHarness，复查 in_sync。资源清单仍为 165 项有效；未重启应用、未改代理/模型/证书。本结果仍是工程回归，不替代真实 Agent 复验。

## 第三批：同范围执行授权和准备质量

已完成以下工程修改，扩大回归进行中：

1. lifecycle 的 execution 批准必须携带 `source_text`，并与当前父会话中的真实用户消息完全一致。sender=harness 后台通知、总控转述、理由字段或不存在的原文不能成为批准。确认记录只保存会话、时间和 SHA-256 来源元数据，不把消息正文写入 manifest。
2. 初始用户消息已经明确授权相同目标、操作范围和数据影响时，总控复用该原文批准当前执行快照，不重复询问；只要求分析、用例或准备计划的消息不算执行授权。目标、范围、数据影响或快照变化时仍须重新确认。
3. 执行器再次校验批准来源，手工构造只有 status=approved 和 snapshot 的记录不能启动产品测试。旧的无来源批准不会被静默沿用。
4. 测试用例角色不得把技术猜测、可选增强、自动刷新或已明确UI入口重新包装成用户待确认假设。普通可定位Web交互应按现有能力判断自动化可行；验证码/MFA、不可控外部设备等才标人工。准备阶段发现全是manual、确认依据或设计合同错误时，作为上游技术质量问题返回总控，不让用户选择Schema，也不手写计划绕过。

第三批定向回归 94/94、扩大回归 121/121 通过。test_agent、test_case_agent、automation_execution_agent 指令已同步，复查 in_sync。未修改代理、模型、证书或历史会话。

## 第四批：交付事实和链接

交付展示改为只信任当前阶段 completed 事件中的 artifact_contract：文件必须仍存在且 SHA-256 与完成时一致才生成链接。阶段状态完成但文件缺失、被修改或未进入合同的路径不再展示。

测试点、测试用例和报告结果数量由相同已验证合同中的规范 JSON 计算，输出 facts 和 concise_summary。回复指令要求所有数字只使用该快照，不从对话、子Agent文字或估算中取值；只使用 delivery 提供的实际链接，不猜测 Markdown 路径。这样可以阻止“实际15条、回复12条”和不存在文件被标为交付。

四批合并工程回归 156/156 通过，无跳过。Agent 同步状态 in_sync，发布资源清单 165 项有效，exe_ready=false。浏览器下载保存曾出现 canceled 的真实问题尚未以本轮工程回归证明修复；需在下一次真实 Agent 复验中单独检查网络响应、浏览器下载事件和桌面落盘结果。
