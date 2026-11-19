# P4 第一切片验收记录：基线前置闸 + 确定性重放

> 日期：2026-11-19
> 范围：P4「端到端验收 E2E-1」的**第一切片**。**P4 未完成**，本文只记录已成立的子集与暴露出的阻塞项。
> 上游：`docs/全流程闭环现状与建设计划-20261119.md` §8.1 P4 行、§8.2 四条判据。

---

## 1. 这一片做了什么

| 交付 | 文件 | 解决的问题 |
|---|---|---|
| 执行前置闸 | `aitestharness_tools/exec/preflight.py` | P3a 的基线只"事后能看"，执行照跑。现在它站在执行**之前**：blocking 漂移拒绝开跑，warning/首次运行放行但降级 |
| 恢复自验壳 | 同上 `verify_restored()` | P3b-1 的本仓库部分：恢复是否成功**不能被测系统自报**，用同一套指纹反验 |
| N 轮确定性重放 | `aitestharness_tools/exec/replay.py` | 3 条剧本 × 5 轮，判定结论可复现；分歧定位到计划/步骤/断言 |
| 固定数据靶子 | `tests/mock_service.py` | 确定性优先的 mock：固定 token、固定订单号、固定金额 |
| 3 条剧本 | `tests/fixtures/replay/plan-0{1,2,3}.yaml` | 正向登录、负向越权、跨步骤传值 |
| 测试 | `tests/smoke_preflight_replay.py` | 23 例 |

### 顺手补的两处「文档承诺、代码没有」

1. **`api_engine` 的 `session` 段**：模块 docstring 写着"通过 session 段先执行登录并把响应 token 写入变量"，代码里完全没有实现，`plan["session"]` 会被静默忽略。已补。
2. **跨步骤变量**：`extract` 声明与 `${data.x}` 在 request 路径上的解析都不存在。没有它们就写不出"登录 → 带 token 下单 → 按下单返回的 id 查详情"这种最基本的真实剧本。已补。

> 这两处与 P0 修的 14 处路径漂移是**同一类问题**：描述先行、实现未跟上。P0 的 `check-tool-contract` 只覆盖 `central_tools` 的描述，管不到模块内 docstring。

---

## 2. 实测数据

环境：内置 Python（`E:/AITestHarness/installed/runtime/tools/python/python.exe`）+ 本地 mock 靶子。

```
RUN-A（首轮，无参考基线）
  deterministic = True   degraded = manual   first_round = baseline_missing
  5 轮 × 3 剧本 = 15 次执行，结论全 pass

RUN-B（新 run 目录，共享同一环境基线）
  deterministic = True   degraded = None     status = comparable   prechecked = True
  每轮耗时 19-20ms
  content_stable = True
  llm = {calls: 0, sdk_present: [], loaded_during: [], guard: "pass"}

产物：
  output/environments/p4-mock/baseline.json     ← 环境级参考基线（跨 run）
  output/runs/replay-p4-a-20261119/{baseline.json, replay.json}
  output/runs/replay-p4-b-20261119/{baseline.json, replay.json}
```

回归：`smoke_baseline` 26 例、`smoke_probe` 11 例、`smoke_round4`、`smoke_preflight_replay` 23 例全过；`ci:contract` PASS（33 工具登记齐）。

### 两个非本切片引入的失败（如实记录）

| 测试 | 原因 | 归属 |
|---|---|---|
| `smoke_tools.test_bootstrap_1010` | 在 HEAD 干净副本上同样失败（已用 worktree 对照） | **既有失败**，非本次引入 |
| `smoke_tools.test_login_126` | 并行改动把 `image` 验证码的 `manual` 分支改成 `agent_vision`，测试断言未同步 | codex 的改动，需其同步测试 |

> `smoke_tools` 此前在运行时 Python 里**根本跑不起来**（缺 `requests`），所以这套测试的失败长期不可见。本次为跑 P4 重放装了 `requests 2.34.2`，它才第一次浮出来。

---

## 3. E2E-1 四条判据的实际覆盖

| 判据 | 状态 | 说明 |
|---|---|---|
| 1 贯通性（`qa_tasks`/`qa_runs` 记录完整，run_id 追到报告） | **未覆盖** | 本切片在 Python 侧跑，未接 server 派发链，未走产品界面 |
| 2 确定性（3 剧本连跑 5 次一致、VLM=0） | **部分成立** | 一致性成立、VLM 守卫成立；但剧本是 **API** 不是 Web，靶子是 mock 不是真实环境 |
| 3 卡点有效性（①②③ confirm 真实阻断 + 确认人受权限校验） | **未覆盖** | 属 server 侧，且依赖 P2 未做的权限强制 |
| 4 可解释（5 分钟内定位阶段与原因） | **部分成立** | 分歧能定位到 plan/step/assertion 并给出两轮 actual；"5 分钟"未实测 |

**结论：P4 不能标完成。** 已成立的是 §8.2 判据 2 的 M2.5 子集 + 基线前置，这是 P4 的地基，不是 P4 本身。

---

## 4. 本片暴露的三个问题

### 4.1 基线的作用域错了（已修）

P3a 把基线写进 `output/runs/<id>/baseline.json`。接前置闸时立刻暴露：**每个 run 都是新目录，下一个 run 读不到上一个——每次都判"首次运行"，闸装上了却永远在放行。**

已修：拆成两层，`preflight(reference_dir=...)` 读环境级基线，`run_dir` 只存本次采集证据。

```
output/environments/<env>/baseline.json   参考基线（跨 run 共享，判据）
output/runs/<id>/baseline.json            采集证据（单次 run，留痕）
```

这与 P2 的"源事实原则"是同一个道理：`qa_runs` 是 manifest 的索引，不是第二真源。基线也不能既当判据又当证据。

### 4.2 `_consistency` 的一致性复跑不区分幂等性（未修，需决策）

`ApiEngine._consistency` 对所有 plan 的第一个 decide 步骤复跑 N-1 次来判 flaky。若该步骤是 `POST /api/orders`，复跑等于**重复创建订单**。mock 靶子固定 id 所以无害，真实环境会造脏数据，而且脏数据会污染下一轮的基线比对。

修法二选一：计划里显式声明 `idempotent: true` 才允许复跑；或把一致性复跑移到"只读步骤"上。**这是设计决策，不是 bug 修复，需确认后改。**

### 4.3 Web driver 仍是空的（P4 的最大阻塞）

`fixtures/plan.valid.yaml` 是 Web 剧本（`goto`/`fill`/`click`），但**没有任何 Web 执行器**——Playwright 目前只在 `probe/` 里被用来"取原料"，不负责重放。

所以本切片只能拿 API 剧本验收。E2E-1 要求"从新建任务到出报告、全程产品界面"，Web driver 不补，判据 1、3 无法成立。

---

## 5. 下一步（按依赖排序）

1. **Web driver 最小闭环**：`goto`/`fill`/`click`/`wait` + `wait_assert` 已有枚举，接 `probe` 的定位器解析 → 让 Web 剧本可重放；
2. **`_consistency` 幂等性决策**（4.2）；
3. **server 侧接线**：`qa_runs` 落 `baseline_hash`（P3a 已留字段）+ replay 结果回写，判据 1 才可测；
4. 判据 3 依赖 P2 的 confirm 权限强制。
