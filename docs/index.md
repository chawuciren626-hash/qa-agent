# 文档导航

更新日期：2026-10-20。为避免旧计划误导，当前待办只在状态页维护，不从历史文档的“下一步”恢复任务。

## 当前入口

- [产品技术介绍与工程架构](product-technical-overview.md)：产品定位、七角色与十一Skill、任务模式、执行工具、交付物及部署边界。

- [工程说明](../README.md)：定位、能力与目录。
- [当前状态与下一步](current-status-and-next-steps.md)：已验证、待验证和优化顺序。
- [日常使用指南](user-guide.md)：面向测试使用者，不要求手工工程操作。

## 维护与技术参考

- [全流程阻断修复与验收](lifecycle-blocking-remediation-2026-10-20.md)：五项整改、原版本幂等交付、故障隔离与部分报告、真实独立用例和六阶段流程复验，及未完成边界。
- [全流程阻断审阅](lifecycle-blocking-audit-2026-10-20.md)：本轮问题依据和五项整改完成标准；实施结果以上一篇为准。

- [用例交付误阻断修复](case-delivery-malformed-command-fix-2026-10-20.md)：未执行的截断命令误拦handoff、受限草稿交付恢复，原58条用例及Excel已受控交接，无重生成或重派发。

- [URL输入与子任务中断修复](url-and-interrupted-child-fix-2026-10-20.md)：中文连写网址、中断误等待、原生句柄保留、104项工程回归，以及历史无句柄会话与真实续接待验收边界。

- [人工登录卡片与原任务续接](human-login-continuation-2026-10-20.md)：同子会话/同浏览器恢复、原生用户确认、防重复处理和验收边界。

- [浏览器执行前纠错与部分结果交接修复](execution-partial-handoff-fix-2026-10-20.md)：sequence 输入错误误停、已关闭部分结果被历史失败拦截、工程文档读取纠错；原会话报告续接与验证记录。

- [10月20日工程多视角审阅](engineering-review-2026-10-20.md)：测试可信度、Agent编排、全栈交付及安全/部署审阅；14项问题与风险、后续建设顺序。只读审阅，不替代正在进行的真实验收，不代表修复已开工。

- [第5项调用效率与异常交付修复](acceptance5-transport-delivery-fix-2026-10-20.md)：单次请求说明、短任务引用、结构化Shell和JSON/目录只读交付；已安装，真实模型复验待进行。

- [第5项断言范围与部分结果修复](acceptance5-result-scope-fix-2026-10-20.md)：实际检查条件、未测范围、部分报告自动收口与验证边界。

- [第5项交接首批修复](acceptance5-handoff-fix-2026-10-19.md)：CLI执行前拒绝、完成预检、句柄纠正和回归证据；真实复验待进行。

- [第5项真实Agent短任务验收](acceptance5-canary-2026-10-19.md)：首轮未通过，记录交接阻塞、调用冗余、断言与交付问题及下一轮顺序。

- [4B/4C调用效率与工程可复现](efficiency-and-reproducibility-2026-10-19.md)：单次结构化入口、连续步骤、证据成本、运行时、依赖与部署边界。
- [4A凭据保护与耗时关联](browser-privacy-and-timing-2026-10-19.md)：工程验证、加密引用、统计口径及未覆盖范围。
- [10月19日合并整改计划](consolidated-remediation-plan-2026-10-19.md)：分包范围与当前落实情况。

- [全流程会话审查与计划](full-lifecycle-review-2026-10-16.md)：132分钟会话的重复设计、执行阻断及六项整改顺序。
- [草稿交接与增量修订修复](draft-handoff-repair-2026-10-16.md)：第1项，统一产物契约、执行前拒绝分类、保留工作草稿与验证边界。
- [任务输入与中文附件修复](task-input-context-repair-2026-10-16.md)：第2项，原话/附件自动归档、后续补充与跨任务隔离、中文Word输入。
- [准备恢复与人工续接](execution-preparation-recovery-2026-10-16.md)：第3项前半段，准备失败分类、保留草稿恢复及原生人工续接；后续适配见下一篇。
- [全流程浏览器执行与报告交接](browser-lifecycle-execution-2026-10-16.md)：第3项后半段，浏览器策略、设计覆盖、失败分类和Word/PDF交接。
- [分批设计与资产复用](incremental-design-and-reuse-2026-10-16.md)：第4项，稳定ID批次保存、原字节导入、边界样本生成、原生句柄查询及无进展恢复反馈。
- [中文任务与连续消息展示](chinese-conversation-delivery-2026-10-16.md)：第5项，中文派发与答复、标点思考过滤、消息拼接边界及安装验证。

- [派发接口与交付回复修复](delegation-interface-repair.md)：目标角色必填、展示与等待元信息边界、真实复验及剩余展示/范围语义问题。

- [总控工具调用根因修复](controller-tool-transport-repair.md)：CWD参数、请求先执行后写入、只读目录误拦截的代码修复与待安装验收边界。

- [独立用例预期依据](expectation-basis.md)：实践融合第1项，预期逐项引文、假设分离、兼容旧用例与Excel依据表。
- [业务成功证据与条件验证](business-verification.md)：实践融合第2项，可选前置条件、被动响应比较及页面/接口/回查证据边界。
- [测试数据台账与安全清理](test-data-ledger.md)：实践融合第3项，本次标记数据的创建/清理观察、防重复操作及残留报告。
- [用例、断言与重试统计](execution-counts.md)：实践融合第4项，可选用例关联、只读复查、框架重试和缺失历史的计数边界。
- [受控接口验证与故障模拟](controlled-api-validation.md)：实践融合第5项，同源GET/HEAD、单次GET故障注入、撤销及模拟证据区分。

- [派发内容绑定](delegation-content-binding.md)：二轮架构修复第1项，登记参数、完整合同和证据索引的启动前核验。
- [清单写入锁安全恢复](manifest-lock-recovery.md)：二轮架构修复第2项，失效所有者核验、并发恢复认领与不重放产品操作的边界。
- [工程测试与CI](engineering-tests-and-ci.md)：统一npm入口、自动发现、隔离运行、结果报告和GitHub Actions适用范围。
- [总控Skill与默认入口职责](controller-role-boundaries.md)：专业Skill可恢复归档、通用入口边界，以及工程回归和真实任务剩余问题。
- [阶段元数据注册表](stage-registry.md)：阶段角色、产物和名称的统一来源，独立任务兼容及扩展边界。

- [用例一致性与资源路径](case-consistency-and-resource-paths.md)：非阻塞数据准备提示、预期来源边界和真实Skill路径派发。

- [角色与轻量记忆组织](role-and-memory-organization.md)：第6项公共规则收敛、任务来源分层、角色派发和模型无关边界。

- [模型参数测量与迁移](model-parameter-tuning.md)：第5项真实对照、保留默认决策，以及不绑定单一模型的测量和迁移规则。

- [报告证据索引与执行事实](report-evidence-index.md)：独立报告的实际文件索引、确定性统计与时序附录，不增加用户审查。
- [独立回归交付](regression-delivery.md)：初测与本轮的可选观察对照、原失败保留和未覆盖范围，不自动关闭缺陷。
- [独立回归报告真实验收](regression-agent-acceptance-2026-10-16.md)：附件任务自主完成，字段保真、结构化对照接入与点击验证仍有缺口。
- [报告结果字段保真修复](report-result-fidelity.md)：唯一来源恢复、导出来源与模拟标签、原稿审计，不新增用户节点。
- [输入与交付体验修复](input-and-delivery-repair.md)：明确附件导入入口、CLI自纠提示、核验链接及简洁收尾，保留会话隔离。
- [修复后真实复验](regression-recheck-2026-10-16.md)：模拟标签校验修正、第二轮自主交付及扩展名/来源关联等剩余问题，区分导航下载与真实点击。
- [附件与结构化内容兼容](attachment-content-compatibility.md)：归档扩展名补齐、按内容识别JSON与BOM、保留源字节及不猜测别名。

- [配置与同步](penguinharness-configuration.md)、[凭据安全](credential-security.md)：维护者职责与边界。
- [会话工作空间](penguin-session-workspaces.md)、[目录上下文](directory-context.md)：工程、会话和数据分离。
- [独立专业任务](independent-professional-tasks.md)、[交互浏览器](interactive-browser-tasks.md)、[可点击交付](delivery-interaction.md)：当前能力机制，文中历史验收只证明当时范围。
- [公共运行规则](../penguin/command-runtime.md)、[总控角色](../penguin/agents/test_agent/AGENTS.md)：当前Agent执行规则的版本化来源，不是用户待填写的流程表。
- [结构化动作](structured-actions.md)、[产物契约](artifact-contracts.md)、[质量治理](quality-governance-lifecycle.md)：内部实现参考。字段以当前代码及catalog为准，旧CLI示例不应当作普通用户入口。

## 学习资料

- [Agent开发学习指南](agent-development-learning-guide.md)：学习入口，不是产品当前完成度声明。
- [一个月计划](one-month-qa-agent-plan.md)：原始学习与建设规划，时序不代表当前待办。
- [多Agent与桌面方案](penguinharness-multi-agent-desktop-app-plan.md)：设计背景，不代表独立exe已发布。

## 历史与证据

- [10月15日动态反馈与证据索引复验](evidence-feedback-recheck-2026-10-15.md)：最新真实执行与报告，记录已验证改善、前置条件缺口和报告语义剩余问题。

- [截至10月15日的状态历史](status-history-through-2026-10-15.md)：整理前状态页正文完整保留。
- [10月15日真实任务基线](real-task-baseline-2026-10-15.md)：普通请求下的耗时、错误、自动返修和交付质量，不是全流程通过声明。
- [10月15日基线问题修复](baseline-repairs-2026-10-15.md)：请求分类、断言时序、读取恢复及报告规则；工程回归与真实复验分开记录。
- [10月15日修复后真实复验](baseline-recheck-2026-10-15.md)：3/3动态断言、一次报告派发及桌面Word打开；记录仍待修复的工具、模板和字体问题。
- [10月15日统一真实复验](unified-recheck-2026-10-15.md)：报告与浏览器第二轮修复后的实际表现，记录定位猜测、重复尝试、事实归因及第4项尚未收尾的依据。
- [10月15日用例真实复验](case-data-single-source-2026-10-15.md)、[URL执行记录](url-direct-execution-2026-10-15.md)、[浏览器修复](browser-recovery-2026-10-15.md)：保留成功与失败及验证边界。
- 其他带日期的修复、迁移、验收文档按该批次理解；内部“已完成”“待确认”和测试数不自动覆盖当前状态，不累加为一个总通过数。

## 更新约定

进度变化更新当前状态页；用户操作变化更新使用指南；机制变化更新相应技术参考。只有需要保留证据的独立批次才新增日期记录，不再向状态页无限追加旧“最新”。历史证据和失败结论不改写为成功。发现文档与实现冲突时先核对代码与真实记录，不用文档描述替代验收。
