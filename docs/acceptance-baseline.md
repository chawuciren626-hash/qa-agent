# 通用验收基座 V1

## 验收边界

基座使用虚构文档草稿管理站点，固定需求、种子数据、六条浏览器参考用例与预期结果。它验证执行器、证据和质量治理的行为，不把预置用例冒充 Agent 自主生成的设计，也不伪造总控的阶段审批记录。

文件：`acceptance/requirements.md` 是需求；`acceptance/oracle.json` 是预期结果；`acceptance/server.mjs` 是只监听回环地址的内存服务；`tests/acceptance/ui/baseline.spec.ts` 是固定执行资产。

## 三种环境

| 场景 | 预期 | 验收意义 |
|---|---|---|
| healthy | 6通过、0失败 | 正常链路 |
| defect | 5通过、TC-BASE-05失败 | 系统故意接受负数预算，测试应发现 |
| unavailable | 1通过、5失败 | 写接口503；由失败分析区分环境与产品问题 |

三个环境使用同一份业务要求和断言，不能为了通过而修改断言。服务故障触发的用例失败是原始执行事实，是否归为环境问题由缺陷分析决定，不直接改成通过或伪装浏览器从未启动。

每条用例前后按独立 scope 重置，只保留虚构种子记录。网页在回环地址启动，跨来源请求被拒绝；它是测试夹具，不是具备生产鉴权的业务服务。

## 执行方式

安装准备应单独完成。正常验收不下载任何组件。通过 PenguinHarness 的执行 Agent 调用：

```powershell
npm run acceptance:run -- --prefix=run-acceptance-unique
```

命令自动选取空闲回环端口，按三种场景创建独立运行，调用项目 `run-ui-tests.mjs`，核对 oracle，保存结果，最后关闭本次站点。前缀不得重复。

如果 PenguinHarness 的 Git Bash 找不到 npm 的 bash 解释器，使用本机已确认的 Node 可执行文件绝对路径运行 `scripts/run-acceptance.mjs`；不要下载安装或猜测路径。

仅检查基座 API 与质量门（不启动浏览器）：

```powershell
npm run acceptance:contracts
```

手工查看站点：`npm run acceptance:serve`，默认地址 `http://127.0.0.1:4317/healthy?scope=manual`。端口占用时设置 `QA_ACCEPTANCE_PORT` 为另一空闲端口。本命令持续运行，结束后关闭对应进程。

## 配置与数据隔离

prepare 脚本将 `runtime.json`、`registry.json` 写入本次运行的 `environment/`，执行计划记录 `environment_config` 与专用测试目录。不会覆盖现有 `config/test-env.json` 或运行旧业务用例。

通用执行器新增可选参数：创建计划时使用 `--environment-config=<path>` 与 `--test-dir=<path>`；环境预检支持 `--registry=<path>`。省略参数仍使用旧默认路径。

每次原始浏览器结果、截图、trace、runner.log 保留在当前 `execution/` 下。`acceptance-verification.json` 验证精确用例集合、通过数、失败 ID 和失败证据是否存在。聚合结果在 `output/acceptance/<prefix>.json`。

验收运行通过 `inputs/acceptance.json` 标记，离线质量夹具通过 `inputs/fixture-origin.json` 标记；全局缺陷索引与质量趋势跳过这些夹具，避免污染真实业务统计。所有执行结果仍被 Git 忽略。

## 质量防护回归

- 缺执行结果、缺证据评估、缺缺陷分析时，质量门必须 blocked。
- 重复路径不能抬高证据置信度，文件不存在、目录或空文件不能作为有效证据。
- 标准缺陷置信度取关联用例的证据评估，证据不足保留 needs_review。
- 重复问题记录有独立 ID，duplicate_of 指向首条记录而非自身。

## 全流程验收与收口

总控自主读需求、派发分析/测试点/用例、生成 XMind/Excel、获取审批、执行、分类、生成 Word/PDF 是另一层验收。应新建正式运行，让真实专业 Agent 生成产物并保留真实会话记录；不可把本基座预置文件登记成它们已完成的阶段。

运行产物引用必须指向当前run内已存在的文件；全局缺陷索引不应登记成运行内quality/defect-index.json。历史错误引用使用remove-missing-artifact脚本删除并追加纠错事件，不删改原始历史事件，不创建虚假索引文件凑齐清单。
