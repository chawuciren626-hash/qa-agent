# 通用执行准备检查

日期：2026-10-12。范围：执行入口、环境静态预检、共享依赖与外部会话路径、授权快照及端口连通性。没有执行产品用例、打开浏览器、登录或安装依赖；不是PenguinHarness全流程复验。

## 检查结果

| 项目 | 结果与边界 |
| --- | --- |
| Node与共享Playwright/XLSX/XMind | 项目包入口可解析；不等同全部导出功能已实测 |
| Chrome | 标准安装路径存在；本轮未启动浏览器 |
| Python报告依赖 | D:/python/python/python.exe实际导入python-docx与reportlab成功 |
| 两个登记环境静态预检 | 各10项ready；不是单次计划批准，不证明网络可用 |
| tms-local端口 | 127.0.0.1:59601返回ECONNREFUSED，当前不能直接开展该环境UI复验 |
| local-gov-bid端口 | local.console.gov-bid.com:443连接成功；未验证TLS、页面、登录或业务功能 |
| 外部目录脚本收集 | 实际E:/QAWorkspaces目录下2份诊断脚本被--list收集，0错误，不执行测试体 |
| 工程回归 | 最终169项通过、0失败/跳过，临时副本正常清理 |
| 目录/清理专项 | 9项通过，与全套存在重叠，不叠加计数 |
| 发布资源检查 | 128项白名单通过，exe_ready仍为false |
| 本机角色同步 | 同步2份执行Skill副本，随后in_sync |

## 发现与修复

### 外部脚本无法解析共享包

改造前，从工程package.json可解析@playwright/test，从外部会话脚本位置解析则MODULE_NOT_FOUND。现有预检只检查工程node_modules目录，无法发现外部脚本加载问题。

新增tsconfig.playwright.json，由playwright.config.ts指定；映射到工程现有@playwright/test入口，不复制依赖、不创建每会话node_modules。共享配置加入执行授权哈希快照、工程测试副本和发布资源白名单。已有执行批准不补造新哈希，若输入快照不符须重新申请批准。

支持边界：常规.spec.ts使用具名import；原生ESM如.spec.mts使用默认import后解构test/expect。当前依赖CommonJS入口不支持原生ESM具名导入；最初专项因此失败，不能把它隐藏为已支持。allowJs用于该解析路径；最终验证两种明确支持的写法。并未为任意npm包建立映射。

--list仍会加载文件顶层代码，本轮只对维护者创建并检查过的无顶层业务副作用诊断文件使用。测试体设置为一旦误执行就抛错，实际仅收集2条；这不是对任意脚本的安全沙箱，也不等于授权执行产品测试。

### 预检边界不清

包检查改为require.resolve；新增仅支持Chrome channel检查、绝对HTTP(S)且无内嵌凭据URL检查、共享解析配置检查。输出标注browser_started=false、network_checked=false、approval_granted=false及静态检查范围。

环境策略允许不等于本次计划批准；执行器继续核验用例依据、依赖确认、计划/环境/脚本快照，执行后再次校验。没有取消原有授权或把静态ready直接作为启动许可。

### 环境默认值风险

工程当前默认登记为tms-local，但端口未监听。本轮不擅自切换默认环境、启服务或沿用历史执行批准。下一项完整复验前应启动对应服务或明确选择其他目标，再按实际目标生成计划与确认执行范围。端口可达不能替代页面/TLS检查。

执行准备指令补充：脚本与runtime配置放当前run，显式设置test_dir与environment_config；不得沿用工程tests/generated中的旧脚本或旧业务配置。其他框架引用需要实际工程绝对路径，不能猜目录层级。

## 证据与下一步

E:/QAWorkspaces/execution-readiness-2026-10-12下保存两份脱敏preflight.json、connectivity.json、collection.json及两份诊断脚本。预检证据省略环境完整配置，未包含凭据。工程测试在独立临时副本中运行；实际本机预检和脚本收集另行执行，不把工程测试当作真实Agent执行结果。

本项完成后暂停。下一项为最新版本真实全流程复验：先落实可用目标环境与需求范围，再在PenguinHarness新会话按阶段确认推进。Word上传、产品浏览器执行、四类交付物打开检查仍属于后续验收。本轮未提交GitHub、未修改历史业务状态。
