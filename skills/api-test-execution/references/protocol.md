# 接口执行工具与声明式用例

入口：现有 `project-action.mjs execute` 的 `qa_request`，`action=api_task`，`run_id` 为当前派发。独立角色为 `api_automation_agent`，阶段为 `api_execution`。

操作：`inspect_contract {source_path,url?,operations?}`、`prepare {cases_path,contract_path?}`、`start`、`status`、`resume {credentials?}`、`cancel`、`collect {partial?}`。这些字段放在 `operation`，其中 `type` 为操作名称。长请求在独立 worker 中运行，start 不等待网络。resume 为原 worker 提供缺失凭据，不重复启动或重放请求。认证卡片绑定原生子任务，不依赖浏览器；已经发出的 401 请求不会自动重试。

接口资料先归档至 inputs；JSON/YAML 由 YAML 2.9.1 解析器读取，仅展开本地引用，不下载远程引用。只支持 Swagger 2.0/OpenAPI 3.0；3.1 明确拒绝。文字与 Word 提取结果供分析和设计角色使用。inspect_contract 可抓取 source_path 中明确引用的文档 URL，并在当前 run 缓存来源及哈希；不猜测文档路径或扫描网站。

执行器可直接读取用户已有场景文档，或设计用例包装中的 `api_plan` 与每条用例的 `api_scenario`。正常用例的 title、expected、steps、preconditions、case_id 仍用于 Excel；`execution_layer=api` 标记适用层。`api_scenario` 存放下列场景字段，expected、case_id、title 从设计原字段继承，不反向修改预期。

```json
{
  "version": 1,
  "scope": [{"url":"http://localhost:3000/api","source_path":"inputs/request.txt","quote":"请测试 http://localhost:3000/api"}],
  "concurrency": 2,
  "timeout_ms": 15000,
  "interval_ms": 100,
  "scenarios": [{
    "scenario_id":"orders-query", "case_id":"API-001", "title":"查询订单",
    "expected":"返回200，业务码为0",
    "source_refs":[{"source_path":"inputs/contract.txt","quote":"业务码为0"}],
    "depends_on":[], "resources":[],
    "steps":[{"request_id":"orders-get-1","method":"GET","url":"http://localhost:3000/api/orders",
      "query":{"page":1},
      "assertions":[{"type":"status","value":200},{"type":"equals","path":"code","value":0}]}]
  }]
}
```

场景通过 `schemas/api_plan.schema.json` 校验。用户已有用例可适配到 `execution/api/scenario-draft.json`，每条通过 `case_source:{source_path,case_id}` 绑定原用例，工具核验 case_id 和原 expected，不能根据响应改变预期。

写请求另需 `write_authorization:{source_path,quote}`，quote 必须保留本任务原生用户完整消息（包括否定、限制条件），并明确授权对应的创建/修改/删除方法；不截取孤立授权片段。场景 `resources` 提供稳定共享资源键。授权来源检查不代替业务风险判断。后置清理只可操作本次可证明归属且已授权的资源，默认不清理。

步骤支持 GET/HEAD/OPTIONS/POST/PUT/PATCH/DELETE、path_params、query、headers、json 或 form。认证字段为 `auth:{type:"bearer|basic|api_key|cookie",ref:"qa-secret://...",name?:"X-API-Key",in?:"header|query"}`；Basic 引用内容可为完整 Basic 值或 `username:password`。API Key 支持请求头和 query，公开证据不包含凭据值。不要直接写密钥。缺少凭据时使用 `credential_key` 替代 ref，worker 进入 waiting_human，原任务以 `resume {credentials:{"命名键":"qa-secret://..."}}` 继续。登录接口可用普通授权请求及 extract 提取 token，再通过加密引用关联后续请求。

断言 type 支持 status、content_type、equals、exists、type、schema、range、length、contains；path 为点分隔字段路径，value 为比较值或严格 JSON Schema，range/length 使用 min/max。所有断言在请求前形成，Schema 不支持的关键字报错，不静默删规则。提取为 `extract:[{name:"order_id",path:"data.id"}]`，后续步骤引用 `${order_id}`；场景依赖显式 depends_on，变量只在当前场景及其依赖链内可见。

当原文档或用例要求响应媒体类型时，声明 `{"type":"content_type","value":"application/json"}`。value 必须是具体媒体类型，不带参数、通配符、path 或 min/max；比较忽略大小写及实际响应的 charset 等参数。`application/problem+json` 与 `application/json` 严格区分，缺失或非法 Content-Type 判失败。回执记录规范化的实际类型与预期，不导出任意响应头。该断言仅验证媒体类型，不代表字符集、响应正文或业务行为通过；正文解析失败时保留已完成的状态/类型断言，整个请求仍为未完成（写入结果可能未知），未执行的正文断言不计通过。旧用例未声明该断言时，不补造验证结论。

请求不自动重试，也不跟随重定向；重定向作为未完成证据，防止凭据跨域。TLS 验证开启。响应体不公开落盘，仅保留类型、大小、哈希和断言结论，提取值加密存储；这也限制了报告的原始响应展示。Playwright 会在内存接收响应后检查大小，因此当前大小限制是证据/解析限制，不是流式下载硬限制。

API 结果位于 execution/api，与 UI 文件分离。报告通过来源哈希读取两分支，源 case_id、scenario_id、attempt 保留；API 结果 ID 使用 api: 前缀。未知写入以 blocked 加 result_unknown=true 表达，不能在报告中变成普通失败或成功。

全流程明确选择 api_execution 时，缺陷依赖选中的执行分支；UI-only 旧默认不变。两分支可同时派发，dispatch.resource_keys 声明共享资源时保守地串行派发冲突阶段；API worker 内部按场景锁定资源，未知写入保留锁。UI/API 的精细操作级协调尚未实现。旧计划不自动增加 API 分支。

worker 丢失时 status/collect 保留已落盘回执并生成部分结果，已发出但无结论的写入标记未知，不重启重放。终结后的部分/失败/取消结果可进入缺陷和报告链路。quality/execution-summary.json 是派生视图，最终报告以派发时绑定哈希的分支源结果为准。

用户要求运行中或认证等待期间先出报告时，`collect {partial:true}` 冻结逐请求回执，返回不可变 snapshot_path、snapshot_at 和 report_template；已完成请求的断言会保留，未完成场景仍 blocked，未知写入保留 result_unknown。将 report_template 交给总控，不越权自行生成报告或完成 API 阶段。总控使用 create_api_snapshot_report {run_id,snapshot_path?} 创建/复用仅报告派生 run，并派报告专业子智能体。省略 snapshot_path 时只读采集当前进度；原任务、worker、认证等待和最终报告阶段均不变，不重试接口。

时点报告 outcome=partial，引用 inputs/api-snapshot.json，交付“模块名称接口时点快照测试报告.html”，必须说明快照时刻及未完成范围。同一快照复用同一报告 run，不能添加执行阶段；后续实际结果不能改写旧快照。最终报告仍在原 run 终结后交付，不自动生成时点报告。
