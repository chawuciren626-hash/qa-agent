# 结构化动作与失败说明

## 目的与入口

减少模型拼接双层CLI参数导致的误用。动作适配层以固定映射构造参数数组，继续调用原脚本和同一个controller-session闸门，不自动纠错重试、不跳过阶段审批、不代替专业Agent。

先查看目录：`node scripts/project-action.mjs catalog`。用文件工具将请求JSON保存到本机output/action-requests内，随后每次仅运行一个命令：

```text
node scripts/project-action.mjs execute --controller-session=<真实总控会话ID> --request=<请求JSON路径>
node scripts/project-action.mjs summary --controller-session=<真实总控会话ID>
```

以上两行是不同操作，不合并执行。请求文件可以放在run创建前的独立目录，无需先有manifest。读取失败、JSON错误、未知字段或参数拒绝都会在身份有效时经过会话失败处理；已停止会话不会因为请求改正而继续。

## 请求示例

下面各对象是独立请求，示例ID替换为实际run。每个请求都只含一个动作，不接受批量动作、cmd、script或shell字段。

```json
{"action":"create_run","run_id":"run-example"}
```

```json
{"action":"plan_run","run_id":"run-example","stages":["analysis"]}
```

```json
{"action":"archive_input","run_id":"run-example","name":"requirements.md","source":"acceptance/requirements.md"}
```

```json
{"action":"run_status","run_id":"run-example"}
```

| 动作 | action之外的字段 |
| --- | --- |
| create_run | run_id |
| plan_run | run_id、stages数组 |
| archive_input | run_id、name，以及source或text二选一 |
| dispatch | run_id、stage、agent、skills数组；可选mode=prepare |
| complete | run_id、stage、dispatch_id、child_session、artifacts数组 |
| block / fail | run_id、stage、dispatch_id、reason |
| request_confirmation | run_id、stage |
| resolve_confirmation | run_id、stage、decision、reason |
| generate_analysis / validate_analysis / run_status | run_id |

stage、decision等仍受原合同检查，不能用不存在的dispatch_id收口，也不能凭用户“继续”自动批准。派发只记录受控事件，真正run_subagent仍由总控随后调用；子任务完成证据校验已覆盖新旧两个入口。

## 输入归档

source仅允许实际文件位于项目inputs或acceptance目录内，其他文件先由维护者明确准备到输入目录，避免默认读取任意本机文件。text保存明确给定的文字，不作需求分析；转达来源必须如实标明。name为简单文件名，目标固定为已存在run的inputs目录，拒绝路径穿越、目录链接及覆盖已存在文件。返回路径和SHA256，不自动登记已批准来源或正式专业产物。

归档在当前进程内执行，不调用cp、不执行shell；失败与其他动作一样使会话停止。源码路径通过真实路径校验，但任意文件写权限下不承诺抵御并发换链接等对抗行为。

## 返回与审计

脚本成功时业务结果放在data，原始命令日志和output_tail仍保留；若无法解析完整JSON，data为null并提示读取日志，不猜测、不自动再运行。归档返回result.path/sha256。每次结构化请求在output/action-audit/<session>保存独立回执，包括请求哈希、动作、时间、分类和命令日志位置；不复制请求正文或整份输入到审计。

分类包括input_rejected、session_stopped、session_running、script_failure及runner_error。script_failure只说明底层脚本非零退出，不代表产品缺陷，也不擅自推断业务失败原因。硬中断遗留started回执由摘要列为incomplete，不能当成功。

summary只读聚合当前会话闸门和动作回执：action_attempts是动作调用数，blocked_after_stop是停止后被拒绝的动作数，failures保留分类与证据。被拒绝的新动作不一定是同一业务任务的重试，因此不自动判断重试意图。user_summary明确声明不覆盖直接CLI/任意工具，零条拒绝不证明“没有重试”。原会话失败清单哈希不因新增动作回执变化；恢复仍按既有审查入口。

## 边界与验证

目录/catalog、summary是只读查询，不解除闸门。stopped时仅run_status、block/fail按既有诊断/收口规则处理；参数正确也不保证阶段允许收口。身份、审批、语义及工具权限边界沿用原设计。旧CLI保留给未覆盖脚本及维护者，新层不能禁止直接工具绕过，不修改PenguinHarness安装包。

本轮工程测试覆盖适配参数、真实CLI请求文件、合成运行创建/归档/规划/状态、错误JSON停机、跨调用拒绝、审计覆盖、输入越界/覆盖拒绝和无派发收口拒绝。全部使用合成父trace，不是PenguinHarness真实Agent复验。历史失败记录不迁移、不补造动作审计。

下一步待确认后进行新会话最小真实复验。本轮不自动解除15:43会话暂停，不执行完整业务测试、不恢复模型评测、不提交GitHub。

2026-10-09验证：106项Node工程测试及7项Python报告逻辑测试通过，新增7项结构化动作测试已纳入全量工程回归。七个角色公开指令同步后差异0，15:43失败清单和会话状态哈希未变。日志为本机output/structured-actions-regression.log；工程测试不能证明真实Agent已正确使用新入口。
