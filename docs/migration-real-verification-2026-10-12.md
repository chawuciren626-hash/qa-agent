# 迁移后真实验收记录

日期：2026-10-12。工程：E:/Codex/AITestWorker。PenguinHarness：0.2.13。

## 范围与方式

本次验证工程改名及数据隔离后的真实最小链路：创建总控会话、共享入口调用、真实需求分析子Agent派发、产物校验和阶段完成登记、请求业务确认。通过运行中的PenguinHarness原生localhost:59764接口提交任务，由其真实模型和工具执行；不是用合成trace代替真实Agent。未进行页面点击、工作空间选择器或桌面窗口验收。

模型保持tokendance / step-3.7-flash，未调整权限设置。没有安装依赖、批准分析、执行产品测试、修改旧会话或提交GitHub。本次启动应用后，各验收任务已回到idle；业务run仍待确认，两者含义不同。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| 默认工作空间 | 创建201；E:/QAWorkspaces/2026-10-12-09-49-35-4a10ffd4 |
| 指定外部工作空间 | 创建201；E:/QAWorkspaces/migration-check-2026-10-12/selected/2026-10-12-09-49-35-7339cd2e |
| 选择工程目录 | 返回400，提示工程目录只用于程序文件，未创建会话 |
| 指定空间共享入口 | 总控实际调用catalog成功，未创建业务run |
| 默认空间真实派发 | requirement_analysis_agent实际执行并返回 |
| 子Agent目录继承 | 与父会话相同；未另建子目录，manifest中的engine_root为新工程根 |
| 应用数据索引 | 两个总控索引均位于LocalAppData/AITestWorker/session-workspaces，与各自.qa-session.json一致 |
| 产物与输入 | 分析正文、台账、原文的SHA256均与确认快照一致 |
| 阶段交接 | 派发、完成、请求确认事件齐全；analysis为awaiting_confirmation，确认为pending |
| 下游范围 | test_points/test_cases/execution/defects/report全部skipped |
| 回流检查 | 本次run不存在于工程output/runs；观察到的任务写入指向外部会话目录 |

默认父会话：session-2026-10-12-09-49-35-4a10ffd4。

子会话：session-2026-10-12-09-50-58-ea580ef5。

指定空间父会话：session-2026-10-12-09-49-35-7339cd2e。

run：run-b3027210-47c8-423a-955c-8db04effbf50。

dispatch：7f6483d8-c64c-4499-ad0e-3cad1e7656c6。

原文：任务名称必填；空白名称不允许保存，提示文字为：请输入任务名称。

总控首个工具调用约09:50:19，最终回复09:52:49，约2分30秒；子任务约09:50:58开始。此次仅为单条需求分析，不能推算完整执行耗时。

## 已发现问题

1. 总控首次命令在真实会话ID后拼接了额外后缀，被hook拒绝；第二次省略身份仍被拒绝；第三次使用真实ID成功。应减少模型手工拼接身份参数，不能通过取消身份核验来修复。
2. 子Agent按相对docs路径读取两份工程说明，实际解析到外部会话目录，发生两次File not found。随后改读E:/Codex/AITestWorker/docs成功。共享资料应统一通过engine_root寻址，用户输入仍只从当前run读取。
3. 总控完成后尝试project-command.mjs旧入口读取状态，被hook拒绝；随后改用结构化run_status成功。需梳理提示与工具返回中的旧入口引导。
4. 简单必填需求被扩展为7条待定假设，最终要求用户回答6个问题，包含其他字段、权限及持久化等未提出的范围。未说明不等于必须补充；应区分关键行为歧义、可选建议和范围外内容，避免普通确认再次变成补材料流程。台账还将原文解释成仅前端校验，原文并无此限制，需要保留实现中立性。

以上技术误用均由Agent自行纠正，未要求人工解除blocked/stopped。仍属于待优化问题，不以最终成功掩盖过程错误。此次父总控分别调用complete和request_confirmation完成交接，未直接调用handoff；因此证明交接结果成立，不宣称handoff单动作经过本次真实验证。

## 证据与边界

机器核验记录：E:/QAWorkspaces/migration-check-2026-10-12/verification.json。创建和提交回执在同目录sessions.json、default-submission.json、selected-submission.json。记录不包含API令牌。

业务清单：E:/QAWorkspaces/2026-10-12-09-49-35-4a10ffd4/output/runs/run-b3027210-47c8-423a-955c-8db04effbf50/manifest.json。

父子原生trace分别在当前用户.penguin/data/default_project/agents/test_agent及requirement_analysis_agent的traces/2026-10-12下，文件以对应sessionId命名。

未验证完整六阶段、Word上传、Office/XMind打开、浏览器产品测试、桌面UI交互或EXE封装；目录检查不是操作系统级写入沙箱证明。旧会话原生workspace路径未迁移，旧诊断会话仍可能引用改名前路径；不能宣称历史对话恢复已完成。

下一项建议先修复本次观测到的入口和资料寻址误用、澄清范围膨胀，再进行执行准备检查及完整生命周期复验。遵循逐项确认，本轮到此停止。
