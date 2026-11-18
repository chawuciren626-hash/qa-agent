# 批次 1F 真实验收旁证核查（2026-11-17 19:35–19:50）

> 撰写方：WorkBuddy。**这不是本批交付**，是执行方之外的第三方旁证：批次 1F 归 Qoder，本文件只记录"在对方工作副本里读到了什么"，供 Codex 判断 1F 的 DoD 是否达成。
> 核查方式：只读。未修改、未重跑、未清理对方的进程与产物。

## 1. 被核查对象

| 项 | 值 |
|---|---|
| 工作副本 | `E:\AITestHarness\collaboration\qoder-20261117`（**独立 clone**，与 `E:\AITestHarness\source` 不共享 `.git`） |
| 分支 | `qoder/batch-2u-20261117` |
| 最后提交 | `20bd3e0` 2026-11-17 19:19:31 `feat(execution): 验证码截图识别回传协议接入浏览器自动登录（批次 1F）` |
| 工作树 | 干净（无未提交改动） |
| 另两条提交 | `bbec531` 1F 打卡、`03392d3` 2U 主实现 |

## 2. 会话是否结束

**结论：Agent 已停，客户端未关。**

| 证据 | 时间 | 读数 |
|---|---|---|
| 最后一次写业务文件 | 19:28:34 | `output/runs/run-e8c7f00f…/execution/browser-network.jsonl` |
| 会话轮次缓冲最后写入 | 19:28:35 | `chat-session-turn-payload-buffer.sqlite`（此后未增长） |
| `qoder-agent-sdk.log` | 19:28 → 19:47 | 仅有每 60s 一次的 `get_models` / `list_byok_configs` 轮询，**无推理、无工具调用** |
| 仓库改动 | 19:28 之后 | 零 |

用户判断为"额度用尽停住"，与日志表现一致（只剩轮询，没报错也没新请求）。

## 3. 真实验收的两次 run

目标：`https://local.console.gov-bid.com/bbiao-admin/login`，`headless=true`，范围声明为"仅验证截图识别回传协议代替人工识别自动填写，不测业务"。

| # | run | 时间 | 结果 |
|---|---|---|---|
| 1 | `run-5ad6b181-a9bc-4f58-8e72-72b01339cdfb` | 19:20 | `status=failed`，`exit_code=1`，`stage=execution` |
| 2 | `run-e8c7f00f-c712-4d35-b660-7c65621fdc2a` | 19:27–19:28 | `status=login_outcome_unknown`（进程 exit 0，**业务结论未知**） |

run 2 的三段相位（`output/real-acceptance/r4-login-out.json`、`r4-rec-out.json`）：

| 相位 | 结果 |
|---|---|
| classification | `is_login=true`，`captcha_type=image`，`basis=project_config_declared`，**`dom_captcha_type=sms`** |
| recognition（本地三路） | `test_bypass_code` 未配置 → 拒；`local_arithmetic_recognition` `no_recognizable_arithmetic_expression` → 拒；`captcha_service` 未配置 → 拒 |
| recognition（agent_vision 回传） | `answer="7"`，`confidence=0.95`，`accepted=true`，指纹 `6f1387e2…` 对齐 |
| submission | `attempts[0].outcome = unknown` |
| next_action | `inspect_snapshot_no_replay_of_uncertain_login` |
| 网络 | `blocked_requests=0`，记录事件 101 条 |

## 4. 对 1F DoD 的判断

手册 1F 的完成条件要求"**真实 gatewayadmin 场景有产品 run 回执**"，且"低置信度和未知提交结果不盲重试"。

- "不盲重试"这一条**做到了**：结论是 unknown 时明确要求 `inspect_snapshot_no_replay`，没有二次提交；
- "真实场景 run 回执"这一条**未达成**：两次尝试，一次进程失败、一次业务结论未知，**没有任何一次成功登录的回执**。

因此 1F 目前的状态应记为：**工程部分已提交，真实场景验收未通过（结论 unknown），待重跑**。不应写成已交付。

## 5. 已查明的三件事（含对上一版推测的更正）

### 5.1 `dom_captcha_type=sms` 是 DOM 分类器误判，配置声明是对的

同一 URL（`https://local.console.gov-bid.com/bbiao-admin/login`）在 19:20 那次的整页快照 `output/runs/run-5ad6b181…/execution/browser-evidence/r3-snap.png` 显示：

- 页面标题「GOV个人中心管理端」，默认是**账号密码登录**；
- 验证码区是一张**算术图形码**：`7 + 9 = ?`，旁边带刷新图标；
- 页面底部有两个 tab：**「账号密码登录」/「手机短信登录」**。

所以 `login-config.json` 里声明的 `captcha_image_target: form img` 与真实页面一致；`dom_captcha_type=sms` 的根因基本可以定位为**把底部「手机短信登录」tab 当成了验证码形态**。修的是 DOM 判定，不是配置。

> 上一版文档把"配置写错"也列为可能，这里更正：配置没错。

### 5.2 算术码下"本地算术识别"没命中，需要单独查

`local_arithmetic_recognition` 报 `no_recognizable_arithmetic_expression`。但页面上的验证码**就是**一个算术式（`7 + 9 = ?`）——这正是该策略声称支持的形态。说明它读的多半不是这张图（例如去读 DOM 文本或读错了元素），而不是"本地不支持"。这条不查清，1F 的"本地能力"结论是站不住的。

### 5.3 那次 0.95 置信度的答案没有可复核的证据

`r4-login-out.json` / `browser-evidence/r4-login.json` 都声称截图在 `execution/browser-captcha-r4-login.png`，但该 run 的 `execution/` 目录下**没有任何 png**（只有 `browser-network.json(.jsonl)`、`browser-progress.json`、`browser-state.json`），`browser-evidence/` 也只有 `r4-start.json`、`r4-login.json`、`r4-rec.json`。

也就是说：协议要求"读受保护的验证码图再回传"，实际**没有留下可审计的图**，却接受了一个 `confidence=0.95` 的答案 `"7"`。结合 19:20 那次的表达式是 `7+9=?`，`7` 恰好是左操作数——这**不能直接判为错答案**（每次加载随机），但没有截图就无法证明它对。这是 1F 自身的证据链缺口，不只是"结果 unknown"。

## 6. 遗留进程（未处置）

`PID 27832`：`node scripts/browser-task.mjs --worker run-e8c7f00f…`，19:27:29 启动，子 Chrome 树 8 个进程；采样 5 秒 CPU 增量 0，控制器 `state.json` 为 `ready`。属"等命令的常驻 worker"，不是卡死；但它占着无头浏览器与会话 token。本次核查未清理，需由用户或 Qoder 决定回收。

## 7. 复核入口

```
output/real-acceptance/r4-start-out.json        启动回执（含 scope 声明）
output/real-acceptance/r4-login-out.json        相位 1/2 + 本地三路策略拒绝原因
output/real-acceptance/r4-rec-out.json          回传识别 + 提交 unknown
output/runs/run-e8c7f00f…/execution/            截图、网络、会话证据
output/controller-command-sessions/<session>/state.json   会话状态与 owner
output/runs/run-5ad6b181…/execution/browser-evidence/r3-snap.png   同 URL 的整页快照（算术码形态的实物证据）
```
