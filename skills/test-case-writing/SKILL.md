---
name: test-case-writing
description: 根据测试点生成符合项目 JSON Schema 的结构化测试用例。
metadata:
  version: '1.2.0'
---

# 测试用例编写 Skill

## 分批保存

大批量用例使用公共运行规则中的draft_records：inspect获取当前sha256；按case_id分批upsert，每批1至20条完整用例。修订仅提交问题ID，不重写已有正确用例。samples可按指定Unicode码点生成test_data长度样本，测量口径不代替需求依据。复用inputs中的用例可seed初始化缺失草稿，旧规则引用仍须按本任务核验，不继承批准。批次保存后继续剩余设计，最终统一diagnose_test_cases、export_test_cases、validate_artifacts，不对每批增加人工确认或整套导出。

## 数据与来源表达（两种模式共用）

提交草稿前由本角色完成语义自检，不新增审批或必填文件：逐字段检查test_data怎样在前置条件或步骤中生效。空字符串需明确清空并核对为空；仅写“不清空”“保持为空”或把空值列入数据，不能保证未知初始状态为空。null、缺失字段、空白字符串是不同输入；false/0不能当作未提供。准备方式应适合当前UI/API，不凭空编造控件或接口。刷新、导航或重置后不能沿用已失效的输入状态。

diagnose_test_cases.data_diagnostics中的data_usage和semantic_review是专业自检提示，不是用户确认项或新质量门。未显式引用不自动证明错误（自然语言前提也可有效），已引用也不证明语义正确；核对否定、顺序和实际准备效果，发现矛盾自行修订再导出。

逐个预期子句对照当前来源：原文只要求提示时，不擅加停留页面、禁止保存、不产生数据、HTTP状态码等断言；有明确来源才保留。可选建议与已要求预期分开，非必要扩展直接省略，不为自己添加的细节追问用户。真正影响既定测试目标的歧义才提出问题。没有访问产品时只描述测试设计，不声称已观察实现。

输入样本只在test_data保存一份。steps用“输入test_data.title”这样的字段引用（字段名使用ASCII标识符），不再重复粘贴长字符串、金额或样本长度；Excel会自动在步骤下展示真实数据。诊断会检查显式引用的字段是否存在。边界目标写在data_checks，例如上限50的紧邻超限样本检查expected=51；测量不符应修正样本，不通过改成86等任意超限值冒充精确边界。

data_checks.unit只是测量口径，不是用户确认的产品规则。原文只说“字/字符”时，优先选择普通ASCII字母作为长度样本，使码点、UTF-16、字素和UTF-8字节计数一致；不自行写“产品已确认按码点计数”。只有不同口径确实影响当前预期时才提出业务问题。不要在preconditions中添加没有来源的“已确认”条件。

task没有真实测试点来源时省略related_test_point，也省略虚构的basis/rule_id；已有编号只能引用task.source_paths中的实际资料，不能为了关联而补造前序。lifecycle仍按真实测试点和台账引用。诊断通过只证明可机械核验的部分，交付前仍应自行核对预期与原文，不把语义审查交给用户。

## 独立任务（task）

新生成用例增加expected_basis数组，为expected中的每个预期子句记录{expected,kind,source_path,quote}。expected是主预期中的完整子句，kind为requirement（需求）、contract（接口/业务约定）或ui_explicit（页面明确约束）；source_path取本次task.source_paths，quote逐字摘录已有资料。示例：expected为“显示请输入标题”，依据为{"expected":"显示请输入标题","kind":"requirement","source_path":"inputs/request.txt","quote":"标题为空时提示请输入标题"}。不要生成新的前序台账或让用户填写这些字段。

diagnose_test_cases.expectation_diagnostics会检查引用是否存在、预期是否全部关联，自行修正后导出。source_located只说明来源文本可定位，不代表语义正确或来源权威已验证；引用整句需求也不能支撑自行附加的保存、跳转、数据库、HTTP状态等预期。页面真实行为不等于界面明确约束，更不证明服务端行为。

必要但尚无依据的业务问题记入任务questions；可选工程假设或建议只写observations:[{statement,kind,reason}]，kind为engineering_assumption或needs_confirmation，不放入expected、不作为通过/失败标准。非必要扩展可以省略，不逐项追问。Excel自动增加“预期依据”表并区分建议，不需要额外脚本。旧用例缺失依据只提示未记录，不要求用户补文件或解锁。

直接从当前材料生成design/test_cases.json，条目包含case_id、title、module、priority、preconditions字符串数组、steps字符串数组、test_data、expected。已有测试点/规则引用可选，不强制related_test_point或完整design_contract，不编造前序产物。保存草稿和任务说明后调用diagnose_test_cases，它自动使用独立任务模式，不要求分析或测试点前序；修正后用export_test_cases导出Excel，再validate_artifacts。

边界数据直接写入test_data，通过diagnose_test_cases返回的data_diagnostics检查实际长度（code_points、utf16、utf8_bytes、graphemes），不启动node -e、嵌套PowerShell或临时脚本数数。需要精确长度或金额校验时，可仅补design_contract.data_checks，不添加虚构basis或前置产物。例如长度检查为{"kind":"length","key":"title","unit":"code_points","expected":51}；金额使用整数最小货币单位及minor_unit_sum，结构见docs/design-quality-gate.md。工具只测量数据，不替用户决定业务规则；计数单位确有业务歧义才提问。技术诊断结果自行消化，不把计算日志全部发给用户。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

仅在当前派发明确为lifecycle时，读取test-case-writing Skill的[生命周期参考](references/lifecycle.md)。该参考保留台账、追溯、设计与执行合同要求；task只执行上面的独立分支，不加载此参考或生命周期Schema。
