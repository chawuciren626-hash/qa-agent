# 第5项调用效率与异常交付修复

日期：2026-10-20。范围：A5-03重复请求写入及派发转抄、Bash登录配置噪声，以及A5-05异常证据可点击入口。工程修复与部署完成，尚未开展新真实模型任务，第5项整体仍未验收通过。

## 修改内容

### 单次调用说明一致

公共指令已经支持exec_command.qa_request，但catalog.invocation_steps和报告角色仍要求先write_file，形成重复步骤。本批统一为：支持qa_request时一次提交动作对象和execute命令，由Hook落盘；旧宿主不支持时才先保存请求再执行。真正业务产物仍需写文件，不等同于请求传输。

不同请求内容继续使用不同文件名，不覆盖旧请求。建议按action及operation.request_id命名；未执行的参数纠正可以使用新文件版本，未知产品执行仍沿用原操作ID查回执，不重放提交。这不是新增幂等授权，也不是自动推断请求内容。

### 派发使用短任务引用

总控可直接将dispatch返回的短delegation对象传给run_subagent；只有回显缺失或截断时才读取delegation_path恢复对象。完整合同仍保存为受管文件，由子Agent读取。短正文不再包含Windows绝对路径、交付数组和重复说明，减少反斜杠与JSON空格转抄失配。

原run、dispatch、父会话、目标角色、策略和文件哈希校验保留；并发归属和重复启动防护没有取消。dispatch仍只是登记，必须有原生run_subagent调用才算子任务启动；本批没有把它改成后台自动启动，也没有允许任意prompt改写。

### 结构化Shell不加载登录配置

仅在绑定QA_DIRECTORY_CONTEXT的工作区、Bash执行单条project-action catalog/summary/execute时使用--noprofile --norc -c，保留宿主继承环境和显式PATH前置。普通Shell、非QA命令和其他Shell行为不变，不修改系统profile或代理。针对原/etc/profile重复警告从调用入口规避，不隐藏其他命令错误。真实模型任务中的噪声消失情况仍待复验。

### 异常证据只读入口

- 对执行test_results.json、exploration.json、browser-network.json及browser-evidence中的observation.json提供内嵌只读预览和下载。
- execution及browser-evidence目录链接可点击浏览允许展示的结果、观察文件及图片；支持返回目录，不提供目录批量执行或任意文件原生打开。
- 新GET文件接口复用宿主会话鉴权，再检查工作区边界、固定路径白名单、符号链接、JSON格式和2 MB大小；目录最多200项。browser-private.json、原始动作请求和任意其他JSON不在新增入口范围内。
- JSON以文本呈现，不执行其中HTML/脚本；下载使用attachment、nosniff及sandbox头。缺失、越界、超限及无效证据显示明确提示，不改变测试事实。该入口不是通用DLP，不承诺旧文件内容已经全面脱敏。
- 保留既有Office原生打开逻辑和限制，不开放exe或脚本。

## 验证

最终七组工程回归125/125通过：

output/engineering-tests/2026-10-20T01-11-44-466Z-38c02397-9212-457f-9cce-ffbf80c1a41c

覆盖：派发绑定、结构化动作、单次请求传输、Shell范围、文件交付、证据安全和安装事务。首轮123/124通过，唯一失败为旧路由测试的mock只有post、未支持新增get；补齐mock并新增鉴权/下载路由测试后全组重跑通过。首轮日志保留，不改写记录。

UI验证：output/acceptance5-delivery-20261020/verification.json。使用实际应用React/Markdown组件和合成对话/JSON，旧报告仅作为只读预览样本；验证JSON点击、下载、目录下钻、脚本文字不执行、受限文件不生成链接、原有HTML/PDF预览及打开失败提示。1440x1000、390x844截图人工检查无溢出。不是新产品测试，也不代替桌面Office原生打开验收。

实际启动后的宿主接口检查（读取原10月19日失败会话现有证据，不改写历史）：JSON200、目录200、下载200且attachment、私密文件400、越界400、无认证401。

静态预检ready、发布资源白名单225项有效、git diff --check通过（已有换行提示保留）。

## 部署

用户确认已退出后检查无PenguinHarness进程；使用事务安装器更新宿主与界面，七个角色同步公共指令；随后启动PenguinHarness。复查installed、changed=false、restart_required=false；角色in_sync。没有强制结束用户任务，没有更换模型、代理或凭据，没有提交或推送GitHub。

## 下一步

在PenguinHarness新建同范围短任务进行真实Agent复验：观察是否不再额外write_file请求、短派发是否一次成功、执行后的部分结果能否进入报告，以及最终JSON/Office交付能否正常点击。只有真实采用和结果才能证明效率改善，本批不宣称模型往返次数减少或具体提速百分比。短任务通过后再扩大完整流程验收。
