# 第2项：改名引用修复与应用数据根

日期：2026-10-12。工程根：`E:/Codex/AITestWorker`。

## 已实施

- `scripts/application-data.mjs`定义独立数据根，Windows默认`%LOCALAPPDATA%/AITestWorker`，支持显式绝对路径`QA_APP_DATA_ROOT`；拒绝与工程包含关系及目录链接重定向。环境变量覆盖须由启动应用和hook的同一环境继承，不通过会话对话临时修改。
- 新会话索引写入该目录的`session-workspaces`。hook优先读取新索引，无新索引时才兼容读取工程旧索引；新索引损坏或身份冲突不会悄悄回退。任务inputs/output仍在各自工作空间，不合并到应用数据目录。
- 安装器新增`--relocate`：核验已装文件、原始备份哈希，以及当前文件能否由原始文件和旧导入路径精确重建，再生成新导入。修改前备份bundle和安装记录，写入异常尝试还原两者。`--check`会报告失效/不一致的旧导入，不能再仅凭安装记录声称可用。
- 新增`relocate-workspace-index.mjs`，默认只预检，`--apply`迁移空诊断会话的索引、身份标记和两个轻量入口。保留旧索引；业务run非空时列为待归档，不自动修改业务记录。每份被改写文件保存原字节备份和迁移前后SHA256。
- 同步总控hook本机路径，仅1份project.json变化，角色内容不变。同步前单独备份原project.json。
- 工作空间适配专项测试使用独立临时应用数据目录，并清理自己创建的测试目录，不再把本测试的索引写入真实用户数据根。

## 本机结果

用户正常退出PenguinHarness后确认进程已退出，再执行迁移。应用原静态导入由旧工程路径更新为`file:///E:/Codex/AITestWorker/scripts/penguin-workspace-adapter.mjs`。

应用数据根：`C:/Users/sbkjadmin/AppData/Local/AITestWorker`。

6份已有空绑定完成迁移：4份历史合成测试绑定、2份10月10日真实目录验收绑定。没有业务run迁移，不应将6份绑定描述为6次真实Agent验收。

迁移日志与文件备份：

`C:/Users/sbkjadmin/AppData/Local/AITestWorker/migrations/workspace-42a81e75-64e7-45f5-854e-0cad5a55ab8b/migration.json`

hook旧配置备份：

`C:/Users/sbkjadmin/AppData/Local/AITestWorker/migrations/hook-project-b41be5e8-f2ed-4621-91ec-c91743fa5f61.json`

服务bundle和安装记录的重定位前备份位于安装目录dist，文件名带`.relocation-<时间戳>.bak`；初始`.qa-workspace.original`备份未覆盖。

随后通过现有启动器启动PenguinHarness，59764端口在127.0.0.1与::1监听。安装检查为installed，server.js语法检查通过，角色同步检查in_sync。对17:54真实验收会话直接调用hook上下文绑定，得到新engine_root，外部session_root保持不变。这是进程/工程接口检查，不是实际Agent派发验收。

## 验证

- `npm run engineering:contracts`：165通过、0失败、0跳过。
- `npm run storage:contracts`：9通过、0失败、0跳过，与上一套存在重叠，不能累计称为174个独立测试。
- 专项覆盖应用数据路径拒绝、新索引不写工程、索引和标记重定位、旧索引保留、重复迁移、修改过的入口拒绝、业务run延后以及安装补丁精确校验。
- 本次未做改名后的浏览器新会话或真实子Agent端到端验证，未执行产品测试，未提交GitHub。

## 未迁移内容与后续边界

- PenguinHarness原生聊天数据库、trace、附件没有移动或改写。
- 17:55验收会话的文件随工程改名移动，标记与索引已更新，但原生会话仍可能指向旧workspace；日志明确标为`native_workspace_rebind_required`，不声称可以直接恢复聊天。
- 其他旧会话原工作空间引用、历史业务run、旧索引、旧日志和产物保留。旧路径对应的维护脚本没有批量改写或执行，历史记录中的旧路径不全局替换。
- 新索引已外置不代表所有运行数据均已外置：legacy模式、工程回归和旧脚本仍可能写工程output/inputs。根时间戳目录、根scratchpad、打包白名单与完整防回流属于后续项。
- 下一项为历史归档：先确认归档目的地和历史查阅方案，生成逐文件清单，复制并核对；不先删除原件，不解除旧会话停止状态。

## 维护命令与恢复要求

```powershell
node scripts/install-penguin-workspace-adapter.mjs 'D:/Program Files/PenguinHarness/resources/app' --check
node scripts/relocate-workspace-index.mjs 'E:/Codex/测试智能体' --check
node scripts/sync-penguin-agents.mjs
npm run storage:contracts
```

迁移工具应在应用正常退出后使用。运行中不迁移，不能用停止进程代替业务状态核查。`--apply`再次执行会验证当前标记与入口，再生成新的备份日志；不会覆盖冲突的新索引。迁移中途异常会把日志标为interrupted并中止，不自动删除文件；恢复时先对比每项before/after哈希，再按日志恢复原有文件、处理本次新增索引，并成套校验，不能单独还原一份标记。当前未提供无人值守跨崩溃恢复。

安装器`--restore`恢复未注入适配的原版server.js，不会把数据搬回去；不要将其与恢复“重定位前的适配版本”混为一谈。后者需要同时恢复对应bundle/安装记录备份，且旧工程路径必须存在，否则仍无法启动。
