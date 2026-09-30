# 1. 编程、接口与数据基础

目标：能理解一次工具调用如何变成网络请求和文件，能用脚本检查结果。预计学习 1-2 周，可随工作反复练习。

## 1.1 计算机执行程序的基本过程

源代码是规则，进程是正在运行的程序，文件是持久化数据。Python 脚本退出后变量通常消失，写入文件或数据库的数据才会保留。Agent 的对话窗口、模型服务、工具服务和浏览器常常是不同进程，某个页面显示成功不代表其他进程真正完成保存。

工作目录 CWD 决定相对路径从哪里开始解析。`report/result.json` 可能在不同工作目录指向不同文件。调试时记录工作目录和最终绝对路径，不要因找不到文件就到整块磁盘搜索。

退出码 0 通常表示进程成功，非 0 表示失败；但程序也可能吞掉异常后错误返回 0。因此要同时检查退出码、结构化状态和实际交付物。

## 1.2 Python 必备知识

| 知识 | 必须会做 | 常见错误 |
|---|---|---|
| 字符串、数字、布尔值、None | 区分文本金额与数值金额 | 把字符串 `"false"` 当成 False |
| list 与 dict | 遍历用例、按字段读取工具结果 | 假设每条记录都有同一字段 |
| if、for、函数 | 根据结果判断和统计 | 修改全局变量造成测试互相影响 |
| 异常 | 区分预期失败和程序错误 | `except: pass` 让失败消失 |
| 文件与 JSON | UTF-8 读取、解析、保存 | 文件可解析就认为业务正确 |
| 模块与依赖 | 理解 import 和虚拟环境 | 安装到另一个 Python 环境 |
| 测试断言 | 明确输入和期望 | 只打印结果，没有失败判定 |

先读懂下面的纯函数。纯函数只由参数计算返回值，容易测试：

```python
def check_budget(document_budget, source_budget):
    if document_budget is None:
        return {"passed": False, "reason": "missing_budget"}
    if document_budget != source_budget:
        return {"passed": False, "reason": "budget_mismatch"}
    return {"passed": True, "reason": None}

assert check_budget(1200000, 1200000)["passed"] is True
assert check_budget(120000, 1200000)["reason"] == "budget_mismatch"
```

金额计算优先用最小货币单位整数，或 Decimal；二进制浮点数不适合要求精确的小数金额相等判断。单位也应单独记录，不能把 120 万与 120 元直接比较。

## 1.3 HTTP 与 API

一次请求包括方法、URL、请求头和请求体；响应包括状态码、响应头和响应体。

- GET 常用于读取；POST 常用于创建或触发任务；PUT/PATCH 常用于更新；DELETE 用于删除。实际是否产生副作用要看接口契约。
- 200/201 表示 HTTP 层成功，但响应体仍可能有业务失败。
- 202 表示请求被接受，不代表生成任务完成；应继续查询任务状态。
- 400/422 常见于输入错误；401 是认证问题；403 是权限问题；404 是资源不可见或不存在；409 是状态冲突；429 是限流；5xx 通常是服务端错误。
- 超时可能发生在操作已写入之后。直接重试写操作可能生成两个文档。

教学响应：

```json
{
  "request_id": "req-demo-001",
  "status": "succeeded",
  "data": {"project_id": "A", "budget_yuan": 1200000, "version": 3}
}
```

检查不能只断言 `status == succeeded`：还要确认 project_id、数据版本、金额类型和当前用户权限。请求超时需设置连接与读取上限；大文件需设置大小限制；重试需有最大次数。

## 1.4 JSON 与 Schema

JSON 支持对象、数组、字符串、数字、布尔值与 null，不支持注释、尾随逗号和单引号字符串。

校验分三层：

1. 语法：是否能被 JSON 解析器读取。
2. 结构：是否有必填字段、类型和枚举是否符合 Schema。
3. 语义：预算是否来自正确项目，日期是否合理，引用文件是否真的存在。

Schema 只能处理其声明的约束。`budget_yuan` 是 number 不能证明它等于业务系统预算；`citation` 是 string 不能证明引用支持结论。

Python 的 `json.loads` 负责解析，不会自动执行 JSON Schema 校验。学习时要分别记录三层校验的结果。

## 1.5 数据库与 SQL

至少掌握 SELECT、WHERE、JOIN、ORDER BY、GROUP BY、COUNT，以及主键、外键、事务。

```sql
SELECT project_id, template_version, status, COUNT(*) AS documents
FROM generated_documents
WHERE project_id = 'A'
GROUP BY project_id, template_version, status;
```

此查询能检查同一项目生成了多少份材料，但不能证明内容正确。多租户系统还应按 tenant_id 限制访问。业务服务需使用参数化查询，不要直接拼接用户或模型文本。

事务保证一组操作按契约整体成功或失败。Agent 连续调用三个外部工具通常没有天然跨服务事务，需要状态记录与补偿操作。

## 1.6 Git 与环境管理

工作区是正在改的文件；暂存区是准备提交的快照；commit 是版本；push 才会上传远端。学习顺序是 `git status`、`git diff`、指定文件 `git add`、`git commit`、`git push`。

`.gitignore` 不会让已经提交的秘密自动消失。若密钥被提交，应先撤销/轮换密钥，再处理版本记录；不能认为删除当前文件就解决泄露。

虚拟环境用于隔离 Python 依赖，lock 文件用于帮助固定依赖版本。固定模型名称也未必固定服务端模型实现，评测还应记录供应商返回的可用版本信息和运行日期。

## 1.7 日志与调试

最少记录 run_id、case_id、阶段、工具名、开始结束时间、重试次数、输入输出摘要、错误码和产物引用。敏感字段应脱敏；日志访问权限应与业务数据匹配。

定位顺序：复现输入 -> 找到第一处偏差 -> 检查上游数据 -> 检查转换或工具调用 -> 对照期望输出。不要只修最后一条报错。

## 1.8 练习与验收

练习：准备 10 条虚构文档记录，包含正常、预算为空、金额单位错误、重复文档和导出失败，用 Python 统计每类问题并输出 JSON。再用一条 SQL 查询核对重复文档。

验收：你能解释每个变量类型；空输入不崩溃；分母为 0 不输出虚假的 100%；出现坏 JSON 会报告文件名；无需复制 AI 的解释也能说明代码如何发现错误。
