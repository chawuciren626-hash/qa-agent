# PenguinHarness 配置即代码

本目录将可公开的测试 Agent 指令和项目 Skill 映射纳入 Git，以便在新机器或新项目中恢复同一套测试能力。

## 受版本管理的内容

- `penguin/agents.json`：七个 Agent 的 ID、指令源和 Skill 映射。
- `penguin/agents/<agent_id>/AGENTS.md`：总控与专业 Agent 的公开角色指令。
- `skills/<skill>/SKILL.md`：项目 Skill 的维护源。
- `scripts/sync-penguin-agents.mjs`：检查和同步脚本。

不会读取、复制或提交 `system_config.yaml`、`.vault.toml`、模型密钥、账号、Token、真实环境地址或运行产物。

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

同步只覆盖清单中声明的 `AGENTS.md` 和项目 Skill；不会删除 Agent 自带的其他 Skill，也不会创建缺失 Agent。同步后需在 PenguinHarness 中新开对话，确保新会话读取最新指令。

## 验收

执行 `npm run penguin:agents:check` 返回 `in_sync`，并确认新建总控会话可以识别六阶段编排与八个项目 Skill，即表示运行时配置与仓库版本一致。
