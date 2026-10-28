---
name: android-execution
description: 通过ADB后端在真实Android设备或模拟器上执行应用启动、控件操作、UI断言、截图与失败取证；区分动作完成、断言通过与基础设施异常，结果未知时不重放，供自动化执行角色在Android派发范围内使用。
metadata:
  version: '1.0.0'
  scope: android-adb-backend
---

# Android 执行 Skill

本 Skill 指导在**已授权**的 Android 设备或模拟器上执行一条可追溯的测试链路。当前实现为 ADB 后端：通过 `adb shell input`、`uiautomator dump`、`screencap`、`logcat` 完成观察与操作，不创建 Appium 会话，也不运行 Espresso／Compose／XCUITest 套件。

先确认派发范围：平台为 android、包名、设备序列号、授权动作类型。没有安装包、设备或账号时明确报告阻塞，不把模拟、历史材料或合成数据当作真实验收。

## 核心原则

1. **先观察再操作**：`snapshot` 或 `health` 确认前台应用与当前页面，再定位控件。页面变化后重新观察，不复用失效坐标。
2. **动作成功不等于用例通过**：`tap/input/key/swipe/start` 无断言时回执为 `ok`，但只代表动作被执行。业务结论必须由带 `case_id`、`title`、`expected` 的断言产生。
3. **断言只证明 UI 层**：默认 `verification_scope` 为 `android_ui`，不证明后端持久化、其他设备或性能。需要接口核验时按授权另行接入，并分别记录。
4. **结果未知不重放**：回执 `status=needs_inspection` 或 `do_not_replay=true` 时，先检查设备状态与证据，再决定人工核实；不得用同一请求重试写操作，也不得换 ID 猜测重放。
5. **会话被阻塞时停止**：基础设施异常会把会话置为 `blocked`。检查证据后，只有确认设备可用才用 `resume_blocked=true` 开启新会话；旧会话保留在 `execution/android-sessions/`。
6. **敏感数据不外泄**：密码、令牌等设置 `secret=true`；回执只记录哈希和长度。日志与 UI 证据会脱敏，但截图像素可能仍含敏感内容，交付时说明。
7. **一次操作一次断言**：多个业务条件分别断言，各自的 `case_id` 唯一；重复 `case_id` 会被拒绝，不覆盖已有结果。

## 操作流程

### 1. 环境检查

`doctor`：检查 adb、SDK、Java、Appium 端点、设备连接、启动完成、锁屏、前台 Activity、目标包与启动入口。结果写入 `execution/android-evidence/<request_id>.preflight.json`。

- `status=ready` 才进入启动；`blocked` 时读取 `blockers[0].id` 与 `reason`，按真实原因报告（无设备、未启动、未安装、锁屏等）。
- Appium 不可用只是能力限制，不是设备故障；ADB 链路仍可继续。
- 不要把 `doctor` 的成功当作业务可用。

### 2. 启动与观察

`start`：需要 `package`。可选 `activity`（`package/Activity`）、`device`、`resume_blocked`、`unlock`、`timeout_ms`。启动后轮询前台包名，返回 `focused`、`current_activity`、`resolved_activity`。

- `focused=false` 且回执 `blocked/app_focus_timeout`：应用可能已启动但未获得前台，重新 `health` 或 `snapshot` 观察，不重复点击启动按钮。
- 首屏出现后先用 `snapshot` 获取控件树；`limit` 控制返回节点数量。
- 判断启动成功要依据前台 Activity 与首屏可见内容，而不是 `am start` 的 `Status: ok`。

`health`：只读，返回前台 Activity、屏幕状态与会话状态；`next_action` 指向阻塞后的正确处理。它不依赖已有会话，可用于排查。

`snapshot`：返回当前 Activity、UI 树摘要，以及截图、UI XML、设备事实证据。

### 3. 操作

`tap`：必须提供 `target`。定位支持 `by: text|id|desc|class`、`match: exact|contains`、`index`。多节点匹配时按工程错误阻塞，不猜测；用更精确的定位或 `index` 消除歧义。

`input`：`text` 仅支持可安全传给 `adb shell input text` 的字符（ASCII 可见字符与常用符号）。中文、emoji 或 shell 元字符会被拒绝，标记 `unsupported_input`；不要改写文本冒充已输入。敏感内容设置 `secret=true`。

`key`：支持 `back/home/enter/delete/tab/escape/menu/app_switch/search/volume_up/volume_down`。

`swipe`：`from`/`to` 为 `[x, y]`，可选 `duration_ms`。

`wait`：等待可见、不可见、文本或 Activity 条件成立；超时返回 `blocked/needs_review`，不登记为通过。

`assert`：只读断言，支持 `visible/not_visible/text/activity`。失败只说明当前 UI 不符合预期，不能直接判定产品缺陷。

`screenshot`：保存 PNG 并记录 sha256；校验 PNG 签名，非图片输出视为失败。

### 4. 结束与交付

`finish`：生成 `execution/android-results.json`（与 `schemas/test_result.schema.json` 兼容）、证据索引和限制说明。

- 无任何断言时状态为 `blocked`，原因 `needs_review`：观察和动作不是通过用例。
- 存在失败断言时状态为 `failed`；全部通过为 `completed`；会话被阻塞或断言受阻为 `blocked`。
- 交付时说明 ADB 后端边界、未验证范围、设备与系统版本；不要用断言数量替代业务用例数量。

## 失败与恢复

| 回执 | 含义 | 处理 |
| --- | --- | --- |
| `blocked` + `failure_category=script_issue` | 定位歧义、非法输入、重复用例、越权包等 | 修正参数或定位后使用新请求；原回执保留 |
| `blocked` + `failure_category=environment_issue` | 设备离线、锁屏、未安装、会话阻塞 | 检查设备与证据；恢复后显式 `start` 并 `resume_blocked=true` |
| `failed` + `needs_review` | 断言未满足 | 结合截图、UI、日志判定产品、脚本或数据原因；证据不足保留待复核 |
| `needs_inspection` + `action_outcome=unknown` | 副作用可能已执行但结果未知 | 先查询实际状态；不得重放，必要时由人工核实 |
| `duplicate=true` | 幂等命中旧回执 | 直接使用旧结果，不重新执行 |

断开连接本身不是产品失败。恢复步骤：`health` 确认会话与设备状态 → 检查 `execution/android-sessions/` 与未决 intent → 确认设备可用后 `start` + `resume_blocked=true` → 重新观察再继续未执行步骤。

## 请求格式与证据

操作参数、证据目录、会话文件和典型链路见 [references/android-adb-ops.md](references/android-adb-ops.md)。所有路径相对当前运行目录；证据路径不得越界。

需要扩展 Appium、原生测试套件或其他平台时，回到公共升级流程，不在本 Skill 内假设未实现的能力。
