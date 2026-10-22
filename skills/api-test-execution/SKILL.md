---
name: api-test-execution
description: 使用独立 HTTP worker 执行已设计的接口场景，保存逐请求断言证据，处理关联、凭据引用、取消和部分结果；不启动浏览器。
---

# 接口执行

先读共享 skills/api-test-execution/references/protocol.md 的声明式场景格式。api_task.prepare 只适配已有用例，不能创建缺失预期；start 返回后通过 status 查看后台状态，终结后 collect。每个 request_id 在本次 dispatch/attempt 内唯一，已有回执永不重发。不要在超时或中断后新建 run 绕过未知副作用。

Bearer、Basic、API Key 和 Cookie 使用本会话 qa-secret:// 引用；响应提取也只以安全引用保存。步骤串行、场景按 depends_on 调度；共享可变资源使用相同 resources 键。写操作引用原生用户授权，并声明资源；不会把“测一下”扩展成生产支付、通知、权限变更或批量删除。

断言失败保留原预期；无业务断言只证明 HTTP 状态。统计分别列出源业务用例、场景、请求和断言。未执行或写入未知不计通过。证据文件由执行器生成，缺陷和报告交给对应角色，不直接生成跨阶段产物。身份过期、worker 丢失或取消后保留原回执并说明限制，禁止自动重放。

原文档或用例要求响应 Content-Type 时，按协议预声明 content_type 断言，不再仅记录响应头后声称已验证。媒体类型断言不等同于字符集、JSON 正文或业务断言；不得根据实际响应反改预期或追补历史通过记录。

用户要求执行中先出报告时，可 collect(partial:true) 冻结已落盘的逐请求证据，将返回的 report_template 交给总控派报告角色；不把 API 阶段提前完成、不重启或重放、不自行写报告。时点报告始终 partial，原任务继续等待或执行。
