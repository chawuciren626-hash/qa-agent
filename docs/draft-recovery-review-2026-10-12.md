# 草稿返修预检与历史审查恢复

日期：2026-10-12。

## 工程调整

1. 抽取 draft-stage-revision.mjs，预检和实际返修共用同一资格判断。新增 preview_revision，只读返回资格与原因，不生成产物、不批准阶段、不重置控制器。
2. revise_stage 在写锁内重新核验，资格不符返回 ineligible，不再把普通资格拒绝变为全局 stopped。控制器原本 stopped 时仍不能修改，只能诊断。
3. 历史命令错误保持严格默认拒绝，不凭 SyntaxError 字样一律自动放行。工程侧逐项审查后，沿用已有 recover-stage/review-session 入口，绑定当前清单与控制器哈希、审查证据及授权依据。
4. 审查恢复时复制保留旧草稿及哈希，不覆盖工作草稿；新的分析派发使用独立的生成/验证预算，旧失败次数不删除。
5. 修复 review-session 的相对证据路径：隔离模式下以当前会话目录解析，继续拒绝会话外证据。
6. 总控指令、动作目录及发布资源清单同步更新。用户不需写技术解锁材料，业务阶段确认规则保持不变。

## 原会话审查

父会话 session-2026-10-12-10-32-28-d11f649c，原 run 保持 run-2b9301e8-66fb-42af-86da-c16e62e94b8c。

工程侧读取旧子任务的原生工具调用、返回及临时脚本的历史写入内容。四条失败命令属于 Python 引号导致的编译语法错误；相关命令只读取文档并打印引用诊断。其他临时脚本涉及台账引用/换行/reason 修改和具名辅助脚本清理，未发现产品测试调用。三份原始输入字节与上传件仍相同。不能由此声称旧业务分析正确或已交付。

审查文件位于原 run 的 audit/engineering-review-20261012.md，记录旧子 trace、台账、源文件及失败命令哈希。先以精确清单哈希登记 stage_recovered，再以精确控制器哈希登记 review_accepted。授权依据是用户在 Codex 中继续修复工程的请求，不是需求确认或执行授权。没有直接编辑清单/控制器、清空预算或新建run。

恢复过程第一次 review-session 使用相对证据路径时遇到旧路径解析错误，未修改状态；改用当前会话绝对路径成功，随后修复并测试通用路径解析。此错误保留在工程记录中。

## 验证状态

最终完整工程回归177/177通过，临时工程测试副本已清理。总控/Skill同步检查in_sync，发布资源清单129项通过，但不代表已打包exe。

原生API派发新的真实专业子任务 session-2026-10-12-11-10-33-e67ec7ac，dispatch=ea5bc028-f4a3-4cf8-8832-a82e39d5b4f3。已实际完成诊断、生成、校验、摘要及总控交接。最终原生父会话idle，业务状态awaiting_confirmation；仅1条pending需求分析确认，控制器ready，下游五阶段均planned。未批准、未执行产品测试。

## 复验新增问题与修复

- 新子任务再次写错一个请求文件名，被旧unbound请求预算拒绝。该请求没有选中或执行任何业务动作。新增证据规则：只有后续有效受控请求成功且回执匹配，才能认定此类请求传输错误已处理；不能由此清除产物失败或未知中断，原请求计数仍为3。
- 首次handoff拒绝，原因是较长analysis_summary被原生宿主截断；完整64110字节日志已由宿主归档，但工程只解析了截断片段。
- readSession现在只对exec_command工具输出的原生归档标记读取完整日志，严格限定当前agent/当前session的scratchpad/truncated-tool-output/exec_command-*.log，拒绝外部路径、重定向、缺文件、空文件和超过8MiB的文件；保持原工具终止状态，不把fatal转为成功。没有修改原始trace。
- 归档兼容修复后，同一专业子任务的证据核验通过；仅重试handoff，没有再次派发或覆盖正式产物，完成completed及confirmation_requested登记。

## 最终证据

- 原3份input与上传原件逐字节一致。
- 原生成预算3、unbound请求预算3、旧摘要失败2、验证失败1完整保留。新增handoff纠错1次保留；未清零。
- 新台账61条，旧台账58条；旧版保存在audit/revisions/analysis-2f3c1865-cb02-4e03-94c1-cca0fb9e8ced/analysis/requirement-ledger.json，SHA256仍为0ee35664b5894b367e44bca1eaec2e2f4dc7194602a5ee9fdc0713f4c1453962。
- 新台账SHA256：99e62cf58972b47e43000e06a10a0d46488e1770501302b46ea06d26ea95c74c。
- 正文SHA256：44125a6856ebbab29e41136e1309232a4ad0289b00972e1c077ea70e265c0de2。
- 新增RULE-DATA-001、RULE-DATA-002及pending的RULE-ASS-010；另有12条既有记录的细化/引用修订。不是只改变格式，需用户审阅新版分析。没有把技术恢复当业务确认。
- 清单事件保留完整顺序：plan_created、dispatched、failed、stage_recovered、dispatched、completed、confirmation_requested。

## 边界与后续

本项实现的是原分析阶段恢复到正式待确认，不是六阶段端到端全部通过。用户可在原PenguinHarness会话审阅并确认，再进入测试点。

真实运行仍存在模型效率和展示问题：重复列目录、重写长台账、请求文件名误写；总控摘要把risk维度与kind/scope数量混列，容易让人误以为可相加；把台账confirmed标签称为“已确认”也易与阶段用户批准混淆。结构及引用通过不等于业务完整性和语义正确性已全面证明，这些保留为下一轮优化，不能宣称零报错。

未安装依赖、提交GitHub或清理历史任务数据。本项结束待确认。
