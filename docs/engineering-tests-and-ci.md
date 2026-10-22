# 工程测试入口与CI

## 入口

```powershell
npm run test:list
npm test
npm run test:core
npm run test:browser
node scripts/run-engineering-tests.mjs tests/acceptance/manifest-lock.test.mjs
```

- `test:list`只列出测试，不检查运行时、不启动浏览器、不创建测试目录。
- `npm test`自动发现`tests/acceptance`第一层的全部`*.test.mjs`，按文件名排序；新测试自动进入默认覆盖范围。
- `test:browser`运行入口中列出的浏览器测试；`test:core`运行其余测试。具体文件用 `test:list -- --suite=browser` 或 `test:list -- --suite=core` 查询。两者不重叠，合并等于默认全集。新增需要启动浏览器的测试文件时，须同步入口中的浏览器分类及分组测试，默认全集发现规则不变。
- `.test.py`目前由对应Node测试调用（Word输入等），不是单独的发现规则。产品Playwright用例、真实Agent任务和题库评分不由此入口自动运行。
- 旧的专项npm命令保留，仍通过同一隔离运行器执行。显式文件列表仍可用；拼错、重复、未知选项或混用套件与文件会报错，不静默缩小范围。

## 环境

工程依赖Node.js至少20.11、Git、`package-lock.json`所定Node依赖、具备python-docx/reportlab的Python。凭据审计另需Python 3.11以上内置tomllib。

报告Python沿用`QA_PYTHON`或PATH探测。若现有报告Python较旧，可仅对维护终端设置`QA_SECURITY_PYTHON`指向已安装的3.11以上解释器；无需更换报告环境。环境不足会输出错误和非零退出码，不冒充跳过或测试通过。运行器不自动安装、升级或联网补依赖。

CI采用Windows Server 2022、Node 22、Python 3.12；安装Node锁文件及`requirements-ci.txt`中固定版本。浏览器作业显式安装锁文件对应的Playwright Chromium。本机 Chrome 回退与 CI Chromium 可能不是同一版本，验证时应记录实际环境。

## 隔离和结果

测试复制工程源码、契约、公开配置及合成夹具到系统临时目录，共享已有node_modules而不重新安装。不复制业务inputs/output、私有环境配置和宿主会话数据。应用数据、角色根目录、工作区和临时目录均指向测试副本；移除继承的业务运行目录/确认环境变量，以及嵌套Node测试上下文。文件级并发固定为2，降低进程拥挤引起的波动，不是Agent阶段预算。

结果写到被Git忽略的`output/engineering-tests/<UTC时间-UUID>/`：

| 文件 | 内容 |
| --- | --- |
| summary.json | 选择的测试、运行环境、状态、退出码、开始结束时间、临时目录清理结果 |
| results.tap | 原始测试结果、失败详情、通过/失败/跳过计数 |
| results.xml | Node原生JUnit报告，用于CI或报告系统读取 |
| stderr.log | 测试进程错误输出 |

测试失败原样返回非零退出码，报告保留；无自动重试、无continue-on-error。缺依赖时保留错误摘要，尚未启动测试则没有JUnit/TAP。普通完成和失败后清理临时副本，不把合成产物塞回真实会话。外部强制杀死运行器不保证完成清理；不能把遗留`running`摘要看作通过。

`summary.status=passed`表示Node测试退出码为0，并不保证零跳过；数量和跳过原因以TAP/JUnit为准。平台权限导致的既有跳过仍可见，不擅自提权。报告日志只有工程夹具结果，CI不上传整份output目录、临时工作区或宿主数据。

## GitHub Actions

配置：`.github/workflows/engineering-tests.yml`。

- push、pull_request和手动workflow_dispatch触发，core/browser分别在干净Windows作业中运行。
- 同一分支更新取消旧CI，作业时限45分钟；这是CI资源限制，不修改Agent自主执行策略。
- GitHub权限仅contents:read，不使用模型密钥、产品账号、pull_request_target或宿主安装。
- 执行与本机相同的npm入口，并检查发布资源白名单。失败不掩盖，尽可能上传结果；报告保留7天。
- 不替代真实模型验收、产品功能测试、客户端文件打开、性能评测或独立exe发布验收。工程回归中的benchmark记录校验不是恢复已暂停的能力评分任务。
- 工作流需提交推送后由 GitHub Actions 执行；远端结果以对应运行记录为准。分支保护中的必需检查由维护者另行配置。
