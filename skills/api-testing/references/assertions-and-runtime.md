# 断言与执行适配

返回[API测试](../SKILL.md)。复用现有Playwright与受控执行器，不创建新的执行旁路。

## 响应断言

先验证来源规定的状态和必要响应头，再根据方法、状态及Content-Type读取响应。HEAD/204检查契约约束的空正文与头；JSON按已确认Schema检查，非JSON按文本或二进制契约检查。

已有ajv可用于支持的JSON Schema，先核实Schema草案和本地模块解析；不会自动把OpenAPI文档当作有效JSON Schema。仅需少量字段时用明确的Playwright断言；不要因示例用了Zod便安装它，不手写放宽规则绕过失败。

针对预期状态、数据字段和副作用分别断言。不用response.ok()覆盖接口明确要求的201/202等区别；只在来源允许一组状态时检查该集合。不要输出Authorization、Cookie或敏感响应正文。

## 脚本适配

- 采用现有.spec.ts和`import { test, expect } from '@playwright/test'`，按计划case_id命名；纯API测试只使用request fixture，不为套POM创建page。
- 准备、执行、验证和清理的合同仍必须落实。UI框架runWithLifecycle签名依赖Page，纯API用例不要传假Page；使用自身try/finally涵盖数据创建后的所有操作，清理失败要留下证据。
- 授权测试账号与baseURL按计划环境读取，不把真实值写入Skill、脚本或资源目录。共享数据用串行执行；隔离不能仅靠随机名称声明，还要保证目标与对照不会互相修改。
- 准备阶段不运行真实请求；正式执行走run-ui-tests的现有Playwright入口。当前预检仍沿用工程浏览器/环境依赖要求，本Skill不声称已提供独立API执行器。
- 保留每个请求的操作、脱敏路径、时间、预期/实际摘要及必要证据；同一请求不得因网络不确定自行重发。重试、实验与复测走既有控制流程。
