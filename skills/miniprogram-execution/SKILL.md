---
name: miniprogram-execution
description: 通过微信开发者工具自动化后端执行小程序启动、页面操作、UI/数据断言、截图与失败取证；区分开发者工具验证与真机验证，结果未知时不重放，供自动化执行角色在小程序派发范围内使用。
metadata:
  version: '1.0.0'
  scope: wechat-devtools-automator-backend
---

# 小程序执行 Skill

本 Skill 指导在**已授权**的微信小程序项目上执行一条可追溯的测试链路。当前实现为微信开发者工具 + `miniprogram-automator` 后端，不连接真机，不调用 `miniprogram-ci` 上传代码，也不读取微信账号凭据。

先确认派发范围：项目目录、AppID 或合成身份、是否允许启动开发者工具、允许操作的动作、是否允许截图。缺少开发者工具、自动化依赖或项目配置时明确报告阻塞，不把单元测试、截图或历史材料当作真实业务验收。

## 核心原则

1. **开发者工具不等于真机**：所有结果标记 `target.kind=devtools`、`real_device=false`。真机兼容性、微信客户端差异、机型与性能不在本 Skill 证明范围内。
2. **先观察再操作**：`doctor` 预检后 `start`，再用 `snapshot` 确认当前页面与可定位元素。页面变化后重新观察，不复用失效元素。
3. **动作成功不等于用例通过**：`tap/input/start` 无断言时回执为 `ok`，但只代表动作被执行。业务结论必须由带 `case_id`、`title`、`expected` 的断言产生。
4. **断言只证明开发者工具 UI/页面数据层**：`verification_scope.layer=miniprogram_devtools_ui` 不证明后端持久化、网络服务、其他客户端或性能。
5. **结果未知不重放**：回执 `status=needs_inspection`、`do_not_replay=true` 或缺少写回执时，先检查证据与开发者工具状态，再决定人工核实；不得用同一请求重试写操作，也不得换 ID 猜测重放。
6. **会话被阻塞时停止**：基础设施异常会把会话置为 `blocked`。确认开发者工具可用后才用 `resume_blocked=true` 开启新会话；旧会话保留在 `execution/miniprogram-sessions/`。
7. **敏感数据不外泄**：密码、令牌设置 `secret=true`；回执只记录长度和 SHA-256。截图可能仍含敏感内容，交付时说明。
8. **一次断言一个用例**：每个断言的 `case_id` 唯一；重复 `case_id` 被拒绝，不覆盖已有结果。

## 操作流程

### 1. 环境检查

`doctor`：检查 `project.config.json`、`app.json`、AppID、开发者工具 CLI、`miniprogram-automator`、目标类型。结果写入 `execution/miniprogram-evidence/<request_id>.preflight.json`。

- `status=ready` 才进入启动；`blocked` 时读取 `blockers[0].id` 与 `reason`，按真实原因报告。
- `touristappid` 只表示合成/游客项目，不能当作生产 AppID 验收。
- `target_kind=device` 会报告 `real_device_not_supported`，不会假装打开真机。
- 不要把 `doctor` 成功当作业务可用。

### 2. 启动与观察

`start`：需要 `operation.project_dir` 或 CLI `--project`。可选 `devtools_cli`、`port`、`resume_blocked`、`timeout_ms`。

- 开发者工具启动后轮询 `currentPage()`；无页面时按 `app_error` 阻塞并保留会话。
- 首次页面快照写入 `execution/miniprogram-evidence/<request_id>.snapshot.json`。
- 启动回执中的 `page_path` 只说明当前页面，不证明业务预期。

`snapshot`：返回页面路径、页面数据摘要、元素文本摘要，以及截图（`screenshot=false` 可关闭）和快照 JSON。

### 3. 操作与断言

`tap`：必须提供 `target`。定位支持 `by: id|class|text`、`match: exact|contains`、`index`。多元素匹配按 `locator_ambiguous` 阻塞，不猜测；优先使用稳定 `id`。

`input`：`target` + `text`。敏感内容设置 `secret=true`，回执不包含原文。输入是否触发页面事件取决于小程序控件，必须用断言确认业务结果。

`wait`：等待 `visible/not_visible/text/page/data` 条件成立；超时返回 `blocked`，不登记为通过。

`assert`：只读断言，支持：
- `page`：当前页面路径。
- `visible/not_visible`：目标元素是否存在。
- `text`：目标元素文本。
- `data`：页面 `data()` 的路径值。

断言失败只说明开发者工具当前状态不符合预期，不能直接判定产品缺陷；证据不足时保留 `needs_review`。

`screenshot`：保存 PNG 并记录 SHA-256；校验 PNG 签名，非图片输出视为失败。

### 4. 结束与交付

`finish`：生成 `execution/miniprogram-results.json`（与 `schemas/test_result.schema.json` 兼容）、证据索引和限制说明。

- 无任何断言时状态为 `blocked`，原因 `needs_review`：观察和动作不是通过用例。
- 存在失败断言时状态 `failed`；全部通过为 `completed`；会话被阻塞或断言受阻为 `blocked`。
- 交付时写明 `target.kind=devtools`、未验证真机、未验证后端持久化；不要用断言数量替代业务用例数量。

## 失败与恢复

| 回执 | 含义 | 处理 |
| --- | --- | --- |
| `blocked` + `script_issue` | 定位歧义、参数错误、重复用例 | 修正参数或定位后使用新请求；原回执保留 |
| `blocked` + `environment_issue` | 开发者工具缺失、连接断开、会话阻塞 | 检查工具与证据；恢复后显式 `start` 并 `resume_blocked=true` |
| `failed` + `needs_review` | 断言未满足 | 结合截图、快照、页面数据判断产品、脚本或数据原因 |
| `needs_inspection` + `action_outcome=unknown` | 写操作可能已执行但结果未知 | 先查询实际状态；不得重放，由人工核实 |
| `duplicate=true` | 幂等命中旧回执 | 直接使用旧结果，不重新执行 |

断开连接本身不是产品失败。恢复步骤：`doctor` 确认工具可用 → 检查 `execution/miniprogram-sessions/`、未决 intent 与证据 → 确认开发者工具可用后 `start` + `resume_blocked=true` → 重新观察再继续未执行步骤。

## 请求格式与证据

操作参数、证据目录、会话文件、CLI 与典型链路见 [references/miniprogram-devtools-ops.md](references/miniprogram-devtools-ops.md)。所有路径相对当前运行目录；证据路径不得越界。

需要 Appium/真机、`miniprogram-ci` 上传、云真机或其他平台时，回到公共升级流程，不在本 Skill 内假设未实现的能力。
