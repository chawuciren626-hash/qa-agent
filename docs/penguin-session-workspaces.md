# PenguinHarness会话目录适配

## 使用规则

- 新建test_agent总控会话、未选择工作空间：在config/session-workspaces.json的default_workspace下创建时间戳加短ID文件夹。默认位置从安装布局及会话配置解析。
- 已选择工作空间：在所选目录下创建相同命名的独立会话目录，避免多次对话互相覆盖。
- 新总控会话拒绝选择工程根及其内部目录，以免程序与产物混存；请选择外部目录或留空。已有会话不因此自动搬移。
- 已有会话恢复：原workspace不变。未绑定的旧会话保持旧模式，不自动迁移。
- 子Agent使用父会话workspace，并在每次命令启动时继承父级QA_DIRECTORY_CONTEXT。不为子Agent再建目录。
- 仅测试总控的新会话启用创建规则，不改变其他Agent的默认工作空间行为。

## 文件布局

会话目录内有.qa-session.json身份标记、inputs、output/action-requests、output/runs以及两个轻量scripts入口。程序本体和node_modules仍共用工程目录，不重复安装。新索引写入%LOCALAPPDATA%/AITestWorker/session-workspaces，用于宿主hook绑定；支持QA_APP_DATA_ROOT绝对路径覆盖。工程output/session-workspaces仅作为旧索引兼容读取来源，不再写入新会话索引。

PenguinHarness原生聊天数据库、trace和上传附件仍由应用存储。它们未被搬到工作空间；工作空间存放任务文件，上传附件仍由归档动作复制到本run输入目录。不要把本次改造描述为聊天数据库迁移。

## 安装与回滚

`scripts/install-penguin-workspace-adapter.mjs` 是统一运行时安装器的兼容入口，接受应用 `resources/app` 目录及 `--check`、`--apply`、`--restore`、`--recover`。工作区与交付适配共同管理；宿主版本、文件锚点和原件哈希必须匹配，未知更新拒绝覆盖。安装、备份和恢复方式见[桌面适配](delivery-interaction.md)。

回滚使用--restore后重启应用。回滚不删除会话文件。应用升级可能覆盖适配，须重新检查，不能强行套旧补丁。适配代码位于工程scripts/penguin-workspace-adapter.mjs；工程移动后需要重新安装校验，当前安装引用绝对模块路径。
