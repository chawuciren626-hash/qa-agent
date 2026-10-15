# 测试Skills增强记录

日期：2026-10-13

## 已完成

保持现有7个Agent，Skills由8个增加到11个。此次增强专业方法与资源分发，不改变保存计划中的主Skill列表、审批机制、执行批次、缺陷治理或正式交付Schema。

| 能力 | 使用角色 | 实际改动 |
|---|---|---|
| test-design-methods（新增） | 需求、测试点、用例；总控可见 | 等价类、边界、决策表、状态迁移、语义与覆盖检查 |
| qa-investigation（新增） | 缺陷分析；总控可见 | 证据、可证伪假设、频率/原因分离、运行内调查模板 |
| api-testing（新增） | 用例、执行；总控可见 | 契约、认证权限、分页、204/HEAD、幂等状态/副作用、受控执行适配 |
| playwright-execution（增强） | 执行、总控 | task/lifecycle分流；入口简化，生命周期细则按需读取；定位、等待、fixtures、POM、mock边界 |
| test-selection（增强） | 总控 | 回归策略、不稳定用例治理与已实现/建议能力区分 |

主Skill与角色增加按需加载说明。test-report-writing和test-asset-management仅将原版本字段保存在标准metadata.version中，未改变专业职责。

补充Skill不是新的必需阶段，不能在dispatch中擅自修改已保存的skills列表；实际运行仍使用原主Skill及当前模式的契约。旧运行不会自动迁移。

## 指令整理

- 区分prepare与execute：准备脚本可以独立交付，但不能声称已执行。
- 新脚本写当前run的execution/scripts；共享合同引用工程已有tests/framework，不沿用旧生成目录。
- lifecycle环境文件以计划environment_config为准，不要求独立task补环境JSON。
- README工作区改为实际存在的E:/Codex/AITestWorker。
- 保留真实业务预期和原始失败；禁止靠削弱断言、skip/fixme或自动重试消除问题。
- 本轮没有重写全部历史角色指令，后续如发现具体重复或冲突，应继续做有依据的局部消歧。

## 资源分发与验证

scripts/skill-resources.mjs统一枚举维护资源；入口、references、templates、scripts、assets和许可证按支持的文件类型打包。引用需在包内可解析。同步不执行附带脚本。

scripts/sync-penguin-agents.mjs改为先验证全部源与目标，再按字节写入差异，支持嵌套文件及二进制资源。损坏链接、目录链接、越界路径和缺失角色在写入前被拒绝。预检不是磁盘故障时的事务回滚；本地未列入源的文件会保留，不自动删除。

新增维护命令：
- npm run skills:check：入口、链接、角色/工作流映射与发布清单。
- npm run skills:contracts：资源同步行为回归。
- 原penguin:agents:check / penguin:agents:sync继续使用。

发布白名单已包含全部24个Skill资源及新增维护脚本，共159项；白名单有效不代表exe已打包。

## 验证结果

本轮实际运行：
- 资源同步与数据治理测试：10/10通过。包含只读预览、嵌套资源/二进制一致性、后续资源漂移、缺失角色、损坏引用、目录链接、发布路径和7个实际角色的完整安装。
- 工作流、独立任务、执行安全与并行调度回归：22/22通过。合计32/32，无跳过。
- skills:check：11个Skills、24个资源、7个Agent通过。
- release:check：159项有效。
- 全部11个Skill的YAML及基础字段使用现有Playwright自带YAML解析器实际解析通过。
- skill-creator的quick_validate.py已尝试，本机与内置Python均缺少PyYAML，未能运行该脚本的校验主体；未安装依赖，采用上述完整YAML解析和工程资源校验替代，不声称原校验器通过。
- git diff --check通过；工程测试在隔离临时目录执行并清理。
- 同步本机62个文件，复查in_sync、changes=0。

同步前备份：
E:/QAArchives/AITestWorker/skills-upgrade-2026-10-13-14d8ca2a/manifest.json

备份仅含此次覆盖的公开角色/Skill文件；清单记录哪些目标此前不存在。恢复应按清单审查，不整体覆盖应用目录或删除业务数据。

## 使用与限制

在PenguinHarness新开会话加载更新后的角色与Skills。没有重启应用、改模型/凭据、改历史运行状态、安装依赖或提交Git。

API Skill可以增强设计、分析和生命周期Playwright脚本；当前独立task仍没有通用HTTP动作，本轮未新增独立API执行器。不伪造接口实测，不擅自转为全流程索取多余前置材料。

Selenium、可访问性依赖、独立CLI执行入口和新增专项Agent按原评估暂缓；当前7个角色先承担增强后的能力。

这些检查证明结构、资源分发与相关工程契约正确，不证明真实模型会话的覆盖率、缺陷发现率或token效率已提升。模型驱动的目标系统端到端比较尚未执行。后续对照可用同一模型/输入/预算比较多条件规则、状态迁移、UI根因调查、API空响应与幂等场景；记录遗漏、无依据结论、首次交付成功率和人工纠正次数。

## 来源与适配

上游：fugazi/test-automation-skills-agents，提交65a72d5e74def3c23143bef8757e72cb68e91032。

方法与参考资料经过中文精简和本工程适配，来源记在对应Skill的metadata，相关包保留上游MIT许可证和版权。没有整体复制外部Agent或导入其安装、自动重试、fixme、强制fixture和单标签政策。

评估依据见[原评估报告](external-testing-skills-assessment-2026-10-13.md)。
