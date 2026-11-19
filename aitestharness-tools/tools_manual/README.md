# tools_manual —— 一次性取证与验收脚本（**不属于产品，CI 不引用**）

这些脚本是"为了搞清楚一个具体环境长什么样"而写的临时工具：登录、dump 控件指纹、
捞接口路径、验证某个选择器写法是否命中。它们的特点是**硬编码目标环境**，因此：

- **不参与构建，不被测试引用，不进 CI**；
- **不要 import 到产品代码**（`aitestharness_tools/` 里不含也不应含本目录的依赖）；
- 换环境时**不要改这些脚本复用**，直接按需新写——改出来的"通用版"往往两头不靠。

## 保留哪些、为什么

| 脚本 | 保留理由 |
|---|---|
| `run_real_plan.py` | 真机跑任一剧本，输出 exec IR。**验收入口**，有长期价值 |
| `cleanup_residue.py` | 只跑 `plan.teardown`。清理补偿入口，清理失败时必需 |
| `establish_session.py` | 人工过一次验证码登录 → 落 `storageState`。会话前置 |
| `replay_real.py` | 真机 N 轮重放，验确定性 |
| `probe_cancel_dialog.py` | **示例价值**：阻断后端请求后再点危险按钮、只看确认框。危险操作探明的标准手法 |
| `diag_user_query.py` | 独立核验某账号状态（不看剧本自述）。验收时必须用它复核 |
| `dump_user_row_actions.py` | dump 表格行内操作与菜单，写新剧本前必做 |
| `diag_row_selector.py` | 实测若干选择器写法的命中数（含阴性对照）。定位写法的判据来源 |

已删除的一次性中间产物：`learn_create_cancel.py`（已被 `plan-bbiao-user-crud.yaml` 取代）、
`dump_add_user_dialog.py`、`establish_session2.py`、`session_bbiao.py`、`find_page_chunk.py`
（这最后一个是用页面内检索定位前端 chunk 的尝试，结论是懒加载命名不可预测，手段无效）。

## 硬编码说明

`BASE` 一律从环境变量 `AITH_SUT_BASE` 读，缺省值仅供该环境使用。凭据同理，只从
`AITH_SUT_USERNAME` / `AITH_SUT_PASSWORD` 读，脚本里不出现账号密码。
