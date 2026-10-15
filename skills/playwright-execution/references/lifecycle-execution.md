# 生命周期执行契约

返回[Playwright执行](../SKILL.md)。仅适用于workflow_mode=lifecycle，独立task按入口中的browser_task说明。

## 外部会话执行准备

脚本保存在当前run的execution/scripts，计划显式设置test_dir和environment_config，不沿用工程tests/generated或旧业务配置。@playwright/test通过工程playwright.config.ts与tsconfig.playwright.json共享映射解析；从工程受控执行入口启动，不在会话安装node_modules，不直接node运行测试文件。其他共享框架文件使用已核实的工程绝对路径，不猜外部目录的相对层级。

优先使用项目现有.spec.ts与`import { test, expect } from '@playwright/test'`。外部原生ESM（例如.spec.mts）当前映射到CommonJS入口，使用`import playwright from '@playwright/test'; const { test, expect } = playwright;`；不要假定原生ESM具名导入也可用。这不是任意npm依赖映射，新增依赖需要另行登记和检查。

预检ready仅表示本机静态条件满足，不代表环境可访问、浏览器已成功启动或本次计划获批。目前执行配置支持Chrome channel，不能给出Firefox配置却仍运行Chrome。预检不访问目标、不安装依赖。prepare阶段不运行用例或打开浏览器；维护者的--list检查会加载脚本顶层代码，因此只对已检查无顶层副作用的诊断脚本使用，不把任意脚本收集称为安全沙箱。

## 统一产物交付契约

遵循`docs/artifact-contracts.md`。PenguinHarness准备派发中先用结构化`prepare_execution_plan`选择确定范围并建计划，再用结构化`validate_execution_prepare`提供运行内脚本路径进行校验，不在隔离工作区直接运行底层CLI。实际执行后通过受控入口校验执行产物。计划与结果的用例ID必须逐条一致，不能漏项、重复或混入未计划用例；结果必须绑定最新invocation_id。失败结果可真实交付，不得为了通过校验改为成功。未启动或中断应记录blocked，而不是伪造completed。证据引用必须属于当前run。

## 适用场景

当需要将适合自动化的 UI 测试用例转换为 Playwright 脚本并执行时使用。

## 输入

- 当前 `run_id` 的结构化测试用例与 `execution/execution-plan.json`
- 当前计划 `environment_config` 指向的环境文件；独立运行使用本run的 `environment/test-env.json`
- 被测系统 URL

## 输出

- 当前 `run_id` 的 `execution/scripts/*.spec.ts`；共享执行合同引用已核实的工程 `tests/framework/`
- 当前 `run_id` 的 `execution/execution-plan.json`
- 当前 `run_id` 的 `execution/test_results.json`
- 如本次执行受阻，交付当前封存批次的 `execution/execution-blocked.json`，不得复用历史结果。
- 截图、Trace、日志等证据文件

## 工作步骤

1. 将 `automation_feasible=true` 的用例转为执行计划，并为每条用例声明数据隔离、准备、断言和清理合同。
   支持prepare任务：仅生成计划与脚本，不启动浏览器，不调用test:ui；交付执行计划和当前run内脚本供审批快照使用。人工用例保留在manual_pending，不写成已自动执行。
2. 调用 `execution:plan:validate`，再生成遵循执行合同的 Playwright 测试脚本。
3. 使用稳定选择器，优先 `getByRole`、`getByLabel`、`data-testid`。
4. 仅在用户批准后通过受控 project-command 入口调用 `run-ui-tests.mjs --run-id=<run_id>`；执行器会完成环境预检并只运行计划内用例。
   真实执行前审批快照必须与当前计划、环境、脚本及共享脚本一致；禁止在确认后修改脚本再沿用旧批准。改动需返修并重新申请确认。prepare结束不等于execution完成。
5. 执行器为每次尝试生成独立invocation_id，将原始结果、日志和证据保存到`execution/attempts/<invocation_id>/`。返回后核对execution-state及本批次attempt.json，不覆盖或清理历史批次。
6. 区分脚本问题、环境问题、产品缺陷。
7. 受控入口的 completed 是命令收口，不是测试通过；读取 execution_outcome。failed 继续交付缺陷分析，blocked/report_only 仅交付受阻分析和报告；返回 completion_artifacts 给总控登记，不自动重跑。不满足封存完整、进程结束条件时仍停止。详见 docs/execution-outcome-closure.md。

## 质量标准

- 脚本可运行。
- 断言明确。
- 失败时有错误信息和证据。
- 执行结果可被后续 Bug 和报告流程消费。

## 禁止事项

- prepare只交付计划和脚本，不宣称已执行；execute须交付实际执行或阻塞结果，不能以脚本生成代替执行。
- 禁止用固定等待替代可靠断言。
- 禁止把所有失败都判定为产品 Bug。
- 禁止成功路径使用违反字段长度、格式或唯一性规则的测试数据。
- Toast/动态提示必须等待目标文本更新；禁止仅以元素已可见或固定等待作为通过依据。
- 禁止用例依赖前一个用例创建的数据；每条涉及写操作的用例必须独立准备和清理数据。

## 执行前置条件

1. 读取并解析当前计划environment_config指向的环境文件，不沿用历史业务配置。
2. 只有 execution.enabled=true、地址和账号不再是占位值、并且用户明确要求执行时，才允许启动浏览器。
3. 只运行已校验执行计划中的用例；用例筛选策略由总控或后续测试选择能力确定，不在执行器中写死优先级规则。
   执行计划必须通过项目create-execution-plan脚本生成design_gate。生成、验证和启动入口都会核验本次用例、规则依据和确认文件的哈希；缺少合同、存在未决假设、数据错误或文件变化时停止。不得手工填写design_gate、复用其他run的来源、绕过test:ui直接启动Playwright。旧计划无design_gate时先补依据并重新生成、重新申请确认，不自动补造历史证据。
4. 未满足条件时，生成当前运行的 blocked 测试结果，不得访问网站。
5. 未观察到页面结构时，不能猜测 DOM 或声称脚本可执行。
6. 不得执行 `npm install`、`playwright install`、`npx` 下载或浏览器下载；只能复用项目已有依赖和本机 Chrome。缺项时输出 blocked 结果。

## 结果与证据

- 新执行的原始Playwright结果、HTML报告、截图和Trace保存到`execution/attempts/<invocation_id>/playwright/`。生成脚本通过testInfo.outputPath/testInfo.attach或QA_RUN_DIR保存证据，不写死旧execution/playwright或其他批次路径。旧证据只读保留。
- 每条结果必须包含用例 ID、状态、耗时、失败分类与证据路径。
- 失败先分类为 needs_review；没有证据不得判为产品缺陷。
- 表单校验用例必须验证提交后新增或更新的真实提示元素及其文本。禁止以 `page.content()`、页面全文、placeholder 或静态标签中存在关键词作为通过依据。
- 生成脚本必须使用执行合同，明确数据隔离、准备、断言和清理。默认 `shared` 用例只能串行执行；只有 `read_only` 或 `isolated` 用例可使用环境允许的并发数。

## 批次稳定性与恢复

- 详见`docs/execution-attempts.md`。每个run只允许一个活动执行器；发现锁时先列出批次，禁止删锁、抢占或创建替代锁。没有确认进程停止，不执行recover。
- 整批超时global_timeout_ms默认900000，预检超时默认60000；数值进入执行计划及批准快照。需要调整预算时先修改配置、重新生成计划、重新批准，不临时放大超时。
- 正常入口强制retries=0，不因失败自动重跑写操作。需要复测由总控在当前批准范围内显式发起；输入或范围变化必须重新批准。
- 结果解析失败、全局错误、漏用例、退出码冲突及中断时记录blocked，保留本批次原始输出。执行器负责发布兼容结果；禁止用results:parse或手写JSON覆盖当前结果来补造成功。
- 未确认终止的进程保留锁和未封存目录。显式恢复只封存中断记录或恢复已封存结果视图，不启动浏览器，不自动续跑未完成业务操作。强制终止可能跳过业务清理，必须报告残留数据风险。
