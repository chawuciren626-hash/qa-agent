# 小程序开发者工具执行参考

## 后端边界

- 当前后端：微信开发者工具 CLI + `miniprogram-automator`。
- 不包含：真机、`miniprogram-ci` 上传、微信账号登录、云端设备、性能或安全测试。
- `target_kind=device` 只返回阻塞，不执行任何设备动作。
- 所有截图和快照标记 `evidence_mode=devtools`。

## 环境变量与 CLI

| 名称 | 用途 |
| --- | --- |
| `WECHAT_DEVTOOLS_CLI` | 开发者工具 CLI 路径（`cli.bat` 或 macOS `cli`） |
| `MINIPROGRAM_PROJECT` | 包含 `project.config.json` 的项目目录 |
| `MINIPROGRAM_TARGET` | `devtools`（默认）或 `device` |
| `MINIPROGRAM_DEVTOOLS_PORT` | 自动化端口，默认 `9420` |

```powershell
node scripts/miniprogram-task-cli.mjs --run-dir <run-dir> --operation-file <operation.json> --project <project-dir>
```

CLI 成功时输出完整回执 JSON。`status` 不是 `ok` 或 `needs_inspection` 时退出码为 1；参数错误退出码 2。

## 运行目录与证据

| 路径 | 内容 |
| --- | --- |
| `execution/miniprogram-receipts/<request_id>.json` | 每个操作的回执 |
| `execution/miniprogram-receipts/<request_id>.intent.json` | 副作用操作执行前的 intent |
| `execution/miniprogram-evidence/<request_id>.preflight.json` | `doctor` 预检 |
| `execution/miniprogram-evidence/<request_id>.snapshot.json` | 页面与元素快照 |
| `execution/miniprogram-evidence/<request_id>.observation.json` | 断言实际值、超时与证据索引 |
| `execution/miniprogram-evidence/<request_id>.png` | 截图 |
| `execution/miniprogram-session.json` | 当前活动会话 |
| `execution/miniprogram-sessions/<session_id>.json` | 结束后归档或阻塞会话 |
| `execution/miniprogram-results.json` | `finish` 生成的测试结果 |

证据路径必须位于运行目录内；路径越界会被拒绝。

## 操作 JSON

### doctor

```json
{"type":"doctor","request_id":"doctor-1","target_kind":"devtools"}
```

### start

```json
{"type":"start","request_id":"start-1","project_dir":"E:/project","target_kind":"devtools","port":9420,"timeout_ms":20000}
```

### snapshot

```json
{"type":"snapshot","request_id":"snapshot-1","screenshot":true}
```

### tap + assert

```json
{
  "type":"tap",
  "request_id":"login-1",
  "target":{"by":"id","value":"login-btn"},
  "assertion":{
    "condition":"page",
    "value":"orders/index",
    "match":"contains",
    "case_id":"MP-LOGIN-01",
    "title":"登录后进入订单页",
    "expected":"当前页面为 orders/index"
  }
}
```

### input secret

```json
{"type":"input","request_id":"password-1","target":{"by":"id","value":"password"},"text":"<password>","secret":true}
```

回执只保留 `value_length` 和 `value_sha256`。

### assert text/data

```json
{"type":"assert","request_id":"status-1","condition":"text","target":{"by":"id","value":"order-1001-status"},"value":"待支付","case_id":"MP-ORDER-01","title":"订单初始状态","expected":"待支付","timeout_ms":5000}
```

```json
{"type":"assert","request_id":"data-1","condition":"data","path":"orders[0].status","value":"待支付","case_id":"MP-DATA-01","title":"页面数据状态","expected":"待支付"}
```

### screenshot / finish

```json
{"type":"screenshot","request_id":"shot-1"}
```

```json
{"type":"finish","request_id":"finish-1","screenshot":true,"summary":"登录与订单取消","limitations":["只验证开发者工具"]}
```

## 回执状态

| status | 含义 |
| --- | --- |
| `ok` | 动作执行成功或断言通过；没有断言的动作仍不代表用例通过 |
| `failed` | 断言不满足或结束结果为失败；需要复核产品、脚本或数据 |
| `blocked` | 参数、定位、环境或会话阻塞；未形成通过结论 |
| `needs_inspection` | 写操作的 intent 存在但没有回执，或同 ID 内容冲突；不得重放 |

`failure_category` 取值：`none`、`script_issue`、`environment_issue`、`needs_review`。

## 失败定位顺序

1. 读回执 `reason`、`failure_category`、`diagnostic`、`do_not_replay`。
2. 看 `evidence_paths` 中的截图、快照、observation。
3. 开发者工具中确认编译状态、当前页面、控制台错误和网络状态。
4. 若会话 `blocked`，先检查 `execution/miniprogram-sessions/` 与 intent；确认工具恢复后再 `start resume_blocked=true`。
5. 任何 `needs_inspection` 都必须先核实实际业务状态，不能直接重试。

## 与真机验证的区别

| 维度 | 开发者工具 | 真机 |
| --- | --- | --- |
| 页面渲染 | 近似 | 真实微信客户端 |
| 设备能力、权限、性能 | 不覆盖 | 需单独验证 |
| 登录态与账号 | 不读取真实凭据 | 需明确授权与凭据管理 |
| 本次是否支持 | 是（本后端） | 否（返回阻塞） |

真机接入需要新的设备/账号授权、后端与证据契约，不能复用本 Skill 的截图或断言冒充真机结果。
