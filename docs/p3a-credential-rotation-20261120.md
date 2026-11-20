# P3a 延伸切片：凭据轮换检测收口——"密码改了"不再是执行时的惊喜 — 2026-11-20

## 0. 一句话

§6.1 的落点：环境密码改了，任务在执行时以"登录失败"暴露，归因容易误判成脚本坏了。本轮把「凭据引用与基线不一致 → **前置 warning 告警 + 归因点名先查凭据**」这条链真正接通——机制（指纹/比对/warning 语义）上一轮就有，缺的是**没人喂**。

## 1. 诚实盘点：哪些是已有的，缺的到底是什么

| 环节 | 状态（本轮前） |
|---|---|
| `credential_fingerprint(refs)`（只收引用、拒绝明文） | ✅ 已有（`baseline.py`） |
| 比对规则（指纹不同 → warning；一侧未纳 → info） | ✅ 已有（`_cmp_credentials`，已接进 `compare_baseline`） |
| `verdict` 定级（warning → `comparable_with_warnings`，不 blocking） | ✅ 已有 |
| **生产链传 `credential_refs`** | ❌ 只有测试夹具传过。基线 credentials 恒为 None，指纹机制空转 |
| **计划的真实引用形态被指纹接受** | ❌ 计划里是 `${cred:...}` 占位（irval `REF_NAMESPACES` 认可），指纹正则只认 `scheme://` 与 `ENV_NAME`——即使有人传也会被拒 |

## 2. 三处改动

1. **`credential_fingerprint` 接受声明性占位**：新增 `${cred:...}` / `${env:...}` 形态（与 irval `REF_NAMESPACES` 同源）。**刻意不收 `${data.*}` / `${ctx.*}`**：那是变量池取值（业务数据、会话 token），指纹跟着它们漂会把"测试数据变了"误报成"凭据轮换了"。明文拒绝闸不变。
2. **`replay()` 从计划顶层 `credentials: [...]` 声明自动收集**，并入 `baseline_config.credential_refs`（与调用方显式传入的去重并集）。理由：计划最清楚这次登录哪个账号，不该要求调用方记得转抄。**`baseline_config=None` 仍是"不采"**——采集开关不取决于计划内容，否则同一个调用方两次调用行为不同，排障时猜不到基线为什么忽然出现；这种组合在报告 `credentials.into_baseline=false` 如实标出（含 abort 路径）。
3. **归因器在 warnings 档点名凭据漂移**：凭据 changed 的 warning 已计入档位压 product 置信度，本轮补的是 notes 里的具体指向——"登录/认证类失败先查凭据与会话，不要先改脚本"。阴性对照钉住：没有凭据漂移时不出现这条提示，不做成万金油备注。

## 3. 语义边界

- **warning 不是 blocking**：凭据轮换不必然导致失败（会话复用可能仍然通着），所以只降级可比性并提示，不拦截执行。
- **检测的是"引用集合变了"**：引用带版本（`@v1`→`@v2`）或换账号可检测；引用不变、**原地改密文值**检测不到——引擎侧没有密钥值解析器，为检测轮换把明文引进引擎链路不值得。密钥值轮换若配版本化引用即可被覆盖；这是对凭据管理的明确要求，不是本层的缺陷。
- V-05（凭证明文闸）对本轮无冲突：`${...}` 是引用形态，本来就在白名单。

## 4. 验收

| 套件 | 新增 |
|---|---|
| `smoke_baseline.py` | +2：占位形态接受与顺序无关；变量池引用/嵌套/大写命名空间/明文一律拒 |
| `smoke_preflight_replay.py` | +2：声明→基线指纹→轮换出 warning 漂移的全链路（真靶子两轮重放）；不采基线时如实标注且不落盘基线文件 |
| `smoke_attribution.py` | +2：凭据漂移出具体提示；无凭据漂移不出提示 |

回归：tools / authorization / maps / web_engine / run_trace 全 PASS；`ci:contract` A1-A4 + B1-B4 PASS；`check-capability-source` PASS。

## 5. 未做（下一切片）

- **§6.2 的另一半：阶段 token 预算与超限行为进契约**——需要先探阶段 agent 的装配点与契约载体，独立成片。
- 渠道"连通性自检"按钮 → 运行时健康状态（管理端 UI，按铁律先出原型）。
- 凭据轮换的**心跳式**复检（现在只在 preflight/replay 采集时比对；长跑中段轮换检测不到）。
