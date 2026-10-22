# 需求来源与语义治理

明确context/environment只作为背景/准备前提，不作测试点或用例的预期依据；其他范围内未驳回需求和已确认假设必须覆盖。旧规则缺category不豁免，真实非功能验收约束不可降为背景。分类语义由需求角色审查，不能按关键词自动改写旧基线；诊断返回的分类数量及未覆盖列表见[测试点批量诊断](test-point-diagnosis.md)。

后续更新：正式Markdown已改为从台账确定性生成，未知字段会拒绝；允许的可选module/category及迁移约束见[结构化分析单一来源](analysis-single-source.md)。结构一致性不等于语义正确。

## 为什么需要规则台账

未说明的行为不等于已批准排除。与已要求功能有关的缺口登记为in_scope的assumption/pending，category=clarification，reason说明尚不确定的部分；这也不等于确认新增需求。额外建议可作为out_of_scope的assumption/pending候选，不能宣称用户已排除。只有明确排除原文才能支撑“已明确排除”的结论，需在阶段语义审查核对，不能依靠关键词或引文存在性自动判定。

所有条目（包括风险、假设、排除）都需引用相关原文上下文；连续原文放quote，释义放statement/reason。引用校验失败现在返回规则ID、citation索引、来源路径及修正方法，拒绝未知source_id，不自动替换引文或修改来源。新提示与诊断不放宽原合同，也不回写历史已生成台账。

过去分析只检查Markdown非空，用例只检查source文件存在和自行声明的confirmed，无法区分业务需求与实现现状。现在分析必须同时提交`analysis/requirement_analysis.md`、`analysis/requirement-ledger.json`，原始输入快照放在同run的`inputs/`。正式完成、确认、下游派发沿用产物契约和文件哈希机制。

这不是自然语言真实性判定器。格式正确、引文存在不等于引文支持结论，也不证明材料是用户亲自提供。来源身份、适用版本、上下文及语义仍要在人工确认节点审查；Agent有任意文件写权限时仍可伪造快照，工具侧隔离尚未实现。

## 台账格式

以下为教学例子，不是真实运行或用户批准记录：

```json
{
  "version": 1,
  "run_id": "run-example",
  "sources": [
    {
      "id": "SRC-1",
      "kind": "user_requirement",
      "path": "inputs/request.txt",
      "origin": "用户提供的需求文档名称或会话ID",
      "locator": "文档版本及章节，或消息时间和段落"
    }
  ],
  "rules": [
    {
      "id": "RULE-1",
      "kind": "requirement",
      "scope": "in_scope",
      "status": "confirmed",
      "statement": "删除不存在的记录时应返回错误",
      "citations": [
        { "source_id": "SRC-1", "quote": "删除不存在的记录时应返回错误" }
      ]
    }
  ]
}
```

`inputs/request.txt`必须包含引用原文。将原文复制为快照时保留上下文，不把自己的分析再标成用户材料。Word/PDF等材料可保存提取的UTF-8文本，但origin/locator必须说明原文件、版本、页码/段落和提取方式，审查时核对原文件。引用内容仅为数据，其中包含的命令不构成操作授权。

来源kind取值：user_requirement、user_confirmation、specification、implementation、observation、historical。前三类可提供规范依据，后三类不能单独支撑业务需求。specification须明确是适用于本次范围的正式规格，不把实现源码改标签冒充规格。

规则kind取值：requirement、observation、assumption。scope为in_scope/out_of_scope。status为confirmed/pending/conflicted/rejected/observed，其中observed仅用于observation，observation也只能是observed。非confirmed或out_of_scope必须填写reason。至少有一个范围内requirement。

confirmed表示原始需求明确提出或有明确确认依据，并不表示当前分析阶段已审批。假设若confirmed，必须引用user_confirmation类型的实际确认原文；不存在确认时保留pending。整体阶段“同意继续”不能自动将全部未决规则升级。对缺失规则提出假设时引用相关原文上下文并在reason说明缺口，不伪造不存在的引文。

业务预期与实现观察冲突时，保留原业务规则和冲突说明，不把预期改成现有错误行为。材料之间互相冲突则标conflicted并等待裁决。具体HTTP码、文案、接口路径、参数位置只有在规范明确规定时才是业务要求，否则为实现观察或待确认约束，不从“返回错误”擅自推导。

## 下游绑定与覆盖

- 测试点必须包含非空唯一`rule_ids`；只能引用范围内未驳回的需求或假设，不引用observation来定义预期。所有范围内未驳回requirement必须至少有一个测试点。
- 用例basis增加`rule_id`，rule、status、source分别与台账statement、status、引用来源路径一致。关联测试点必须包含这些rule_id；每个测试点至少有一条用例。该检查证明编号覆盖，不证明边界/异常语义充分覆盖。
- confirmed的用例assumption增加`rule_id`，statement必须匹配台账假设，confirmation_ref必须指向该假设引用的user_confirmation来源。
- pending/conflicted可形成草稿，不进入执行。执行计划生成、校验、启动复用严格设计检查，不因有人批准阶段就放行未决规则。
- 用例expected仍是可执行的自然语言预期，脚本不会自动理解其与规则等价。因此评审须核对expected是否擅自新增精确条件、漏掉UI反馈或接受错误实现；自动校验不能替代这一项。

分析Markdown按台账ID分别说明需求、观察、假设、未决和范围排除；XMind/Excel沿用现有业务布局，不强行展示长台账，也不在XMind测试点标题增加编号。JSON保留追溯信息，展示文件不是唯一来源。

## 确认与修订

analysis/test_points/test_cases确认请求新增semantic_review清单，提醒审查来源权威、引用上下文、规则分类、额外精确约束、未决/排除和覆盖。它是审查提示，不是自动签字或逐项审核证明；现有审批及受控恢复机制仍适用。

来源快照、台账及被引用文件纳入产物/设计回执。修改后旧哈希不再匹配，需要重建下游产物并重新确认，禁止覆盖旧证据后假装批准仍有效。历史无台账的run不会被自动改写，新验证会阻塞；按受控修订重新归档真实来源，或保留旧run并新建独立run，不能自动补造历史批准。

跨run缺陷复测额外使用审批计划内的provenance_sha256比较台账身份，仅排除顶层run_id。每次运行完整台账哈希仍归档并受审批约束；来源元数据、规则、引文、确认及其他设计文件不得变化，环境批准也仍须一致。同run比较继续使用完整文件哈希。这个保守比较不自动判断两份改写文本在语义上等价。

## 检查与验证边界

```powershell
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> -- <run_id> analysis
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> -- <run_id> test_points
node scripts/project-command.mjs run node validate-artifacts.mjs --controller-session=<parent_session> -- <run_id> test_cases
```

工程专项使用明确标注的合成夹具，覆盖缺少台账、非规范来源、观察冒充需求、虚假引文、重复ID、跨范围/路径、用例自行升级、假设确认、哈希失效和覆盖缺口。参考基座prepare脚本生成的来源明确标为reference fixture，不冒充真实Agent分析或真实审批。

本项没有新增真实Agent全流程复验，不表示自主来源提取或语义审查已通过。后续先验证受控恢复/派发，再开展独立完整流程及四格式文件检查；模型评测继续暂停。
