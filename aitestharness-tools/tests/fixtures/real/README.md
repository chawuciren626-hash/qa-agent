# fixtures/real —— 真机验收样例（**不是模板，不可抄**）

本目录下的剧本只服务于一件事：**在真实系统上验收执行器**，证明引擎能对真实
系统完成"读 → 写 → 验证 → 清理"。它们**不是产品资产**，也**不是新环境的起点**。

## 当前内容

| 文件 | 用途 | 有副作用 |
|---|---|---|
| `plan-bbiao-user-add.yaml` | 填表演练，最后一步刻意不点「创建用户」 | 无 |
| `plan-bbiao-user-crud.yaml` | 创建 1 个用户 → 列表验证 → 注销清理 | **有（写库）** |

对应环境：`bbiao-admin` 用户管理页。一次性取证脚本在同仓库 `tools_manual/`。

## 为什么不能当模板抄

这两个剧本里还有两类**只属于那个环境**的东西。抄走它们，等于把别人的环境假设
搬到自己的系统上，而且失败时会记成"产品缺陷"：

| 妥协点 | 本目录的写法 | 换环境必须怎么做 |
|---|---|---|
| 清理语义 | 注销 = 软删（状态改「注销」、行仍在、用户名不释放） | 先探明目标系统的移除语义，别假设"删除"存在 |
| 列表接口 | `POST /bbiao-backend/v2/sysEmployee/page` | 从实际网络请求里取，不要猜 |

**行定位已经不是妥协点了。** 原来只能用列序号钉死：

```yaml
css: 'tr.el-table__row:has(td:nth-child(3):has-text("x"))'   # 加一列就静默点到隔壁列
```

现在用作用域表达，列号由引擎按**表头文本**在运行时解析：

```yaml
target:
  scope:
    container: {css: "tr.el-table__row"}
    where: [{column_name: 用户名, text: qa_probe}]
  css: 'button:has-text("注销")'      # 不给内层指纹则定位"筛出来的那一行"本身
```

`column`（列序号）仍然保留，但会在 exec IR 的 `locator.positional` 里标为 `true`——
它代表位置假设，与 `column_name` 的语义定位不是同一可靠性等级，报告里必须能区分。
写法示例见 `tests/fixtures/web/` 与 `smoke_web_engine.py` 的 `test_scope_*` 用例。

## 通用剧本在哪里

与具体系统无关、CI 可重复跑的剧本在：

- `tests/fixtures/web/` —— 本地假页面，覆盖 10 动作 / 8 等待 / 9 断言
- `tests/fixtures/replay/` —— 重放与一致性

新环境接入时，先看 `tests/fixtures/web/` 了解剧本写法，再对目标系统单独 dump
指纹写新剧本；**不要复制本目录**。

## 跑之前必须知道

1. **会改真实数据**：`plan-bbiao-user-crud.yaml` 会真的创建账号。执行前需要明确许可，
   且必须在**授权闸**下执行：`tools_manual/issue_approval.py` 签发，
   `run_real_plan.py --approval <file>` 执行。没有授权记录时引擎拒绝运行且不启动浏览器。
2. **凭据只从环境变量读**（`AITH_SUT_USERNAME` / `AITH_SUT_PASSWORD`），任何剧本里都不写账号密码。
3. **重跑要换用户名**：注销不释放用户名，同名再创建会被后端拒绝。剧本头部标了要改的位置。
4. **清理失败不会自动重试**：用 `tools_manual/cleanup_residue.py` 单独清，不要重跑整个剧本
   （重跑会先造一个新账号，用制造新副作用的方式清理旧残留，方向是反的）。
