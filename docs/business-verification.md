# 业务成功证据与条件验证

## 目的与使用体验

页面提示成功、接口返回HTTP 200、业务处理成功、数据已保存是不同结论。执行Agent按任务需要选用对应检查，不把仅验证提示的任务升级成必须提供接口文档或数据库权限的任务。

用户仍只需给出需求或URL及测试范围。必要的业务歧义或验证码等人工操作才询问用户；定位、准备状态和参数纠错由Agent处理。证据不足可交付部分结果与未验证范围，不停止整个任务要求解锁。

## 已实现

- `browser_task` 的 `click` / `press` 可附 `preconditions`，最多4个只读条件，复用已有目标和断言格式。先检查再动作；未满足时返回 `precondition_not_met`、`operation_started:false`，不写产品失败断言。刷新或导航后应重新建立必要状态，不机械给每次操作添加检查。
- 同一动作可附 `response_check`，在动作前监听新请求，被动比较明确的HTTP状态和业务字段，不发起额外HTTP请求、不改写路由、不模拟响应。
- 页面断言和接口断言分别标记 `verification_scope.layer=ui/api_contract`。报告事实附录显示层次，旧结果无字段时显示“未记录”，不追溯补造历史证据。
- 沿用稳定 `request_id` 和回执防重放。读取同一回执不再提交；动作结果不确定不换ID补跑。接口证据缺失仍可 `finish` 为部分结果并继续报告。

## 维护者字段示例

以下为通用语法示例，不是普通用户需要填写的配置，也不是固定成功码约定。Agent必须根据当前资料填写真实值。

```json
{
  "type": "click",
  "request_id": "save-once",
  "target": {"by": "css", "value": "#save"},
  "preconditions": [
    {"target": {"by": "css", "value": "#title"}, "condition": "value", "value": "sample"}
  ],
  "response_check": {
    "url": "https://example.test/save",
    "method": "POST",
    "http_status": 200,
    "field": "data.code",
    "equals": 0,
    "source_path": "inputs/contract.txt",
    "quote": "HTTP 200 and data.code 0 mean accepted.",
    "case_id": "API1",
    "title": "接口约定核验",
    "expected": "满足当前资料明确的成功约定"
  }
}
```

实际字段以 `catalog.field_rules.browser_verification` 为准。UI断言可同时附加，但必须使用不同编号；两条断言不等于两条独立业务用例。

## 证据边界

1. 接口地址必须同源且已提供或被浏览器观察；不接受凭据、查询参数或片段。来源需为当前任务 `inputs/` 中的原文，引文必须存在。该校验仅验证出处，不自动证明引文支持所有语义；Agent仍需判断条件和约定是否适用。
2. 只比较点分路径末级为 `code`、`status`、`success` 的标量，拒绝敏感字段。HTTP状态与业务值分别严格匹配，HTTP 200本身不是业务成功。
3. 只观察动作窗口中新发起的主页面请求。没有响应、多个匹配请求、业务字段缺失、非JSON、无明确长度或超过64KiB均不计通过。当前不支持无Content-Length的流式响应和跨域接口核验；这些限制不是确认的产品缺陷。
4. 不归档原始响应正文、请求头或实际业务字段值，只记录匹配布尔值、HTTP状态、原因、路径指纹、来源哈希及时间。短时观察的时间关联不构成因果证明。
5. 接口约定通过不证明数据库已持久化，也不证明无副作用。若范围要求保存核验，可在不会重放写操作的前提下重新打开已授权页面，检查回显；这仍只是重新读取页面的证据，不是直接数据库校验。本项未新增数据库访问能力。
6. `blocked` 仅表示该项接口断言证据不足，不新增运行锁、流程解锁或用户技术确认。失败默认待分析，不自动归为确认产品缺陷。
