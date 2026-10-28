# Android ADB 执行：参数、证据与链路

本文件是 `android-execution` Skill 的参考，描述已实现的 ADB 后端契约。字段以 `scripts/android-task.mjs` 的校验为准；公共动作和调度接入由宿主契约提供。

## 操作字段

所有操作共有：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | `doctor/health/start/stop/snapshot/tap/input/key/swipe/wait/assert/screenshot/finish` |
| `request_id` | 是 | 幂等键，`[A-Za-z0-9._-]`，1–80 字符；同一 ID 不重复执行 |
| `run_id` | 否 | 结果中的运行标识；缺省为会话默认值 |
| `device` | 否 | 设备序列号；与已有会话不一致会拒绝 |
| `package` | 否 | 包名；`start` 必填，其他操作不得与会话包名冲突 |
| `timeout_ms` | 否 | 启动、等待或断言超时，最大 300000 |
| `assertion` | 否 | 随动作断言，见下节 |

操作专属：

| 操作 | 字段 |
| --- | --- |
| `start` | `package`、`activity`、`unlock`、`resume_blocked` |
| `tap` | `target` |
| `input` | `text`、`target`（先点击聚焦）、`secret` |
| `key` | `key`（枚举值） |
| `swipe` | `from`、`to`、`duration_ms` |
| `wait` | `target`／`condition`／`assertion`、`timeout_ms`、`poll_ms` |
| `assert` | `condition`、`target`、`value`、`match`、`case_id`、`title`、`expected`、`timeout_ms` |
| `snapshot` | `screenshot`、`limit` |
| `finish` | `summary`、`limitations`、`screenshot` |
| `doctor` | `appium_url`、`allow_locked` |

`target`：`{ by: "text"|"id"|"desc"|"class", value, match?: "exact"|"contains", index?: 0-99 }`。

`assertion`（随动作）：`{ condition, target?, value?, match?, case_id, title, expected, timeout_ms?, poll_ms? }`。`visible/not_visible` 需要 `target`；`text/activity` 需要 `value`。`wait` 的断言不需要用例字段。

`condition` 语义：

- `visible`：匹配节点存在且宽高均大于 0。
- `not_visible`：没有匹配节点。
- `text`：无 `target` 时按全树文本匹配；有 `target` 时比较该节点文本。
- `activity`：前台组件字符串包含 `value`。

## 状态与失败分类

| 字段 | 取值 |
| --- | --- |
| 回执 `status` | `ok`、`blocked`、`failed`、`needs_inspection` |
| `failure_category` | `none`、`product_defect`、`script_issue`、`environment_issue`、`test_data_issue`、`needs_review` |
| `action_outcome` | `not_executed`、`completed_with_error`、`unknown` |
| `do_not_replay` | 结果未知的副作用为 `true` |

常用诊断类别：`adb_not_found`、`adb_timeout`、`adb_connection_lost`、`device_not_found`、`device_offline`、`device_unauthorized`、`device_locked`、`device_not_booted`、`package_not_installed`、`package_not_allowed`、`launcher_unresolved`、`locator_not_found`、`locator_ambiguous`、`unsupported_input`、`session_blocked`、`no_active_session`、`duplicate_case_id`、`app_error`、`app_focus_timeout`。

基础设施与设备类类别映射为 `environment_issue`；参数、定位与用例问题映射为 `script_issue`；应用错误、焦点超时与断言失败映射为 `needs_review`。

## 目录与文件

| 路径 | 内容 |
| --- | --- |
| `execution/android-session.json` | 当前会话：状态、设备、包、用例、回执索引、证据、限制 |
| `execution/android-sessions/<session_id>.json` | 被归档的阻塞或已完成会话 |
| `execution/android-results.json` | `finish` 生成的测试结果 |
| `execution/android-receipts/<request_id>.json` | 每个请求的最终回执 |
| `execution/android-receipts/<request_id>.intent.json` | 副作用执行前的意图记录；用于识别结果未知 |
| `execution/android-evidence/<request_id>.*` | 截图、UI XML、日志、设备事实、断言观察与证据记录 |

证据记录中的 `missing` 列出采集失败项；设备不可用时后续采集会被跳过并记录原因，而不是伪造文件。

## 典型链路

```json
[
  {"type":"doctor","request_id":"doctor-01","device":"emulator-5554","appium_url":"http://127.0.0.1:4723/status"},
  {"type":"start","request_id":"start-01","package":"com.example.app","device":"emulator-5554"},
  {"type":"snapshot","request_id":"snap-01","limit":80},
  {"type":"assert","request_id":"assert-login","condition":"visible","target":{"by":"text","value":"登录"},"case_id":"TC-01","title":"登录页可见","expected":"启动后显示登录标题"},
  {"type":"input","request_id":"input-user","text":"tester01","target":{"by":"id","value":"com.example.app:id/username"}},
  {"type":"input","request_id":"input-pass","text":"SyntheticPass1","secret":true,"target":{"by":"id","value":"com.example.app:id/password"}},
  {"type":"tap","request_id":"tap-login","target":{"by":"text","value":"登录"},"assertion":{"condition":"visible","target":{"by":"text","value":"首页"},"case_id":"TC-02","title":"登录后进入首页","expected":"合法账号登录后显示首页","timeout_ms":10000}},
  {"type":"finish","request_id":"finish-01","summary":"登录主流程"}
]
```

命令行等价入口：

```sh
node scripts/android-task-cli.mjs --run-dir <运行目录> --operation '<JSON>'
```

## 边界与后续接入

- 仅 ADB：无 Appium 会话、无原生测试套件、无 iOS/Windows。
- `input text` 不支持非 ASCII 和 shell 元字符；需要时另行接入 ADBKeyboard 或 Appium。
- WebView 内容不保证出现在 UI 树；混合框架需先验证可访问性。
- 断言只覆盖 UI 状态；后端持久化、跨设备与性能未验证。
- 公共动作名、权限、阶段写入与结果汇入 `test_results.json` 由宿主统一接入；在动作未注册前，不宣称已通过调度执行。
