# 外部测试 Agents / Skills 对比评估

评估日期：2026-10-13

## 结论

建议选择性吸收，不建议整体替换，也不建议直接把外部7个Agent全部接入。

现有工程的优势是测试工作流、来源追溯、执行控制、证据归档和交付校验；外部仓库的优势是测试专业知识、专项自动化方法、分层参考资料和通用示例。最佳组合是保留现有运行与治理机制，把筛选后的专业知识接到现有角色上。

“结构更规范”不等于“测试更正确”，更不等于“直接接入即可运行”。本次没有开展两套智能体的相同任务对照实验，因此不承诺效率或准确率提升百分比。

## 范围与实际验证

- 当前工程：`E:/Codex/AITestWorker`。会话给出的旧路径`E:/Codex/测试智能体`不存在；实际工程README仍保留该旧路径。本文以找到的AITestWorker工作副本为比较对象。
- 当前配置：7个Agent（总控+6个专业角色），8个Skills，运行于PenguinHarness。
- 外部仓库：`D:/work/测试/test-automation-skills-agents`，7个Agent、10个Skills、3份instructions；本地提交`65a72d5e74def3c23143bef8757e72cb68e91032`。
- 阅读角色、Skill入口、关键参考资料、同步脚本、执行代码和现有状态文档；外部参考代码为抽查，并非全部逐行审计。
- 实跑外部`node scripts/lint-skills.mjs`：退出码0，10个Skills，0 errors / 0 warnings。
- 实跑现有`node scripts/sync-penguin-agents.mjs`只读检查：`in_sync`，changes=0。
- 没有安装依赖、启动业务测试、导入外部Agent、修改运行配置或提交Git。本次仅新增评估文档。
- 没有重跑现有全部工程回归；状态文档里的既往测试数量不作为本次实测结果。该文档明确说明：最新交互能力有合成页面验证，但目标系统的模型驱动端到端验收仍待完成。
- 当前工程有既存未提交修改，结论针对当前工作副本，不能当作已发布版本能力证明。

## 两套方案的优缺点

| 维度 | 当前工程 | 外部仓库 | 判断 |
|---|---|---|---|
| 定位 | 可执行测试工程，含状态、结构化动作和导出工具 | 提示词、知识、模板与少量辅助脚本库 | 互补，不能简单替换 |
| 测试生命周期 | 需求→测试点→用例→执行→缺陷→报告；另有独立任务模式 | 偏计划→代码生成→修复，以及API/Selenium专项 | 当前更适合完整中文测试交付 |
| 测试设计方法 | 对来源、字段、边界数据和追溯要求具体；方法示例较少 | 等价类、边界值、决策表、状态迁移、探索式测试有专门资料 | 外部内容值得吸收 |
| 执行与证据 | run_id、invocation_id、执行合同、审批快照、批次封存、失败分类 | 主要依赖模型遵守文本约束，没有同等运行状态与证据机制 | 保留当前机制 |
| 专项广度 | 主要为Playwright；已有API响应断言/接口资产，尚无独立API Skill与角色 | API、可访问性、Selenium、POM、CI分片、flaky调查 | 外部专项资料更丰富 |
| 技能组织 | 8份入口文档，专业规则与运行操作混在一起，强依赖工程docs/scripts | 10份入口配references/templates/scripts，适用与不适用边界更明确 | 借鉴外部分层形式 |
| 校验 | Schema、跨产物引用、执行与交付测试代码 | 结构lint；未提供同等行为评测系统 | 外部lint不是正确性认证 |
| 使用成本 | 受控动作与交接复杂，历史上出现技术误停，仍需真实会话验收 | 轻量易复用，但落入你的工程需要工具和契约适配 | 先控制复杂度，再加角色 |

现有工程的“更强”主要指机制与工程约束，不代表本次已证明模型执行全链路更稳定。

## 外部Skills是否标准规范

优点：入口具备name/description；大量明确When to Use与Do NOT Use；参考资料按主题拆分；模板与确定性脚本分离；提供结构检查与CI；附有许可证。这些是可借鉴的可维护性设计。

但不能视为权威认证：ISTQB-aligned是知识组织声明；lint只检查部分结构、链接与仓库自定规则，不验证测试语义、示例编译、工具可用性或多Agent运行效果。单标签、禁XPath、强制所有POM经fixture注入、所有数据外置等属于其工程政策，不是所有测试项目必须遵循的行业标准。

具体不足：

1. Healer在失败持续且认为测试正确时允许test.fixme，并追求反复修复至通过。它也明文禁止削弱断言，因此不能说它鼓励伪造成功；但跳过产品问题的策略不能直接进入你的缺陷治理流程。
2. API幂等示例要求两次PUT状态码和响应体完全相同。幂等的核心是重复请求的预期服务端效果一致；时间戳、响应表示或允许的状态码可能变化。应依据实际接口契约检查资源最终状态和副作用，不能把该示例作为通用判定。
3. API Skill包含“every response”做Schema校验的绝对措辞。204、HEAD、非JSON响应应按契约分别处理，不能一律解析JSON。
4. Orchestrator/Generator要求spec不能直接从@playwright/test导入test，而E2E Skill示例直接导入；说明角色规则与示例存在一致性缺口。
5. 单执行标签将smoke、API类型、destructive影响混入一个分类维度，且回归Skill另允许a11y附加标签。不要替换你现有模块、风险、标签和数据隔离的多维元数据。
6. 5/5连续通过只能作为有限样本，不足以证明低flaky率。CI重试、隔离清单和通过率目标应按业务风险制定，不能照抄数值。
7. 部分frontmatter使用bash、playwright-test/*、handoffs和mcp-servers，实际具有宿主工具依赖，“tool-agnostic”不代表这些字段能直接在PenguinHarness生效。

## 10个Skills逐项建议

| 外部Skill | 推荐方式 | 接入位置及收益 | 优先级 |
|---|---|---|---|
| qa-manual-istqb | 拆取方法和检查表；不整体替换交付模板 | requirement-analysis、test-point-design、test-case-writing补静态评审、等价类、边界、决策表、状态迁移、探索章程 | 第一批 |
| qa-investigation | 改造成运行内的根因调查Skill | defect_analysis_agent：复现→证据→可证伪假设→根因→建议→预防；调查记录绑定run和批次 | 第一批 |
| playwright-e2e-testing | 选择性引入references | automation_execution_agent补fixtures、POM、网络等待、定位器、mock适用边界；保留现有执行合同 | 第一批 |
| api-testing | 新增本地适配版Skill，先用已有Playwright request与可用Schema工具 | 用例与执行角色补认证、权限、负向、分页、契约、幂等；不同时引入Java和Supertest栈 | 第二批；API业务多时可前移 |
| playwright-regression-testing | 合并策略资料到test-selection | 借鉴变更影响、历史失败、耗时、flake治理；保留现有Profile和选择回执 | 第二批 |
| a11y-playwright-testing | 作为可选专项能力 | 键盘、焦点、语义、表单标签和axe扫描；依赖需单独准备，扫描通过不代表完整WCAG合规 | 第二批，按需求 |
| grill-me-qa | 取静态评审问题清单；仅显式策略评审时启用交互模式 | 总控做策略审查，不给日常测试增加默认10–15轮问答 | 可选 |
| playwright-cli | 借鉴观察与证据方法，不新增旁路入口 | 当前已有browser_task及受控Playwright；先维护同一执行来源 | 暂缓独立接入 |
| webapp-selenium-testing | 保留为资料 | 只有明确Java/Selenium存量测试资产时才考虑 | 暂缓 |
| accessibility-selenium-testing | 保留为资料 | Selenium栈确有可访问性需求时再考虑 | 暂缓 |

qa-investigation原文将文件写到项目根、每两次读取记录一次、修复后重复运行。适配时应改为运行内证据引用和阶段更新，避免多任务覆盖文件；复现与修复后执行必须走现有授权和批次入口。根因确定性与故障频率应分开分类，稳定复现不自动等于产品Bug。

## 7个Agents逐项建议

| 外部Agent | 是否新增 | 理由 |
|---|---|---|
| qa-orchestrator | 不新增 | 与test_agent重复；保留现有总控的状态与交接职责 |
| playwright-test-planner | 不新增 | 方法分配给需求、测试点和用例角色；避免出现第二份不受追溯约束的计划 |
| playwright-test-generator | 先不新增 | 现有automation_execution_agent已有prepare模式；补生成方法即可。只有生成维护任务量大时再拆角色 |
| playwright-test-healer | 不原样新增 | 先增强缺陷角色的调查能力；将脚本修改、产品缺陷和复测分开，禁止为得到绿色结果而隔离失败 |
| api-tester-specialist | 最值得作为后续新增候选 | API任务足够频繁、需要独立契约与认证状态管理时再拆；先用Skill试点验证收益 |
| test-refactor-specialist | 作为后续维护角色候选 | 测试资产形成规模后才有明显收益；保持case_id、断言意图与覆盖，修改后重建批准依据 |
| selenium-test-specialist | 暂不新增 | 当前主栈Playwright；增加Java/Maven/驱动链条的成本缺乏现阶段收益依据 |

首轮建议仍保留现有7个角色；先证明专业能力增强有效，再按工作量考虑API专员与测试维护专员。新增角色是职责设计，需要接入运行系统，并非复制一个.agent.md文件。

## 接入前必须解决的实际问题

1. **资源同步不完整**：scripts/sync-penguin-agents.mjs第25–28行仅复制SKILL.md，不复制references/templates/scripts。需要完整目录同步或统一只读资源定位，覆盖依赖文件的发布、校验与路径解析；同时避免把运行产物当Skill资源复制。
2. **新角色需注册**：同步脚本第21行要求目标Agent先存在；还需修改penguin/agents.json、工作流/独立任务路由、派发守卫、发布资源清单和相关测试。frontmatter工具名必须映射实际工具。
3. **执行规则冲突**：外部直接npx/MCP运行、生成后立即测试、CI retries=2不能替代受控入口；现有execution-runner明确--retries=0。task与lifecycle模式分别沿用既有授权边界，不人为给独立任务增加全流程前置材料。
4. **修复与跳过规则**：产品缺陷保持真实失败并进入缺陷流程；脚本修复不改业务预期、不删断言、不把skip/fixme计为修复；改动后按现有计划快照与复测规则执行。
5. **输出契约冲突**：外部CSV/Markdown模板不能替换现有Schema、rule_id、case_id和invocation_id；调查记录不能覆盖归档证据；汇总继续使用现有度量事实源。
6. **现有指令应先消歧**：playwright-execution第46行允许prepare只生成脚本，第64行又写禁止只生成不执行；第15行要求运行内脚本目录，第37行仍列tests/generated输出。README仍有失效工程路径。应明确模式适用范围和当前唯一目录约定。
7. **知识与执行适配分层**：Skill入口只保留用途、边界、必要步骤和出口条件；测试方法放references，确定性工作交脚本，工程状态/审批规则统一引用。减少Agent和Skill重复堆放操作细则。
8. **来源管理**：本次查看的根LICENSE及抽查Skill LICENSE为MIT。复制资源时保留对应许可证与版权信息，记录上游提交、导入文件和本地改动；不默认自动同步未来上游策略。

## 推荐实施顺序与验收

第一步：修正现有指令冲突，补完整Skill资源同步/可达性检查，不新增业务确认节点。

第二步：先取ISTQB测试设计方法、qa-investigation与Playwright参考资料，接现有角色；保留结构化输出与执行入口。

第三步：按业务需求接API Skill及可访问性能力，再增强回归策略。只有当实际任务体现出专业分工收益时才增加Agent。

用同一模型配置、同一输入和近似预算比较当前版与增强版，建议至少覆盖：

- 多条件权限/折扣规则：是否正确使用决策表、识别遗漏组合。
- 状态流转：是否覆盖无效迁移，并保持原需求语义。
- UI失败：能否区分定位器错误、共享数据、环境问题和产品缺陷；证据不足是否保留待确认。
- API：正确处理401/403、204、分页、幂等副作用与契约差异。
- 产品真实缺陷：不得通过修改预期、删除断言或skip/fixme获得“修复通过”。
- 新会话安装与派发：引用资料可读取，输出能进入现有报告链路，task不被lifecycle前置条件误拦。

比较有效缺陷发现、无依据结论、遗漏场景、首次交付校验成功率、人工纠正次数、耗时和token。格式lint及工程回归是必要检查；还需真实模型会话才能判断智能体是否更好。

## 关键证据文件

当前工程：
- penguin/agents.json：角色及Skill映射。
- skills/test-case-writing/SKILL.md：设计依据、数据检查、可执行性与交付契约。
- skills/playwright-execution/SKILL.md：执行模式、路径与重试规则，以及上述文本冲突。
- scripts/sync-penguin-agents.mjs：当前同步范围和新角色存在性检查。
- scripts/execution-runner.mjs：真实执行入口及--retries=0。
- scripts/delegation-guard.mjs：派发与计划角色匹配。
- docs/current-status-and-next-steps.md：最新能力与真实会话验证边界。

外部仓库：
- AGENTS.md、README.md、scripts/lint-skills.mjs：结构规则及验证范围。
- agents/playwright-test-healer.agent.md第71、85–89行：修复与fixme策略。
- agents/playwright-test-generator.agent.md：工具绑定、fixture与立即执行要求。
- skills/qa-manual-istqb/references/test-design-techniques.md：专业设计方法。
- skills/qa-investigation/SKILL.md：持久调查和可证伪假设方法。
- skills/api-testing/references/contract-testing.md第45–73行：幂等示例需修正。
- skills/playwright-regression-testing/references/flaky-management.md：默认重试及隔离策略。
