# CI 接入与 JUnit 输出（P2-3）

## 为什么是 JUnit

企业采购第一问通常是「能不能接我们的流水线」。答不上来的原因不是没有接口，而是**没有标准输出**：没有 JUnit XML，CI 里只剩一个退出码，看不到「哪条用例挂了」。

## 用法

```bash
node scripts/ci-run.mjs --suite=smoke
# → output/ci/junit-smoke.xml  +  控制台摘要
```

```json
{ "status": "passed", "tests": 178, "failures": 0, "elapsed_ms": 4510,
  "junit": "/workspace/qa/output/ci/junit-smoke.xml" }
```

GitLab / GitHub Actions / Jenkins 都能直接吃这个文件。

## `smoke` 套件是什么，不是什么

**是**：本仓的工程冒烟集——13 个测试文件，178 条用例，4.5 秒。改坏了这里说明主干断了：

| 覆盖 | 文件 |
|---|---|
| 工具闸门 | `tool-gate.test.mjs` |
| 调用轨迹 | `trace.test.mjs` |
| 结论合成（预期上限 / 外部依赖） | `execution-verdict` / `execution-stub` |
| 产物契约与预期溯源 | `artifact-contracts` / `expected-provenance` |
| 部分成功 / 采样分层 | `partial-submit` / `regression-sampling` |
| 新增能力 | `defect-cluster` / `requirement-completeness` / `release-probe` / `golden-runner` / `coverage-split` |

**不是**：业务冒烟用例集。业务冒烟属 §13.3，选的是被测产品的核心路径，跟这里完全两回事。名字容易混，所以代码注释和文档都写死。

## 一条保险：解析条数必须对得上

TAP 解析器只认 `ok/not ok` 行与紧邻的 `duration_ms` / `error` 块，**不追求 TAP 全量兼容**——解析器写得越"完整"，越容易在 node 换输出格式时悄悄错位，那时 CI 会显示"全绿"。

所以另有一条硬保险：解析出的用例数必须等于 TAP 末尾的 `# tests N`。对不上就**拒绝生成 XML**，退出码 2，并把原始 stdout 尾巴打出来。

> 这条保险是被真实问题逼出来的：把 golden 样本加进 CI 时，测试工作区只复制了 `tests/acceptance`，没复制 `tests/golden`，4 条用例在 CI 里挂、本地过。如果当时没有条数对齐和真实跑一遍 `--suite=smoke`，这个坑会在别人机器上炸。

## 诚实边界

| 做得到 | 做不到 |
|---|---|
| 标准 JUnit 输出、退出码语义、条数一致性校验 | 一条命令跑完整条测试流水线的产品化 CLI（不做，会变成半成品） |
| 13 个文件的工程冒烟集 | 业务冒烟集的选取（属 §13.3，需要被测系统） |
| 失败用例名 + 首行错误 | 失败归因（那要看证据包） |
