# 结果持续保存与异常交付：第2项实现记录

日期：2026-10-19。

用户要求暂不进行真实Agent复验，继续下一项工程修复。本批不启动PenguinHarness产品测试，不改模型、代理、凭据或历史会话状态，也不推送仓库。

## 问题与修复

原实现逐次保存操作回执，但断言数组和正式汇总主要在worker内存中维护，直到正常finish才生成test_results.json。worker退出时已有证据仍在，交接却缺少可用汇总。

本批实现：

1. 每个断言的completed回执提交后，原子替换execution/browser-progress.json。start生成初始空快照；普通导航、截图查询不反复重写整份结果。只有已提交回执的断言进入快照。
2. 回执版本2绑定run、浏览器invocation、dispatch、request及请求摘要，记录真实回执完成时刻和断言证据哈希。
3. 快照写入失败不重放业务操作，返回checkpoint_write_failed提示；原completed回执仍为恢复来源。使用现有原子文件替换，不新增第二套JSONL日志，不宣称断电级持久性。
4. browser-result-recovery.mjs提供只读恢复函数，从原回执及受控命令身份恢复事实，不连接worker、不重开浏览器、不写原run。
5. 同请求不同回执、重复断言ID、损坏JSON、缺失证据、证据哈希不符、跨run或跨尝试回执单独列为问题。相同回执副本不重复计数。started或尚未确认的传输单独列为未知操作，不计为产品失败或成功。
6. 恢复结果始终partial、finished_at=null、browser_closed=unknown，标记result_origin=recovered。不伪造finish、成功命令、闭环清理或阶段完成。
7. 统计复用execution-counts，保留原失败、模拟故障和只读复查口径。关联设计用例数不等于整条用例全部执行完成。
8. 历史证据可能包含未知凭据，恢复投影不复制标题、预期、观察值、DOM正文或网络内容等自由文本，只保留受限证据引用和通用说明。统计基于原回执计算，复核需重跑恢复函数，不能拿脱敏投影重新推断复查关系。

## 历史证据只读检查

来源：E:\QAWorkspaces\2026-10-19-09-45-32-4301a9d5中的run-adc95506-d3fa-4f98-ad51-d815f5433347。

- 恢复50条断言：46通过、4失败，关联25条设计用例。
- 2份非当前派发回执单独列为foreign_attempt，没有合入结果。
- 没有重新执行产品操作，没有更改历史状态或清理测试数据，没有导出原观察值。
- 旧回执没有新版本的证据哈希，只能记录本次读取时的来源哈希，不能追溯证明历史上从未被修改。哈希也不是真实性签名。

## 首批边界（续批已接入，见下）

这是第2项的首批工程实现，不是第2项全部完成。

- 进度快照是辅助产物，不替代现有正式test_results.json或exploration.json。
- 恢复函数尚未接入总控结构化动作；现有执行交接仍要求受控finish，不能宣称worker退出后的自动报告交付已打通。
- 后续仍需接入受控恢复动作、partial交接、缺陷分析和Word/PDF报告，保持来源校验并避免要求用户技术解锁。
- 本批不放宽任何业务授权，也不把恢复事实当作重新执行许可。
- 已运行worker不会热加载新代码；新worker才使用新增快照逻辑。

## 工程回归

首批浏览器集成与恢复关联回归29/29通过，报告位于output/engineering-tests/2026-10-19T06-44-31-538Z-b67fa47d-5492-41ba-9976-e123157d1ca7，覆盖原有正常finish、人工登录续接、partial交接及Word/PDF合成报告路径。后续新增待确认传输、版本和写入失败保护后进行了以下最终专项；两批覆盖重叠，不累加，也不等同全部发布回归。

结果恢复专项11项与Windows真实合成worker退出1项，最终12/12通过，报告位于output/engineering-tests/2026-10-19T06-48-16-445Z-f78de599-469d-4b2e-a8c7-0e3cca4ac992。此前9项专项结果保留，不累加计数。

覆盖未知操作、冲突去重、旧版本兼容、跨run与跨attempt隔离、损坏JSON、越界和缺失证据、原子快照、证据变更、模拟故障及只读复查，并补未知版本拒绝及快照写入失败后原回执仍可恢复。真实合成worker被终止后，原回执和进度快照字节不变，另一run正常结束。测试使用本地合成页面和数据，不是真实Agent或产品验收。

发布资源检查通过，当前清单199项，其中包含并行发生的界面资源变更；本批只新增browser-result-recovery.mjs，不代表验收其他界面变更。独立exe仍未就绪。

## 续批：总控入口与部分报告交接

用户随后要求继续，仍不进行真实Agent验收。本批新增browser-recovery-delivery.mjs，将恢复接入既有browser_task工具，operation为recover，只需要type和request_id，不需要用户编写恢复文档。

### 使用流程

1. 命令超时后由Agent调用health；worker仍存活则安全检查或finish，不重开浏览器。
2. worker已确认退出，或状态expired且连接文件已由worker移除时，可调用recover。退出未证实时返回recovery_not_ready，不强杀或冒充退出。
3. 工具依据原回执生成partial的test_results.json、browser-recovery.json和exploration.json；全流程另生成browser-coverage.json。保留源回执和浏览器状态，不覆盖正常finish结果。
4. 只在已核验的同run浏览器命令故障上恢复控制器的交接能力，保留previous_failure事件。不会清除其他任务的失败，也不会自动撤销用户主动取消。
5. 执行角色写outcome=partial的任务摘要，按正常交接将结果交给已请求的缺陷/报告任务。缺陷分析区分已有失败断言、工程中断和未知操作；证据不足时使用needs_review，不虚构产品根因。
6. 报告导出自动加入“异常中断后的部分结果”说明，保留result_origin=recovered、status=partial、finished_at=null和browser_closed=unknown。统一使用已核验恢复器的统计，不能用脱敏投影重新推断复查关系。

恢复交接不再要求每条历史断言对应的CLI都正常退出；以原始回执和来源一致性为准，同时要求本次恢复命令正常结束且产物哈希匹配。没有删除原来的正常finish核验分支，也没有放宽新产品操作的授权。

### 新增边界检查

- completed是回执处理结束，不等于业务结果已确定。fill/click/press/select/check回执中的needs_inspection或observation_unavailable单列为未知操作；明确operation_started=false的前置条件拒绝不算产品执行。
- 同一历史全流程仍为50条断言（46通过、4失败）、25条关联设计用例；另识别1个结果未确认操作和2份非当前派发回执。原断言计数不变。
- 新入口服务于仍在执行的、当前拥有者的派发。不会悄悄重新打开已经被登记为failed/blocked的旧阶段、绕过明确取消或伪造失败子Agent的正常返回。旧会话仍按只读证据保留，未改历史状态或重新启动产品测试。
- 恢复字段不能覆盖数据残留的不确定性，不自动清理、删除测试数据，也不声称浏览器退出即代表数据已恢复。
- 本批修复的是异常后的真实部分交付，不代表原未执行的业务用例已经补测，也不解决历史65秒进程滞留根因。

### 续批验证与同步

- 首轮相关回归54/54通过：output/engineering-tests/2026-10-19T06-57-33-252Z-55ce29ad-361a-4d7b-bbf1-34bc5b62a91b。含合成worker退出后，全流程执行交接、缺陷分析、Word/PDF导出。
- 控制器、恢复与报告专项51/51通过：output/engineering-tests/2026-10-19T07-01-06-110Z-bfbf8c70-4f8d-4811-8649-c2fed7ad4fe9。
- 最后追加“不确定结果的completed回执”后，恢复专项14/14通过：output/engineering-tests/2026-10-19T07-07-53-335Z-5deea362-179b-4fd4-bf2b-f9d1c9242cb1。
- 最终浏览器与独立任务扩大回归47/47通过：output/engineering-tests/2026-10-19T07-03-52-398Z-59fedd61-be86-405f-9922-8717a0fef4c8。独立任务无需设计前序，通过合成浏览器退出、恢复、报告交接、Word/PDF生成，并检查Word正文包含异常部分结果说明；全流程保留设计覆盖和失败断言的缺陷分析交接。该批与追加恢复专项互补、覆盖重叠，不累加。
- 执行Skill同步1处后in_sync、changes=0；8个角色system_config.yaml同步前后哈希一致。未改模型、代理或凭据，无需本批宿主重启，未推送GitHub。
- 当前发布资源清单205项检查通过，包含其他并行界面资源修改，不代表本批验证了那些修改；独立exe仍未就绪。各批测试覆盖重叠，不累加，不等于真实模型端到端验收或客户端文件打开验收。
