# 测试数据诊断与工具纠错

日期：2026-10-15。

后续更新：本文记录本日首批诊断修复及delivery4的原始结果。其剩余数据/来源问题已继续处理，同范围最终真实复验见[用例数据与来源一致性修复](case-data-single-source-2026-10-15.md)；下文历史问题和证据保留。

## 问题与修改

独立用例任务此前没有复用现有长度、金额校验，Skill 甚至要求不调用 diagnose_test_cases。子 Agent 因此启动临时脚本或嵌套 Shell 数数、查文件；一次技术探路错误便可能在最终交接时被拒绝。

本次不增加新的业务节点、人工确认、前序分析或测试点要求，也不新增计算脚本入口。复用 diagnose_test_cases 和 diagnose_task，在当前模式下返回 data_diagnostics：

- code_points：Unicode 码点数量。
- utf16：UTF-16 代码单元数量，与 JavaScript 字符串 length 一致。
- utf8_bytes：UTF-8 编码字节数。
- graphemes：Intl.Segmenter 计算的用户感知字符数量。

例如表情加带组合音调的字母，四种计数可能不同。工具同时给出测量值，不替用户规定产品采用哪种口径；可使用各口径一致的 ASCII 边界数据避免无关歧义。只有产品预期确实受计数口径影响时才提出业务问题。

## 使用方式

专业 Agent 保存当前 run 的 design/test_cases.json 和 test_cases-task.json，再执行已有结构化动作：

```json
{"action":"diagnose_test_cases","run_id":"run-example"}
```

独立任务不要求 related_test_point、需求台账或完整 design_contract。所有字符串 test_data 字段均返回实际长度，不回显原字符串。需要声明精确数据约束时，可仅填写：

```json
{"design_contract":{"data_checks":[{"kind":"length","key":"title","unit":"code_points","expected":51}]}}
```

金额复用 minor_unit_sum，用安全整数最小货币单位计算，避免浮点误差；不相等时返回实际和声明总数。未声明检查的旧独立用例仍兼容，不自动推断其业务预期。

诊断不写草稿、不导出 Excel、不访问产品、不批准需求。独立模式错误返回内层 blocked，生命周期返回 needs_correction；外层动作完成不代表数据正确。Agent 自行修正至 passed 后导出，再正式校验；已声明的错误在正式交付校验中同样不能绕过。

## 工具纠错边界

专业子 Agent 的 Shell 调用在执行前限定为现有 project-action / project-command 入口。文件检查使用原生文件工具，不再启动不同 Shell 猜语法。不可用命令由 qa-stage-boundary 提示替代工具，命令没有执行，不需要用户批准技术解锁。历史已执行检查仍按原兼容规则核验，不回填或改写历史 trace。

交接只对同时具备原生 approval_decision=deny、aborted 工具输出、指定 hook 和纠错标记的记录识别为“执行前工具纠错”。伪造同样的 stdout、普通命令失败、用户拒绝及没有原生拒绝记录的输出均不适用。真实未知执行结果不会因此变成成功。该机制不是操作系统安全沙箱，也不会自动重试产品操作。

## 验证记录

工程联合回归 138/138 通过，无跳过；宿主补丁及安装专项 17/17 通过，与前者有重叠，不相加。角色配置 in_sync，发布白名单 169 项，exe_ready=false。

首轮真实任务 session-2026-10-15-08-52-40-90fd946c 已调用新诊断并得到实际测量，但此前混用 Shell 已执行失败；已停止并保留，不计作交付成功。第二轮 session-2026-10-15-08-56-59-39cb8d34 发现子 Agent 的 Shell 仍实际执行。根因为宿主 sessionHooks 对 child 提前返回，子任务没有加载安装好的执行前钩子；不是数据诊断本身失效。该会话也已停止，保留历史失败。

已修复宿主子任务钩子加载：仅启用 qa-stage-boundary 的 preToolUse，不向子任务注入父任务的停止、用户输入或后台派发钩子，并尊重显式禁用 hooks 的配置。经用户正常退出后，通过统一安装器更新宿主，server.js 语法检查通过，已重新启动。未修改模型、代理、认证或证书设置。

更新后新建真实会话 session-2026-10-15-09-03-27-79a04216，子会话 session-2026-10-15-09-05-00-a4f3eb3d，运行 run-a02d507d-af8b-4c9c-affd-05a414aebdb9。真实子任务的一次目录 Shell 探测在执行前被 qa-stage-boundary 拒绝，原生 approval_decision=deny 和 aborted 输出齐全；随后自行改用 read_file。诊断、导出、正式校验、交接全部完成，test_cases 与 run 均 completed，父任务 idle、无运行中子任务。没有操作者追加推进消息、人工解锁或修改产物。最终回复实际数量为三条、仅设计未执行，并提供 Excel 链接。界面显示用时约 3 分 27 秒，仅为本次样本，不代表性能基准。

独立核验：JSON 与 Excel 均恰好三条，编号、标题、预期和未执行状态对应；标题字段实际码点长度分别为 0、86、4。真实会话页面的链接和交付卡片可见，执行详情默认折叠；桌面和手机截图已检查，手机无横向溢出。下载接口 HTTP 200，返回字节 SHA256 与磁盘 Excel 一致。本轮没有重新验证桌面点击后 WPS 打开，也没有将下载接口成功等同于浏览器点击下载成功。

验收范围仅是运行恢复和交付链路，内容质量尚未完全通过：第二条步骤重复写出的字符串实际为 92 码点，却声明为 86；test_data 的 86 码点测量本身正确。另有无真实测试点来源的 related_test_point 编号，以及将产品计数口径标为已确认的问题。两个超长样本均超过 50 字，但不等于精确 51 字边界测试。原产物保持不变，后续应减少数据重复和无来源关联，不能将形式校验成功当作语义质量通过。

证据目录：E:\QAArchives\AITestWorker\real-agent-repair-recheck-20261014。包含 reliability-delivery4-snapshot.json、delivery4-verification.json、delivery4-desktop.png、delivery4-mobile.png。工程测试日志为 data-diagnostics-final-20261015.log 和 child-hook-host-20261015.log。

下一步：先统一步骤对测试数据的引用及独立任务来源表达，再复验内容质量；随后完成真实 URL/执行/报告链路及 Word/PDF 桌面打开检查。本场景不访问产品，不代表产品执行、全生命周期或 Word/PDF 打开验收。本轮未提交 GitHub。
