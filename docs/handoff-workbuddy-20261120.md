# WorkBuddy → Codex 交接文档：全流程闭环 P0→P7（2026-11-19 ~ 11-20）

> 交接人：WorkBuddy（GLM Agent）。本文档覆盖 **2026-11-19 17:07 起的 21 个提交**——即建设计划（`docs/全流程闭环现状与建设计划-20261119.md`，现已推进到 v19）里 P0 到 P7 第一切片的全部落地工作，外加 3 个同日上午的前置提交。
> 交接对象：codex，用于合并、推送、部署与后续整合。
> 逐切片的详细记录（问题、口径、验收、边界）见各提交附带的 `docs/p*.md`，本文只做索引。

---

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 分支 | `codex/remove-first-run-guide-20261118`（本地，**未推送、未设 upstream**） |
| 领先 origin/main | 24 个提交 |
| 提交归属边界 | `660c591`（11-19 上午，环境页派发探索入口）及更早已在 main；领先部分 = **3 个前置提交**（11-19 上午）+ **21 个本轮提交**（11-19 17:07 `44c9318` → 11-20 09:29 `1bc228a`） |
| 工作区 | 本轮 21 个提交**无未提交残留**；仅 2 个不属于本轮的改动文件（见 §6） |

3 个前置提交（一并随分支走，均为探索/qpm 线）：

| 提交 | 时间 | 内容 |
|---|---|---|
| `a5b4a8e` | 11-19 11:30 | fix(qpm): 探索弹窗输入框塌陷修复 |
| `4aea17f` | 11-19 14:41 | feat(qa): 派发探索弹窗回填上一轮目标页/登录页 |
| `573550d` | 11-19 15:56 | feat(qpm): 探索回写联动项目资料知识构建（B1） |

---

## 2. 本轮 21 个提交（P0 → P7 第一切片）

| # | 提交 | 时间 | 阶段 | 内容 | 触达面 |
|---|---|---|---|---|---|
| 1 | `44c9318` | 11-19 17:07 | P0+P1 | 工具台账 impl_path 与探索探针层 | 引擎+server+scripts |
| 2 | `41b7839` | 11-19 17:53 | P2 | 任务/运行承载对象、环境贯通、资源池租约表 | server |
| 3 | `2e0639c` | 11-19 18:09 | P3a | 环境基线校验与 diff（可比性判据） | 引擎+server |
| 4 | `503f39c` | 11-19 18:10 | P1 docs | 订正 P1 为实机验收完成 | docs |
| 5 | `ecfa96a` | 11-19 19:38 | P4-1 | 执行前置闸与 N 轮确定性重放 | 引擎 |
| 6 | `c8e9dc3` | 11-19 19:57 | P4-2 | Web 执行闭环 | 引擎 |
| 7 | `546aeda` | 11-19 20:24 | E2E-1 | 真实被测系统首次跑通（5 轮确定性 pass，零 LLM） | 引擎 |
| 8 | `65789b3` | 11-19 21:02 | P4-3 | 写库闭环与清理契约（创建→验证→注销，零残留） | 引擎 |
| 9 | `45258e5` | 11-19 21:34 | P4 chore | 隔离真机验收产物，防环境特例扩散 | 引擎 |
| 10 | `7c372a3` | 11-19 22:01 | P4-4 | 写操作授权卡点（判据 3 首次成立） | 引擎 |
| 11 | `5f9f94c` | 11-19 22:27 | P4-5 | 定位补「作用域+文本」一等表达 | 引擎 |
| 12 | `56876c8` | 11-19 22:44 | exec chore | 收口执行阶段既有工程改动（验证码闭环/阶段回执/**打包运行时**） | 引擎+server+core+scripts+skills |
| 13 | `e759529` | 11-19 22:50 | P4 | run 派发队列（被 #14 抵消） | 引擎+server |
| 14 | `7729f31` | 11-19 23:17 | P4 | **队列收回改执行登记**（产品里没有排队；#13+#14 净效果=执行登记） | 引擎+server |
| 15 | `d87f17e` | 11-19 23:57 | P5 | 能力出口与单一真源（ci:contract A1-A4/B1-B4 的来源） | 引擎+server+scripts+skills |
| 16 | `f45d8f5` | 11-20 00:09 | P6/G9 | 地图版本号——变了判得出来但不算环境坏 | 引擎+server |
| 17 | `e993dc9` | 11-20 07:31 | P6/G4 | 测试点 uid（哈希口径：需求引用+模块+标题+描述）+缺陷挂点+覆盖率三视角 | server |
| 18 | `0624c49` | 11-20 08:02 | P4-6 | 运行痕迹：trace 读模型 + `report_untraced` + 四场景前端原型 | server+docs+prototype |
| 19 | `e9f00a0` | 11-20 08:40 | P7/M4 | 失败三分归因（规则表 A1-A11 + 置信度矩阵 + 两道护栏） | 引擎+scripts |
| 20 | `4a2f54c` | 11-20 09:05 | P4-7 | 判据 3 收口：confirm 卡点 owner-only + 资源池租约强制点 | server |
| 21 | `1bc228a` | 11-20 09:29 | P4-8 | 发起方接线：`dispatch.json` + trace 带出「被发起过」 | server+scripts |

各切片详细记录（均随提交入库）：

`docs/p4-run-traceability-20261119.md`（切片 6）· `docs/p7-three-way-attribution-20261120.md`（P7）· `docs/p4-criterion3-closure-20261120.md`（切片 7）· `docs/p4-dispatch-initiation-20261120.md`（切片 8）· P5/P6 记录见对应提交正文与主计划 v14-v16。主计划版本表 v2→v19 与上述一一对应。

---

## 3. 部署指引

### 3.1 三个部署面

| 面 | 动作 | 说明 |
|---|---|---|
| **服务端**（`platform/packages/server` + `core`） | 构建并重启 | **schema 迁移随打开库自动执行**（`db/database.ts` 打开时 `migrate(db)`），P2/P6 的 4 个新迁移步骤（`2026-11-19-qa-task-run` / `qa-run-execution` / `maps-hash` / `point-uid`）无需手工跑。`release.mjs` 不校验迁移状态是流程缺口，不是本次阻塞 |
| **引擎运行时**（`aitestharness-tools` Python + `scripts/*.mjs` + `skills/`） | **重新打包运行时** | 打包链路 `56876c8` 已收口（`config/release-resources.json`），照该链路走。P3a/P4 全部执行侧改动、P6/G9 地图版本、P7 归因都在引擎包里 |
| **Web 前端**（`platform/packages/web`） | **不需要动** | 本轮 21 个提交一行没碰 web；UI 侧只有原型与文档（`prototype/run-trace-stalled-prototype.html` 等），待用户确认后才动真实前端 |

### 3.2 一个需要知晓的行为变化

`4a2f54c` 后，确认卡点的 **approve/reject 只允许项目 owner**（此前任何成员都能点）。错误码 `project_owner_required` 与报告发布同款，前端已有处理，无需改前端。验收时用成员账号确认一次「能 submit 送审、approve/reject 被拒、批次仍停 `reviewing`」。

### 3.3 部署后验收顺序（建议）

1. 起服务端，看迁移日志无报错；
2. 换引擎运行时；
3. 成员账号过确认卡点（§3.2）；
4. 跑一次执行，看 run 目录出现 `execution/dispatch.json`，且 `GET /api/projects/:projectId/agents/qa/task-records/:sessionId/runs/:runId/trace` 返回 `{registered, run, trace}`，`trace.dispatch` 有值；
5. 故意对「目录里只有 manifest、无执行痕迹」的 run 发结论为 passed 的报告，应被 400 `report_untraced` 拒。

### 3.4 预期行为（不是故障）

- 资源池闸已装但**暂无人经过**：`startRun` 目前没有调用方（派发未接线），线上不会立刻看到 409 `pool_full`——闸等接线后才开始拦人。
- P7 归因挂在已有 `defect.tools` 上（带 `exec_ir` 才启用），不带时输出与之前完全一致；**unknown 比例会比以前高**，这是有意拆掉「product 当默认值」的结果，unknown 长期过半该补的是 preflight/重放覆盖而不是放宽规则表。

---

## 4. 测试与门禁状态

| 门禁 | 结果 |
|---|---|
| server `tsc --noEmit` | 干净 |
| server 集成测试（需 `AITEST_ENGINE_ROOT=E:/AITestHarness/source`） | 相邻套件全绿：trace 13 + trace-route 1 + traceability 8 + run-execution 13 + registry 24 + pool-lease 2 + migration/u2/qa-integration 13 |
| 引擎冒烟（`aitestharness-tools/tests/`） | tools / authorization / baseline / maps / preflight_replay / web_engine / run_trace / **attribution(32 例)** 全 PASS |
| Node 验收 | `central-mcp.test.mjs` 9 例、`stage-tool-scenarios` 1 例 |
| `npm run ci:contract` | A1-A4（登记覆盖/路径/无影子/无漂移）+ B1-B4（契约⊆出口等）PASS |
| `node scripts/check-capability-source.mjs` / `check-tool-contract.mjs` | PASS |

注意：Windows 下 vitest `retry: 2` 会掩盖偶发失败，定位问题用 `--retry 0`。

---

## 5. 已知边界（不阻塞合并，后续要收）

1. **判据 1 登记缺口**：执行器启动前就断掉的运行进不了 `qa_runs`（dispatch 解决「可见」不解决「登记」）。要补可信登记入口是产品决策：谁调、何时调、如何防伪造。
2. **前端三处未做**：`stalled`/trace 展示（原型已出待确认）、`point_uid`/覆盖率新字段展示、跨 run 的健康聚合。按界面迭代铁律，**先原型确认再动真实前端**。
3. **结果写入不刷新 `started_at`**：发起时刻要到报告发布才补上，列表页晚一步正确。
4. **`DEFAULT_POOL_CAPACITY.web = 1`** 与 §6.3「Web 单机可多实例」矛盾，接派发时复核；长跑超 30 分钟 TTL 需心跳续租（续租=同 run 再调 `acquirePoolSlot`，暂无调用方）。
5. **P5 遗留三件**：agent `tools.mcpServers` 未加出口条目；渠道健康未接「起跑前降级」判定点；skill 正文未重排（只做了声明层）。
6. **P6/P7 遗留**：缺陷按 uid 反查；漏测/地图增量回流（缺数据源：`qa_exploration_hypotheses` 0 行）；剧本固化（依赖 M2b 视觉兜底，需 VL 渠道支持图片输入）；M3/M5 移动端 driver（需真机与微信开发者工具）；G5 人工成本度量（无人填耗时）。

---

## 6. 工作区遗留（合并时不要带上）

| 文件 | 状态 | 说明 |
|---|---|---|
| `platform/packages/server/src/services/project-service.ts` | 已修改，**未提交** | `sharedRolesReady` 简化为恒 `false`（agent 资源按"当前本机一个版本"管理，不再依赖发布目录/远端共享 agent 版本）；配套测试 `qa-shared-project-defaults.test.ts` 同步简化。改动方向已定但**未验证未提交**，属用户自己的在途工作 |
| `platform/packages/server/test/qa-shared-project-defaults.test.ts` | 同上 | 与上者一体 |
| untracked 若干 | 未跟踪 | `dump.rdb`、`*.tar.gz`、`qa-server-results*.json`、十余个一次性部署/探查脚本等——**本地运行产物，禁止 `git add -A`** |

---

## 7. 给 codex 的操作注意事项（踩坑实录）

1. **主计划文档是表格密集型**：`docs/全流程闭环现状与建设计划-20261119.md` 的切片行与版本表（v2→v19）每行都很长，Edit 工具按前缀替换时**容易把相邻两行并成一行**（本轮发生过两次）。改完后按行号逐行查行首，只看插入点附近不够。
2. **heredoc 里往 Python 传 `\\n` 会变成字面反斜杠+n**，插行不换行（本轮表格行被并成一行的根因之一）。往文档插行优先用 Edit 工具，脚本兜底时行尾换行要在 Python 里写成真实的 `"\n"`。
3. **测试夹具要跟真实产物对齐**：凡读 IR 字段的模块（归因、trace），至少一组用例要用真实引擎产出的 IR——手写夹具这次就漏了 `url_contains` 默认 `level=observe`（不写 `decide` 时 verdict 是 pass）。
4. **不为通过而放宽断言**：`report_untraced` 落地时暴露了旧夹具「报告说 failed、目录里只有 manifest 和手写截图」，正确做法是补执行痕迹夹具，不是放宽断言；同理删掉了两处「编时间」（`observeRun` 的 in_progress 回退、`settleRun` 的 COALESCE 回填）。
5. **中文引号别写进 JS/TS 字符串定界位置**（「」与 "" 混用会让 `it("...")` 直接语法错误）；Python 冒烟测试同理。
6. **集成测试路径**：trace 路由前缀是 `/api/projects/:projectId/agents/qa/task-records/:sessionId/runs/:runId/...`（是 `task-records` 不是 `tasks`）；项目 id 要过 `[A-Za-z0-9_-]+` 校验（用 `trace_route_owner-sandbox` 这类）。
