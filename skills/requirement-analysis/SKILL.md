---
name: requirement-analysis
description: 分析需求中的功能、业务规则、风险和待澄清问题。
metadata:
  version: '1.1.0'
---

# 需求分析 Skill

材料有歧义、矛盾或不可测表述时，按需读[需求缺口与风险取舍](references/requirement-gaps.md)。适用于task和lifecycle，不新增文档上传后的固定确认节点。

## 独立任务（task）

直接读取当前文字或附件，编写analysis/requirement_analysis.md并保留条件、否定、数值与不确定性。无需requirement-ledger，不调用diagnose_analysis、generate_analysis或analysis_summary；不要为了分析当前材料先补一个生命周期。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

以下流程、输入、Schema及规则台账/批次要求仅适用于lifecycle。task复用专业方法和展示样式，不执行本分支的前序检查或生命周期专用动作。

### 专业方法

需求静态评审按需读取已安装的test-design-methods Skill的语义与覆盖检查；仅用于发现会改变预期的歧义，不新增固定问答或前序产物要求。


用户补充材料由apply_analysis_feedback按原话归档，通过revision_context.feedback_input传入；登记为user_confirmation并逐项更新旧规则。只回答一部分的规则要拆分，不能把剩余未知也标成confirmed；排除范围同步所有关联规则，不能只写在备注。展示本次变更和保留的未决项，新版交总控按保存的确认策略处理；auto无新业务歧义时不重复确认。

分类影响测试设计：context用于背景/架构说明，environment用于运行准备前提，它们保留来源但不自动要求业务测试点。范围内真实可验证行为、兼容性或环境验收约束归functional/constraint。性能/安全测试要求保留原文和引用，按公共能力范围标out_of_scope，reason明确为当前能力排除，不能伪称原文排除或改成背景。混合背景与行为必须拆分并保留引用；不能为消除覆盖报错把行为改成背景。旧规则缺category时仍按原覆盖要求处理，分类调整也属于需求修订，保留来源和变化记录，按保存的确认策略处理。

范围修订后做一次跨规则复核：同一主题可能同时出现在功能规则、数据约束、非功能要求、验收标准和待确认项，不能仅修改某个模块或总控列出的示例ID。逐项核对用户补充对应的全部受影响ID、修改后的scope/status和来源引用；混合规则保留未排除行为，将排除维度另行记录并引用排除原话。交付摘要列出本次变更与保留项，不把结构诊断通过描述为语义审查通过。此复核由角色内部完成，不新增用户授权或解锁节点。

先保存 requirement-ledger.json，再用 diagnose_analysis 检查全部规则及引用；result.status=passed 后才正式 generate_analysis、validate_analysis。诊断不依赖 Markdown，不代表语义确认。引用保留原始 LF/CRLF，可使用 read_source.quote_json 的 JSON 字符串值。正式正文缺失时不能用 analysis_summary 代替草稿诊断。按 recovery 进行安全纠错，stalled 表示连续无进展，应换方法或返回实际错误和已保存草稿，保留原始输入及旧失败记录；不套用历史固定次数限制。

本Skill中的docs/路径均相对工程根，不相对会话工作空间或Skill安装位置。读取catalog.runtime_context.shared_docs_root或派发中的Engine directory，使用绝对路径读共享资料；本次需求则只读派发列出的run inputs，不混用工程历史输入。

交付前经统一命令入口运行`validate-artifacts.mjs <run_id> analysis`，遵循`docs/artifact-contracts.md`与`docs/requirement-provenance.md`。检查结构化规则台账、原文引用和来源快照，不等于语义正确；由专业角色核对，只有影响当前预期的真实歧义才请用户决定。

### 适用场景

当需要从需求文档、用户故事、接口文档或代码变更中识别功能范围、业务规则、风险点和待确认问题时使用。

### 输入

Word的原始.docx应保留在当前run输入中，阅读extract_word返回的.docx.txt与.extraction.json。正文、表格按顺序提取，locator标出段落/表格/行/单元格；这是逻辑结构定位，不是页码。引用指向提取文本，origin注明原Word及提取方式。先读warnings，图片、批注、修订等不能宣称全部读取；相关缺口作为材料局限说明。原文明确的数值、否定、条件和文案不重复要求确认，不能自行改成“允许等价替代”。

- 用户提供的文字、文档、链接或已有测试资产
- 可选：接口文档、原型说明、代码变更 Diff、历史 Bug

### 输出

- 需求摘要
- 模块列表
- 功能点列表
- 业务规则
- 异常流程
- 风险点
- 待确认问题
- 当前 `run_id` 的 `analysis/requirement_analysis.md`
- 同目录`requirement-ledger.json`，以及run内`inputs/`下的原始材料快照；结构和完整示例见`docs/requirement-provenance.md`。

### 工作步骤

当作为专业子Agent接收已有run时，输入快照已由总控归档。直接读取派发列出的本run inputs，不再次archive_input，不把run相对路径当成工作区根inputs的文件。只编辑本run的分析台账，不创建/规划run或登记阶段完成。

1. 阅读输入文档。
2. 按模块拆分功能。
3. 提取主流程、异常流程和约束条件。
4. 标记高风险点。
5. 输出待确认问题。
6. 为每条规则分配稳定ID，区分需求、实现观察与假设，登记范围、状态、原文引用及未决/排除原因。摘要必须按规则ID说明，不得只在JSON标待确认而在正文宣称已确认。
7. 原始用户表述只规定“返回错误”时，不擅自升级为特定HTTP码或错误文本；实现参数的位置、当前行为、故障注入均单列观察。按原文覆盖UI反馈、边界及异常要求，不能只看接口代码遗漏用户需求。
8. 只编写结构化台账，不独立编写或追加正式Markdown。模块用module、分类用category；背景/环境约束也登记为有来源的规则。先判断缺口是否使原文已要求的同一行为出现不同预期；只有存在这种影响或执行安全风险时，才用in_scope、assumption、pending、clarification登记关键澄清，reason说明关联规则和不同预期。不要因其他功能/字段/实现机制未提及就批量生成必答题。可选扩展建议如需记录，使用assumption/pending并注明可选、非本次确认前置；标out_of_scope也只表示候选范围判断，不是用户批准的排除。只有原文明确排除才称来源已明确排除；性能/安全测试属于公共能力范围排除，原因必须区分。实现层次未指定时保持中立，不推断仅前端、仅后端或存储机制。保留kind/status约束，不默认最大值、不把校验trim推导为保存规范化。
9. 先用文件工具保存`{"action":"generate_analysis","run_id":"<当前run>"}`为请求JSON，运行`node scripts/project-action.mjs execute --controller-session=<父会话ID> --request=<请求文件路径>`生成正文；再将请求改为`validate_analysis`并执行同一入口校验。不要把JSON直接传给--request，不直接调用底层脚本。所有假设、未决、风险和排除必须先入台账，不能只写在正文或最终口头结论。字段白名单、修订和来源边界见`docs/analysis-single-source.md`。
10. 先完善台账再生成正文。当前专业派发尚未完成、没有当前待确认/批准/拒绝决定时，generate_analysis可对自己有完整生成快照的草稿按实际进展再生成，不设固定次数上限，旧台账和正文自动保存在audit/analysis-generations；不要自行移动、删除正文。有历史确认时，只允许经用户修改入口登记并重新派发的修订版本生成。总控通过resolve_confirmation的analysis/revision_requested归档旧版，再传入revision_context；从保留的工作台账继续修订，完成后按保存的确认策略推进，不能把返修一律变成再次人工确认。来源不明、其它派发或尚未退回的产物不能靠重生成绕过审批。详见docs/analysis-user-revision.md。

### 质量标准

- 生成前逐条做原文与statement语义核对：保留必须/不得、条件与否定、AND/OR关系、数值和指定文案。多个同时要求的结果不能改成任选其一；提示或返回错误不替代原文要求的状态变化或禁止变化。避免释义削弱规则，必要时直接沿用原文；新增解释保留pending，不标confirmed。此为专业语义审查要求，字符串/哈希校验不能替代。

- 澄清按影响排序：先会改变已要求行为的输入分类、边界、状态转移和结果断言，再执行授权/数据风险，最后表现细节或额外建议。不是每个维度必问；原文已经明确的不再问，与目标无关的不扩展。reason写明关联规则ID、不同解释如何改变预期以及优先级理由，仍使用现有字段；不要由规则编号推断优先级。
- 汇报前读取analysis_summary（run_id），使用实际条目的ID、原声明、范围和状态，不把未记录主题说成已登记。不把没有out_of_scope条目解释为全部主题都在范围内。材料观察不等于产品实现观察。摘要只核验结构与正文一致，不能判断自然语言完整性，也不批准阶段。

- 优先使用派发返回的source_read_templates读取实际输入。quote复制read_source返回的连续原文或其原样子串，保留换行和标点；释义写入statement/reason。引用是相关上下文，不代表来源已经确认推断。规则、假设、风险和排除都需要引用。
- 保存台账前一次检查每条记录的必填字段和引用，避免边生成正文边逐条补漏。编辑JSON前确认目标唯一；多处重复文本不做模糊替换。失败后按错误中的规则ID和citation索引定点修正，不修改原始来源迎合校验。

- 结论必须可追溯到输入来源。
- 实际采用的未证实推断必须标记为待确认；未描述的所有主题不需要穷举成待确认需求。保留范围内功能风险与执行防护，不用“减少问题”掩盖真实歧义；性能/安全测试仅列范围外说明，不作为必答问题。
- 不允许凭空补充需求。

### 禁止事项

- 禁止把猜测写成事实。
- 禁止静默丢弃来源中的性能/安全要求；仅保留范围外说明，不开展分析设计或执行。
- 禁止删除待确认问题。
