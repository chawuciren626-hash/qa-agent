# LLM 输出的回归基线（golden set，L-4）

## 它要回答的那句话

> 「你怎么证明上周那个 prompt 改动没让测试点质量下降？」

之前答不上来。`irval` 的 97 条用例保的是「IR 格式合法」，冒烟保的是确定性模块，**8 个 LLM 调用点等于没有测试**。改一次提示词，输出全变，没人知道变好还是变坏。

## 为什么不断言原文

用「输出完全相等」去断言 LLM，第一次跑就全红，然后所有人都会绕开它。所以只断言**结构特征**，六类，全部零 LLM 可判：

| 断言 | 例子 | 抓什么 |
|---|---|---|
| 结构合法 | `required: ["items"]` | 模型跑偏格式 |
| 条目数量区间 | 期望 10 → 接受 7~13 | 漏抽 / 幻觉膨胀 |
| 必含关键词 | `must_include: ["预算"]` | 抓错重点 |
| **不得含关键词** | `must_not_include: ["折扣"]` | **幻觉** |
| 引用完整性 | `source.quote` 能在原文里找到 | 编造原文位置 |
| 越权字段为零 | 不得出现 `verdict`/`approved_by` | 权限回归 |

引用比对走文本归一化（NFKC + 去空白 + 去标点），全角半角、标点差异不误判。**短于 4 字的引用跳过**——单字命中没有意义，只会制造假阳性。

## 两个不肯让步的设计

**一、没有基线时结论是 `no_baseline`，不是 `pass`。**
首次跑当然全绿，但那只是「记录了一次」，不是「质量通过」。叫它 pass，等于第一天就给自己发假合格证。

**二、退化按「错误率上升幅度」判，不按「某条挂了」。**
LLM 输出本来会抖；单条失败就拦，团队会习惯性重跑直到绿，门禁随即失效。判据是 `rate_now - rate_baseline > 5pp`。

## 目录与用法

```
tests/golden/
  index.json                  # 8 个 LLM 点的登记表（ready / pending）
  requirement_extract/
    samples.json              # 6 条样本（input + expect + recorded_output）
    baseline.json             # 基线（首次 --record 生成）
  testpoint_fill/
    ...
```

```bash
node scripts/golden-runner.mjs                    # 看点覆盖状态
node scripts/golden-runner.mjs --task=testpoint_fill
node scripts/golden-runner.mjs --all              # 跑所有 ready 点
node scripts/golden-runner.mjs --all --record     # 记录基线（人明确要求时才做）
```

## 覆盖现状（别把它当成已完成）

| 点 | 状态 | 样本 |
|---|---|---|
| `requirement_extract` 需求项抽取 | ready | 6 / 20 |
| `testpoint_fill` 测试点补齐 | ready | 6 / 20 |
| `analysis_clarify` 需求澄清 | pending | 0 / 20 |
| `case_step_fill` 步骤补全 | pending | 0 / 20 |
| `assertion_generate` 断言生成 | pending | 0 / 20 |
| `defect_attribution` 缺陷归因 | pending | 0 / 20 |
| `report_review` 报告审阅 | pending | 0 / 20 |
| `expected_suggest` 预期变更建议 | pending | 0 / 20 |

**pending 不等于已覆盖。** 剩下的点要接真实模型录制输出，沙箱里没有模型额度，不能假装跑过。

## 两个模式

| 模式 | 触发 | 用途 |
|---|---|---|
| `replay` | 默认，读 `sample.recorded_output` | 验证断言逻辑本身；框架能不能用不该取决于今天有没有额度 |
| `live` | 传 `produce(sample)` | 真实调用模型，比对基线判退化 |

CLI 目前只跑 `replay`。`live` 的入口留给编排层——它知道该用用户配置的哪档模型（§10.9）。

## 诚实边界

| 做得到 | 做不到 |
|---|---|
| 六类结构断言、错误率趋势、退化拦截 | 判断「这条测试点写得好不好」——那需要人 |
| 幻觉（输入里没有的内容）机械检出 | 语义等价（「满100减10」vs「消费百元立减十元」） |
| 引用可反查 | 引用是否**恰当**（引了原文但引错位置，只能靠人看） |

## 录制新样本（真实环境操作步骤）

> 2026-11-15 复核结论：沙箱内**不可录**。核查过 `output/runs/` 下全部 1616 个历史 run，
> 其产物（requirement-ledger / test_cases 等）全部标注 `synthetic engineering fixture, not real authorization`
> ——用合成数据录 golden 等于用假数据当基准，比保持 pending 更糟。此结论已回填 `tests/golden/index.json`。

在**有真实模型与真实任务**的环境里，每个 pending 点按以下步骤录制：

1. **选取真实输入**：从真实 run 里取该调用点的输入（如 `analysis_clarify` 取需求原文、
   `assertion_generate` 取确认过的 expected 与 observable）；
2. **真实产出一次**：让该调用点用生产配置的模型真实跑一遍，把原始输出存为 `recorded_output`；
   **不得手写或"照着期望编"**——录制的是事实基线，不是理想答案；
3. **填写 expect**：按六类断言给判据（`required` / `expected_count` / `must_include` /
   `must_not_include` / `check_citations`），数值区间固定 0.7~1.3 倍；
4. **跑 replay 验证**：`node scripts/golden-runner.mjs --task=<task> --all`，全部样本必须 pass
   才算录制成功——录完就红的样本说明 expect 与事实矛盾，先修 expect；
5. **登记**：更新 `tests/golden/index.json` 的 `status/samples`，并在样本文件顶部保留输入来源
   （run_id + 原文位置），保证可反查。

每点目标 20 条；不足 20 条时 index 里保持 `target: 20`，不虚报覆盖。
