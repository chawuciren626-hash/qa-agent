# 执行稳定性与独立批次归档

## 用户使用方式

仍在PenguinHarness向总控提出测试目标并批准执行。执行入口仍是`npm run test:ui -- --run-id=<run_id>`，每次显式调用产生一个新的UUID作为invocation_id，失败不会自动触发下一次调用。总控和执行Agent遵循已同步的指令处理批次、复测和中断。

```text
output/runs/<run_id>/execution/
  execution-plan.json            当前待批准计划
  execution-state.json           当前批次指针，version=2
  test_results.json              最近可发布结果的兼容视图
  execution-blocked.json         最近阻塞诊断，须核对批次ID
  execution.lock.json            仅活动执行或待恢复时存在
  recovery-events.jsonl          显式恢复记录
  attempts/<invocation_id>/
    inputs/execution-plan.json
    inputs/approval-snapshot.json
    preflight-command.json
    preflight.log
    environment/preflight.json
    playwright-command.json
    playwright.log
    playwright/                 原始JSON、HTML、trace、截图
    events.jsonl                阶段、PID、结束原因与耗时
    state.json
    test_results.json
    attempt.json                封存清单、状态、耗时、文件SHA256
    previous/                   开始前兼容视图与报告等的快照
```

未进入某个阶段时，不会虚构其命令、日志或原始结果。无法确认进程停止时只有partial-result及未封存目录，不产生attempt.json。初始化失败也保留锁和部分目录等待恢复。

## 独立归档与结果发布

- 创建批次前用排他文件创建取得run级锁。另一个执行器收到退出码3，不改活动批次状态，不自动抢占过期锁。
- 每次Playwright由QA_RUN_DIR指向新的attempt目录，因此原始证据从产生时就隔离；不是运行后覆盖原目录再复制。
- 开始前保存上一轮兼容结果、状态、阻塞记录和quality/defects/report文件到previous。它们明确属于开始前视图，不冒充本批次执行证据。旧execution/playwright原地保留，缺失历史不补造。
- 输入保留本批计划及批准快照的文件哈希；不会复制账号明文或整个依赖环境。这不是可完整重建操作系统、浏览器和服务端数据的环境镜像。
- 原始报告必须覆盖计划ID且无重复/混入；全局错误、零执行、退出码与统计冲突、证据缺失或来自其他attempt均阻止发布。缺陷失败可记录failed，解析和基础设施故障记录blocked，不擅自分类为产品问题。
- 正常执行入口强制`--retries=0`。只读解析器仍保留原始报告中的retry历史及flaky标志，不把重试前失败从原始证据中删除。
- 封存清单记录归档文件大小及SHA256。正常API拒绝重写已封存批次，完整性校验能发现改动、缺失和新增文件。拥有本机文件写权限的人仍可同时改写清单和文件，不能称为不可篡改存储。
- 当前结果与状态分别通过临时文件替换发布，不是多文件事务；进程在两次发布之间崩溃时，状态/结果不一致会阻塞报告，随后通过显式恢复重建已封存视图。
- 新批次阻塞不覆盖以前的成功test_results，但最新state会标记blocked。不得单独读取旧兼容结果宣称当前通过。

## 超时与中断

execution_policy包含global_timeout_ms（默认900000，即15分钟）及preflight_timeout_ms（默认60000，即1分钟）。计划生成器从环境execution同名配置读取；合法范围分别为1秒到24小时、1秒到5分钟。批准快照覆盖这些输入，修改预算需重新生成计划和批准。

Playwright使用整批超时；外层进程保护另留10秒退出宽限。预检的Python探测也有10秒上限。超时/取消在Windows通过指定PID的taskkill /T终止树，在其他平台通过进程组终止；事件记录预检和测试进程耗时。

可捕获的SIGINT/SIGTERM会走中断收尾；断电、系统强杀或父进程突然消失无法保证收尾，锁及原始输出保留。无法确认子进程停止时不封存、不释放锁。强制终止可能跳过用例finally清理，必须人工检查遗留数据；不能自动重跑或自动删除业务数据。

## 查询与恢复

```powershell
npm run execution:attempts -- list <run_id>
npm run execution:attempts -- verify <run_id> <invocation_id>
```

list显示每批状态、开始/结束时间、耗时、原因及锁；不代表完整性已验证。verify才会重算归档清单。未封存批次不能verify为通过。

恢复前检查原主进程、记录的子进程及可能遗留的浏览器/worker均已停止，确认业务残留风险并获得用户同意，然后执行：

```powershell
npm run execution:attempts -- recover <run_id> --confirm-stopped --reason="已检查进程停止，说明中断原因"
```

恢复拒绝仍存活的owner/child PID、跨主机锁及并行恢复。PID复用可能导致保守拒绝，不自动强制解锁。confirm-stopped是人工确认声明，不是脚本能完全证明所有脱离父进程的后代都已停止。

恢复未封存批次时记录interrupted，当前视图为blocked；不会从残缺原始JSON推断成功。已封存但未完成发布的批次，先校验完整性再恢复视图。恢复只处理归档和锁，不访问业务环境、不执行剩余用例、不自动产生新批次。

## 下游绑定

证据评估从最新封存批次读取结果并写invocation_id。新版bugs.json必须是包含run_id、invocation_id和bugs数组的对象，标准缺陷记录继承该ID；旧批次评估/缺陷不能被当作新批次结论。

质量指标遇到归档损坏、当前视图与封存结果不一致或stale_derived_artifacts时阻塞正式交付；下游应重新评估当前批次，而不是修改旧结果。阻塞批次可以生成当前空评估/空缺陷及阻塞说明，但不能变成执行通过。没有封存的活动/异常批次先停止并恢复，不伪造完成回执。

`results:parse`现在仅支持指定run、invocation及退出码的只读诊断输出，不再直接覆盖当前test_results；唯一发布入口是执行器。现有接受新批次的验收检查器同样读取最新封存结果。出现attempt归档后，旧自动证据清理脚本拒绝apply，避免删除历史引用。

## 已知边界

- 不迁移旧trace或补造以前丢失的原始证据；新版状态缺失的历史数据维持原有兼容处理，不宣称其已有独立归档。
- 生成脚本必须使用testInfo.outputPath/attach或QA_RUN_DIR，不能写死旧输出目录。当前不是操作系统沙箱，任意自定义脚本仍可能越界写文件或启动脱离进程树的程序。
- 不提供自动重试、失败用例自动修复、数据回滚、跨机器调度或按配额清理归档。磁盘占用会增长，需要后续制定保留策略。
- 日志、trace、计划、previous快照可能含业务信息，全部留在已忽略的output；不要把它们作为公开仓库内容提交。
- 进程日志能帮助区分预检、执行、解析及退出耗时，但不包含模型推理与Agent交互的总耗时，不代表已优化完整对话时长。
