# 第4项：PenguinHarness会话目录适配

## 状态

2026-10-12补充：工程已改名为E:/Codex/AITestWorker，安装适配器、hook与空目录绑定已重定位，会话索引外置到用户应用数据根；原生历史workspace未迁移。详见改名修复与验收边界（本地历史记录，不随源码分发）。以下10月10日实机验收仅代表改名前状态。

已实现并安装本机适配，目标版本PenguinHarness 0.2.13。2026-10-10用户重新启动应用后，已通过真实页面完成默认工作空间、指定工作空间的新会话创建和旧会话恢复检查。两次新会话均由真实总控调用catalog入口成功；本次不是完整测试流程验收。

## 使用规则

- 新建test_agent总控会话、未选择工作空间：在config/session-workspaces.json的default_workspace下创建时间戳加短ID文件夹。当前默认E:/QAWorkspaces。
- 已选择工作空间：在所选目录下创建相同命名的独立会话目录，避免多次对话互相覆盖。
- 2026-10-12起新总控会话拒绝选择工程根及其内部目录，以免程序与产物混存；请选择外部目录或留空。已有会话不因此自动搬移，10月10日选择工程目录的验收属于旧行为。
- 已有会话恢复：原workspace不变。未绑定的旧会话保持旧模式，不自动迁移。
- 子Agent使用父会话workspace，并在每次命令启动时继承父级QA_DIRECTORY_CONTEXT。不为子Agent再建目录。
- 仅测试总控的新会话启用创建规则，不改变其他Agent的默认工作空间行为。

## 文件布局

会话目录内有.qa-session.json身份标记、inputs、output/action-requests、output/runs以及两个轻量scripts入口。程序本体和node_modules仍共用工程目录，不重复安装。2026-10-12起新索引写入%LOCALAPPDATA%/AITestWorker/session-workspaces，用于宿主hook绑定；支持QA_APP_DATA_ROOT绝对路径覆盖。工程output/session-workspaces仅作为旧索引兼容读取来源，不再写入新会话索引。

PenguinHarness原生聊天数据库、trace和上传附件仍由应用存储。它们未被搬到工作空间；工作空间存放任务文件，上传附件仍由归档动作复制到本run输入目录。不要把本次改造描述为聊天数据库迁移。

## 安装与回滚

scripts/install-penguin-workspace-adapter.mjs接受应用resources/app目录以及--check、--apply、--restore。安装只适配已检查的0.2.13版本，要求三个代码锚点唯一。它备份dist/server.js到server.js.qa-workspace.original，记录原文件/修改后SHA256到server.js.qa-workspace.json。已安装时不重复注入；未知更新拒绝覆盖。

回滚使用--restore后重启应用。回滚不删除会话文件。应用升级可能覆盖适配，须重新检查，不能强行套旧补丁。适配代码位于工程scripts/penguin-workspace-adapter.mjs；工程移动后需要重新安装校验，当前安装引用绝对模块路径。

## 本项验证与待办

2026-10-12迁移后补验：默认/指定外部目录创建、工程目录拒绝、真实需求分析子Agent目录继承、共享入口及产物交接已验证，见迁移后真实验收记录（本地历史记录，不随源码分发）。存在自行恢复的身份参数、旧入口和共享文档寻址错误；完整测试生命周期及迁移后UI选择器仍未验证。以下保留10月10日验收记录，不能当作迁移后的最新边界。

本轮完整Node工程回归165项通过，0失败、0跳过；安装状态校验为installed。未提交GitHub。

工程测试已覆盖默认目录、指定目录、同目录复用拒绝、历史目录不变、子会话继承、轻量入口调用及版本/锚点拒绝。安装后server.js语法检查通过。子会话继承的工程测试不等于真实子Agent验收。

### 重启后真实应用验收

- 默认目录：session-2026-10-10-17-54-52-4ed9c99e，未选择Workspace，实际创建E:/QAWorkspaces/2026-10-10-17-54-52-4ed9c99e。身份文件与工程索引一致，页面工作空间分组显示该目录。
- 指定目录：session-2026-10-10-17-55-45-c99a12af，从E:/Codex/测试智能体的“在此工作区新建对话”进入，实际Workspace为E:/Codex/测试智能体/2026-10-10-17-55-45-c99a12af，页面Session信息与索引一致。
- 两次均使用test_agent、TokenDance step-3.7-flash，由Agent各调用一次node scripts/project-action.mjs catalog并返回成功。未创建业务run、未派发子Agent、未执行测试或安装依赖。
- 历史会话session-2026-10-10-15-56-28-312cab4c重新打开后仍显示Workspace E:/Codex/测试智能体。未迁移历史文件，未解除其运行阻塞，未更改历史确认。
- 截图证据：output/workspace-acceptance/selected-workspace.jpg。此次指定目录验收产生的时间戳目录为运行数据，不应随工程源码提交。

验收边界：catalog成功证明实际总控可从新工作空间调用共享入口，但未独立证明所有环境变量传播、子Agent真实派发、实际产物隔离或外部目录依赖解析。本项新会话目录行为已核验，这些执行链路检查留到后续执行准备与真实完整复验；不宣称端到端已通过。默认目录会话回复提及/etc/profile和locale警告，入口未失败，警告原因尚未专项排查。

按逐项确认约定，本轮停在第4项，未进入第5项执行准备检查，未提交GitHub。
