---
name: api-contract-analysis
version: 2026.11.22.2
description: 解析当前任务的 OpenAPI/Swagger 或文字接口契约，形成有来源的接口清单及业务规则，供接口测试点和用例设计使用。
sections:
  criteria: ["什么算合格", "不要做"]
  knowledge: ["接口规则怎么落"]
  steps: ["输入", "输出", "产物格式", "工作步骤"]
---

# 接口契约分析

## 适用范围

本阶段的接口轨：把 OpenAPI / Swagger 或文字接口契约，拆成有来源的接口清单和接口业务规则。
功能与业务规则走《需求分析》，不在这里做。两轨都有的任务，产物分开交。

## 输入

- 本 run 的 `inputs/` 契约文件：OpenAPI 3.x、Swagger 2.0 的 JSON / YAML，或文字版接口说明。
- 用户指定的接口范围（哪些 operation 要测）。
- 契约解析的限制要随产物一起交：外部 `$ref` 不跟随，3.1 的循环引用与组合结构可能无法完整展开。**没解析出来的就写进限制清单，不伪称完整校验。**

## 输出

1. 接口清单（按 method + path）
2. 每个接口的认证方式、参数、请求体、响应、错误定义
3. 接口业务规则（并入同一份需求台账，不另建台账）
4. `analysis/api_contract.json`
5. `analysis/requirement_analysis.md` 中的接口部分

## 产物格式

`api_contract.json` 只装接口清单，业务规则仍然进 `requirement-ledger.json`，两边用 `rule_ids` 关联。当前只校验 JSON 合法性，结构按下列约定保持稳定，不要每次换形状。

```json
{
  "version": 1,
  "run_id": "run-example",
  "source": { "path": "inputs/openapi.json", "sha256": "<契约文件哈希>", "spec": "openapi3" },
  "operations": [
    { "id": "OP-1", "method": "GET", "path": "/api/users/{id}",
      "summary": "查询用户详情", "auth": "bearer",
      "params": [ { "in": "path", "name": "id", "type": "string", "required": true } ],
      "request": null,
      "responses": [ { "status": "200", "schema": "User" }, { "status": "404", "schema": "Error" } ],
      "rule_ids": ["RULE-3"], "limits": [] }
  ],
  "limits": ["外部 $ref 未解析"]
}
```

约定：

- `spec` 取 `openapi3` / `swagger2` / `text`。
- `source.sha256` 记契约文件哈希，来源变了要能看出来。
- `operations[].rule_ids` 指向台账里的规则 ID，台账才是业务预期的唯一来源。
- 解析不了、不支持的结构写进 `limits`（接口级和全局两级都要用）。

## 工作步骤

1. 核对归档材料与目标接口范围，读契约。
2. 解析出接口结构，记录来源与哈希。
3. 逐接口对照原文，抽出业务规则并落进台账。
4. 解析不出的结构、契约内部的矛盾，写进限制清单或待确认问题。
5. 生成 `api_contract.json`，再跑本阶段的检查与产物校验。

## 接口规则怎么落

- 接口路径、参数位置、状态码、文案，只有契约明确写了才是业务要求；没写的，是实现细节或待确认。
- 只写"返回错误"的，不要替它补一个状态码。
- 契约里的示例响应**不是**已确认的业务预期；实测响应也不能回写预期。
- 认证、权限、幂等、限流这类约束，按原文登记为 `constraint`。
- 跨接口的依赖顺序（先建后查），按契约写明的关系登记，不凭经验补。

## 什么算合格

1. 每个接口都有 method、path、认证方式和来源。
2. 接口规则挂在台账里，`rule_ids` 指得回具体规则。
3. 解析限制写清楚了，没把"没解析出来"说成"契约里没有"。
4. 没有拿示例响应当预期。

## 不要做

- 不请求被测接口，本阶段只做静态分析。
- 不靠猜路径去扫服务，文字契约只能形成有来源的设计。
- 不把功能规则写成接口规则，两轨不混。
