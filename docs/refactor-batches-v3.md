# v3 重构落地批次计划

> 依据：《AITestHarness 测试平台架构重构方案 v3》§18 实施路线图、§25.5 落地清单、§25.2 P1 项。
> 原则：每批次自带验收，**上一批不过不进下一批**；每批都要能指着某个东西说「这个以前是空的」。

## 一、起点盘点（2026-11-15 核过，不是抄文档）

| 项 | 现状 | 判定 |
|---|---|---|
| L-1 `expected` 收权 + 待审队列 | `scripts/expectation-audit.mjs` + `tests/acceptance/expected-provenance.test.mjs` | ✅ 已落 |
| L-2 `invalidate` 子集 / `partially_stale` | `scripts/artifact-scope.mjs` | ✅ 已落 |
| L-3 预期溯源 R1~R5 | `scripts/expected-source.mjs` + `execution-verdict.mjs` | ✅ 已落 |
| L-6 采样分层 | `scripts/regression-sampling.mjs` | ✅ 已落 |
| L-7 `submit` 部分成功 | `scripts/partial-submit.mjs` | ✅ 已落 |
| L-11 多模块状态机 | `scripts/artifact-scope.mjs`（scope + depends_on） | ✅ 已落 |
| 工具运行面闸门 | `scripts/tool-gate.mjs` + 后台 `central-tools` | ✅ 已落（线上验过） |
| L-10 全链路 trace | `scripts/trace.mjs` + jsonschema 过滤 CLI | ✅ 已落（B1） |
| L-9 缺陷根因聚类 | `scripts/defect-cluster.mjs` | ✅ 已落（B2） |
| L-8 需求完备性检查 | `scripts/requirement-completeness.mjs` | ✅ 已落（B3） |
| L-5 发版探针 | `scripts/release-probe.mjs` | ✅ 已落（B4） |
| L-4 golden set | `scripts/golden-runner.mjs` + `tests/golden/`（8 点 / 12 样本） | ✅ 已落（B5） |
| P1-5 stub 声明 | `scripts/execution-stub.mjs` + `execution-summary` 接入 | ✅ 已落（B6） |
| P2-3 CI + JUnit | `scripts/ci-run.mjs --suite=smoke --junit` | ✅ 已落（B7） |
| P2-4 覆盖度「已执行/仅分配」拆分 | `scripts/coverage-split.mjs`，两口径并排 | ✅ 已落（B8） |
| 软依赖 `tool_degraded` 进报告 | `scripts/report-runtime-sections.mjs` → `reportFactBody` 的「运行时事实」段 | ✅ 已落（B8） |

## 二、批次表

| 批次 | 主题 | 对应 | 交付物 | 验收（自检口径） | 状态 |
|---|---|---|---|---|---|
| **B1** | 全链路 trace | L-10 / P1-3 | `scripts/trace.mjs` + `executeAction` 接入 + CLI 回放 | 每个 action 一条 trace；凭据不入盘；可按 run/action/成败过滤；`--json` 可机读 | ✅ |
| **B2** | 缺陷根因聚类 | L-9 / P1-4 | `scripts/defect-cluster.mjs` | 40 条同类失败聚成 1 组、**缺陷单数不变**（只改展示分组）；无堆栈时不硬聚 | ✅ |
| **B3** | 需求完备性检查 | L-8 / 元问题一 | `scripts/requirement-completeness.mjs` | 5 项检查表零 LLM 可判；输出 `score` + `missing[]`；无可判输入时报 `available=false`（不得给 0 分） | ✅ |
| **B4** | 发版探针 | L-5 / P1-7 | `scripts/release-probe.mjs` | 构建号/资源 hash 变才触发；探针失败率 >20% → `blocked=true` 且不出全量报告 | ✅ |
| **B5** | golden set 框架 | L-4 / P1-2 | `scripts/golden-runner.mjs` + `tests/golden/` | 六类断言可判；无 baseline 时明确 `no_baseline` 而不是假绿；样例点跑通 | ✅ |
| **B6** | stub 声明 | P1-5 / M2 | plan 增 `stub`；外部不可用 → 该步 `inconclusive` | 有 stub 声明的步骤失败不得产 `fail`；无声明仍为 `fail` | ✅ |
| **B7** | CI 接入 + JUnit | P2-3 | `scripts/ci-run.mjs` | `--suite smoke --junit` 产合法 XML；失败退出码非 0 | ✅ |
| **B8** | 覆盖度拆分 + 降级进报告 | P2-4 + 上轮遗留 | 覆盖度「已执行/仅分配」；报告消费 `tool_degraded` | 报表不再把「仅分配」算成已覆盖；报告里能看到「哪条纪律没生效」 | ✅ |
| **B9** | M1 一致性验收报告 | §18.2 四条 | `scripts/consistency-report.mjs` | N=3 同用例结果一致率可算；取证包可定位失败；口径写在报告里 | ✅ |
| **B10** | IR 契约升 v1.1 + S 层规则 | §25.6 / P0-1 | 契约文档 v1→v1.1；`irval` 加 V-39/V-40 | 消除「两套契约」；未确认预期不得产 pass；漂移可检出 | ✅ |
| **B11** | 测试数据生命周期 | P1-6 | `scripts/data-lifecycle.mjs`；报告「运行时事实」第 6 段 | data_residue 清理失败正面进报告；无 teardown 只许只读；persistent 不许用例级增删改 | ✅ |
| **B12** | 确认卡点三件套 | P2-2 | `scripts/confirm-gate.mjs` | diff/sample/risk 三层可算；抽样可复现；反绕过核对缺口退出码 1 | ✅ |

依赖：B8 依赖 B2/B3 的输出字段；B9 依赖 B1（trace）+ B8。B10（契约）/B11（数据）/B12（确认）为计划外追加批，响应「还剩多少没做」核查结果，对应 v3 §26 剩余评审遗留。

## 三、不在本批范围（写明，防止被当成漏做）

| 项 | 为什么不做 |
|---|---|
| 四类 Driver Adapter 真实采集（Playwright/Appium/小程序宿主运行时） | 需要真机/真浏览器环境，沙箱只能验证规则层。§11.9 已标 🔜 M2 |
| 探索器运行时 | 同上，需真实站点 |
| 种子缺陷集（§19.2 植入 20~30 个缺陷） | 需要可控被测系统，人工工作，与代码并行但不在本仓 |
| `harness run --suite` 的完整 CLI（一条命令跑完全链） | B7 只做 CI 入口与 JUnit 输出，不做产品化 CLI |

## 四、执行记录

| 批次 | 完成时间 | 新增/改动 | 自检结果 |
|---|---|---|---|
| B1 | 2026-11-15 | `scripts/trace.mjs`(新)、`scripts/structured-actions.mjs`(入口+finally 接入)、`scripts/requirement-completeness.mjs`调用方挂接、`tests/acceptance/trace.test.mjs`(新)、`docs/runtime-trace.md`(新) | trace 12/12 通过 |
| B2 | 2026-11-15 | `scripts/defect-cluster.mjs`(新)、`tests/acceptance/defect-cluster.test.mjs`(新)、`docs/defect-root-cause-cluster.md`(新) | defect-cluster 12/12 通过；`merge_safety: display_only` 保证缺陷单数不变 |
| B3 | 2026-11-15 | `scripts/requirement-completeness.mjs`(新)、`tests/acceptance/requirement-completeness.test.mjs`(新)、`docs/requirement-completeness.md`(新) | requirement-completeness 18/18 通过；unknown 不进分母，全 unknown 时 score=null |
| B4 | 2026-11-15 | `scripts/release-probe.mjs`(新)、`tests/acceptance/release-probe.test.mjs`(新)、`docs/release-probe.md`(新) | release-probe 19/19 通过；整数比较避浮点误差 |
| B5 | 2026-11-15 | `scripts/golden-runner.mjs`(新)、`tests/golden/`(8 点 12 样本)、`tests/acceptance/golden-runner.test.mjs`(新)、`docs/golden-set.md`(新) | golden-runner 20/20 通过 |
| B6 | 2026-11-15 | `scripts/execution-stub.mjs`(新)、`scripts/execution-summary.mjs`(接入 stubs)、`tests/acceptance/execution-stub.test.mjs`(新)、`docs/execution-stub.md`(新) | execution-stub 12/12 通过；未声明 stubs 时行为与原来逐字节一致 |
| B7 | 2026-11-15 | `scripts/ci-run.mjs`(新)、`scripts/run-engineering-tests.mjs`(修 tests/golden 漏复制)、`tests/acceptance/ci-run.test.mjs`(新)、`docs/ci-integration.md`(新) | ci-run 7/7 通过；`--suite=smoke` 178 tests/0 failures，JUnit XML 经 xml.etree 校验 |
| B8 | 2026-11-15 | `scripts/coverage-split.mjs`(新)、`scripts/report-runtime-sections.mjs`(新)、`scripts/report-fact-body.mjs`(加 runtime 段)、`scripts/draft-artifact-actions.mjs`(接入)、`scripts/tool-gate.mjs`(软依赖)、`tests/acceptance/coverage-split.test.mjs`+`report-runtime-sections.test.mjs`(新)、`docs/coverage-truthfulness.md`(新) | coverage-split 9/9、report-runtime-sections 8/8、tool-gate 18/18 通过 |
| B9 | 2026-11-15 | `scripts/consistency-report.mjs`(新)、`scripts/api-worker.mjs`(case 级 duration_ms 汇总)、`scripts/ci-run.mjs`(加入 smoke)、`tests/acceptance/consistency-report.test.mjs`(新)、`docs/m1-consistency-acceptance.md`(新) | consistency-report 23/23 通过；真实 run 产出 `not_ready`，未编造通过 |
| B10 | 2026-11-15 | `AITestHarness-IR契约规范-v1.md`（v1→v1.1，附录 C 变更记录）、`aitestharness-ir/irval/`（enums/schema_rules/semantic_rules/xref_rules/errors，V-39/V-40）、`fixtures/`(2 新)、`suite/cases.py`(10 用例) | irval 114/114 通过；V-39 拦「未确认预期产 pass」，V-40 拦「漂移未标注」 |
| B11 | 2026-11-15 | `scripts/data-lifecycle.mjs`(新)、`scripts/report-runtime-sections.mjs`(第 6 段)、`tests/acceptance/data-lifecycle.test.mjs`(新)、`docs/data-lifecycle.md`(新)、`package.json` | data-lifecycle 22/22 通过；孤儿清理结果不静默；CI smoke 223/0 |
| B12 | 2026-11-15 | `scripts/confirm-gate.mjs`(新)、`tests/acceptance/confirm-gate.test.mjs`(新)、`docs/confirm-gate.md`(新)、`package.json` | confirm-gate 19/19 通过；40 条样本 diff 模式必审 40→10 条；抽样确定性可复现 |
