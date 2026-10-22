# PenguinHarness 配置即代码

本目录将可公开的测试 Agent 指令和项目 Skill 映射纳入 Git，以便在新机器或新项目中恢复同一套测试能力。

## 受版本管理的内容

- `penguin/agents.json`：七个 Agent 的 ID、指令源和 Skill 映射。
- `penguin/agents/<agent_id>/AGENTS.md`：总控与专业 Agent 的公开角色指令。
- `penguin/command-runtime.md`：七个角色共同的项目命令入口规则，由清单的`shared_instructions`声明。
- `skills/<skill>/`：项目 Skill 入口与按需加载的references、templates、scripts、assets和许可证。
- `scripts/sync-penguin-agents.mjs`：检查和同步脚本。

配置同步不会读取、复制或提交 `system_config.yaml`、`.vault.toml`、模型密钥、账号、Token、真实环境地址或运行产物。维护者显式执行的脱敏安全检查与配置同步分开，规则见[凭据安全维护](credential-security.md)；vault不等同于加密保险库。

## 安装与同步

1. 在 PenguinHarness 中先创建以下 Agent：`test_agent`、`requirement_analysis_agent`、`test_point_agent`、`test_case_agent`、`automation_execution_agent`、`defect_analysis_agent`、`test_report_agent`。
2. 进入项目根目录，先检查本机运行时配置：

```powershell
npm run penguin:agents:check
```

3. 仅在确认要以仓库版本覆盖公开指令与项目 Skill 后执行：

```powershell
npm run penguin:agents:sync
```

默认目标目录为当前用户的 `~/.penguin/data/default_project/agents`。如 PenguinHarness 使用其他数据目录，通过环境变量或参数指定：

```powershell
$env:PENGUIN_AGENT_ROOT = 'D:\PenguinData\agents'
npm run penguin:agents:check
node scripts/sync-penguin-agents.mjs --apply --target-root='D:\PenguinData\agents'
```

同步覆盖清单声明的组合 `AGENTS.md`、完整项目Skill资源，以及总控qa-delegation-guard和子Agent的qa-stage-boundary钩子文件；project.json由本机工程/Agent目录生成，不复制其他机器的绝对路径。不会删除Agent自带的其他Skill，也不会创建缺失Agent。同步后需在PenguinHarness中新开对话，确保新会话读取最新指令。钩子同步不是宿主安装补丁，不能替代宿主适配检查。

安装后的`AGENTS.md`由角色指令源和共同命令规则组合生成，检查时也比较组合内容，不能再用角色源文件单独与安装文件逐字对比。Skill资源按完整目录同步，并逐文件比较字节。所有源和目标路径在写入前检查，损坏引用、链接目录和缺失角色会阻止本次同步；此预检不等于磁盘故障时的事务回滚。不会执行Skill附带脚本，也不删除未列入当前源的本地文件。

以上npm命令供维护者在正常终端使用，不是用户每次对话的步骤。PenguinHarness总控使用结构化project-action入口，具体调用身份及字段以catalog和[公共运行规则](../penguin/command-runtime.md)为准。doctor仅在确有运行时依赖问题时，由有命令权限的专业角色或维护者按需调用，不作为每次开场步骤；不使用npm/npx或嵌套cmd/bash补救环境故障。同步检查由维护者直接运行`node scripts/sync-penguin-agents.mjs`。

## 验收

执行 `npm run penguin:agents:check` 返回 `in_sync`，仅证明其检查的公开指令、Skill和hook与当前工程一致；不证明模型已加载、宿主补丁已安装或真实业务测试通过。还需分别核对宿主适配与真实会话行为。

新机器还需由维护者准备模型配置、依赖和宿主适配。统一安装器用法见[桌面适配](delivery-interaction.md)；当前适配仅针对已检查的PenguinHarness版本，不是通用一键安装。修改宿主文件前正常退出应用，安装后按需重启；普通文档修改无需重启。任务目录规则见[使用指南](user-guide.md)，当前待办见状态页（本地历史记录，不随源码分发）。

## 补充专业能力与资源检查

新增test-design-methods、qa-investigation、api-testing，角色总数仍为7。它们按需从主Skill/角色指令加载，不更改保存计划中的主skills列表或历史运行。Skill版本保存在frontmatter的metadata.version，保留原版本信息。

维护时先运行`npm run skills:check`检查入口、包内链接、角色/工作流映射及发布清单；运行`npm run skills:contracts`验证完整目录同步。`in_sync`证明源与安装文件一致，不证明模型已读取或业务测试通过。变更详情与验证边界见本次增强记录（本地历史记录，不随源码分发）。
