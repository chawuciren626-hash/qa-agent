# P5 配置生效（管理端闭环）— 落地记录 2026-11-19

> 对应计划 §8.1 的 P5 行与 §8.3 的三条 CI。四件事：**M1 能力出口 / R4 单一真源 / M6 skill 三类分离 / 6.2 渠道自检**。

## 0. 一句话

这轮之前，能力声明有四份：`central_tools` 台账 33 条（管理端能看能停）、`TASK_CONTRACTS.tools` 写的函数名、`STAGE_TOOLS` 注册表 10 条（真正能调）、skill 正文里散落的工具名。**四份各说一遍，谁也不会因为不一致而报错**——最贵的错误是 12 条契约声明里只有 4 条能对上真实入口，其余 8 条在 prompt 里只是噪声（`defect.tools.dedup_fingerprint` 这个函数在代码里根本不存在）。

这轮把它们收成一条链：`TASK_CONTRACTS.tools`（声明）→ `STAGE_TOOLS`（注册表，唯一真源）→ MCP `tools/list`（出口）→ skill `tools`（使用方），并在 CI 里逐段断言。

## 1. M1：能力出口（`scripts/central-mcp.mjs`）

MCP stdio 服务，把 10 个确定性阶段工具暴露给 agent。

| 决定 | 取这个的原因 | 代价 |
|---|---|---|
| stdio，不新起 HTTP 服务 | core 的 `McpToolProvider` 本来就支持 stdio；工具全是本机确定性脚本，没有跨机需求。多一个端口＝多一份部署/鉴权/生命周期 | 由父进程拉起，生命周期绑在会话上 |
| 手写 JSON-RPC，不引 SDK | `@modelcontextprotocol/server` 只在 core 的 devDependencies，没进发布资源清单；为 10 个工具改发布链与四个打包脚本，成本高于 60 行分派 | 新协议版本（sampling/elicitation）要手工跟进——届时必须换 SDK |
| 工具名用下划线（`irval_check`） | core 的 `LLM_TOOL_NAME_PATTERN` 是 `[a-zA-Z0-9_-]{1,128}`，点号名会被 **warn-and-skip**，出口等于空壳，而且只在 stderr 说一句 | 与 tool_id（`irval.check`）是两个名字；映射只允许存在于 `mcpToolName` 一处，契约与 CI 都引它 |
| 调用转发 `run_stage_tool`，不起第二条执行路径 | 身份校验、工具闸门、用量与阶段回执都在那一条路上。MCP 只是传输形态，不是新的权限通道 | 需要注入 `AITEST_RUN_ID` / `AITEST_CONTROLLER_SESSION` |
| 缺上下文时"能列不能调"，并当场说出来 | Inspector 调试需要看契约；但如果默默能列，就会有人以为配好了 | 列表里每个工具的 description 都标注未绑定原因 |

三个细节钉死：`stdout` 只走协议（`console.log` 被重定向到 stderr——下游任何一行打印都会把协议行截成两截，客户端表现为"连接断了"）；停用工具在协议层就返回 `isError`（不是"列出来再拒"）；`stage` 从 manifest 的 `in_progress` 自动解析（0 个=还没开始，多个=归属不明要显式传，两句文案分开）。

验收：`tests/acceptance/central-mcp.test.mjs` 9 例，用**官方 SDK 客户端**（与 Inspector、`McpToolProvider` 同一个包）实连，含"点号名会被跳过"和"停用即拒"的阴性对照。

## 2. R4：单一真源三条 CI

`scripts/check-capability-source.mjs`，接进 `npm run ci:contract`（原来只有 A 系列 + 发布链）。

| 断言 | 内容 | 挡的是 |
|---|---|---|
| **B1 契约 ⊆ 出口** | `TASK_CONTRACTS[task].tools` 每一项都在 MCP `tools/list`；同时要求 `stage`、`budget_tokens`、`on_exceed` 非空 | 契约承诺了但运行时没暴露 |
| **B2 skill ⊆ 契约** | 声明了 tools 就必须声明 task，且 tools ⊆ 契约 tools、stage 一致；`task: none` 必须配 `deterministic: true` 且 tools ⊆ 全局出口 | skill 私自扩权；"不绑定契约"当逃逸口 |
| **B3 正文 ⊆ 声明** | SKILL.md 正文提到的 tool_id 必须 ⊆ 它自己 frontmatter 的 tools | 文档教 agent 用声明外的工具 |
| **B4 三类分离** | 每个 `##`/`###` 标题都在 frontmatter `sections`（判据/知识/执行步骤）里归类，且 sections 没有幽灵标题 | 新加一节没人定性，慢慢长成第二套真源 |

第三条 CI（`central_tools.impl_path` 指向的文件存在）由 A2 覆盖，未重复实现。

**阴性对照**（不做这一步，闸等于没装）：契约加一个 `requirement.nonexistent` → B1 红；skill tools 加一个 `report.reviewer` → B2 红；恢复后 PASS。

### 契约里改了什么

`TASK_CONTRACTS.tools` 从 Python 函数名改成 **tool_id**（`requirement.testability.check_testability` → `requirement.testability`）。理由：agent 唯一入口是 `run_stage_tool` 的 tool_id，写函数名的下游一个也调不通。12 条声明收敛为 5 份契约共 15 条，全部 ⊆ 10 个出口工具；每个契约补 `stage` 与 `budget_tokens`/`on_exceed`。

被删掉的 8 条（`testpoint.matrix.*`、`case.builder.*`、`assets.*`、`regression.selector.suspicious_signals`、`regression.plan_regression.*`、`defect.tools.dedup_fingerprint`）**不是能力丢失**：它们是程序内部函数或由 `testpoint.coverage`／`defect.tools`／`regression.impact` 覆盖，agent 从来没有调到过它们。

## 3. M6：skill 三类分离（声明层，未重排正文）

15 个 SKILL.md 的 frontmatter 增 `sections: {criteria, knowledge, steps}`，把每个现有小节归到一类；有工具的 6 个另加 `task`/`stage`/`tools`。

**取舍**：没有把正文重排成三个顶级章节。原因是 15 个文件的小节结构差异很大（`android-execution` 是操作手册，只有"核心原则"一处判据；`requirement-analysis` 的判据藏在 `生命周期模式` 下的三级标题里），强行重排等于重写 15 份 prompt，风险远高于收益，而且改坏的地方不会被任何断言抓到。改成"声明 + CI 双向校验"后，**新加小节不归类就红**——这是"分离"能被守住的最小机制。

## 4. 6.2：渠道自检与成本声明

两半：

- **健康状态持久化**（`services/channel-health.ts`）：管理端 `/detect`、`/test` 的结论写入 `<engine root>/output/runtime/channel-health.json`，与 `tool-usage.jsonl` 同目录；`GET /models/health` 读回。此前结论只活在页面内存，刷新即失忆，运行期也无从得知。无 engine root 时返回 `{enforced:false, reason:"engine_root_unset"}` 且**不写文件**（写到猜的路径等于没人读）。
- **成本声明**：5 份契约各写 `budget_tokens`（8000–16000）与 `on_exceed`（全部 `degrade`，程序兜底而不是中止整条任务），`dispatch()` 返回这两个值。CI 断言非空——不写就等于"超了随便"。

## 5. 顺手修掉的回归（都在 P4 第四切片之后失效）

| 用例 | 症状 | 修法 |
|---|---|---|
| `test_api_engine_live` | 计划含 POST，被授权闸判 `invalid`，期望 pass | 用 `build_approval` 真实签发；**不是关闸** |
| `test_version_stamp_247` | 同上 | 同上 |
| `test_login_126` | 期望 `manual_required`，实得 `recognition_failed` | 状态收敛：`recognition_failed` 没有任何消费方（browser-task 用 `captcha_unresolved`），上层只认 ok/manual_required，等于"识别失败被当未知结果丢掉"；收敛回 `manual_required` 并保留 `auto_recognition_failed: true` |

顺带补上 `api_engine.run_plan` 便捷入口的 `authorization`/`env_id` 透传：**唯一能跑的入口没有开口，调用方只能去掉闸**——这不是"实现了绕过"，是"逼人绕过"。

## 6. 验收

```
node scripts/check-capability-source.mjs   PASS  B1/B2/B3/B4（阳性 + 两项阴性对照）
npm run ci:contract                        PASS  A1-A4 / B1-B4 / release 一致
node --test tests/acceptance/central-mcp.test.mjs   9 pass（真 SDK 客户端）
vitest: channel-health 6 + qa-run-execution 13 + registry 23 = 42 pass
python: smoke_tools / smoke_web_engine / smoke_authorization /
        smoke_preflight_replay / smoke_run_trace / smoke_probe / smoke_baseline   ALL PASS
tsc --noEmit（server）                      干净
```

## 7. 未做（明确留下，不假装完成）

1. **agent 装配未接线**：出口进程能被客户端连上，但 agent 的 `tools.mcpServers` 里还没有这一条。装配属管理端资源（服务端只维护一套 agent、管理员后台维护），代码里写默认值等于绕过那条产品决定；需要管理员在 agent 配置里加一条（`command: node`、`args: ["scripts/central-mcp.mjs"]`，env 由运行时注入 run/session）。
2. **健康状态尚未在运行前拦截**：`/models/health` 能读，阶段 agent 起跑前还没有"渠道 down 就显式降级"的判定点。判定点要落在 session 创建处（core），与判据 1 的接线同一片区域，按用户要求先停在那里。
3. **skill 正文未重排**（见 §3）。
4. `stalled` 前端展示仍缺（P4 遗留）。
