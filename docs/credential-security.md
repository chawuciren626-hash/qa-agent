# 凭据安全维护

本规范用于维护者，不是测试用户的前置审查步骤。测试Agent不需要读取模型密钥、宿主令牌或私有浏览器连接信息才能完成业务任务。

## 存储与能力边界

当前安装版PenguinHarness将模型凭据内联保存在项目的`.project_config.toml`。宿主原生文件工具会检查该文件及`.vault.toml`的名称和实际链接目标，阻止直接读取。

已核对安装版`loadAgentVault/saveAgentVault`：vault通过TOML解析和序列化保存，并注入Agent子进程环境变量。没有在该存取路径发现加密步骤；设置文件mode不等于加密，也不等于Windows ACL隔离。不能将模型key随意迁入vault并假设模型客户端支持变量引用，更不能把迁移称为加密完成。

真正的加密存储需要宿主凭据提供器支持Windows Credential Manager/DPAPI等能力，并配套解密使用、迁移回滚与更新兼容。这个改造不在当前测试任务运行路径自动执行。

## 当前工程防护

- `sensitive-file-guard.mjs`供总控和六个专业角色的现有hook共用；除宿主已有存储保护外，拦截备份副本、`api-token`、`browser-private.json`的原生read_file访问。
- 匹配大小写、Windows备用数据流后缀及实际符号链接目标。硬链接、改名后的普通副本、任意本机进程不是此hook能保证隔离的范围，不将其宣传为操作系统沙箱。
- 公开browser-state、测试证据及当前任务所需的environment/test-env仍可按既有流程读取；不新增人工确认或解锁文件。
- Git忽略已知的凭据存储、运行连接文件、常见备份及真实`.env`文件，保留`.env.example`。忽略规则不会删除已跟踪文件，也不能检测任意源码中粘贴的密钥。
- 发布资源使用白名单，不发布模型配置、vault、令牌、业务输入或历史运行。本次新增运行时guard已列入白名单；维护审计脚本不是Agent可调用的产品测试动作。

## 脱敏检查

`scripts/credential-exposure-audit.py`使用Python 3.11+的TOML解析器。只由维护者显式调用，读取当前模型key作为内存匹配值，不输出原值、前后缀、内容片段或密钥哈希，也不将原值放入Git参数或环境变量。

```powershell
& '<Python 3.11+ executable>' scripts/credential-exposure-audit.py `
  --config '<Penguin project>/.project_config.toml' `
  --repo 'E:/Codex/AITestWorker' --history `
  --scan-root '<related runtime or archive directory>' `
  --output '<new local redacted report.json>'
```

报告只能新建，不能覆盖旧报告或配置。配置解析失败只返回错误类型，不回显出错行。脚本只读配置、当前工程与历史，不执行网络请求、不轮换密钥、不清理历史。

检查范围及局限：

- 当前工程扫描Git跟踪文件和未被忽略的未跟踪文件；额外目录必须显式传入。
- 历史只检查本机可达refs，不fetch，不扫描reflog、悬空对象或远端服务端日志。
- 匹配当前key的UTF-8、UTF-16及JSON转义表示；旧key、分段、加密或其他变换可能遗漏。
- 默认单文件16MiB、每个范围512MiB；超限或读取失败标为不完整。链接目录、依赖缓存和压缩包解包不在范围内。
- Windows目录联接及其他重解析点也不进入；跳过目录链接或目录读取失败时标记范围不完整，并记录traversal计数。正在变化的运行目录不是一致性快照，本工具不是抵御并发恶意替换的安全沙箱。
- 命中表示发现相同敏感值，不等于已证实被外部使用；没有命中也不等于没有泄漏。脚本正常退出只代表检查结束，须阅读findings、complete和skipped。

不要把包含原始凭据的文件复制到报告中，也不要因为发现命中就自动改写审计日志。先确定暴露范围，再决定轮换和清理；用户授权前不操作供应商账号。

## 回归

使用已有Python 3.11+，不自动安装依赖，不改变产品报告运行时的QA_PYTHON：

```powershell
$env:QA_SECURITY_PYTHON = '<Python 3.11+ executable>'
npm run security:contracts
```

测试使用合成密钥，覆盖已删除Git文件、UTF-16副本、解析错误不泄露、文件备份防误读、Git忽略和既有角色边界。操作系统不允许创建符号链接时明确跳过对应测试，不宣称该路径在本机已实测。

## 权限和轮换

若ACL允许不需要凭据的本机账号或组读取，应评估收紧权限，并验证宿主原子写回是否继承新目录权限。不要只改一次文件ACL就宣称长期解决，也不要为此随意修改整个用户目录权限。

若发现真实key进入仓库、聊天、日志或不受控备份，建议向供应商撤销/轮换受影响key，再通过宿主支持的配置入口更新并验证模型连接。值迁移、轮换、Windows ACL改动和清理历史须明确范围，不与公开指令同步混在一起。
