# 第3项：历史运行数据归档

日期：2026-10-12。

## 当前状态

后续清理说明：2026-10-12用户确认后，已从源工程移除30份冗余夹具/日志，归档data内副本保留且复核一致。详见[限定清理回执](E:/QAArchives/AITestWorker/cleanup-applied-2026-10-12-01.json)。下文“未删除源文件”描述的是归档完成时状态，不代表后续未执行清理。

用户确认归档位置并从托盘正常退出PenguinHarness后，进程检查确认退出，已完成正式复制、源数据复核和独立归档校验。归档目录为`E:/QAArchives/AITestWorker/history-2026-10-12-01`。未删除源文件、移动原生数据库、修改批准或解锁旧运行；应用保持退出，未提交GitHub。

顶层盘点发现output/runs有4929个目录，包含历史业务产物和大量工程夹具，不能等同于4929次真实Agent运行。

正式归档结果：79730个普通文件、64939个目录、267197074字节（约255MiB），7个目录链接仅记录不遍历，5个选定范围均存在。复制时逐文件源/副本SHA256一致，复制后重新检查源清单和全部源哈希，最终源目录检查无变化，manifest状态为verified。

随后单独运行--verify，只读取归档目录，返回status=verified、files=79730、bytes=267197074、source_required=false。归档README提供新旧工程路径与data相对路径的映射和查阅说明。

主要入口：

- [归档查阅说明](E:/QAArchives/AITestWorker/history-2026-10-12-01/README.md)
- [逐文件清单](E:/QAArchives/AITestWorker/history-2026-10-12-01/manifest.json)
- [历史运行目录](E:/QAArchives/AITestWorker/history-2026-10-12-01/data/output/runs)

第3项数据复制与完整性验收完成，历史查阅采用上述归档路径，不声称修复了原生旧聊天链接。下一项是防回流与清理，需用户确认后开始；不能用本次成功归档自动批准删除源文件。

## 范围与排除

复制工程根下output、inputs、scratchpad、tests/generated，以及根目录符合时间戳加短ID命名的会话目录。保留相对目录结构及空目录；inputs内已跟踪样例也复制一份，但这不代表该样例可从源码删除。

不复制.git、node_modules、程序源码、安装目录、用户应用数据根或PenguinHarness原生聊天数据库。应用数据迁移备份沿用第2项记录，本归档不是整个桌面应用的可启动备份。

目录链接仅记录路径及readlink目标，不跟随、不重建，也不复制目标内容。扫描已发现工程夹具留下的链接；将其原样遍历会越出归档边界或重复读取。普通文件逐项保存大小和SHA256，长路径使用Windows命名空间解析。

## 工具使用

```powershell
npm run archive:contracts
node scripts/archive-project-data.mjs --scan
node scripts/archive-project-data.mjs --create E:/QAArchives/AITestWorker/<本次唯一归档目录>
node scripts/archive-project-data.mjs --verify E:/QAArchives/AITestWorker/<本次唯一归档目录>
```

正式创建前父目录需已存在，目标目录必须不存在且位于工程外。工具不会覆盖已有归档，也没有源数据删除功能。

每个归档包含manifest.json和data目录。清单记录当前源工程路径、归档路径、所选范围、缺失项、目录、链接策略，以及逐文件大小、修改时间、SHA256。清单path为工程相对路径，对应副本为`data/<path>`，对应原文件为`source_root/<path>`。

创建时先扫描，计算源哈希、复制、校验副本；随后重新扫描并复核源哈希，确认文件集未变化才标记verified。出错则标记incomplete，保留部分副本用于调查，绝不当作成功归档。归档是期间稳定文件集的副本，不能代替数据库事务快照，因此必须暂停任务。

独立verify不依赖源文件，检查归档文件集、目录及所有哈希。校验通过也只代表复制完整性，不代表每份报告内容正确或客户端可打开。

## 历史查阅方式

旧文档中的`E:/Codex/测试智能体/<相对路径>`对应当前工程`E:/Codex/AITestWorker/<相对路径>`。归档后按同一相对路径在data目录查阅。可以通过run_id定位`data/output/runs/<run_id>`，不全局改写历史文档中的证据路径。

PenguinHarness旧会话数据库的workspace不自动改写，旧聊天产物链接不保证可点击，也不保证旧任务可续跑。原生绑定修复/只读导航方案要单独验收。归档副本不是新测试任务，不应直接执行其中保存的脚本。

归档可能包含私有需求、账号、日志和截图，只存本地，不提交GitHub、不放进安装包。下一项清理必须先依据归档清单检查当前文件是否仍匹配，不能凭本轮副本就删除之后有变化的文件。

## 专项测试

2项测试通过，覆盖源字节保留、源码排除、空目录及长路径、目标覆盖/工程重叠拒绝、独立校验与篡改检测、链接记录但不遍历。未运行产品测试或真实Agent流程。
