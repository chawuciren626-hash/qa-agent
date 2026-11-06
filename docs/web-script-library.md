# Web 自动化脚本的项目级积累

完整生命周期的 `execution` 准备阶段先生成本次用例选择和执行计划。隔离会话中，受控入口随后检查当前项目的 Web 脚本库，按项目 ID、目标 origin 和用例 JSON 哈希匹配已验证脚本。命中时复制到本次 `execution/scripts/`，在计划的 `script_reuse` 中记录来源 run、bundle ID、用例 ID 与文件哈希。`prepare_execution_plan` 回执的 `reused` 是已复用用例，`remaining` 仍需编写。已有草稿目录不会被覆盖。

本次脚本仍需通过 `validate_execution_prepare`、现有执行审批快照、环境预检和实际 Playwright 批次。历史通过不能替代本次结果。当前仅处理 Web 脚本；交互式 browser_task、API、Android 和小程序执行不进入此库。

执行结果获得阶段结果确认后，只有当前密封批次全部通过、无 flaky 用例、脚本位于本次 run 目录且所有计划用例 ID 出现在 spec 中时，才自动归档为 `verified` bundle。归档保留来源 run、批次、站点、用例哈希、脚本哈希和验证时间。库位于安装环境 QA 数据根目录的 `projects/<project_id>/automation/web/`，不属于源码或发布包；旧 bundle 保留。归档失败会在确认动作的 `script_library` 回执中显示，已确认的测试结果不被改写。

当前采用精确匹配。用例内容、站点或项目变化时不复用，需按当前范围编写或修订；归档目前以一次完整通过的脚本集合为单位。后续可扩展为按模块管理与单脚本版本升级，但不能降低运行快照、证据和审批要求。
