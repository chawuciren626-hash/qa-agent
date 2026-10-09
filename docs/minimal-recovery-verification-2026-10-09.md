# 最小真实恢复链路复验

日期：2026-10-09。通过PenguinHarness界面实际操作，总控及子Agent均使用现有step-3.7-flash；不是终端模拟、模型评分或完整业务验收。

## 结论

受监督的恢复、重新派发、真实子会话绑定、结构校验及确认退回链路已验证。需求分析语义审查未通过；失败后停止的指令遵守也未通过，不能称为零干预自主成功。本次不批准analysis，不进入其他阶段。

最终清单：run.status为in_progress，analysis.status和确认状态为revision_requested。in_progress在这里是工作流尚未结束的聚合状态，不代表仍有Agent在执行。原始分析、台账及所有事件保留。未修改工程脚本/Skill/配置，未提交GitHub。

## 实际证据

- run：`run-acceptance-recovery-20261009`，仅选择analysis，其余五阶段skipped。
- 总控会话：`session-2026-10-09-14-55-55-d1f06f07`。
- 首次dispatch：`26906606-b942-4201-a503-6be564e69ee8`。
- 材料核对子会话：`session-2026-10-09-14-56-29-081e944c`，自然结束，生成`audit/material-check.md`。
- 本次blocked是预先说明的恢复演练暂停，不是产品故障或伪造失败。正式blocked发生于北京时间14:58:12。
- Codex核对父子trace、无执行锁或running执行状态及调用内容，写入`audit/recovery-review.md`；审查哈希为`6126d63f988d741a22022fa724150317c9cd6478ee1eb418a0abbfc8a3874e37`。
- 15:00:41正式stage_recovered保存原阶段和首个已结束子会话；恢复到revision_requested，没有手改manifest。
- 新dispatch：`88d8a930-0be2-4026-b168-ffd0dc1dcba7`，发生于15:00:54。
- 正式分析子会话：`session-2026-10-09-15-01-01-e702c385`，真实prompt含新编号及run_id，产出`analysis/requirement_analysis.md`、`analysis/requirement-ledger.json`。
- completed事件15:03:05绑定`chatcmpl-tool-82faf646fb7ab592`及真实subagent事件，含产物、来源哈希及passed结构回执。
- 15:03:09发起确认`confirm-analysis-1791529389080`，附semantic_review清单；没有批准。
- 15:04:25通过resolve-stage-confirmation正式退回revision_requested，审计为`audit/semantic-review.md`。

所有run相对路径均位于`output/runs/run-acceptance-recovery-20261009/`。运行日志和截图仅留本机，真实trace保留在PenguinHarness对应Agent的同日traces目录，不提交原始会话到仓库。

原`run-acceptance-base-20261009`未改动，清单SHA256仍为`B4F6EDCF946DFFCE607D4B6CB418E124477E10D73F526895EB74889D49539DFD`。旧协议运行没有被补造新派发编号。

## 发现的问题

1. 正文与台账不一致。Markdown包含ASSUME-1至3、待确认问题及scope/reset背景，JSON却只有7条confirmed需求。结构校验没有捕获正文未登记声明，后续仅按台账计算覆盖会遗漏这些内容。
2. 未确认推断仍混入正文。默认以系统可表示范围作为预算上限、创建后无需手动刷新均非原文明示；应明确待确认且不得形成正式预期。并发属于额外建议，应标范围外。将trim后长度校验写成保存前必须去除空格，可能扩大为存储规范化，需明确区分。
3. 材料归档和范围判断混淆。首轮总控未归档输入；子Agent正确发现缺项，却把本轮消息已明确的规则说成范围无法确认，并搜索登录样例/历史资料。恢复时由Codex澄清并要求归档原文，这是实际工程干预。
4. 命令调用及失败停止不稳定。总控首次recover缺少reason被拒后自行补参数重试；子Agent把运行器run-id误当底层参数，并尝试不支持的--help。台账还经历JSON语法错误、引文引号不一致，之后自行修正重验。没有绕过脚本，但未遵守本轮失败停止要求，总控也未把该要求完整传给子任务。失败日志不能被最终passed掩盖。
5. 状态汇报失真。首次实际run blocked却汇报in_progress；第二次实际run和analysis均awaiting_confirmation，却说in_progress/completed。事件completed只表示完成登记历史，不能替代当前状态。

积极变化：未再次发生npm/Bash入口卡死或交互式cmd等待；没有看到下载安装、启动被测浏览器、改工程脚本或手写manifest的调用。两次派发分别使用独立编号，历史暂停与审查记录没有被删除。

## 下一轮建议顺序

1. 建立单一结构化分析源：将需求、假设、待确认、范围排除及背景约束统一登记，再确定性生成Markdown；检查正文声明和台账覆盖，避免两份内容独立维护。
2. 规范命令与子任务契约：参数校验和帮助信息清晰区分运行器/脚本；明确可修正输入错误与必须停止的业务闸门策略，并把停止条件传入子Agent。不能仅增加更长提示词或为本次基座硬编码规则。
3. 状态摘要从清单直接生成：分别展示当前状态、最近事件、待确认及执行进程状态，不让模型凭历史事件推断。
4. 以上修复后先重新进行同范围最小验证，确认语义审查通过再安排独立完整复验；不直接扩展业务测试，也不启动模型评测。

每项仍需完成后停下待确认。本次只验证和记录，不静默实施以上修复。此前73项Node/7项Python工程回归结论保留，本轮未重跑，也不将它们冒充此次真实复验通过证据。
